"use strict";

/**
 * host-read.js —— 只读读取 PI-Desktop 宿主自己的本地记录。
 *
 * 本模块是**纯 Node**（CommonJS），不依赖宿主注入的全局 `pi`，因此可以脱离
 * 插件进程单独 require 测试。
 *
 * 两个数据来源：
 *   1. 会话转录本 `<hostRoot>\sessions\<sessionId>.jsonl`
 *      —— 能精确到「每一次助手回复」：用量 + responseDurationMs。
 *   2. 宿主 SQLite `<hostRoot>\pi.sqlite` 的 `turns` 表
 *      —— 只取 completed 回合，用于兜底补足转录本里没有的用量（子智能体等）。
 *
 * 设计约定（与宿主渲染层保持一致）：
 *   - 速度口径 = Math.round(outputTokens / (durationMs / 1000))，与宿主内置
 *     「生成速度」完全同公式（含首字延迟，不是纯解码速度）。
 *   - outputTokens 缺失/为 0 时退化为按可见字符数估算：
 *     Math.max(1, Math.ceil(Array.from(thinking + text).length / 4))，UI 用 ≈ 标注。
 *
 * 全程只读：不写任何文件、不联网、不输出完整路径。
 */

const {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} = require("node:fs");
const { homedir } = require("node:os");
const path = require("node:path");

const SESSION_DIR_NAME = "sessions";
const SESSION_SUFFIX = ".jsonl";
const HOST_DB_NAME = "pi.sqlite";
/** 导入文件会重复计数，必须排除；`*.revisions.jsonl` 是编辑历史，同理。 */
const EXCLUDED_PREFIXES = ["import-codex-", "import-claude-code-"];
/** 转录本缺失 responseDurationMs 时，用 Date.now()-createdAt 退化的新鲜度上限。 */
const FRESH_FALLBACK_MS = 5 * 60 * 1000;
/** 用「下一条回复的间隔」估算用时时的上限，超过就认为无法推断。 */
const MAX_GAP_MS = 10 * 60 * 1000;
/** 默认的增量读取块大小：只读文件尾部，避免反复读 2MB+ 的大文件。 */
const DEFAULT_TAIL_BYTES = 128 * 1024;
const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"];

/* ------------------------------------------------------------------ 小工具 */

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

