/**
 * engine.js — 轨迹回放的索引引擎（纯 Node 模块，不依赖 pi 对象）。
 *
 * 数据源：~/.pi-desktop/sessions/<id>.jsonl 会话转录本。实测行类型只有三种：
 *   {"type":"session", createdAt, schema, sessionId}
 *   {"type":"message", blocks:[...], createdAt, id, meta, role}
 *   {"type":"compaction", createdAt, details}
 * message 的 blocks 可能是 text / thinking / tool_call / image / attachment。
 * assistant 消息的 meta 带 modelId / providerId / responseDurationMs / status /
 * usage{inputTokens, outputTokens, reasoningTokens, cacheReadTokens,
 * cacheWriteTokens, totalTokens}；其中 cache 字段可能为 null。
 *
 * message 的 role 有三种：user / assistant / tool——工具结果作为独立的
 * role="tool" 消息行保存（每行一个 tool_call 块，含 args 与 result）；
 * blocks 可能是 text / thinking / tool_call / image / attachment。
 *
 * 诚信纪律（对齐 Pace Trajectory 的设计）：
 *   1. jsonl 里不存在 run/turn 边界，turn 只能「由用户消息切分推导」，
 *      UI 必须明标 derived，不得伪装成引擎实测。
 *   2. usage 是 Pi 实测；缺失就是缺失（null），不伪造 0。
 *   3. 宿主没有费用数据，任何地方都不显示费用。
 *   4. 索引只存每块 ≤PREVIEW_CHARS 的预览与字节偏移；完整内容按需原位读取。
 */

"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");

const IDX_VERSION = 2; // v2: totals 增加 lastUserTs（「当前会话」判定信号）
/** 索引里每个块的预览长度（字符）。 */
const PREVIEW_CHARS = 160;
/** 列表响应里每次最多重建的索引数，避免单次调用占用进程太久。 */
const LIST_BUILD_BUDGET = 3;
/** 单条消息原文的最大读取量；超过则标记 tooLarge，不做整段加载。 */
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
/** block 通道返回正文的上限。 */
const BLOCK_TEXT_CAP = 262144;
/** block 通道返回工具参数/结果的上限。 */
const BLOCK_TOOL_CAP = 65536;
/** quickScan 最多读文件头部多少字节。 */
const QUICK_SCAN_BYTES = 256 * 1024;

/* ---------------------------------------------------------------- 小工具 */

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function parseTs(v) {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** 任意值 → 单行预览字符串；超长截断。 */
function previewOf(value, max) {
  if (value == null) return "";
  let s;
  if (typeof value === "string") s = value;
  else {
    try {
      s = JSON.stringify(value);
    } catch {
      return "";
    }
  }
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) : flat;
}

function num2(v) {
  return isNum(v) ? v : null;
}

/** usage 压缩；三个主计数全缺时视为无 usage（返回 null），不伪造。 */
function compactUsage(u) {
  if (!u || typeof u !== "object") return null;
  const c = {
    i: num2(u.inputTokens),
    o: num2(u.outputTokens),
    r: num2(u.reasoningTokens),
    cr: num2(u.cacheReadTokens),
    cw: num2(u.cacheWriteTokens),
    t: num2(u.totalTokens),
  };
  if (c.i == null && c.o == null && c.t == null) return null;
  return c;
}

function compactBlock(b) {
  if (!b || typeof b !== "object") return { t: "other", p: "" };
  const t = typeof b.type === "string" ? b.type : "other";
  const out = { t };
  if (t === "text" || t === "thinking") {
    const p = previewOf(b.text, PREVIEW_CHARS);
    if (p) out.p = p;
    return out;
  }
  if (t === "tool_call") {
    if (typeof b.name === "string") out.n = b.name;
    if (b.args != null) out.p = previewOf(b.args, PREVIEW_CHARS);
    if (isNum(b.durationMs)) out.d = b.durationMs;
    const rc = b.result && Array.isArray(b.result.content) ? b.result.content : null;
    if (rc) {
      const texts = rc
        .map((c) => (c && typeof c === "object" && typeof c.text === "string" ? c.text : ""))
        .join(" ")
        .trim();
      out.rp = previewOf(texts, PREVIEW_CHARS);
      out.ric = rc.length;
    } else if (b.result != null) {
      out.rp = previewOf(b.result, PREVIEW_CHARS);
    }
    return out;
  }
  if (t === "image") {
    if (typeof b.mimeType === "string") out.m = b.mimeType;
    let kb = 0;
    try {
      kb = Math.max(1, Math.round(JSON.stringify(b).length / 1024));
    } catch {
      kb = 0;
    }
    out.kb = kb;
    return out;
  }
  if (t === "attachment") {
    const name = typeof b.path === "string" ? b.path : typeof b.name === "string" ? b.name : "";
    if (name) out.n = name;
    if (isNum(b.size)) out.kb = Math.max(1, Math.round(b.size / 1024));
    return out;
  }
  out.p = previewOf(b, PREVIEW_CHARS);
  return out;
}

