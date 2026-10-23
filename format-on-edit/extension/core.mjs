/**
 * Format on Edit —— 编辑后自动格式化的纯逻辑层。
 *
 * 这个插件最大的风险不是「格式化跑不起来」，而是**格式化改写了文件内容，
 * 让模型手里的 Edit tag 失效**，下一次 Edit 就会 EDIT_PARSE_FAILED 或改错行。
 *
 * 所以本模块的核心是两件事：
 *   1. `tagOf()` —— 精确复现宿主的 4-hex tag，格式化后算出新 tag 回传给模型；
 *   2. `planFormat()` —— 一堆前置闸门，任何一条不满足都**不改**（fail-closed）。
 *
 * tag 算法（逐字来自 crates/host-core/src/tools/hashline/tag.rs:93-123）：
 *   hash_input = 每一行去掉尾随 [空格|tab|CR]，再用 LF join（保留尾部空片段）
 *   tag        = uppercase_hex_4(low_16_bits(SHA-256(hash_input)))
 * 文件层面还有两条：BOM 剥离后才算 tag；CRLF 先归一成 LF 才参与哈希。
 *
 * 这一层不碰 ExtensionAPI、不起进程、不读写文件（读取由入口层传进来），
 * 因此可以独立单测 —— 包括与 Rust 侧断言对齐的 tag 用例。
 */

import { createHash } from "node:crypto";

/** UTF-8 BOM，宿主在算 tag 前会剥掉。 */
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** 单文件体积上限：超过就不格式化，避免拖垮 30 秒事件窗口。 */
const MAX_FORMAT_BYTES = 2 * 1024 * 1024;

/**
 * 内置 formatter 表。
 *
 * 只收「命令可用即用、不需要项目配置文件」的。需要项目配置才能正确工作的
 * （clang-format 要 .clang-format、ocamlformat 要 .ocamlformat、pint 要 composer.json）
 * 一律不收 —— 没有配置就跑，可能把用户的代码风格改坏。
 */
const FORMATTERS = [
  {
    id: "prettier",
    extensions: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".json", ".jsonc", ".css", ".scss", ".less", ".md", ".mdx", ".yaml", ".yml", ".html"],
    command: "prettier",
    args: ["--write"],
    /// 需要项目里有 prettier 依赖或配置文件，否则可能是全局版乱跑。
    requiresProjectDependency: "prettier",
  },
  {
    id: "biome",
    extensions: [".js", ".jsx", ".ts", ".tsx", ".json", ".jsonc", ".css", ".md"],
    command: "biome",
    args: ["format", "--write"],
    requiresProjectConfig: "biome.json",
  },
  {
    id: "ruff",
    extensions: [".py", ".pyi"],
    command: "ruff",
    args: ["format"],
    requiresProjectDependency: "ruff",
  },
  {
    id: "gofmt",
    extensions: [".go"],
    command: "gofmt",
    args: ["-w"],
    /// gofmt 无需项目依赖，是 Go 工具链自带。
    requiresProjectDependency: null,
  },
  {
    id: "rustfmt",
    extensions: [".rs"],
    command: "rustfmt",
    args: ["--edition", "2021"],
    requiresProjectDependency: null,
  },
  {
    id: "shfmt",
    extensions: [".sh", ".bash"],
    command: "shfmt",
    args: ["-w"],
    requiresProjectDependency: null,
  },
];

/** 永远不格式化的路径特征：生成物与依赖目录。 */
const SKIP_PATH_PATTERN = /(^|[\\/])(node_modules|dist|build|out|target|\.git|vendor|coverage)([\\/]|$)/i;

/** 格式化超时：远小于宿主 30 秒的事件放弃窗口。 */
const FORMAT_TIMEOUT_MS = 8000;

/**
 * 计算宿主的 4-hex tag。
 *
 * @param {string|Buffer} input 文件内容（Buffer 会先剥 BOM、CRLF 归一）
 * @returns {string} 形如 "A1B2"
 */
function tagOf(input) {
  let text;
  if (Buffer.isBuffer(input)) {
    const raw = input.subarray(0, UTF8_BOM.length).equals(UTF8_BOM) ? input.subarray(UTF8_BOM.length) : input;
    text = raw.toString("utf8");
  } else {
    text = typeof input === "string" ? input : "";
  }
  // CRLF / 孤立 CR 一律归一成 LF，BOM 在字符串里也再剥一次。
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lf = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const hashInput = lf === ""
    ? ""
    : lf.split("\n").map((line) => line.replace(/[ \t\r]+$/u, "")).join("\n");

  const digest = createHash("sha256").update(hashInput, "utf8").digest();
  // low_16_bits = 最后两个字节按大端读成 u16
  return digest.readUInt16BE(30).toString(16).toUpperCase().padStart(4, "0");
}

/** 按扩展名找 formatter；没有就返回 null。 */
function formatterFor(filePath) {
  const lower = String(filePath ?? "").toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = lower.slice(dot);
  return FORMATTERS.find((entry) => entry.extensions.includes(ext)) ?? null;
}

