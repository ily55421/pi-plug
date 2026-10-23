/**
 * Format on Edit —— agent extension 入口。
 *
 * 接线：`tool_result` 钩子（宿主在 `afterToolCall` 触发，可替换 content）。
 * 在 `Edit` / `Write` 成功之后，按扩展名跑 formatter，然后**必须**把新的
 * 4-hex tag 回传给模型 —— 否则文件内容变了、tag 没变，模型下一次 Edit
 * 会直接 EDIT_PARSE_FAILED。
 *
 * 权限：只需要 `agent.extension`。因为 `exec` 跑在 sidecar 且带会话 cwd，
 * 不需要 `fs.*` 或进程权限。
 *
 * 已核实的宿主契约：
 *   - runtime.ts:2049 `tool_result` 事件含 { toolName, toolCallId, input, content, details, isError }
 *   - runner.ts `exec` 在 sidecar 里、以会话 cwd 运行（spec 16 §7.5）
 *   - tag 算法见 crates/host-core/src/tools/hashline/tag.rs:93-123
 *
 * 三个刻意的保守选择：
 *   1. 默认**关闭**：需要显式 `pluginSettings.formatOnEdit === true`。
 *   2. 任何一步失败都退回**原结果**，绝不因为格式化把一次成功的编辑变成失败。
 *   3. 自带 8 秒超时（宿主的结果型事件 30 秒就放弃），超时即放弃并说明。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, dirname as pathDirname } from "node:path";

import { FORMAT_TIMEOUT_MS, MAX_FORMAT_BYTES, formatNotice, planFormat, tagOf } from "./core.mjs";
import { readPluginSettings } from "./settings.mjs";

/** 兜底键。 */
const FALLBACK = "__fallback__";

/** 每个会话的统计，供状态工具使用。 */
const stats = new Map();

function statsFor(key) {
  let entry = stats.get(key);
  if (!entry) {
    entry = { considered: 0, formatted: 0, skipped: 0, failed: 0, last: null };
    stats.set(key, entry);
  }
  return entry;
}

/** 会话键：ctx 上没有 sessionId，只能经 sessionManager 拿。 */
function sessionKeyOf(event, ctx) {
  const fromEvent = event && (event.sessionId ?? event.session_id);
  if (typeof fromEvent === "string" && fromEvent) return fromEvent;
  try {
    const fromCtx = ctx?.sessionManager?.getSessionId?.();
    if (typeof fromCtx === "string" && fromCtx) return fromCtx;
  } catch {
    // runner 销毁后不可用。
  }
  return FALLBACK;
}

/**
 * 是否启用。默认关闭 —— 自动改写用户文件这件事，没有明确许可就不做。
 * 设置来自 settings.mjs（读宿主的 plugins/data/<id>/settings.json）。
 */
function isEnabled() {
  return readPluginSettings().formatOnEdit === true;
}

/** 相对路径以会话 cwd 为基准。 */
function resolvePath(filePath, ctx) {
  const raw = String(filePath ?? "");
  if (isAbsolute(raw)) return raw;
  const cwd = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd();
  return join(cwd, raw);
}

/**
 * 跑 formatter。
 *
 * `exec` 是工厂入参 `pi` 上的成员（runner.ts:923），**不在事件 ctx 上** ——
 * tool_result 事件的 ctx 来自 createContext（runner.ts:713-739），没有 exec。
 * 宿主实现（runner.ts:635-671）以会话 cwd 无 shell spawn，结果形状是
 * `{ stdout, stderr, code, killed }`；options.timeout 到点会 SIGTERM 子进程，
 * 因此不会在 formatter 还在写盘时就去重读文件。
 *
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function runFormatter(pi, formatter, absolutePath) {
  const argv = [formatter.command, ...formatter.args, absolutePath];
  try {
    const result = await pi.exec(argv[0], argv.slice(1), { timeout: FORMAT_TIMEOUT_MS });
    const code = typeof result?.code === "number" ? result.code : 0;
    if (code !== 0) {
      const stderr = typeof result?.stderr === "string" ? result.stderr.trim().slice(0, 300) : "";
      const why = result?.killed === true ? "timed out (SIGTERM)" : `exited ${code}`;
      return { ok: false, reason: `${formatter.id} ${why}${stderr ? `: ${stderr}` : ""}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `${formatter.id} failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * 把工具结果文本里残留的旧 tag 换成新 tag。
 *
 * 宿主 Edit/Write 的结果里带 `[path#TAG]` 头，那个 tag 是「格式化前」算的。
 * 只追加说明的话，模型会同时看到结构化头里的旧 tag 和说明里的新 tag，而
 * 模型大多直接信头里的值 —— 旧 tag 残留是每次格式化都会发生的高概率失效。
 * 这里把结果文本中的 `#oldTag]`（大小写不敏感）替换为新 tag。4-hex 有
 * 1/65536 的碰撞率，替换锚定 `#XXXX]`，误伤另一个同 tag 文件头的概率可忽略；
 * 反之留着旧 tag，下一次 Edit 几乎必挂。
 */