function compactMessage(obj, off, len) {
  const meta = obj && typeof obj.meta === "object" && obj.meta ? obj.meta : {};
  const msg = {
    r: obj.role === "user" ? "u" : obj.role === "assistant" ? "a" : String(obj.role || "?"),
    ts: parseTs(obj.createdAt),
    id: typeof obj.id === "string" ? obj.id : null,
    st: typeof meta.status === "string" ? meta.status : null,
    off,
    len,
  };
  if (msg.r === "a") {
    if (typeof meta.modelId === "string") msg.m = meta.modelId;
    if (isNum(meta.responseDurationMs)) msg.dur = meta.responseDurationMs;
    const u = compactUsage(meta.usage);
    if (u) msg.u = u;
  }
  if (Array.isArray(obj.blocks)) msg.b = obj.blocks.map(compactBlock);
  return msg;
}

function eventPreview(obj) {
  const d = obj && typeof obj.details === "object" && obj.details ? obj.details : null;
  if (!d) return "";
  const bits = [];
  if (d.failureCode) bits.push(String(d.failureCode));
  if (d.fallback) bits.push("fallback:" + String(d.fallback));
  if (isNum(d.generation)) bits.push("gen" + d.generation);
  if (!bits.length) bits.push(previewOf(d, 80));
  return bits.join(" · ");
}

/* --------------------------------------------- 按行流式读取（带字节偏移） */

/**
 * 逐行产出 {text, off, len}。text 不含换行（可能含 \r，解析前需再 trim）；
 * off/len 覆盖原始行字节（含换行），用于之后的原位随机读取。
 */
async function* iterateLines(filePath) {
  const handle = await fsp.open(filePath, "r");
  try {
    const CHUNK = 1 << 20;
    const buf = Buffer.alloc(CHUNK);
    let pending = null; // 未凑整行的残段（已复制，独立于 buf）
    let pendingOff = 0;
    let filePos = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, CHUNK, null);
      if (bytesRead <= 0) break;
      const chunkStart = filePos;
      filePos += bytesRead;
      let data = buf.subarray(0, bytesRead);
      let dataOff = chunkStart;
      let searchFrom = 0;
      if (pending) {
        data = Buffer.concat([pending, data]);
        dataOff = pendingOff;
        searchFrom = pending.length;
        pending = null;
      }
      let nl = data.indexOf(10, searchFrom);
      while (nl !== -1) {
        yield { text: data.subarray(0, nl).toString("utf8"), off: dataOff, len: nl + 1 };
        data = data.subarray(nl + 1);
        dataOff += nl + 1;
        searchFrom = 0;
        nl = data.indexOf(10, 0);
      }
      if (data.length) {
        pending = Buffer.from(data); // 必须复制：buf 会被复用
        pendingOff = dataOff;
      }
    }
    if (pending && pending.length) {
      yield { text: pending.toString("utf8"), off: pendingOff, len: pending.length };
    }
  } finally {
    await handle.close();
  }
}

/** 从打开的句柄读一段原始字节。 */
async function readRange(handle, off, len) {
  const cap = Math.min(len, MAX_MESSAGE_BYTES);
  const buf = Buffer.alloc(cap);
  const { bytesRead } = await handle.read(buf, 0, cap, off);
  return { text: buf.subarray(0, bytesRead).toString("utf8"), truncated: bytesRead < len };
}

function parseLineText(raw) {
  let s = raw;
  if (s.endsWith("\n")) s = s.slice(0, -1);
  if (s.endsWith("\r")) s = s.slice(0, -1);
  return JSON.parse(s);
}

/**
 * 按 index 中记录的 off/len 原位读取一批消息行。
 * 返回与 entries 等长的数组，元素为 {obj, tooLarge, broken}。
 */