/** 依次尝试多个字段名（兼容 snake_case 变体），null/undefined 视为缺失。 */
function pick(object, names) {
  if (!object || typeof object !== "object") return undefined;
  for (const name of names) {
    const value = object[name];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** `<data>/plugins/data/<pluginId>` → `<data>`；目录布局由宿主拥有。 */
function hostRootFromDataPath(dataPath) {
  return path.resolve(String(dataPath || ""), "..", "..", "..");
}

/**
 * 定位宿主根目录。
 * 优先用显式 dataPath（插件进程里来自 pi.plugin.getDataPath()），
 * 否则退回环境变量 / `~/.pi-desktop`，这样脱离插件进程也能跑。
 */
function resolveHostRoot(dataPath) {
  if (dataPath) return hostRootFromDataPath(dataPath);
  const fromEnv = process.env.PI_DESKTOP_DATA_DIR;
  if (fromEnv && String(fromEnv).trim()) return path.resolve(String(fromEnv).trim());
  return path.join(homedir(), ".pi-desktop");
}

/** 转录本文件过滤：排除 revisions 与 import-* 导入文件。 */
function isTranscriptFile(file) {
  const name = path.basename(String(file || ""));
  if (!name.endsWith(SESSION_SUFFIX)) return false;
  if (name.endsWith(`.revisions${SESSION_SUFFIX}`)) return false;
  return !EXCLUDED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** 会话文件清单，按 mtime 倒序；第一个即「当前活跃会话」的稳健近似。 */
function readSessionIndex(hostRoot) {
  const dir = path.join(String(hostRoot || ""), SESSION_DIR_NAME);
  const result = { ok: false, dir, sessions: [], active: null, error: null };
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    result.error = "NO_SESSION_DIR";
    return result;
  }
  const sessions = [];
  for (const name of names) {
    if (!isTranscriptFile(name)) continue;
    const file = path.join(dir, name);
    try {
      const stat = statSync(file);
      if (!stat.isFile()) continue;
      sessions.push({
        file,
        name,
        sessionId: name.slice(0, -SESSION_SUFFIX.length),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    } catch {
      /* 单个文件读不到就跳过，不影响整体 */
    }
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs || b.size - a.size);
  result.ok = true;
  result.sessions = sessions;
  result.active = sessions[0] || null;
  return result;
}

/* --------------------------------------------------------------- 用量与速度 */

/** 与宿主渲染层完全同公式：round(output / (durationMs / 1000))。 */
function tokensPerSecond(outputTokens, durationMs) {
  if (!Number.isFinite(outputTokens) || outputTokens <= 0) return undefined;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return undefined;
  return Math.round(outputTokens / (durationMs / 1000));
}

/** 宿主退化口径：thinking + text 的可见字符数 / 4，先 trim。 */
function estimateOutputTokensFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return undefined;
  let text = "";
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type !== "thinking" && block.type !== "text") continue;
    if (typeof block.text === "string") text += block.text;
  }
  text = text.trim();
  if (!text) return undefined;
  return Math.max(1, Math.ceil(Array.from(text).length / 4));
}

/** 归一化 usage：字段可能为 null，也可能是 snake_case 变体。 */
function normalizeUsage(usage) {
  const input = toNumber(pick(usage, ["inputTokens", "input_tokens", "input"]));
  const output = toNumber(pick(usage, ["outputTokens", "output_tokens", "output"]));
  const cacheRead = toNumber(pick(usage, ["cacheReadTokens", "cache_read_input_tokens", "cache_read_tokens", "cacheRead"]));
  const cacheWrite = toNumber(pick(usage, ["cacheWriteTokens", "cache_creation_input_tokens", "cache_write_tokens", "cacheWrite"]));
  const reasoning = toNumber(pick(usage, ["reasoningTokens", "reasoning_output_tokens", "reasoning_tokens", "reasoning"]));
  const reportedTotal = toNumber(pick(usage, ["totalTokens", "total_tokens", "total"]));
  const sum = input + output + cacheRead + cacheWrite + reasoning;
  // 宿主写入的 totalTokens 有时不含 reasoning，所以「有上报值就用上报值」。
  return { input, output, cacheRead, cacheWrite, reasoning, total: reportedTotal || sum };
}

function emptyTokenBag() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
}

function addTokenBags(left, right) {
  const out = emptyTokenBag();
  for (const field of TOKEN_FIELDS) out[field] = (left?.[field] || 0) + (right?.[field] || 0);
  out.total = (left?.total || 0) + (right?.total || 0);
  return out;
}

/**
 * 解析一条助手回复记录。
 *
 * 只接受 `type === "message" && role === "assistant"` 且带 `meta.usage` 的记录。
 * 子智能体回复（带 `meta.agentName` / `meta.parentToolCallId`）照样计入，
 * 只是额外标注 agentName。
 *
 * 用时来源（durationSource）：
 *   reported        meta.responseDurationMs —— 权威值，与宿主内置读数一致
 *   since-created   Date.now() - createdAt，仅在记录足够新鲜（≤5 分钟）时使用，
 *                   即宿主自己的退化口径；对陈旧历史记录这样算会得到荒唐的
 *                   巨大用时，所以加了新鲜度上限，交给 applyGapFallback 处理
 *   next-record-gap 与下一条助手回复的间隔（见 applyGapFallback）
 */