/** 路径是否在被忽略的目录里（生成物、依赖、VCS）。 */
function isSkippedPath(filePath) {
  return SKIP_PATH_PATTERN.test(String(filePath ?? ""));
}

/**
 * 决定「这次编辑之后该不该格式化」。
 *
 * **fail-closed**：任何一条不满足都返回 `{ format: false, reason }`，绝不猜。
 * 这不是保守 —— 格式化是改写用户文件的操作，宁可少做。
 *
 * @param {object} input
 * @param {string} input.toolName 触发的工具名
 * @param {object} input.args 工具入参
 * @param {boolean} [input.isError] 该工具调用是否失败
 * @param {(path: string) => boolean} [input.exists] 判断项目依赖/配置是否存在
 * @returns {{format: boolean, reason: string, formatter?: object, filePath?: string}}
 */
function planFormat(input) {
  const { toolName, args, isError, exists } = input ?? {};

  // 工具调用失败时文件可能只写了一半，绝不格式化。
  if (isError) return { format: false, reason: "tool call failed" };

  // 只处理写文件的两个工具。Edit 是精确替换，Write 是整文件写。
  if (toolName !== "Edit" && toolName !== "Write") {
    return { format: false, reason: `tool ${String(toolName)} does not write files` };
  }

  // 宿主 Edit/Write 的规范入参名是 `path`（crates/host-core/src/tools/mod.rs:2773/2789）。
  // runtime.ts:1215 的 normalizeToolParams 会在 tool_result 事件发出前删除 `file_path`
  // 别名，所以这里以 `path` 为准；`file_path` 只作为极端兜底保留。
  const filePath =
    typeof args?.path === "string" && args.path
      ? args.path
      : typeof args?.file_path === "string"
        ? args.file_path
        : "";
  if (!filePath) return { format: false, reason: "no path in arguments" };

  if (isSkippedPath(filePath)) {
    return { format: false, reason: "path is in a generated or dependency directory", filePath };
  }

  const formatter = formatterFor(filePath);
  if (!formatter) {
    return { format: false, reason: "no formatter for this extension", filePath };
  }

  // 需要项目依赖/配置的，确认它真的在，否则可能是全局版的同名命令在乱跑。
  const needs = formatter.requiresProjectDependency ?? formatter.requiresProjectConfig ?? null;
  if (needs) {
    if (typeof exists !== "function") {
      return { format: false, reason: `needs ${needs} in the project but existence could not be checked`, filePath, formatter };
    }
    let present = false;
    try {
      present = exists(needs) === true;
    } catch {
      present = false;
    }
    if (!present) {
      return { format: false, reason: `project does not declare ${needs}`, filePath, formatter };
    }
  }

  return { format: true, reason: "ok", formatter, filePath };
}

/** 只保留有意义的扩展名清单，给报告用。 */
function supportedExtensions() {
  const set = new Set();
  for (const formatter of FORMATTERS) {
    for (const ext of formatter.extensions) set.add(ext);
  }
  return [...set].sort();
}

/**
 * 把「格式化结果」并入工具结果，让模型知道 tag 变了。
 *
 * 这是整个插件存在的理由：不告诉模型新 tag，下一次 Edit 必挂。
 *
 * @param {object} input
 * @param {string} input.filePath
 * @param {string} input.oldTag 格式化前算出的 tag
 * @param {string} input.newTag 格式化后算出的 tag
 * @param {number} [input.changedLines] 格式化导致的变更行数（-1 表示未知）
 * @param {string} [input.formatterId]
 * @returns {string} 追加到工具结果后面的说明
 */
function formatNotice(input) {
  const { filePath, oldTag, newTag, changedLines, formatterId } = input ?? {};
  const lines = [
    "",
    "---",
    `[format-on-edit] ${formatterId ?? "formatter"} reformatted ${filePath}.`,
  ];

  if (oldTag && newTag && oldTag !== newTag) {
    lines.push(`The file tag changed from ${oldTag} to ${newTag}.`);
  } else if (newTag) {
    lines.push(`Current file tag: ${newTag}.`);
  }

  if (typeof changedLines === "number" && Number.isFinite(changedLines)) {
    // 负数同样要报：格式化把多行合并成一行时行数是减少的。
    const sign = changedLines > 0 ? "+" : "";
    lines.push(`Line count changed by ${sign}${changedLines}.`);
  }

  lines.push(
    `Use \`${newTag ?? "<unknown>"}\` as the tag in your next Edit for this path, re-read the file if you need exact line numbers.`,
  );
  return lines.join("\n");
}

export {
  FORMATTERS,
  FORMAT_TIMEOUT_MS,
  MAX_FORMAT_BYTES,
  SKIP_PATH_PATTERN,
  formatNotice,
  formatterFor,
  isSkippedPath,
  planFormat,
  supportedExtensions,
  tagOf,
};
