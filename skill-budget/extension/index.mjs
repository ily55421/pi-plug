/**
 * Skill Budget —— agent extension 入口。
 *
 * 只做两件事：
 *   1. 注册一个**只读**审计工具，让用户和模型能问清「技能广告占了系统提示多少」。
 *   2. 在 `before_agent_start` 里**可选地**按 id 去重技能段（默认关闭）。
 *
 * 为什么默认关闭改写：改系统提示是侵入性操作。宿主自己的
 * `pluginSkillsPrompt`（packages/agent-runtime/src/plugin-skills-prompt.ts）
 * 按设计把技能广告全量渲染，用户没要求时不该被插件悄悄改掉。默认只报告，
 * 让用户看着数字决定要不要开。
 *
 * 权限：只需要 `agent.extension`。不读写文件、不联网、不起进程。
 * 判定逻辑全在 core.mjs，可独立单测。
 *
 * 已核实的宿主契约：
 *   - runner.ts:737 `getSystemPrompt: () => bridge.getSystemPrompt()`
 *   - runner.ts:735 `getContextUsage: () => bridge.getContextUsage()`
 *   - runtime.ts:2366 getContextUsage 返回 { tokens, contextWindow, percent }
 *   - `before_agent_start` 的结果被采纳，可改 systemPrompt（spec 16 §6）
 */

import { auditSkills, dedupeSkillsSection, renderReport } from "./core.mjs";
import { readPluginSettings } from "./settings.mjs";

/** 兜底键：ctx 尚未就绪时也能工作。 */
const FALLBACK = "__fallback__";

/**
 * 每个会话的去重记录：最近一次是否真的做了改写，以及移除了几条。
 * 只用于观测与排查「为什么没生效」，不参与判定。
 * （改写本身是幂等的，所以不需要「记住已改过的指纹」。）
 */
const applied = new Map();

/** 取出会话键。ctx 上没有 sessionId，只能经 sessionManager 拿。 */
function sessionKeyOf(event, ctx) {
  const fromEvent = event && (event.sessionId ?? event.session_id);
  if (typeof fromEvent === "string" && fromEvent) return fromEvent;
  try {
    const fromCtx = ctx?.sessionManager?.getSessionId?.();
    if (typeof fromCtx === "string" && fromCtx) return fromCtx;
  } catch {
    // runner 销毁后 getSessionId 可能不可用。
  }
  return FALLBACK;
}

/**
 * 读是否开启改写。默认关闭：没有明确指令就不动系统提示。
 * 设置来自 settings.mjs（读宿主的 plugins/data/<id>/settings.json）。
 */
function isDedupeEnabled() {
  return readPluginSettings().dedupeSkillsSection === true;
}

export default function skillBudget(pi) {
  /**
   * 可选改写：在系统提示送出前按 id 去重技能段。
   *
   * 只有用户显式开启时才动作；不开启时返回 undefined，宿主原样使用提示。
   * 刻意**不**在这里 catch：宿主对 handler 抛错的行为是记 handler_error
   * 诊断并按 undefined 处理（runner.ts），语义同样是「退化为不改写」，
   * 但那样错误会进入 Settings → Extensions 的诊断面板，可排查；
   * 而本地 catch + `pi.log` 在真实宿主里是 no-op（ExtensionAPI 没有 log
   * 成员，runner.ts 的 createApi 无此键），等于把错误完全吞掉。
   */
  pi.on("before_agent_start", (event, ctx) => {
    if (!isDedupeEnabled()) return undefined;

    const original = typeof event?.systemPrompt === "string" ? event.systemPrompt : "";
    if (!original) return undefined;

    const key = sessionKeyOf(event, ctx);
    const { deduped, removed } = dedupeSkillsSection(original);
    if (removed === 0 || deduped === original) {
      applied.set(key, { removed: 0, at: Date.now() });
      return undefined;
    }

    applied.set(key, { removed, at: Date.now() });
    return { systemPrompt: deduped };
  });

  /** 会话结束清理记录。 */
  pi.on("session_shutdown", (event, ctx) => {
    applied.delete(sessionKeyOf(event, ctx));
    return undefined;
  });

  /**
   * 只读审计工具。
   *
   * 刻意只返回「成本与可疑项」，不返回技能全文：审计工具本身不该吃上下文。
   */
  pi.registerTool({
    name: "skill_budget_audit",
    label: "Skill budget audit",
    description:
      "Report how much of the current system prompt the skill catalog costs: how many skills are advertised, " +
      "their estimated token cost and share of the prompt, the heaviest entries, and any skills advertised twice " +
      "(same id) or near-duplicated under different ids. Read-only. Token counts are estimates, not tokenizer-exact. " +
      "Use it when you want to know whether skill descriptions are crowding out the actual task.",
    parameters: { type: "object", properties: {}, required: [] },
    execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const prompt = typeof ctx?.getSystemPrompt === "function" ? ctx.getSystemPrompt() : "";
      const report = auditSkills(prompt);
      const usage = typeof ctx?.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
      const text = renderReport(report);
      return {
        content: [{ type: "text", text }],
        details: {
          found: report.found,
          estimate: true,
          totals: report.totals,
          duplicates: report.duplicates,
          nearDuplicates: report.nearDuplicates,
          contextUsage: usage ?? null,
        },
      };
    },
  });

  /**
   * 让用户能主动触发一次审计报告（不依赖模型去调工具）。
   * 命令跑在 sidecar 里，绑定当前活动会话。
   */
  pi.registerCommand("skill-budget", {
    description: "Report the token cost of the skill catalog in the current system prompt",
    handler(_args, ctx) {
      const prompt = typeof ctx?.getSystemPrompt === "function" ? ctx.getSystemPrompt() : "";
      const report = auditSkills(prompt);
      const text = renderReport(report);
      try {
        ctx?.ui?.notify?.(text.split("\n")[0] ?? "skill-budget: no data");
      } catch {
        // 通知失败不影响任何状态（本命令只读）。
      }
    },
  });
}

/* 便于测试直接引用；不影响运行期行为。 */
export { applied, isDedupeEnabled, sessionKeyOf };
