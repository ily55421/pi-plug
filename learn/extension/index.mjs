/**
 * Learn —— agent extension 入口。
 *
 * **不重复造注入半场**：PI-Desktop 已经原生实现「读文件时带出该子树
 * AGENTS.md」（`runtime.ts:5127 loadPathInstructions`，在 Read/Write/Edit/
 * BrowserPreview 执行前按 `params.path` 重建指令链）。本插件只补宿主没有的
 * 回写半场：把洞见按作用域写进就近那一层的 AGENTS.md。
 *
 * 两个工具：
 *   - `learn_scope`：只读，告诉模型这条洞见该写进哪个文件、以及现有预算占用；
 *   - `learn_append`：真正写入。默认关闭，需要显式开启。
 *
 * 安全：
 *   - 作用域必须在 workspace 内（core.recommendScope 做段级路径消解）；
 *   - 只写 AGENTS.md 系列文件名，绝不写其他路径；
 *   - 拒绝会话细节、显然事实、超长洞见；
 *   - 超过 32 KiB 直接拒绝，不静默截断别人的内容。
 *
 * 权限：只有 `agent.extension`。
 *
 * 为什么不要 `fs.read` / `fs.write`：规范原文是「fs.* permissions gate the
 * plugin API, not the process」（04-plugin-security.md）——这里的文件读写走
 * sidecar 内的 node:fs，属于进程能力，那两项权限根本不生效，声明只会误导用户。
 * 真正的保护来自本文件与 core.mjs 里的路径消解、文件名白名单、体积上限与内容校验。
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  INSTRUCTION_NAMES,
  mergeInsight,
  recommendScope,
  summarizeFile,
  validateInsight,
} from "./core.mjs";
import { readPluginSettings } from "./settings.mjs";

/** 兜底键。 */
const FALLBACK = "__fallback__";

/** 每次会话的写入计数，供状态排查。 */
const writes = new Map();

function writeLog(key) {
  let entry = writes.get(key);
  if (!entry) {
    entry = { appended: 0, duplicates: 0, rejected: 0, last: null };
    writes.set(key, entry);
  }
  return entry;
}

/** 会话键。 */
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
 * 工作区根。
 *
 * `agent.extension` 的 ctx 没有直接的 workspaceRoot 字段；可用的是
 * `ctx.cwd`（会话工作目录）。这里以 cwd 为根 —— 与宿主
 * `loadInstructionChain(projectPath)` 的 projectPath 语义一致。
 */
function workspaceRootOf(ctx) {
  const cwd = typeof ctx?.cwd === "string" ? ctx.cwd.trim() : "";
  return cwd || "";
}

/** 写入是否被允许。默认关闭 —— 自动改用户的项目文件，没有明确许可不做。 */
function isWriteEnabled() {
  return readPluginSettings().learnAppend === true;
}

/**
 * 写入前的最后一道防线：用 realpath 校验目标不链出 workspace。
 *
 * core.mjs 的段级消解只防词法逃逸（`.`/`..`），防不了符号链接：workspace
 * 里一个指向外部的目录链接，或本身就是符号链接的 AGENTS.md，都能把内容
 * 写到工作区外。宿主读侧有 realpath 防线（project-instructions.ts 的
 * canonicalFile/canonicalRoot），写侧对齐它：
 *   1. 目标目录 realpath 后必须仍在 workspace realpath 之内；
 *   2. 目标文件若已存在，其 realpath 必须等于 realpath(目录)/文件名 ——
 *      不是的话说明这个指令文件是个链往外部的符号链接，拒绝写入。
 *
 * Windows 上 realpath 的大小写可能与传入 root 不同，所以比较大小写不敏感。
 * @returns {{ok: boolean, reason?: string}}
 */
