/**
 * Learn —— 会话洞见回写「就近那一层 AGENTS.md」的纯逻辑层。
 *
 * 背景：PI-Desktop 已经原生实现了「读文件时带出该子树 AGENTS.md」——
 * `runtime.ts:5127 loadPathInstructions()` 在 Read/Write/Edit/BrowserPreview
 * 执行前，按 `params.path` 重建指令链并重算系统提示
 * （`PATH_SCOPED_INSTRUCTION_TOOLS` = Read/Write/Edit/BrowserPreview，
 *  见 runtime.ts:578）。所以**注入半场宿主已经有了，本插件不重复造**。
 *
 * 宿主没有的是**回写半场**：把会话里学到的洞见按作用域写回对应层级的
 * AGENTS.md。opencode 的 `.opencode/command/learn.md` 就是干这个的，
 * 但它只是提示词，没有任何校验。本模块补的是校验与安全：
 *
 *   1. 作用域推荐：这条洞见该写进哪一层的 AGENTS.md；
 *   2. 格式校验：拒绝显然不该写进去的东西（过长的、带会话细节的、重复的）；
 *   3. 写入内核：read → merge → write，全程不越出 workspace。
 *
 * 这一层不碰 ExtensionAPI，文件访问由入口层以「注入 IO」的方式提供，
 * 因此可以在 Node 里用内存文件系统完整单测。
 */

/** 宿主认可的指令文件名，优先级从高到低（见 project-instructions.ts:5-10）。 */
/** 宿主认可的指令文件名，优先级从高到低（与 project-instructions.ts 的 INSTRUCTION_FILE_NAMES 一致）。 */
const INSTRUCTION_NAMES = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md"];

/** 单条洞见的长度上限：opencode 的约定是 1-3 行，这里按字符给硬上限。 */
const MAX_INSIGHT_CHARS = 600;

/** 单个 AGENTS.md 的体积上限，与宿主的 MAX_INSTRUCTION_BYTES 对齐。 */
const MAX_FILE_BYTES = 32 * 1024;

/** 判断「像会话细节」而非「像工程洞见」的特征。 */
const SESSION_DETAIL_PATTERNS = [
  /\b(session|coversation|conversation)\s+(id|#)?\s*[0-9a-f]{8,}/i,
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, // ISO 时间戳
  /\b(user|我)\s+(asked|said|asked me|让我|要求我)\b/i,
  /^\s*(okay|ok|sure|好|好的|明白了)[\s,，]/i,
];

/** 判断「像显然事实」的特征：这些不该占用工程约定文件。 */
const OBVIOUS_PATTERNS = [
  /\b(python|javascript|typescript|rust|go)\s+is\s+an?\s+(language|programming)/i,
  /^\s*(use|使用)\s+(git|npm|node)\s*$/i,
];

/**
 * 把 Windows/POSIX 路径统一成 `/` 分隔，并消解 `.` 与 `..`。
 *
 * **安全性所在**：只做分隔符归一是不够的 —— `/w/../outside` 会以 `/w/`
 * 为前缀通过 isWithin 检查，等于允许写到工作区外。所以这里必须做段级消解。
 * 消解后仍保留越界痕迹（`..` 无法消掉时保留在路径里），交给 isWithin 拒绝。
 *
 * 不改大小写 —— caller 需要自己决定大小写敏感性。
 */
function normalizePath(input) {
  const raw = String(input ?? "").replace(/\\/g, "/");
  if (!raw) return "";

  const drive = /^[A-Za-z]:/.exec(raw);
  const prefix = drive ? drive[0] : raw.startsWith("/") ? "/" : "";
  const rest = drive ? raw.slice(drive[0].length) : raw;

  const out = [];
  for (const segment of rest.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
      continue;
    }
    out.push(segment);
  }

  const joined = out.join("/");
  if (!prefix) return joined;
  if (prefix === "/") return joined ? "/" + joined : "/";
  return joined ? prefix + "/" + joined : prefix;
}

/**
 * 路径是否在根目录之内（含根本身）。用分段比较，避免 `/a/bc` 被 `/a/b` 误判为子路径。
 */
function isWithin(root, candidate) {
  const r = normalizePath(root);
  const c = normalizePath(candidate);
  if (!r) return false;
  if (r === c) return true;
  return c.startsWith(`${r}/`);
}