async function readMessageObjects(filePath, entries) {
  const handle = await fsp.open(filePath, "r");
  try {
    const out = [];
    for (const e of entries) {
      if (!e || !isNum(e.off) || !isNum(e.len) || e.len <= 0) {
        out.push({ obj: null, tooLarge: false, broken: true });
        continue;
      }
      if (e.len > MAX_MESSAGE_BYTES) {
        out.push({ obj: null, tooLarge: true, broken: false });
        continue;
      }
      try {
        const { text } = await readRange(handle, e.off, e.len);
        out.push({ obj: parseLineText(text), tooLarge: false, broken: false });
      } catch {
        out.push({ obj: null, tooLarge: false, broken: true });
      }
    }
    return out;
  } finally {
    await handle.close();
  }
}

/* ---------------------------------------------------------------- turn 推导 */

/**
 * turn 边界由 role=user 的消息切分：每条用户消息开启一个 turn，直到下一条
 * 用户消息；首条用户消息之前的 assistant 内容归入 kind="prelude"。
 * 这是推导（derived），不是引擎实测边界。
 */
function deriveTurns(messages) {
  const segs = [];
  if (!messages.length) return segs;
  const userIdx = [];
  messages.forEach((m, i) => {
    if (m.r === "u") userIdx.push(i);
  });
  if (!userIdx.length) {
    segs.push({ from: 0, to: messages.length - 1, kind: "prelude" });
  } else {
    if (userIdx[0] > 0) segs.push({ from: 0, to: userIdx[0] - 1, kind: "prelude" });
    userIdx.forEach((ui, k) => {
      const to = k + 1 < userIdx.length ? userIdx[k + 1] - 1 : messages.length - 1;
      segs.push({ from: ui, to, kind: "turn" });
    });
  }
  return segs.map((s, n) => summarizeTurn(s, n, messages));
}

function summarizeTurn(seg, n, messages) {
  let ts0 = null;
  let ts1 = null;
  let modelMs = 0;
  let out = 0;
  let cr = 0;
  let cw = 0;
  let ctxIn = null; // turn 末尾的上下文规模 ≈ 最后一条带 usage 的 assistant 的 i+cr
  let tools = 0;
  let think = 0;
  let texts = 0;
  let imgs = 0;
  let atts = 0;
  let others = 0;
  let hasUsage = false;
  const models = new Set();
  let worst = null; // error > aborted > complete
  let preview = "";
  for (let i = seg.from; i <= seg.to; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.ts != null) {
      if (ts0 == null || m.ts < ts0) ts0 = m.ts;
      if (ts1 == null || m.ts > ts1) ts1 = m.ts;
    }
    if (m.r === "u") {
      if (!preview) {
        const firstText = (m.b || []).find((b) => b.t === "text");
        preview = (firstText && firstText.p) || "";
      }
    } else if (m.r === "a") {
      if (m.m) models.add(m.m);
      if (isNum(m.dur)) modelMs += m.dur;
      if (m.u) {
        hasUsage = true;
        out += m.u.o || 0;
        cr += m.u.cr || 0;
        cw += m.u.cw || 0;
        const iPlusCr = (m.u.i || 0) + (m.u.cr || 0);
        if (m.u.i != null) ctxIn = iPlusCr;
      }
      if (m.st === "error") worst = "error";
      else if (m.st === "aborted" && worst !== "error") worst = "aborted";
      else if (m.st === "complete" && !worst) worst = "complete";
    }
    for (const b of m.b || []) {
      if (b.t === "tool_call") tools++;
      else if (b.t === "thinking") think++;
      else if (b.t === "text") texts++;
      else if (b.t === "image") imgs++;
      else if (b.t === "attachment") atts++;
      else others++;
    }
  }
  return {
    n,
    kind: seg.kind,
    from: seg.from,
    to: seg.to,
    msgs: seg.to - seg.from + 1,
    ts0,
    ts1,
    spanMs: ts0 != null && ts1 != null ? ts1 - ts0 : null, // 推导：墙钟跨度
    modelMs,
    out: hasUsage ? out : null,
    cr: hasUsage ? cr : null,
    cw: hasUsage ? cw : null,
    ctxIn,
    tools,
    think,
    texts,
    imgs,
    atts,
    others,
    models: Array.from(models).slice(0, 4),
    st: worst,
    preview: previewOf(preview, 90),
  };
}