function parseAssistantRecord(record, options = {}) {
  if (!record || typeof record !== "object") return null;
  if (record.type !== "message" || record.role !== "assistant") return null;
  const meta = record.meta;
  const usage = meta && typeof meta.usage === "object" && meta.usage ? meta.usage : null;
  if (!usage) return null;

  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : null;
  const createdMs = createdAt ? Date.parse(createdAt) : NaN;
  const tokens = normalizeUsage(usage);

  const reported = Number(meta.responseDurationMs);
  let durationMs = null;
  let durationSource = null;
  if (Number.isFinite(reported) && reported > 0) {
    durationMs = reported;
    durationSource = "reported";
  } else if (Number.isFinite(createdMs)) {
    const elapsed = now - createdMs;
    if (elapsed > 0 && elapsed <= FRESH_FALLBACK_MS) {
      durationMs = Math.max(1, elapsed);
      durationSource = "since-created";
    }
  }

  // 输出 token 缺失/为 0 时按可见字符数估算，UI 用 ≈ 区分。
  const estimatedOutput = tokens.output > 0 ? undefined : estimateOutputTokensFromBlocks(record.blocks);
  const outputEstimated = tokens.output <= 0 && Number.isFinite(estimatedOutput);
  const outputTokens = tokens.output > 0 ? tokens.output : estimatedOutput || 0;

  return {
    id: typeof record.id === "string" ? record.id : null,
    sessionId: options.sessionId ? String(options.sessionId) : null,
    createdAt,
    createdMs: Number.isFinite(createdMs) ? createdMs : null,
    modelId: typeof meta.modelId === "string" ? meta.modelId : null,
    providerId: typeof meta.providerId === "string" ? meta.providerId : null,
    agentName: typeof meta.agentName === "string" && meta.agentName.trim() ? meta.agentName.trim() : null,
    isSubagent: Boolean(meta.agentName || meta.parentToolCallId),
    status: typeof meta.status === "string" ? meta.status : null,
    durationMs,
    durationSource,
    outputTokens,
    outputEstimated,
    inputTokens: tokens.input,
    cacheReadTokens: tokens.cacheRead,
    cacheWriteTokens: tokens.cacheWrite,
    reasoningTokens: tokens.reasoning,
    totalTokens: tokens.total,
    tokensPerSecond: tokensPerSecond(outputTokens, durationMs) ?? null,
    tokensPerSecondEstimated: outputEstimated || (durationSource !== null && durationSource !== "reported"),
  };
}

function recomputeSpeed(entry) {
  entry.tokensPerSecond = tokensPerSecond(entry.outputTokens, entry.durationMs) ?? null;
  entry.tokensPerSecondEstimated = entry.outputEstimated || (entry.durationSource !== null && entry.durationSource !== "reported");
  return entry;
}

/**
 * 为缺少 responseDurationMs 的历史记录补一个「下一条回复间隔」的估算用时。
 * 这是插件读取历史时的合理退化：宿主自己用 Date.now()-createdAt，对历史记录
 * 会算出几分钟甚至几小时，速度直接变成 0。间隔估算至少量级正确，并且一律
 * 标记为估算（UI 用 ≈）。
 */
function applyGapFallback(entries) {
  const list = Array.isArray(entries) ? entries : [];
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index];
    if (!entry || entry.durationMs !== null) continue;
    const next = list[index + 1];
    const nextMs = next && Number.isFinite(next.createdMs) ? next.createdMs : null;
    if (Number.isFinite(entry.createdMs) && nextMs !== null) {
      const gap = nextMs - entry.createdMs;
      if (gap > 0 && gap <= MAX_GAP_MS) {
        entry.durationMs = gap;
        entry.durationSource = "next-record-gap";
        recomputeSpeed(entry);
      }
    }
  }
  return list;
}

/* ------------------------------------------------------------- 转录本读取 */

/** 解析一段文本里的助手回复记录（一行一个 JSON，坏行直接跳过并计数）。 */
function collectAssistantEntries(text, options = {}) {
  const raws = [];
  let malformedLines = 0;
  let records = 0;
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    records += 1;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    if (!parsed || parsed.type !== "message" || parsed.role !== "assistant") continue;
    if (!parsed.meta || !parsed.meta.usage) continue;
    raws.push(parsed);
  }
  const entries = [];
  for (const raw of raws) {
    const entry = parseAssistantRecord(raw, { sessionId: options.sessionId, now: options.now });
    if (entry) entries.push(entry);
  }
  return { entries, malformedLines, records };
}