function replaceStaleTag(content, oldTag, newTag) {
  if (!Array.isArray(content) || !oldTag || !newTag || oldTag === newTag) return content;
  const pattern = new RegExp(`#${oldTag}\\]`, "gi");
  return content.map((part) => {
    if (!part || part.type !== "text" || typeof part.text !== "string") return part;
    const next = part.text.replace(pattern, `#${newTag}]`);
    return next === part.text ? part : { ...part, text: next };
  });
}

/** 把说明追加到工具结果的文本内容上。 */
function appendNotice(content, notice) {
  if (!Array.isArray(content)) return content;
  const index = content.findIndex((part) => part && part.type === "text" && typeof part.text === "string");
  if (index === -1) {
    return [...content, { type: "text", text: notice }];
  }
  const next = content.slice();
  next[index] = { ...next[index], text: `${next[index].text}${notice}` };
  return next;
}

export default function formatOnEdit(pi) {
  pi.on("tool_result", async (event, ctx) => {
    try {
      if (!isEnabled()) return undefined;

      const key = sessionKeyOf(event, ctx);
      const entry = statsFor(key);

      const toolName = event?.toolName;
      const args = event?.input;
      const isError = event?.isError === true;

      entry.considered += 1;

      // 先用闸门判一次（不含 exists）：判断「是不是写文件 + 有没有 formatter」。
      const preliminary = planFormat({
        toolName,
        args,
        isError,
        // 这一步还没有项目信息，先按「无依赖需求」处理，后面再补。
        exists: () => true,
      });

      if (!preliminary.format) {
        // 不是写文件 / 失败 / 路径被跳过：这一类根本不该记进「跳过」。
        if (toolName === "Edit" || toolName === "Write") entry.skipped += 1;
        return undefined;
      }

      const absolutePath = resolvePath(preliminary.filePath, ctx);

      // 体积闸：大文件不格式化，避免拖垮 30 秒窗口。
      let before;
      try {
        const raw = await readFile(absolutePath);
        if (raw.byteLength > MAX_FORMAT_BYTES) {
          entry.skipped += 1;
          entry.last = { tool: toolName, file: preliminary.filePath, reason: "file too large" };
          return undefined;
        }
        before = raw;
      } catch (error) {
        entry.skipped += 1;
        entry.last = {
          tool: toolName,
          file: preliminary.filePath,
          reason: `cannot read: ${error instanceof Error ? error.message : String(error)}`,
        };
        return undefined;
      }

      const oldTag = tagOf(before);
      const oldLineCount = countLines(before.toString("utf8"));

      // 真正开工前再判一次：这次带上项目依赖检查。
      const plan = planFormat({
        toolName,
        args,
        isError,
        exists: (name) => projectDeclares(name, absolutePath, ctx),
      });
      if (!plan.format) {
        entry.skipped += 1;
        entry.last = { tool: toolName, file: preliminary.filePath, reason: plan.reason };
        return undefined;
      }

      const outcome = await runFormatter(pi, plan.formatter, absolutePath);
      if (!outcome.ok) {
        entry.failed += 1;
        entry.last = { tool: toolName, file: preliminary.filePath, reason: outcome.reason };
        // 失败就退回原结果，但在结果里说清「没格式化」，避免模型以为已格式化。
        return {
          content: appendNotice(event.content, `\n\n[format-on-edit] skipped formatting ${preliminary.filePath}: ${outcome.reason}`),
        };
      }

      // 格式化成功：重新读文件，算新 tag。
      let after;
      try {
        after = await readFile(absolutePath);
      } catch {
        // 读不到就只报「已格式化」而不编造 tag。
        entry.formatted += 1;
        return {
          content: appendNotice(event.content, formatNotice({ filePath: preliminary.filePath, formatterId: plan.formatter.id })),
        };
      }

      const newTag = tagOf(after);
      const changedLines = countLines(after.toString("utf8")) - oldLineCount;
      entry.formatted += 1;
      entry.last = { tool: toolName, file: preliminary.filePath, reason: "formatted", oldTag, newTag };

      // 内容没变时也照常回传：模型手里的 tag 仍是最新的。
      // 先把结果里残留的旧 tag 换成新 tag（见 replaceStaleTag），再追加说明。
      return {
        content: appendNotice(
          replaceStaleTag(event.content, oldTag, newTag),
          formatNotice({
            filePath: preliminary.filePath,
            oldTag,
            newTag,
            changedLines,
            formatterId: plan.formatter.id,
          }),
        ),
      };
    } catch (error) {
      // 任何内部异常都不该影响这次编辑的结果。
      try {
        pi.log?.("warn", "format-on-edit tool_result failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // 日志失败也不再抛。
      }
      return undefined;
    }
  });

  pi.on("session_shutdown", (event, ctx) => {
    stats.delete(sessionKeyOf(event, ctx));
    return undefined;
  });

  /**
   * 只读状态工具：让用户与模型确认「到底格式化过没有、为什么没做」。
   * 失败原因尤其重要 —— 静默不格式化比报错更难排查。
   */
  pi.registerTool({
    name: "format_on_edit_status",
    label: "Format on Edit status",
    description:
      "Report whether format-on-edit is enabled in this session and what it has done: how many edits it considered, " +
      "formatted, skipped and failed, plus the last decision and its reason. Read-only. Use it when a file was edited " +
      "but not reformatted and you want to know why.",
    parameters: { type: "object", properties: {}, required: [] },
    execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const key = sessionKeyOf(undefined, ctx);
      const entry = statsFor(key);
      const enabled = isEnabled();
      const lines = [
        `enabled: ${enabled}`,
        enabled ? "mode: reformat after Edit and Write, then report the new file tag" : "mode: reporting only (formatting is off)",
        `considered: ${entry.considered}, formatted: ${entry.formatted}, skipped: ${entry.skipped}, failed: ${entry.failed}`,
      ];
      if (entry.last) {
        lines.push(
          `last: ${entry.last.tool} ${entry.last.file} → ${entry.last.reason}` +
            (entry.last.oldTag && entry.last.newTag ? ` (tag ${entry.last.oldTag} → ${entry.last.newTag})` : ""),
        );
      } else {
        lines.push("last: (nothing yet)");
      }
      return { content: [{ type: "text", text: lines.join("\n") }], details: { enabled, stats: { ...entry } } };
    },
  });
}