function computeTotals(messages) {
  let users = 0;
  let assistants = 0;
  let others = 0;
  let out = 0;
  let cr = 0;
  let cw = 0;
  let modelMs = 0;
  let withUsage = 0;
  let withoutUsage = 0;
  let firstTs = null;
  let lastTs = null;
  let lastUserTs = null; // 最近一条真人输入；「当前会话」判定的一级信号
  const models = new Set();
  for (const m of messages) {
    if (!m) continue;
    if (m.ts != null) {
      if (firstTs == null || m.ts < firstTs) firstTs = m.ts;
      if (lastTs == null || m.ts > lastTs) lastTs = m.ts;
    }
    if (m.r === "u") {
      users++;
      if (m.ts != null && (lastUserTs == null || m.ts > lastUserTs)) lastUserTs = m.ts;
    } else if (m.r === "a") {
      assistants++;
      if (m.m) models.add(m.m);
      if (isNum(m.dur)) modelMs += m.dur;
      if (m.u) {
        withUsage++;
        out += m.u.o || 0;
        cr += m.u.cr || 0;
        cw += m.u.cw || 0;
      } else withoutUsage++;
    } else others++;
  }
  return {
    msgs: messages.length,
    users,
    assistants,
    others,
    out,
    cr,
    cw,
    modelMs,
    withUsage,
    withoutUsage,
    firstTs,
    lastTs,
    lastUserTs,
    models: Array.from(models).slice(0, 6),
  };
}

/* ------------------------------------------------------------------ 建索引 */

async function buildIndex(filePath, stat) {
  const st = stat || (await fsp.stat(filePath));
  const messages = [];
  const events = [];
  let header = null;
  let skipped = 0;
  let totalLines = 0;
  for await (const { text, off, len } of iterateLines(filePath)) {
    totalLines++;
    if (!text || text === "\r") continue;
    let obj;
    try {
      obj = parseLineText(text);
    } catch {
      skipped++;
      continue;
    }
    if (!obj || typeof obj !== "object") {
      skipped++;
      continue;
    }
    const t = obj.type;
    if (t === "session") {
      header = {
        sessionId: typeof obj.sessionId === "string" ? obj.sessionId : null,
        createdAt: parseTs(obj.createdAt),
        schema: isNum(obj.schema) ? obj.schema : null,
      };
      continue;
    }
    if (t === "message") {
      messages.push(compactMessage(obj, off, len));
      continue;
    }
    events.push({
      k: typeof t === "string" ? t : "other",
      ts: parseTs(obj.createdAt),
      off,
      len,
      p: eventPreview(obj),
    });
  }
  const turns = deriveTurns(messages);
  return {
    v: IDX_VERSION,
    file: path.basename(filePath),
    mtimeMs: Math.round(st.mtimeMs),
    size: st.size,
    builtAt: Date.now(),
    header,
    lines: { total: totalLines, skipped },
    messages,
    events,
    turns,
    totals: computeTotals(messages),
    partial: false,
  };
}

/* ------------------------------------------------------------------ 缓存层 */

function idxCachePath(cacheDir, name) {
  return path.join(cacheDir, "idx", name + ".json");
}
function rowCachePath(cacheDir, name) {
  return path.join(cacheDir, "row", name + ".json");
}

async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp" + process.pid;
  await fsp.writeFile(tmp, JSON.stringify(data), "utf8");
  await fsp.rename(tmp, file);
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 加载（必要时重建）单个会话的完整索引。
 * 返回 {index, stale, fromCache}；stale=true 表示内容可能落后于磁盘。
 */
async function loadIndex(filePath, cacheDir, opts = {}) {
  const allowBuild = opts.allowBuild !== false;
  const st = await fsp.stat(filePath);
  const name = path.basename(filePath);
  const mtimeMs = Math.round(st.mtimeMs);
  const cached = await readJson(idxCachePath(cacheDir, name));
  const fresh =
    cached &&
    cached.v === IDX_VERSION &&
    cached.mtimeMs === mtimeMs &&
    cached.size === st.size &&
    cached.partial === false;
  if (fresh) return { index: cached, stale: false, fromCache: true };
  if (!allowBuild) {
    if (cached && cached.v === IDX_VERSION) return { index: cached, stale: true, fromCache: true };
    return { index: await quickScan(filePath, st), stale: true, fromCache: false };
  }
  const index = await buildIndex(filePath, st);
  try {
    await writeJsonAtomic(idxCachePath(cacheDir, name), index);
    await writeJsonAtomic(rowCachePath(cacheDir, name), rowFromIndex(index, st, false));
  } catch {
    /* 缓存写失败不影响功能 */
  }
  return { index, stale: false, fromCache: false };
}