/** 完整扫描一个会话转录本（插件启动时做一次）。 */
function scanSessionFile(file, options = {}) {
  const result = {
    ok: false,
    file,
    sessionId: path.basename(String(file || ""), SESSION_SUFFIX),
    entries: [],
    malformedLines: 0,
    records: 0,
    bytes: 0,
    mtimeMs: null,
    error: null,
  };
  let text;
  try {
    const stat = statSync(file);
    result.bytes = stat.size;
    result.mtimeMs = stat.mtimeMs;
    text = readFileSync(file, "utf8");
  } catch {
    result.error = "UNREADABLE_SESSION";
    return result;
  }
  const collected = collectAssistantEntries(text, { sessionId: result.sessionId, now: options.now });
  result.entries = applyGapFallback(collected.entries);
  result.malformedLines = collected.malformedLines;
  result.records = collected.records;
  result.ok = true;
  return result;
}

/**
 * 只读文件尾部（默认 128 KiB），从块内第一个换行之后开始解析。
 * 用于实时刷新，避免每次重读整个大文件。
 */
function readTailText(file, maxBytes = DEFAULT_TAIL_BYTES) {
  try {
    const stat = statSync(file);
    const start = Math.max(0, stat.size - Math.max(1, maxBytes));
    const fd = openSync(file, "r");
    try {
      const length = stat.size - start;
      const buffer = Buffer.allocUnsafe(length);
      const read = readSync(fd, buffer, 0, length, start);
      let text = buffer.subarray(0, read).toString("utf8");
      if (start > 0) {
        // 起点可能落在半行中间（甚至半个 UTF-8 字符），丢掉第一行即可。
        const newline = text.indexOf("\n");
        text = newline >= 0 ? text.slice(newline + 1) : "";
      }
      return { ok: true, text, size: stat.size, mtimeMs: stat.mtimeMs, truncated: start > 0, error: null };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { ok: false, text: "", size: 0, mtimeMs: null, truncated: false, error: "TAIL_READ_FAILED" };
  }
}

/** 尾部增量解析：返回这一块里解析出的助手回复（不做间隔兜底，交给调用方）。 */
function readTailEntries(file, options = {}) {
  const tail = readTailText(file, options.maxBytes ?? DEFAULT_TAIL_BYTES);
  if (!tail.ok) return { ...tail, entries: [], malformedLines: 0, records: 0 };
  const collected = collectAssistantEntries(tail.text, {
    sessionId: options.sessionId || path.basename(String(file || ""), SESSION_SUFFIX),
    now: options.now,
  });
  return { ...tail, entries: collected.entries, malformedLines: collected.malformedLines, records: collected.records };
}

/* --------------------------------------------------------------- 汇总统计 */

/** 会话累计 + 最近回复列表。 */
function summarizeEntries(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const limit = Number.isFinite(options.limit) ? Math.max(1, options.limit) : 20;
  const totals = emptyTokenBag();
  const models = [];
  let replies = 0;
  let estimatedReplies = 0;
  let subagentReplies = 0;
  let durationMs = 0;
  let speedSum = 0;
  let speedCount = 0;
  let peak = null;
  let firstAt = null;
  let lastAt = null;

  for (const entry of list) {
    if (!entry) continue;
    replies += 1;
    for (const field of TOKEN_FIELDS) totals[field] += entry[field === "input" ? "inputTokens" : field === "output" ? "outputTokens" : field === "cacheRead" ? "cacheReadTokens" : field === "cacheWrite" ? "cacheWriteTokens" : "reasoningTokens"] || 0;
    totals.total += entry.totalTokens || 0;
    if (entry.outputEstimated) estimatedReplies += 1;
    if (entry.isSubagent) subagentReplies += 1;
    if (Number.isFinite(entry.durationMs) && entry.durationMs > 0) durationMs += entry.durationMs;
    if (Number.isFinite(entry.tokensPerSecond)) {
      speedSum += entry.tokensPerSecond;
      speedCount += 1;
      peak = peak === null ? entry.tokensPerSecond : Math.max(peak, entry.tokensPerSecond);
    }
    if (entry.modelId && !models.includes(entry.modelId)) models.push(entry.modelId);
    if (Number.isFinite(entry.createdMs)) {
      if (firstAt === null || entry.createdMs < firstAt) firstAt = entry.createdMs;
      if (lastAt === null || entry.createdMs > lastAt) lastAt = entry.createdMs;
    }
  }

  // 缓存命中率与宿主同公式：cacheRead / (input + cacheRead)。
  const cacheBase = totals.input + totals.cacheRead;
  const cacheHitRate = cacheBase > 0 ? Math.round((totals.cacheRead / cacheBase) * 100) : null;

  return {
    replies,
    estimatedReplies,
    subagentReplies,
    totals,
    durationMs,
    avgTokensPerSecond: speedCount > 0 ? Math.round(speedSum / speedCount) : null,
    peakTokensPerSecond: peak,
    cacheHitRate,
    speedSamples: speedCount,
    models,
    firstAt,
    lastAt,
    recent: list.slice(-limit).reverse(),
  };
}

/* ---------------------------------------------------------- 宿主 SQLite 兜底 */

/** 只读打开宿主数据库；`node:sqlite` 在旧运行时不存在，失败是预期而非异常。 */
function openHostDb(dbFile) {
  let sqlite;
  try {
    sqlite = require("node:sqlite");
  } catch {
    return null;
  }
  if (!sqlite || typeof sqlite.DatabaseSync !== "function") return null;
  try {
    return new sqlite.DatabaseSync(dbFile, { readOnly: true });
  } catch {
    return null;
  }
}

function closeQuietly(db) {
  try {
    db?.close();
  } catch {
    /* 关闭失败的句柄不值得关心 */
  }
}

function localDayKey(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * 读取宿主 turns 表的 completed 回合。
 * 只选 token 列与 id/时间列，不读任何消息正文。
 */
function readCompletedTurnUsage(hostRoot) {
  const result = { ok: false, available: false, rows: [], error: null };
  const dbFile = path.join(String(hostRoot || ""), HOST_DB_NAME);
  if (!existsSync(dbFile)) {
    result.error = "NO_HOST_DB";
    return result;
  }
  const db = openHostDb(dbFile);
  if (!db) {
    result.error = "SQLITE_UNAVAILABLE";
    return result;
  }
  try {
    const rows = db
      .prepare(
        `SELECT id, session_id, status, provider_id, model_id, usage_json,
                input_tokens, output_tokens, started_at, ended_at
         FROM turns
         WHERE status = 'completed' AND ended_at IS NOT NULL`,
      )
      .all();
    result.available = true;
    for (const row of rows || []) {
      const startedAt = Number(row?.started_at);
      const endedAt = Number(row?.ended_at);
      const sessionId = String(row?.session_id || "").trim();
      if (!sessionId || !Number.isFinite(endedAt)) continue;
      const tokens = tokensFromTurnRow(row);
      if (!tokens.total) continue;
      const durationMs = Number.isFinite(startedAt) && endedAt > startedAt ? endedAt - startedAt : null;
      result.rows.push({
        id: String(row?.id || ""),
        sessionId,
        day: localDayKey(endedAt),
        modelId: String(row?.model_id || ""),
        providerId: String(row?.provider_id || ""),
        startedAt: Number.isFinite(startedAt) ? startedAt : null,
        endedAt,
        durationMs,
        tokens,
      });
    }
    result.ok = true;
    return result;
  } catch {
    result.error = "SQLITE_QUERY_FAILED";
    return result;
  } finally {
    closeQuietly(db);
  }
}

function tokensFromTurnRow(row) {
  let parsed = null;
  try {
    parsed = row?.usage_json ? JSON.parse(String(row.usage_json)) : null;
  } catch {
    parsed = null;
  }
  const object = parsed && typeof parsed === "object" ? parsed : {};
  const input = toNumber(pick(object, ["inputTokens", "input_tokens"]) ?? row?.input_tokens);
  const output = toNumber(pick(object, ["outputTokens", "output_tokens"]) ?? row?.output_tokens);
  const cacheRead = toNumber(pick(object, ["cacheReadTokens", "cache_read_input_tokens"]));
  const cacheWrite = toNumber(pick(object, ["cacheWriteTokens", "cache_creation_input_tokens"]));
  const reasoning = toNumber(pick(object, ["reasoningTokens", "reasoning_output_tokens"]));
  const total = toNumber(pick(object, ["totalTokens", "total_tokens"])) || input + output + cacheRead + cacheWrite + reasoning;
  return { input, output, cacheRead, cacheWrite, reasoning, total };
}

/**
 * 把 completed 回合折入转录本：同一「会话 + 本地日期」下取差额补足，绝不重复计数。
 * 官方 pi.token-insights 的 mergePiDesktopTurnRemainder 就是这个思路。
 */
function mergeTurnRemainder(entries, turnRows) {
  const jsonlByKey = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || !entry.sessionId || !Number.isFinite(entry.createdMs)) continue;
    const key = `${localDayKey(entry.createdMs)}|${entry.sessionId}`;
    const bag = {
      input: entry.inputTokens,
      output: entry.outputTokens,
      cacheRead: entry.cacheReadTokens,
      cacheWrite: entry.cacheWriteTokens,
      reasoning: entry.reasoningTokens,
      total: entry.totalTokens,
    };
    jsonlByKey.set(key, jsonlByKey.has(key) ? addTokenBags(jsonlByKey.get(key), bag) : bag);
  }

  const turnByKey = new Map();
  for (const row of Array.isArray(turnRows) ? turnRows : []) {
    if (!row || !row.sessionId || !row.day) continue;
    const key = `${row.day}|${row.sessionId}`;
    const existing = turnByKey.get(key);
    if (existing) {
      existing.tokens = addTokenBags(existing.tokens, row.tokens);
      existing.durationMs = (existing.durationMs || 0) + (row.durationMs || 0);
      existing.turns += 1;
      continue;
    }
    turnByKey.set(key, {
      sessionId: row.sessionId,
      day: row.day,
      modelId: row.modelId || null,
      tokens: { ...row.tokens },
      durationMs: row.durationMs || 0,
      turns: 1,
    });
  }

  const extras = [];
  for (const [key, turn] of turnByKey) {
    const jsonl = jsonlByKey.get(key);
    if (!jsonl) {
      extras.push({ ...turn, reason: "turn-only" });
      continue;
    }
    const remainder = emptyTokenBag();
    for (const field of TOKEN_FIELDS) remainder[field] = Math.max(0, (turn.tokens[field] || 0) - (jsonl[field] || 0));
    const totalGap = Math.max(0, (turn.tokens.total || 0) - (jsonl.total || 0));
    remainder.total = remainder.input + remainder.output + remainder.cacheRead + remainder.cacheWrite + remainder.reasoning;
    if (remainder.total === 0 && totalGap > 0) {
      // 字段全对不上但总量有差额：整体记到 input，避免凭空丢数。
      remainder.input = totalGap;
      remainder.total = totalGap;
    }
    if (!remainder.total) continue;
    extras.push({ ...turn, tokens: remainder, reason: "remainder" });
  }
  return { extras };
}