/** 数行数（与 hashline 的 split_lines 语义一致：以 \n 计，末尾换行不算多一行）。 */
function countLines(text) {
  const source = typeof text === "string" ? text : "";
  if (source === "") return 0;
  const lf = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let count = lf.split("\n").length;
  if (lf.endsWith("\n")) count -= 1;
  return count;
}

/**
 * 项目里是否声明了某个依赖/配置文件。
 *
 * 从被编辑文件的目录向上找，最多到 cwd；找到 package.json 就解析其依赖键，
 * 找到 biome.json / .prettierrc 之类的配置文件就按文件名命中。
 * 读不到、解析失败一律返回 false（fail-closed）。
 */
function projectDeclares(name, absolutePath, ctx) {
  try {
    // 同步读取：这里在 30 秒事件窗口内，且只是几个小文件。
    const stopAt = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : null;
    let dir = pathDirname(absolutePath);
    for (let depth = 0; depth < 40; depth += 1) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        try {
          if (statSync(candidate).isFile()) return true;
        } catch {
          // 忽略单次 stat 失败。
        }
      }

      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
          for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
            const block = pkg && pkg[key];
            if (block && typeof block === "object" && Object.prototype.hasOwnProperty.call(block, name)) return true;
          }
        } catch {
          // package.json 坏了就当没声明。
        }
      }

      if (stopAt && dir === stopAt) break;
      const parent = pathDirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return false;
  } catch {
    return false;
  }
}
/* 便于测试直接引用；不影响运行期行为。 */
export { countLines, isEnabled, projectDeclares, replaceStaleTag, resolvePath, sessionKeyOf, statsFor };