/** 只读文件头部，产出一个「标题已知、统计未知」的部分行（partial）。 */
async function quickScan(filePath, stat) {
  const st = stat || (await fsp.stat(filePath));
  let header = null;
  let title = "";
  let partialLines = 0;
  const handle = await fsp.open(filePath, "r");
  try {
    const buf = Buffer.alloc(QUICK_SCAN_BYTES);
    const { bytesRead } = await handle.read(buf, 0, QUICK_SCAN_BYTES, 0);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    for (const line of text.split("\n")) {
      const s = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (!s) continue;
      if (partialLines > 60) break;
      let obj;
      try {
        obj = JSON.parse(s);
      } catch {
        break; // 头部截断处解析失败即停
      }
      partialLines++;
      if (obj.type === "session") {
        header = {
          sessionId: typeof obj.sessionId === "string" ? obj.sessionId : null,
          createdAt: parseTs(obj.createdAt),
          schema: isNum(obj.schema) ? obj.schema : null,
        };
      } else if (obj.type === "message" && obj.role === "user" && !title) {
        const firstText = (obj.blocks || []).find((b) => b && b.type === "text" && typeof b.text === "string");
        if (firstText) title = firstText.text;
      }
    }
  } finally {
    await handle.close();
  }
  return {
    v: IDX_VERSION,
    file: path.basename(filePath),
    mtimeMs: Math.round(st.mtimeMs),
    size: st.size,
    builtAt: Date.now(),
    header,
    lines: { total: null, skipped: null },
    messages: [],
    events: [],
    turns: [],
    totals: null,
    partial: true,
    quickTitle: previewOf(title, 90),
  };
}

function rowFromIndex(index, stat, stale) {
  const st = stat || { size: index.size, mtimeMs: index.mtimeMs };
  const totals = index.totals || null;
  const header = index.header || {};
  const previewSrc =
    totals && totals.users > 0
      ? null
      : index.quickTitle || "";
  let title = index.quickTitle || "";
  if (!title && index.turns) {
    for (const t of index.turns) {
      if (t.kind === "turn" && t.preview) {
        title = t.preview;
        break;
      }
    }
  }
  return {
    id: header.sessionId || index.file.replace(/\.jsonl$/, ""),
    name: index.file,
    title: title || "(无用户消息)",
    createdAt: header.createdAt || null,
    lastAt: (totals && totals.lastTs) || st.mtimeMs,
    lastUserTs: totals ? totals.lastUserTs || null : null,
    msgs: totals ? totals.msgs : null,
    users: totals ? totals.users : null,
    turns: index.turns ? index.turns.length : null,
    out: totals ? totals.out : null,
    cr: totals ? totals.cr : null,
    models: totals ? totals.models : [],
    size: st.size,
    mtimeMs: Math.round(st.mtimeMs),
    stale: !!stale,
    partial: !!index.partial,
    skipped: index.lines && index.lines.skipped != null ? index.lines.skipped : null,
    schema: header.schema != null ? header.schema : null,
    imported: /^import-/.test(index.file),
  };
}
/**
 * 列出全部可回放会话（排除 *.revisions.jsonl）。每次最多重建
 * buildLimit 个索引（优先最近活跃），其余用行缓存或 quickScan。
 *
 * opts.hostSessions: Map<sessionId, {title, deletedAt}>（可选，宿主权威信息：
 *   title 对齐宿主侧栏显示名，deletedAt 标记已删除会话）。
 * opts.hostCurrentId: string（可选，宿主 messages 表「最近真人输入」的会话 id，
 *   是「当前会话」的一级权威信号）。
 *
 * current 判定（三级降级，basis 字段如实标注来源）：
 *   host-user  — 宿主最近真人输入的会话（权威）；
 *   index-user — 无宿主信号时，取索引里 lastUserTs 最大者
 *                （mtime 会被后台长任务污染，真人输入时间更贴近「当前」）；
 *   mtime      — 连用户消息都没有时退回最近活跃。
 */