/* -------------------------------------------------------------- 快照组装 */

/**
 * 由「已经算好的 entries」组装视图要的紧凑快照。
 * 插件进程首扫与增量刷新都走这里，保证两种路径输出形状一致。
 * 注意：快照里不包含任何绝对路径，只保留会话 id 前 8 位。
 */
function buildSnapshotFromEntries(input = {}) {
  const entries = Array.isArray(input.entries) ? input.entries : [];
  const sessionId = String(input.sessionId || "");
  const summary = summarizeEntries(entries, { limit: input.limit ?? 20 });
  const turns = input.turns || null;
  let remainder = null;
  let source = "transcript";

  if (turns && turns.ok && turns.rows?.length) {
    const merged = mergeTurnRemainder(entries, turns.rows);
    const forSession = merged.extras.filter((extra) => extra.sessionId === sessionId);
    if (forSession.length) {
      const bag = emptyTokenBag();
      let durationMs = 0;
      for (const extra of forSession) {
        const added = addTokenBags(bag, extra.tokens);
        for (const field of TOKEN_FIELDS) bag[field] = added[field];
        bag.total = added.total;
        durationMs += extra.durationMs || 0;
      }
      remainder = { turns: forSession.length, tokens: bag, durationMs, details: forSession };
      const merged2 = addTokenBags(summary.totals, bag);
      for (const field of TOKEN_FIELDS) summary.totals[field] = merged2[field];
      summary.totals.total = merged2.total;
      summary.durationMs += durationMs;
      source = "transcript+sqlite";
    }
  }

  const latest = entries.length ? entries[entries.length - 1] : null;
  const lastModel = latest?.modelId || summary.models[summary.models.length - 1] || null;

  return {
    ok: Boolean(input.ok ?? true),
    generatedAt: Number.isFinite(input.now) ? input.now : Date.now(),
    source,
    readMode: input.readMode || "full",
    session: {
      id: sessionId,
      shortId: sessionId ? sessionId.slice(0, 8) : "",
      modelId: lastModel,
      models: summary.models,
      replies: summary.replies,
      estimatedReplies: summary.estimatedReplies,
      subagentReplies: summary.subagentReplies,
      totals: summary.totals,
      durationMs: summary.durationMs,
      avgTokensPerSecond: summary.avgTokensPerSecond,
      peakTokensPerSecond: summary.peakTokensPerSecond,
      cacheHitRate: summary.cacheHitRate,
      speedSamples: summary.speedSamples,
      firstAt: summary.firstAt,
      lastAt: summary.lastAt,
      fileMtimeMs: Number.isFinite(input.fileMtimeMs) ? input.fileMtimeMs : null,
      fileSize: Number.isFinite(input.fileSize) ? input.fileSize : null,
    },
    latest,
    recent: summary.recent,
    sqlite: turns
      ? {
          available: Boolean(turns.available),
          error: turns.error || null,
          completedTurns: turns.rows?.length || 0,
          remainder,
        }
      : { available: false, error: "NOT_READ", completedTurns: 0, remainder: null },
    diagnostics: {
      malformedLines: input.malformedLines || 0,
      records: input.records || 0,
      scannedBytes: input.scannedBytes || 0,
      sessionFiles: input.sessionFiles || 0,
    },
  };
}