function verifyRealScope(root, targetPath) {
  try {
    const realRoot = realpathSync(root).replace(/[\\/]+$/, "");
    const realDir = realpathSync(dirname(targetPath));
    const rootLower = realRoot.toLowerCase();
    const dirLower = realDir.toLowerCase();
    const sameRoot =
      dirLower === rootLower ||
      dirLower.startsWith(`${rootLower}\\`) ||
      dirLower.startsWith(`${rootLower}/`);
    if (!sameRoot) {
      return { ok: false, reason: "target directory resolves outside the workspace via symlinks" };
    }
    if (existsSync(targetPath)) {
      const realFile = realpathSync(targetPath);
      const expected = join(realDir, basename(targetPath));
      if (realFile.toLowerCase() !== expected.toLowerCase()) {
        return { ok: false, reason: "instruction file is a symlink pointing outside the workspace" };
      }
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `cannot resolve real path: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * 找该目录下已存在的指令文件；没有就返回首选名 AGENTS.md。
 * 与宿主 project-instructions.ts 的优先级一致（override 优先）。
 */
function resolveInstructionFile(directory) {
  for (const name of INSTRUCTION_NAMES) {
    const candidate = join(directory, name);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return { path: candidate, name };
    } catch {
      // 继续找下一个候选名。
    }
  }
  return { path: join(directory, "AGENTS.md"), name: "AGENTS.md" };
}

/** 相对 workspace 的展示路径。 */
function displayPath(absolutePath, root) {
  const normalizedRoot = String(root).replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = String(absolutePath).replace(/\\/g, "/");
  if (normalizedPath === normalizedRoot) return ".";
  return normalizedPath.startsWith(`${normalizedRoot}/`)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : normalizedPath;
}

export default function learn(pi) {
  /**
   * 只读：这条洞见该写进哪一层，以及那一层现在的预算占用。
   * 让模型先看清落点再决定要不要写，也便于用户审阅。
   */
  pi.registerTool({
    name: "learn_scope",
    label: "Learn: where does this belong",
    description:
      "Recommend which AGENTS.md a durable project insight belongs in, given the file or directory it relates to, " +
      "and report that file's current size and budget. Read-only. Rules are scoped per directory: place an insight " +
      "as close to the relevant code as possible. Use this before learn_append so the insight lands in the right layer " +
      "rather than the workspace root.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "A file the insight relates to (absolute or workspace-relative)." },
        directory: { type: "string", description: "Or a directory, when the insight is not about one file." },
      },
      required: [],
    },
    execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const root = workspaceRootOf(ctx);
      if (!root) {
        return failure("no workspace root available in this session");
      }

      const scope = recommendScope({
        workspaceRoot: root,
        file: typeof params?.file === "string" ? params.file : undefined,
        directory: typeof params?.directory === "string" ? params.directory : undefined,
      });
      if (!scope.ok) return failure(scope.reason);

      const target = resolveInstructionFile(scope.directory);
      let content = "";
      try {
        if (existsSync(target.path)) content = readFileSync(target.path, "utf8");
      } catch (error) {
        return failure(`cannot read ${displayPath(target.path, root)}: ${error instanceof Error ? error.message : String(error)}`);
      }

      const summary = summarizeFile(content);
      const lines = [
        `Write this insight into: ${displayPath(target.path, root)}`,
        `That file currently: ${summary.bytes} bytes, ${summary.lines} lines, ${summary.learnedItems} learned item(s), ${summary.budgetPercent}% of the 32 KiB budget.`,
        summary.learnedItems >= 15
          ? "It already carries many learned items; consider whether the insight belongs in a deeper directory instead."
          : "Nested files take the last word for the files beneath them, so the deepest relevant directory is usually right.",
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { ok: true, target: displayPath(target.path, root), relative: scope.relative, summary },
      };
    },
  });

  /**
   * 写入。默认关闭。
   */
  pi.registerTool({
    name: "learn_append",
    label: "Learn: append to AGENTS.md",
    description:
      "Append one durable project insight to the AGENTS.md closest to the given file or directory. " +
      "The insight must be durable project knowledge: hidden relationships, non-obvious configuration, debugging " +
      "breakthroughs, constraints, commands missing from the README. It must NOT be session-specific (ids, timestamps, " +
      "who asked what), obvious framework facts, or longer than a few lines. Exact duplicates are skipped. " +
      "Disabled unless explicitly enabled.",
    parameters: {
      type: "object",
      properties: {
        insight: { type: "string", description: "The durable insight, 1-3 lines, imperative." },
        file: { type: "string", description: "A file it relates to; decides the directory." },
        directory: { type: "string", description: "Or a directory." },
      },
      required: ["insight"],
    },
    execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const key = sessionKeyOf(undefined, ctx);
      const log = writeLog(key);

      if (!isWriteEnabled()) {
        return failure(
          "learn_append is disabled. Writing to AGENTS.md changes every future session's system prompt, so it must be enabled explicitly (plugin setting learnAppend). learn_scope still works and shows where the insight would go.",
          log,
        );
      }

      const root = workspaceRootOf(ctx);
      if (!root) return failure("no workspace root available in this session", log);

      const verdict = validateInsight(params?.insight);
      if (!verdict.ok) {
        log.rejected += 1;
        log.last = { reason: verdict.reason };
        return failure(verdict.reason, log);
      }

      const scope = recommendScope({
        workspaceRoot: root,
        file: typeof params?.file === "string" ? params.file : undefined,
        directory: typeof params?.directory === "string" ? params.directory : undefined,
      });
      if (!scope.ok) {
        log.rejected += 1;
        log.last = { reason: scope.reason };
        return failure(scope.reason, log);
      }

      const target = resolveInstructionFile(scope.directory);

      let existing = "";
      try {
        if (existsSync(target.path)) existing = readFileSync(target.path, "utf8");
      } catch (error) {
        log.rejected += 1;
        log.last = { reason: "read failed" };
        return failure(`cannot read ${displayPath(target.path, root)}: ${error instanceof Error ? error.message : String(error)}`, log);
      }

      const merged = mergeInsight(existing, verdict.insight);
      if (!merged.ok) {
        log.rejected += 1;
        log.last = { reason: merged.reason };
        return failure(merged.reason, log);
      }

      if (merged.duplicate) {
        log.duplicates += 1;
        log.last = { file: displayPath(target.path, root), reason: "duplicate" };
        const summary = summarizeFile(existing);
        return {
          content: [
            {
              type: "text",
              text: `Already present in ${displayPath(target.path, root)}; nothing written. That file is ${summary.bytes} bytes (${summary.budgetPercent}% of the 32 KiB budget).`,
            },
          ],
          details: { ok: true, duplicate: true, target: displayPath(target.path, root), log: { ...log } },
        };
      }

      try {
        mkdirSync(dirname(target.path), { recursive: true });
      } catch (error) {
        log.rejected += 1;
        log.last = { reason: "mkdir failed" };
        return failure(`cannot create ${displayPath(target.path, root)}: ${error instanceof Error ? error.message : String(error)}`, log);
      }

      // realpath 防线在 mkdir 之后、写盘之前：此时目录已存在，realpath 可解析。
      const realCheck = verifyRealScope(root, target.path);
      if (!realCheck.ok) {
        log.rejected += 1;
        log.last = { reason: realCheck.reason };
        return failure(realCheck.reason, log);
      }

      try {
        writeFileSync(target.path, merged.content, "utf8");
      } catch (error) {
        log.rejected += 1;
        log.last = { reason: "write failed" };
        return failure(`cannot write ${displayPath(target.path, root)}: ${error instanceof Error ? error.message : String(error)}`, log);
      }

      log.appended += 1;
      log.last = { file: displayPath(target.path, root), reason: "appended" };

      const summary = summarizeFile(merged.content);
      const shown = displayPath(target.path, root);
      return {
        content: [
          {
            type: "text",
            text: [
              `Appended to ${shown}.`,
              `That file is now ${summary.bytes} bytes (${summary.budgetPercent}% of the 32 KiB budget), ${summary.learnedItems} learned item(s).`,
              "The change takes effect on the next tool call that touches this directory — the host rebuilds the instruction chain per path.",
            ].join("\n"),
          },
        ],
        details: { ok: true, added: true, target: shown, summary, log: { ...log } },
      };
    },
  });

  /** 会话结束清理计数。 */
  pi.on("session_shutdown", (event, ctx) => {
    writes.delete(sessionKeyOf(event, ctx));
    return undefined;
  });
}

/** 统一的失败返回：既给模型看，也给 details 结构化数据。 */
function failure(reason, log) {
  return {
    content: [{ type: "text", text: `learn: ${reason}` }],
    details: { ok: false, reason, log: log ? { ...log } : null },
  };
}

/* 便于测试直接引用。 */
export { displayPath, isWriteEnabled, resolveInstructionFile, sessionKeyOf, workspaceRootOf, writeLog };