async function listSessions(sessionsDir, cacheDir, opts = {}) {
  const buildLimit = isNum(opts.buildLimit) ? opts.buildLimit : LIST_BUILD_BUDGET;
  let names = [];
  try {
    names = (await fsp.readdir(sessionsDir)).filter(
      (n) => n.endsWith(".jsonl") && !n.endsWith(".revisions.jsonl"),
    );
  } catch (err) {
    return { ok: false, error: `READ_DIR_FAILED: ${err && err.message ? err.message : err}`, sessions: [] };
  }

  // 先 stat 一遍，最近活跃的优先占用本次重建预算。
  const statted = [];
  for (const name of names) {
    const file = path.join(sessionsDir, name);
    try {
      const st = await fsp.stat(file);
      statted.push({ name, file, st });
    } catch {
      /* 文件刚被删掉：跳过 */
    }
  }
  statted.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);

  let builds = 0;
  const sessions = [];
  for (const { name, file, st } of statted) {
    const mtimeMs = Math.round(st.mtimeMs);
    const rowCache = await readJson(rowCachePath(cacheDir, name));
    const rowFresh =
      rowCache && rowCache.mtimeMs === mtimeMs && rowCache.size === st.size && !rowCache.stale;
    if (rowFresh) {
      sessions.push(rowCache);
      continue;
    }
    const idxCache = await readJson(idxCachePath(cacheDir, name));
    const idxFresh =
      idxCache && idxCache.v === IDX_VERSION && idxCache.mtimeMs === mtimeMs && idxCache.size === st.size;
    if (idxFresh) {
      const row = rowFromIndex(idxFresh, st, false);
      try {
        await writeJsonAtomic(rowCachePath(cacheDir, name), row);
      } catch {
        /* 忽略缓存写失败 */
      }
      sessions.push(row);
      continue;
    }
    if (builds < buildLimit) {
      builds++;
      const index = await buildIndex(file, st);
      const row = rowFromIndex(index, st, false);
      try {
        await writeJsonAtomic(idxCachePath(cacheDir, name), index);
        await writeJsonAtomic(rowCachePath(cacheDir, name), row);
      } catch {
        /* 忽略缓存写失败 */
      }
      sessions.push(row);
      continue;
    }
    // 预算用尽：退回旧缓存或 quickScan。
    if (rowCache) {
      sessions.push({ ...rowCache, stale: true });
      continue;
    }
    const partial = await quickScan(file, st);
    sessions.push(rowFromIndex(partial, st, true));
  }

  sessions.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));

  // 融合宿主权威信息：标题对齐宿主侧栏显示名，标记已删除会话。
  const hostSessions = opts.hostSessions instanceof Map ? opts.hostSessions : null;
  if (hostSessions) {
    for (const row of sessions) {
      const hs = hostSessions.get(row.id);
      if (!hs) continue;
      if (hs.title) row.title = hs.title;
      if (hs.deletedAt != null) row.isDeleted = true;
    }
  }

  // 「当前会话」三级判定（见函数头注释）。
  let current = null;
  let basis = null;
  if (opts.hostCurrentId) {
    const hit = sessions.find((s) => s.id === opts.hostCurrentId && !s.isDeleted);
    if (hit) {
      current = hit;
      basis = "host-user";
    }
  }
  if (!current) {
    let best = null;
    for (const s of sessions) {
      if (s.isDeleted || s.lastUserTs == null) continue;
      if (!best || s.lastUserTs > best.lastUserTs) best = s;
    }
    if (best) {
      current = best;
      basis = "index-user";
    }
  }
  if (!current) {
    current = sessions.find((s) => !s.isDeleted) || null;
    basis = "mtime";
  }

  return {
    ok: true,
    sessions,
    current: current ? { name: current.name, id: current.id, title: current.title, basis } : null,
    pendingCount: sessions.filter((s) => s.stale || s.partial).length,
    generatedAt: Date.now(),
  };
}

/* ------------------------------------------------------------- 时间线/详情 */

