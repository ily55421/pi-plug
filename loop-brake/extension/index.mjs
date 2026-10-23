/**
 * Loop Brake —— agent extension 入口。
 *
 * 这一层只做接线：把 ExtensionAPI 的 `tool_call` 事件接到 core.mjs 的判定上，
 * 再注册一个只读状态工具与一个重置命令。**所有判定逻辑都在 core.mjs**，
 * 这里不做任何决策，因此判定可以在 Node 里独立测试。
 *
 * 权限：只需要 `agent.extension`。不读文件、不联网、不起进程、不写设置。
 *
 * 已核实的宿主契约（PI-Desktop）：
 *   - runner.ts:713 `createContext`：ctx 上是 `sessionManager.getSessionId()`，
 *     没有 `sessionId` 字段；
 *   - runtime.ts:2032：`tool_call` 事件只有 `toolName` / `toolCallId` / `input`；
 *     处理器返回 `{ block: true, reason }` 即阻断；
 *   - runtime.ts:2071：`context` 事件的入参是 `{ type, messages }`，
 *     返回 `{ messages }` 可替换消息列表。
 */

import { LoopBrake, describe } from "./core.mjs";
import { readPluginSettings } from "./settings.mjs";

/** 兜底键：ctx 尚未就绪时也有闸门可用。 */
const FALLBACK = "__fallback__";

/**
 * 每个会话一个闸门实例。
 *
 * Runner 为每个桌面会话绑定一个 extension 实例，但同一进程内可能同时存在
 * 多个会话，所以按会话 id 分桶；`session_shutdown` 时精确清理，
 * 避免长跑进程里这个 Map 无限增长。
 */
const brakes = new Map();

/** 取出（必要时创建）某个会话的闸门。 */
function brakeFor(sessionKey) {
  const key = typeof sessionKey === "string" && sessionKey ? sessionKey : FALLBACK;
  let brake = brakes.get(key);
  if (!brake) {
    brake = new LoopBrake();
    brakes.set(key, brake);
  }
  return brake;
}

/**
 * 从事件与 ctx 里取出会话 id。
 *
 * 依据 runner.ts:713，ctx 上没有 `sessionId` 字段，会话 id 只能经
 * `ctx.sessionManager.getSessionId()` 拿到；事件对象里也不带 sessionId。
 * 任何取不到的情况都退回兜底键，保证始终有状态可用。
 */
function sessionKeyOf(event, ctx) {
  const fromEvent = event && (event.sessionId ?? event.session_id);
  if (typeof fromEvent === "string" && fromEvent) return fromEvent;
  try {
    const fromCtx = ctx?.sessionManager?.getSessionId?.();
    if (typeof fromCtx === "string" && fromCtx) return fromCtx;
  } catch {
    // getSessionId 在 runner 销毁后可能不可用，退回兜底键。
  }
  return FALLBACK;
}

/**
 * 读插件设置。
 *
 * ctx 上没有 settings（宿主 TrustedExtensionBridge 无此字段），
 * 所以走 `settings.mjs`：读宿主的 plugins/data/<id>/settings.json，
 * 缺失则用 manifest 里声明的默认值。每次工具调用都重读，改设置立即生效。
 */
function readSettings() {
  const stored = readPluginSettings();
  // ignoreTools 在设置页里是逗号分隔字符串，core 需要数组。
  const ignoreTools = typeof stored.ignoreTools === "string"
    ? stored.ignoreTools.split(",").map((item) => item.trim()).filter(Boolean)
    : Array.isArray(stored.ignoreTools)
      ? stored.ignoreTools
      : [];
  return { ...stored, ignoreTools };
}