/**
 * 推荐这条洞见该写进哪一层 AGENTS.md。
 *
 * 规则（对齐 opencode learn 的作用域约定）：
 *   - 给了 `file` → 写在该文件所在目录（最贴近代码）；
 *   - 给了 `directory` → 写在该目录；
 *   - 都没给 → 写在 workspace 根。
 *
 * 无论哪种，结果都必须落在 workspace 内；越界返回 `{ok:false}`，绝不"就近写到外面去"。
 *
 * @param {{workspaceRoot: string, file?: string, directory?: string}} input
 */
function recommendScope(input) {
  const root = normalizePath(input?.workspaceRoot);
  if (!root) return { ok: false, reason: "workspace root is required" };
  const raw = input?.directory ?? (input?.file ? dirOf(input.file) : "");
  // 宿主系统提示一贯引导模型用 workspace-relative 路径，learn_scope 的参数
  // 说明也写了 "(absolute or workspace-relative)" —— 相对路径必须先与 root
  // 拼接再判越界，否则按说明传参必然得到误导性的「outside the workspace」。
  const isAbsolute =
    typeof raw === "string" && raw !== "" && (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith("/"));
  const target = raw ? normalizePath(isAbsolute ? raw : `${root}/${raw}`) : root;

  if (!isWithin(root, target)) {
    return { ok: false, reason: `scope ${target} is outside the workspace ${root}` };
  }

  return {
    ok: true,
    /// 建议写入的目录（相对 workspace 的形式便于阅读，绝对形式便于写入）
    directory: target,
    relative: target === root ? "." : normalizePath(target).slice(root.length + 1),
    /// 具体文件名：优先沿用已有文件，否则用 AGENTS.md
    fileName: "AGENTS.md",
  };
}

/**
 * 取目录部分。
 *   "E:/proj/a.ts"      -> "E:/proj"
 *   "E:/a.ts"           -> "E:"       （盘符也是合法父目录）
 *   "src/a.ts"          -> "src"
 *   "a.ts"              -> ""         （无父目录信息，caller 用 root 兜底）
 */
function dirOf(filePath) {
  const normalized = normalizePath(filePath);
  const slash = normalized.lastIndexOf("/");
  return slash > 0 ? normalized.slice(0, slash) : "";
}

/**
 * 校验一条洞见是否值得写进 AGENTS.md。
 *
 * 这些规则不是「品味」，是防止 AGENTS.md 变成垃圾场的硬闸：
 * 它会进入每次会话的系统提示，写坏一条就长期消耗上下文。
 *
 * @returns {{ok: boolean, reason?: string, insight?: string}}
 */
function validateInsight(raw) {
  const insight = String(raw ?? "").trim();

  if (!insight) return { ok: false, reason: "insight is empty" };
  if (insight.length > MAX_INSIGHT_CHARS) {
    return { ok: false, reason: `insight is ${insight.length} chars, over the ${MAX_INSIGHT_CHARS} limit; keep it to 1-3 lines` };
  }

  for (const pattern of SESSION_DETAIL_PATTERNS) {
    if (pattern.test(insight)) {
      return { ok: false, reason: "insight looks like session-specific detail (ids, timestamps, who asked what); AGENTS.md is for durable project knowledge" };
    }
  }

  for (const pattern of OBVIOUS_PATTERNS) {
    if (pattern.test(insight)) {
      return { ok: false, reason: "insight states an obvious fact or standard framework behavior; it does not belong in project instructions" };
    }
  }

  // 至少要是完整的一句，避免「TODO」「fix this」这类占位。
  if (insight.length < 12) {
    return { ok: false, reason: "insight is too short to be actionable" };
  }
  if (!/[a-zA-Z\u4e00-\u9fff]/.test(insight)) {
    return { ok: false, reason: "insight has no words" };
  }

  // 统一成单行里保留换行：允许多行，但压掉多余空行。
  const normalized = insight
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line, index, all) => !(line === "" && (index === 0 || index === all.length - 1)))
    .join("\n");

  return { ok: true, insight: normalized };
}