function timelineFrom(index) {
  const markers = (index.events || []).map((e) => {
    let turnIdx = null;
    const turns = index.turns || [];
    for (const t of turns) {
      if (e.ts != null && t.ts0 != null && t.ts1 != null && e.ts >= t.ts0 && e.ts <= t.ts1) {
        turnIdx = t.n;
        break;
      }
    }
    if (turnIdx == null && turns.length && e.ts != null) {
      // 落在 turn 间隙或首尾：归到时间上最近的前一个 turn。
      for (const t of turns) {
        if (t.ts1 != null && t.ts1 <= e.ts) turnIdx = t.n;
      }
    }
    return { k: e.k, ts: e.ts, p: e.p, turnIdx };
  });
  return {
    ok: true,
    session: {
      id: (index.header && index.header.sessionId) || index.file.replace(/\.jsonl$/, ""),
      name: index.file,
      createdAt: index.header && index.header.createdAt,
      schema: index.header && index.header.schema,
      partial: !!index.partial,
      lines: index.lines || null,
      totals: index.totals || null,
      size: index.size,
      mtimeMs: index.mtimeMs,
    },
    turns: index.turns || [],
    markers,
    honesty: {
      turnDerived: true, // turn 边界由用户消息推导，非引擎实测
      usageMeasured: true, // token 数字来自 Pi 实测 meta.usage
      hasCost: false, // 宿主无费用数据，本视图不显示费用
    },
    generatedAt: Date.now(),
  };
}

const ITEM_TEXT_CHARS = 800;
const ITEM_TOOL_CHARS = 400;

function expandBlock(b, bi, msg) {
  const base = { t: b ? b.type : "other", bi, off: msg.off, len: msg.len };
  if (!b || typeof b !== "object") return { ...base, p: "", trunc: false };
  if (b.type === "text" || b.type === "thinking") {
    const raw = typeof b.text === "string" ? b.text : "";
    return { ...base, text: raw.slice(0, ITEM_TEXT_CHARS), trunc: raw.length > ITEM_TEXT_CHARS, fullLen: raw.length };
  }
  if (b.type === "tool_call") {
    let argsText = "";
    try {
      argsText = b.args == null ? "" : JSON.stringify(b.args, null, 2);
    } catch {
      argsText = String(b.args);
    }
    const rc = b.result && Array.isArray(b.result.content) ? b.result.content : null;
    let resultText = "";
    if (rc) {
      resultText = rc
        .map((c) => (c && typeof c === "object" && typeof c.text === "string" ? c.text : ""))
        .join("\n")
        .trim();
    } else if (b.result != null) {
      try {
        resultText = JSON.stringify(b.result, null, 2);
      } catch {
        resultText = String(b.result);
      }
    }
    return {
      ...base,
      n: typeof b.name === "string" ? b.name : "",
      d: isNum(b.durationMs) ? b.durationMs : null,
      args: argsText.slice(0, ITEM_TOOL_CHARS),
      argsTrunc: argsText.length > ITEM_TOOL_CHARS,
      result: resultText.slice(0, ITEM_TOOL_CHARS),
      resultTrunc: resultText.length > ITEM_TOOL_CHARS,
      ric: rc ? rc.length : 0,
    };
  }
  if (b.type === "image") {
    let kb = 0;
    try {
      kb = Math.max(1, Math.round(JSON.stringify(b).length / 1024));
    } catch {
      kb = 0;
    }
    return { ...base, m: typeof b.mimeType === "string" ? b.mimeType : "", kb };
  }
  if (b.type === "attachment") {
    return {
      ...base,
      n: typeof b.path === "string" ? b.path : typeof b.name === "string" ? b.name : "",
      kb: isNum(b.size) ? Math.max(1, Math.round(b.size / 1024)) : null,
    };
  }
  try {
    return { ...base, p: previewOf(b, PREVIEW_CHARS) };
  } catch {
    return { ...base, p: "" };
  }
}