export default function loopBrake(pi) {
  /**
   * 主闸：每次工具调用前核对指纹。
   *
   * 这个处理器**绝不抛错**。宿主会把处理器异常记成诊断并按 undefined 处理
   * （即放行），但我们显式放行更可控，也不依赖宿主兜底行为。
   */
  pi.on("tool_call", (event, ctx) => {
    try {
      const toolName = event && typeof event.toolName === "string" ? event.toolName : "";
      if (!toolName) return undefined;

      // 本插件自己的状态工具不参与判定，避免「查状态」被自己的闸门拦下。
      if (toolName === "loop_brake_status") return undefined;

      const brake = brakeFor(sessionKeyOf(event, ctx));

      // 设置只在真正变化时才下发：updateSettings() 内部会 reset() 连续计数，
      // 若每次调用都对齐设置，计数会被自己清零，闸门永远触发不了。
      const next = readSettings();
      const signature = JSON.stringify(next);
      if (brake.settingsSignature !== signature) {
        brake.updateSettings(next);
        brake.settingsSignature = signature;
      }

      const verdict = brake.observe(toolName, event.input);

      if (verdict.action === "block") {
        // 阻断：宿主会把 reason 交给模型，模型因此有机会换策略而不是重试。
        return { block: true, reason: verdict.reason };
      }

      if (verdict.action === "warn") {
        // `tool_call` 的返回值只认 block/reason，没有「放行 + 提示」这一档。
        // 先记下来，由 `context` 事件在下一轮把提醒递进上下文。
        brake.pendingWarning = verdict.reason;
      }

      return undefined;
    } catch (error) {
      try {
        pi.log?.("warn", "loop-brake tool_call handler failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // 日志失败也不抛。
      }
      return undefined;
    }
  });

  /**
   * 把上一轮攒下的警告递进上下文。
   *
   * `context` 允许替换消息列表，是唯一能「放行但让模型看到提醒」的位置。
   * 只在有警告待发时改动列表，其余时候原样返回 —— 不做无谓侵入。
   */
  pi.on("context", (event, ctx) => {
    try {
      const brake = brakeFor(sessionKeyOf(event, ctx));
      const warning = brake.pendingWarning;
      if (!warning) return undefined;
      brake.pendingWarning = null;

      const messages = Array.isArray(event && event.messages) ? event.messages.slice() : null;
      if (!messages) return undefined;

      messages.push({
        role: "system",
        content:
          `[loop-brake] ${warning} ` +
          "(If you already changed strategy, ignore this notice.)",
      });
      return { messages };
    } catch {
      return undefined;
    }
  });

  /** 会话结束即释放状态。 */
  pi.on("session_shutdown", (event, ctx) => {
    brakes.delete(sessionKeyOf(event, ctx));
    return undefined;
  });

  /**
   * 只读状态工具。让模型与用户都能确认「闸门现在是什么状态」，
   * 也是排查误判的入口。只读、无参数、不改任何状态。
   */
  pi.registerTool({
    name: "loop_brake_status",
    label: "Loop Brake status",
    description:
      "Report the loop-brake guard state for this session: whether it is enabled, the repetition threshold, " +
      "the current consecutive-call count, and how many warnings and blocks have fired. Read-only; it never " +
      "changes the guard. Use it when a tool call was blocked and you want to understand why.",
    // `parameters` 是 ToolDefinitionLike 的必填字段；空 schema 表示无参。
    parameters: { type: "object", properties: {}, required: [] },
    execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const snapshot = brakeFor(sessionKeyOf(undefined, ctx)).snapshot();
      const lines = [
        `enabled: ${snapshot.settings.enabled}`,
        `mode: ${snapshot.settings.mode}`,
        `threshold: ${snapshot.settings.threshold}`,
        `consecutive identical calls: ${snapshot.consecutive}`,
        `already warned in this run: ${snapshot.warned}`,
        `ignoreTools: ${
          snapshot.settings.ignoreTools.length === 0
            ? "(none)"
            : snapshot.settings.ignoreTools.join(", ")
        }`,
        `checked: ${snapshot.stats.checked}, warned: ${snapshot.stats.warned}, blocked: ${snapshot.stats.blocked}`,
        snapshot.stats.lastBlocked
          ? `last blocked: ${snapshot.stats.lastBlocked.tool} at call #${snapshot.stats.lastBlocked.count}`
          : "last blocked: (never)",
      ];
      return { content: [{ type: "text", text: lines.join("\n") }], details: { snapshot } };
    },
  });

  /**
   * 手动清空闸门。用户被误判卡住时的逃生口。
   * 命令跑在 sidecar 里，绑定当前活动会话。
   */
  pi.registerCommand("loop-brake-reset", {
    description: "Clear the loop-brake consecutive-call counter for this session",
    handler(_args, ctx) {
      const brake = brakeFor(sessionKeyOf(undefined, ctx));
      brake.reset("manual reset via /loop-brake-reset");
      const snapshot = brake.snapshot();
      const text =
        `loop-brake reset. Threshold ${snapshot.settings.threshold}, mode ${snapshot.settings.mode}; ` +
        `consecutive count is now ${snapshot.consecutive}.`;
      try {
        ctx?.ui?.notify?.(text);
      } catch {
        // 通知失败不影响重置本身。
      }
    },
  });
}

/* 便于测试直接引用；不参与 extension 运行期行为。 */
export { brakeFor, describe, sessionKeyOf };