/** 一次性完整读取（首扫、独立测试用）。 */
function buildSnapshot(hostRoot, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const index = readSessionIndex(hostRoot);
  if (!index.ok || !index.active) {
    return {
      ok: false,
      generatedAt: now,
      source: "transcript",
      reason: index.error || "NO_ACTIVE_SESSION",
      session: null,
      latest: null,
      recent: [],
      sqlite: { available: false, error: "NOT_READ", completedTurns: 0, remainder: null },
      diagnostics: { malformedLines: 0, records: 0, scannedBytes: 0, sessionFiles: 0 },
    };
  }
  const scan = scanSessionFile(index.active.file, { now });
  if (!scan.ok) {
    return {
      ok: false,
      generatedAt: now,
      source: "transcript",
      reason: scan.error,
      session: null,
      latest: null,
      recent: [],
      sqlite: { available: false, error: "NOT_READ", completedTurns: 0, remainder: null },
      diagnostics: { malformedLines: 0, records: 0, scannedBytes: 0, sessionFiles: index.sessions.length },
    };
  }
  const turns = options.withTurns === false ? null : readCompletedTurnUsage(hostRoot);
  return buildSnapshotFromEntries({
    ok: true,
    now,
    entries: scan.entries,
    sessionId: scan.sessionId,
    fileMtimeMs: scan.mtimeMs,
    fileSize: scan.bytes,
    malformedLines: scan.malformedLines,
    records: scan.records,
    scannedBytes: scan.bytes,
    sessionFiles: index.sessions.length,
    readMode: "full",
    turns,
  });
}

module.exports = {
  DEFAULT_TAIL_BYTES,
  FRESH_FALLBACK_MS,
  MAX_GAP_MS,
  addTokenBags,
  applyGapFallback,
  buildSnapshot,
  buildSnapshotFromEntries,
  collectAssistantEntries,
  emptyTokenBag,
  estimateOutputTokensFromBlocks,
  hostRootFromDataPath,
  isTranscriptFile,
  localDayKey,
  mergeTurnRemainder,
  normalizeUsage,
  parseAssistantRecord,
  readCompletedTurnUsage,
  readSessionIndex,
  readTailEntries,
  readTailText,
  resolveHostRoot,
  scanSessionFile,
  summarizeEntries,
  tokensPerSecond,
};