/** 展开一页 turn 内容：读原位消息行，产出自包含的 items。 */
async function turnItems(filePath, index, turnN, opts = {}) {
  const offset = isNum(opts.offset) ? opts.offset : 0;
  const limit = isNum(opts.limit) ? opts.limit : 120;
  const turn = (index.turns || []).find((t) => t.n === turnN);
  if (!turn) return { ok: false, error: "TURN_NOT_FOUND" };
  const slice = (index.messages || []).slice(turn.from, turn.to + 1);
  if (!slice.length) return { ok: true, items: [], total: 0, hasMore: false, turn };
  const page = slice.slice(offset, offset + limit);
  const raws = await readMessageObjects(filePath, page.map((m) => ({ off: m.off, len: m.len })));
  const items = page.map((m, k) => {
    const raw = raws[k] || {};
    const item = {
      kind: m.r === "u" ? "user" : m.r === "a" ? "assistant" : m.r,
      ts: m.ts,
      id: m.id,
      st: m.st,
      off: m.off,
      len: m.len,
      tooLarge: !!raw.tooLarge,
      broken: !!raw.broken,
    };
    if (m.r === "a") {
      item.model = m.m || null;
      item.dur = isNum(m.dur) ? m.dur : null;
      item.usage = m.u || null;
    }
    const blocks = raw.obj && Array.isArray(raw.obj.blocks) ? raw.obj.blocks : null;
    if (blocks) {
      item.blocks = blocks.map((b, bi) => expandBlock(b, bi, m));
    } else if (!raw.tooLarge && !raw.broken) {
      item.blocks = [];
    }
    return item;
  });
  return {
    ok: true,
    items,
    total: slice.length,
    hasMore: offset + page.length < slice.length,
    turn,
  };
}

/** 取一个块的完整内容（按需展开），带硬上限与截断标记。 */
async function blockAt(filePath, off, len, bi) {
  if (!isNum(off) || !isNum(len) || len <= 0 || len > MAX_MESSAGE_BYTES) {
    return { ok: false, error: "BAD_RANGE" };
  }
  const raw = await readMessageObjects(filePath, [{ off, len }]);
  const r = raw[0] || {};
  if (r.broken || !r.obj) return { ok: false, error: "READ_FAILED" };
  if (r.tooLarge) return { ok: false, error: "TOO_LARGE" };
  const blocks = Array.isArray(r.obj.blocks) ? r.obj.blocks : [];
  const b = blocks[bi];
  if (!b || typeof b !== "object") return { ok: false, error: "BLOCK_NOT_FOUND" };
  if (b.type === "text" || b.type === "thinking") {
    const text = typeof b.text === "string" ? b.text : "";
    return {
      ok: true,
      block: {
        t: b.type,
        text: text.slice(0, BLOCK_TEXT_CAP),
        trunc: text.length > BLOCK_TEXT_CAP,
        fullLen: text.length,
      },
    };
  }
  if (b.type === "tool_call") {
    let argsText = "";
    try {
      argsText = b.args == null ? "" : JSON.stringify(b.args, null, 2);
    } catch {
      argsText = String(b.args);
    }
    const rc = b.result && Array.isArray(b.result.content) ? b.result.content : null;
    let resultText = "";
    if (rc) {
      resultText = rc
        .map((c) => (c && typeof c === "object" && typeof c.text === "string" ? c.text : ""))
        .join("\n")
        .trim();
    } else if (b.result != null) {
      try {
        resultText = JSON.stringify(b.result, null, 2);
      } catch {
        resultText = String(b.result);
      }
    }
    return {
      ok: true,
      block: {
        t: b.type,
        n: typeof b.name === "string" ? b.name : "",
        args: argsText.slice(0, BLOCK_TOOL_CAP),
        argsTrunc: argsText.length > BLOCK_TOOL_CAP,
        result: resultText.slice(0, BLOCK_TOOL_CAP),
        resultTrunc: resultText.length > BLOCK_TOOL_CAP,
      },
    };
  }
  if (b.type === "image") {
    let kb = 0;
    try {
      kb = Math.max(1, Math.round(JSON.stringify(b).length / 1024));
    } catch {
      kb = 0;
    }
    return { ok: true, block: { t: "image", m: typeof b.mimeType === "string" ? b.mimeType : "", kb } };
  }
  if (b.type === "attachment") {
    return {
      ok: true,
      block: {
        t: "attachment",
        n: typeof b.path === "string" ? b.path : "",
        kb: isNum(b.size) ? Math.max(1, Math.round(b.size / 1024)) : null,
      },
    };
  }
  try {
    return { ok: true, block: { t: "other", p: previewOf(b, BLOCK_TEXT_CAP) } };
  } catch {
    return { ok: false, error: "SERIALIZE_FAILED" };
  }
}

/* ------------------------------------------------------------------ 导出 */

module.exports = {
  IDX_VERSION,
  PREVIEW_CHARS,
  MAX_MESSAGE_BYTES,
  iterateLines,
  buildIndex,
  deriveTurns,
  computeTotals,
  loadIndex,
  listSessions,
  timelineFrom,
  turnItems,
  blockAt,
  quickScan,
  rowFromIndex,
};