/**
 * 把一条洞见并入 AGENTS.md 内容。
 *
 * 行为：
 *   - 文件为空 → 写一个 `## Learned` 段 + 这一条；
 *   - 已有 `## Learned` 段 → 追加到该段末尾；段不存在 → 文件末尾新建；
 *   - **完全重复**（逐行相同，或规范化空白后整条相同）→ 不写，返回 `duplicate: true`；
 *   - 结果超过体积上限 → 拒绝，不做静默截断（截断会丢别人的内容）。
 *
 * @returns {{ok: boolean, content?: string, duplicate?: boolean, reason?: string, added: boolean}}
 */
function mergeInsight(existingContent, insight) {
  const text = typeof existingContent === "string" ? existingContent : "";
  const bare = String(insight ?? "").trim();

  // bullet：多行洞见的续行缩进 2 空格，保持 Markdown 列表项不被拆断。
  const bullet = `- ${bare.split("\n").join("\n  ")}`;

  // 重复检测，两层：
  //   1. 逐行比对（单行洞见的精确路径）；
  //   2. 整条规范化（collapse 全部空白）后做 includes —— bare 含 \n 时
  //      永远匹配不到任何单行元素，没有这一层多行洞见每次都能再写一遍。
  // 规范化粒度放宽到「已有文本完全覆盖这条」就不写：宁可不重复，也不错写。
  const collapse = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const existingLines = text.split(/\r?\n/).map((line) => line.trim().replace(/^-\s*/, ""));
  if (existingLines.includes(bare) || collapse(existingLines.join(" ")).includes(collapse(bare))) {
    return { ok: true, duplicate: true, added: false, content: text };
  }

  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text === "" ? [] : text.split(/\r?\n/);

  // 找 `## Learned` 段（大小写不敏感），把新条目插在该段最后一个非空行之后。
  const headingIndex = lines.findIndex((line) => /^##\s+learned\s*$/i.test(line.trim()));

  let next;
  if (headingIndex === -1) {
    // 没有该段：文件末尾新建，前面留一个空行。
    next = [...lines];
    if (next.length > 0 && next[next.length - 1].trim() !== "") next.push("");
    next.push("## Learned", "", bullet);
  } else {
    // 找到该段结束位置：下一个 `## ` 标题，或文件末尾。
    let end = lines.length;
    for (let i = headingIndex + 1; i < lines.length; i += 1) {
      if (/^##\s+\S/.test(lines[i].trim())) {
        end = i;
        break;
      }
    }

    // 段内最后一个非空行的位置。
    let insertAt = headingIndex + 1;
    for (let i = headingIndex + 1; i < end; i += 1) {
      if (lines[i].trim() !== "") insertAt = i + 1;
    }

    next = [...lines];
    // 段里只有标题时，插入前补一个空行，保持 Markdown 可读。
    if (insertAt === headingIndex + 1) {
      next.splice(insertAt, 0, "", bullet);
    } else {
      next.splice(insertAt, 0, bullet);
    }
  }

  const content = next.join(newline);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_FILE_BYTES) {
    return {
      ok: false,
      added: false,
      reason: `result would be ${bytes} bytes, over the ${MAX_FILE_BYTES} byte limit; AGENTS.md is injected into every session, so it must stay small`,
    };
  }

  return { ok: true, added: true, duplicate: false, content };
}

/**
 * 统计一个 AGENTS.md 的「预算占用」，给状态工具与用户判断用。
 */
function summarizeFile(content) {
  const text = typeof content === "string" ? content : "";
  const bytes = Buffer.byteLength(text, "utf8");
  const lines = text === "" ? 0 : text.split(/\r?\n/).length;
  const learnedIndex = text.split(/\r?\n/).findIndex((line) => /^##\s+learned\s*$/i.test(line.trim()));
  const learnedItems = learnedIndex === -1
    ? 0
    : text.split(/\r?\n/).slice(learnedIndex + 1).filter((line) => /^-\s+/.test(line.trim())).length;
  return {
    bytes,
    lines,
    learnedItems,
    /// 0-100，占宿主 32 KiB 上限的比例
    budgetPercent: Math.round((bytes / MAX_FILE_BYTES) * 1000) / 10,
  };
}

export {
  INSTRUCTION_NAMES,
  MAX_FILE_BYTES,
  MAX_INSIGHT_CHARS,
  isWithin,
  mergeInsight,
  normalizePath,
  recommendScope,
  summarizeFile,
  validateInsight,
};
