"use strict";

/**
 * history.js —— 跨会话的累计统计（年 / 月 / 日 + 按模型）。
 *
 * 为什么需要单独一层：main.js 现有的实时快照只看**当前活跃会话**，因为它的职责是
 * 「这一条回复多快」。而「今年 / 这个月 / 今天一共烧了多少 token、哪个模型最快」
 * 必须跨所有会话文件聚合。
 *
 * 为什么不直接用宿主 SQLite：实测宿主 pi.sqlite 的 turns 表只覆盖最近几天
 * （本次核对为 4 天 / 86 个 completed 回合），而 sessions 目录里的转录本覆盖
 * 更长的历史（同一次核对为 5 天 / 7751 条助手回复）。用数据库做累计会静默漏数，
 * 所以累计统计以转录本为准，数据库只继续服务于实时快照的差额补足。
 *
 * 性能约束（决定了这里必须做缓存）：实测全量扫描 56 个文件 / 214 MB 需要约 2.6 秒。
 * 这个开销不能放进 1.2 秒的实时轮询，因此：
 *   1. 每个文件的聚合结果按 `size + mtimeMs` 指纹缓存，只有变化的文件才重扫；
 *   2. 缓存落在插件自己的数据目录，跨进程重启复用；
 *   3. 累计统计走独立的慢节奏定时器（默认 60 秒），与实时快照解耦。
 *
 * 只读：本模块从不写入宿主目录，只写自己的缓存文件（由调用方给路径）。
 */

const { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const {
  MAX_GAP_MS,
  isTranscriptFile,
  localDayKey,
  normalizeUsage,
  tokensPerSecond,
} = require("./host-read");

/** 缓存结构版本；形状一变就作废，避免读到旧结构的字段。 */
const CACHE_VERSION = 3;
/** 快照里最多带多少天明细（总量仍按全部天数精确计算）。 */
const MAX_SNAPSHOT_DAYS = 120;
/** 看板柱状图最多画多少天。 */
const MAX_CHART_DAYS = 30;

/**
 * 判定「速度样本可信」的最短用时。
 *
 * 为什么需要它：宿主偶尔会上报极短的 responseDurationMs（本次核对里 142/7477 条
 * 低于 50ms，其中 4 条低于 10ms），例如「92 个输出 token / 1ms」= 92000 tok/s。
 * 任何模型都不可能这么快，这个读数完全被宿主的计时精度主导，属于无意义的离群值。
 * 若把它算进峰值，看板上的「峰值速度」就永久变成一串垃圾数字。
 *
 * 100ms 是保守下限。低于此值的样本仍计入**总量与平均**（token 消耗真实发生过），
 * 只是不参与峰值；被排除的条数会随快照一起发布（implausible），
 * 所以这不是隐藏数据，而是明确标注了取舍。
 */
const MIN_PLAUSIBLE_DURATION_MS = 100;

const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"];

/* ------------------------------------------------------------------ 小工具 */

/** 一个全零的 token 包。 */
function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
}

function addTokens(target, source) {
  for (const field of TOKEN_FIELDS) target[field] += source?.[field] || 0;
  target.total += source?.total || 0;
  return target;
}

/** 单条样本是否可用于峰值：速度有限、为正，且用时达到可信下限。 */
function isPlausibleSpeedSample(record) {
  return (
    Number.isFinite(record?.speed) &&
    record.speed > 0 &&
    Number.isFinite(record.durationMs) &&
    record.durationMs >= MIN_PLAUSIBLE_DURATION_MS
  );
}

/**
 * 一个空的聚合桶：既用于「某一天」，也用于「某个月 / 某一年 / 全局」。
 *
 * `speedSum/speedCount` 决定平均值（所有有速度的样本都参与，含估算值），
 * 而 `peak` 只由可信样本决定，`implausible` 记录被排除的条数。
 * `durationReported/Gap/Unknown` 是「用时到底从哪来」的自我交代。
 */
function emptyAggregate() {
  return {
    replies: 0,
    tokens: emptyTokens(),
    durationMs: 0,
    speedSum: 0,
    speedCount: 0,
    peak: null,
    implausible: 0,
    firstAt: null,
    lastAt: null,
    estimated: 0,
    subagent: 0,
    durationReported: 0,
    durationGap: 0,
    durationUnknown: 0,
    models: {},
  };
}

function emptyModelAggregate() {
  return {
    replies: 0,
    tokens: emptyTokens(),
    durationMs: 0,
    speedSum: 0,
    speedCount: 0,
    peak: null,
    implausible: 0,
    firstAt: null,
    lastAt: null,
  };
}

/** 把一条回复累加进一个聚合桶（并同时累加进它的按模型子桶）。 */
function addRecordToAggregate(aggregate, record) {
  aggregate.replies += 1;
  addTokens(aggregate.tokens, record.tokens);
  if (Number.isFinite(record.durationMs) && record.durationMs > 0) {
    aggregate.durationMs += record.durationMs;
  }
  if (Number.isFinite(record.speed)) {
    aggregate.speedSum += record.speed;
    aggregate.speedCount += 1;
    // 峰值只认可信样本；被排除的计数留给视图解释，而不是静默丢掉。
    if (isPlausibleSpeedSample(record)) {
      aggregate.peak = aggregate.peak === null ? record.speed : Math.max(aggregate.peak, record.speed);
    } else {
      aggregate.implausible += 1;
    }
  }
  if (Number.isFinite(record.createdMs)) {
    if (aggregate.firstAt === null || record.createdMs < aggregate.firstAt) aggregate.firstAt = record.createdMs;
    if (aggregate.lastAt === null || record.createdMs > aggregate.lastAt) aggregate.lastAt = record.createdMs;
  }
  if (record.estimated) aggregate.estimated += 1;
  if (record.subagent) aggregate.subagent += 1;
  if (record.durationSource === "reported") aggregate.durationReported += 1;
  else if (record.durationSource === "gap") aggregate.durationGap += 1;
  else aggregate.durationUnknown += 1;

  const modelId = record.modelId || "(未知模型)";
  let model = aggregate.models[modelId];
  if (!model) {
    model = emptyModelAggregate();
    aggregate.models[modelId] = model;
  }
  model.replies += 1;
  addTokens(model.tokens, record.tokens);
  if (Number.isFinite(record.durationMs) && record.durationMs > 0) model.durationMs += record.durationMs;
  if (Number.isFinite(record.speed)) {
    model.speedSum += record.speed;
    model.speedCount += 1;
    if (isPlausibleSpeedSample(record)) {
      model.peak = model.peak === null ? record.speed : Math.max(model.peak, record.speed);
    } else {
      model.implausible += 1;
    }
  }
  if (Number.isFinite(record.createdMs)) {
    if (model.firstAt === null || record.createdMs < model.firstAt) model.firstAt = record.createdMs;
    if (model.lastAt === null || record.createdMs > model.lastAt) model.lastAt = record.createdMs;
  }
  return aggregate;
}

/** 把一个聚合桶并入另一个（用于跨文件 / 跨天 / 跨月求和）。 */
function mergeAggregate(target, source) {
  if (!source) return target;
  target.replies += source.replies || 0;
  addTokens(target.tokens, source.tokens);
  target.durationMs += source.durationMs || 0;
  target.speedSum += source.speedSum || 0;
  target.speedCount += source.speedCount || 0;
  target.estimated += source.estimated || 0;
  target.subagent += source.subagent || 0;
  target.implausible += source.implausible || 0;
  target.durationReported += source.durationReported || 0;
  target.durationGap += source.durationGap || 0;
  target.durationUnknown += source.durationUnknown || 0;
  if (Number.isFinite(source.peak)) {
    target.peak = target.peak === null ? source.peak : Math.max(target.peak, source.peak);
  }
  if (Number.isFinite(source.firstAt)) {
    target.firstAt = target.firstAt === null ? source.firstAt : Math.min(target.firstAt, source.firstAt);
  }
  if (Number.isFinite(source.lastAt)) {
    target.lastAt = target.lastAt === null ? source.lastAt : Math.max(target.lastAt, source.lastAt);
  }
  for (const [modelId, model] of Object.entries(source.models || {})) {
    let into = target.models[modelId];
    if (!into) {
      into = emptyModelAggregate();
      target.models[modelId] = into;
    }
    into.replies += model.replies || 0;
    addTokens(into.tokens, model.tokens);
    into.durationMs += model.durationMs || 0;
    into.speedSum += model.speedSum || 0;
    into.speedCount += model.speedCount || 0;
    into.implausible += model.implausible || 0;
    if (Number.isFinite(model.peak)) {
      into.peak = into.peak === null ? model.peak : Math.max(into.peak, model.peak);
    }
    if (Number.isFinite(model.firstAt)) {
      into.firstAt = into.firstAt === null ? model.firstAt : Math.min(into.firstAt, model.firstAt);
    }
    if (Number.isFinite(model.lastAt)) {
      into.lastAt = into.lastAt === null ? model.lastAt : Math.max(into.lastAt, model.lastAt);
    }
  }
  return target;
}

/** 平均速度按「每条回复的速度取平均」，与面板里会话累计的口径一致。 */
function averageSpeed(aggregate) {
  return aggregate.speedCount > 0 ? Math.round(aggregate.speedSum / aggregate.speedCount) : null;
}

/** 缓存命中率与宿主同公式：cacheRead / (input + cacheRead)。 */
function cacheHitRate(tokens) {
  const base = (tokens?.input || 0) + (tokens?.cacheRead || 0);
  return base > 0 ? Math.round(((tokens.cacheRead || 0) / base) * 100) : null;
}

/** 与 host-read.estimateOutputTokensFromBlocks 同口径。 */
function estimateOutput(blocks) {
  if (!Array.isArray(blocks)) return 0;
  let text = "";
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type !== "thinking" && block.type !== "text") continue;
    if (typeof block.text === "string") text += block.text;
  }
  text = text.trim();
  if (!text) return 0;
  return Math.max(1, Math.ceil(Array.from(text).length / 4));
}

/* --------------------------------------------------- 单文件扫描（只出聚合） */

/**
 * 扫描一个转录本，直接产出「按天聚合」，不构造完整 entry 数组。
 *
 * 为什么不用 host-read.scanSessionFile：那个函数会为每条回复建一个约 20 个字段的
 * 对象（本次核对有 7751 条），只为了最后求和。这里边读边累加，内存占用与条数无关。
 *
 * 用时口径与实时快照保持一致：
 *   - `meta.responseDurationMs` 有值 → 权威值（durationSource = "reported"）；
 *   - 否则用「与下一条助手回复的间隔」估算（上限 MAX_GAP_MS，durationSource = "gap"）。
 *     因为这里按文件顺序线性读取，只需把当前记录挂起，等下一条到了再回填。
 *     实测子智能体回复**从不**带 responseDurationMs（2251/2251 条），所以这条路径
 *     是子智能体唯一能拿到速度的方式。
 */
function scanFileIntoDays(file, options = {}) {
  const result = { ok: false, days: {}, records: 0, malformed: 0, bytes: 0, mtimeMs: null, error: null };
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

  let pending = null;

  /** 落一条记录：此时已经知道它的「下一条」，可以定下用时。 */
  const flush = (record, nextCreatedMs) => {
    if (!record) return;
    let durationMs = record.durationMs;
    let estimated = record.estimated;
    let durationSource = record.durationSource;
    if (durationMs === null && Number.isFinite(nextCreatedMs) && Number.isFinite(record.createdMs)) {
      const gap = nextCreatedMs - record.createdMs;
      if (gap > 0 && gap <= MAX_GAP_MS) {
        durationMs = gap;
        estimated = true;
        durationSource = "gap";
      }
    }
    const dayKey = localDayKey(record.createdMs);
    if (!dayKey) return;
    let bucket = result.days[dayKey];
    if (!bucket) {
      bucket = emptyAggregate();
      result.days[dayKey] = bucket;
    }
    addRecordToAggregate(bucket, {
      tokens: record.tokens,
      durationMs,
      durationSource,
      speed: tokensPerSecond(record.outputTokens, durationMs) ?? null,
      createdMs: record.createdMs,
      modelId: record.modelId,
      estimated,
      subagent: record.subagent,
    });
  };

  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    result.records += 1;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      result.malformed += 1;
      continue;
    }
    if (!parsed || parsed.type !== "message" || parsed.role !== "assistant") continue;
    const meta = parsed.meta;
    if (!meta || !meta.usage) continue;

    const createdMs = typeof parsed.createdAt === "string" ? Date.parse(parsed.createdAt) : NaN;
    const tokens = normalizeUsage(meta.usage);
    const reported = Number(meta.responseDurationMs);
    const hasReported = Number.isFinite(reported) && reported > 0;
    const outputTokens = tokens.output > 0 ? tokens.output : estimateOutput(parsed.blocks);

    const record = {
      createdMs: Number.isFinite(createdMs) ? createdMs : null,
      modelId: typeof meta.modelId === "string" ? meta.modelId : null,
      tokens,
      outputTokens,
      durationMs: hasReported ? reported : null,
      durationSource: hasReported ? "reported" : null,
      estimated: !hasReported || tokens.output <= 0,
      subagent: Boolean(meta.agentName || meta.parentToolCallId),
    };

    // 挂起的那条现在知道「下一条」了，可以定下它的用时。
    flush(pending, record.createdMs);
    pending = record;
  }
  flush(pending, null);

  result.ok = true;
  return result;
}

/* -------------------------------------------------------------------- 缓存 */

function readCache(cacheFile) {
  try {
    const parsed = JSON.parse(readFileSync(cacheFile, "utf8"));
    if (parsed && parsed.version === CACHE_VERSION && parsed.files && typeof parsed.files === "object") {
      return parsed;
    }
  } catch {
    // 缓存缺失或损坏都只是「退化成全量重扫」，不是错误。
  }
  return { version: CACHE_VERSION, files: {} };
}

function writeCache(cacheFile, cache) {
  try {
    mkdirSync(path.dirname(cacheFile), { recursive: true });
    // 先写临时文件再改名：进程被杀时不会留下半个 JSON 让下次读到坏缓存。
    const temporary = `${cacheFile}.tmp`;
    writeFileSync(temporary, JSON.stringify(cache), "utf8");
    renameSync(temporary, cacheFile);
    return true;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- 主入口 */

/**
 * 聚合所有会话转录本。
 *
 * @param {string} hostRoot 宿主根目录
 * @param {object} options
 *   - cacheFile  缓存文件路径（省略则不用缓存，每次都全量重扫）
 *   - now        注入「现在」，便于测试
 *   - maxDays    快照里保留的天数上限
 *   - force      忽略缓存，全部重扫
 */
function aggregateHistory(hostRoot, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const maxDays = Number.isFinite(options.maxDays) ? options.maxDays : MAX_SNAPSHOT_DAYS;
  const result = {
    ok: false,
    generatedAt: now,
    files: { total: 0, rescanned: 0, reused: 0, bytes: 0, unreadable: 0 },
    totals: null,
    years: [],
    months: [],
    days: [],
    daysTruncated: false,
    models: [],
    chart: [],
    cacheSaved: false,
    error: null,
  };

  const dir = path.join(String(hostRoot || ""), "sessions");
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    result.error = "NO_SESSION_DIR";
    return result;
  }

  const files = [];
  for (const name of names) {
    if (!isTranscriptFile(name)) continue;
    const file = path.join(dir, name);
    try {
      const stat = statSync(file);
      if (!stat.isFile()) continue;
      files.push({ name, file, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // 单个文件 stat 不到就跳过，不影响整体聚合。
    }
  }
  result.files.total = files.length;

  const cache = options.cacheFile ? readCache(options.cacheFile) : { version: CACHE_VERSION, files: {} };
  const nextCache = { version: CACHE_VERSION, files: {} };

  for (const entry of files) {
    result.files.bytes += entry.size;
    const cached = cache.files[entry.name];
    const usable = !options.force && cached && cached.size === entry.size && cached.mtimeMs === entry.mtimeMs;
    if (usable) {
      // 缓存命中：直接复用这份按天聚合。
      nextCache.files[entry.name] = cached;
      result.files.reused += 1;
      continue;
    }
    const scan = scanFileIntoDays(entry.file, { now });
    if (!scan.ok) {
      result.files.unreadable += 1;
      continue;
    }
    nextCache.files[entry.name] = {
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      days: scan.days,
      records: scan.records,
      malformed: scan.malformed,
    };
    result.files.rescanned += 1;
  }

  if (options.cacheFile) {
    result.cacheSaved = writeCache(options.cacheFile, nextCache);
  }

  // 按天求和。
  const byDay = {};
  for (const entry of Object.values(nextCache.files)) {
    for (const [dayKey, aggregate] of Object.entries(entry.days || {})) {
      let into = byDay[dayKey];
      if (!into) {
        into = emptyAggregate();
        byDay[dayKey] = into;
      }
      mergeAggregate(into, aggregate);
    }
  }

  const dayKeys = Object.keys(byDay).sort();
  if (!dayKeys.length) {
    // 一条记录都没有：照样给出完整形状（含空的 periods），视图不必为「没有 periods」写特例。
    result.ok = true;
    result.totals = summarizeAggregate(emptyAggregate(), 0);
    result.periods = buildPeriods({ byDay: {}, byMonth: {}, byYear: {}, dayKeys: [], now });
    result.chart = result.periods.day.chart;
    return result;
  }

  // 年 / 月由天派生，保证三级数字永远自洽（不会因为各自的累加路径不同而对不上）。
  const byMonth = {};
  const byYear = {};
  const overall = emptyAggregate();
  for (const dayKey of dayKeys) {
    const aggregate = byDay[dayKey];
    mergeAggregate(overall, aggregate);
    const monthKey = dayKey.slice(0, 7);
    const yearKey = dayKey.slice(0, 4);
    if (!byMonth[monthKey]) byMonth[monthKey] = emptyAggregate();
    if (!byYear[yearKey]) byYear[yearKey] = emptyAggregate();
    mergeAggregate(byMonth[monthKey], aggregate);
    mergeAggregate(byYear[yearKey], aggregate);
  }

  result.totals = summarizeAggregate(overall, dayKeys.length);
  result.years = Object.keys(byYear)
    .sort()
    .reverse()
    .map((key) => ({ key, ...summarizeAggregate(byYear[key], countDays(byDay, key, 4)) }));
  result.months = Object.keys(byMonth)
    .sort()
    .reverse()
    .map((key) => ({ key, ...summarizeAggregate(byMonth[key], countDays(byDay, key, 7)) }));

  const newestFirst = [...dayKeys].reverse();
  const kept = newestFirst.slice(0, maxDays);
  result.daysTruncated = newestFirst.length > kept.length;
  result.days = kept.map((key) => ({ key, ...summarizeAggregate(byDay[key], 1) }));
  // 按模型：全量一份，三个周期各自一份。两处共用 summarizeModels，
  // 所以「本月 deepseek 占 48.9%」与「全量 deepseek 占 48.9%」是同一套算法。
  result.models = summarizeModels(overall, (modelId) => countModelDays(Object.values(byDay), modelId));

  // 周期包：日 / 月 / 年各自带着自己的四个数字、柱状图与按模型明细，
  // 视图切换周期时整块看板跟着换，而不是永远显示全量累计。
  result.periods = buildPeriods({ byDay, byMonth, byYear, dayKeys, now });
  // 兼容 0.3.x 的旧视图（覆盖安装后它可能还在跑）：chart 保留为「日」粒度。
  result.chart = result.periods.day.chart;

  result.ok = true;
  return result;
}

/** 数出某个前缀（年或月）下有多少天有记录。 */
function countDays(byDay, prefix, prefixLength) {
  let count = 0;
  for (const dayKey of Object.keys(byDay)) {
    if (dayKey.slice(0, prefixLength) === prefix) count += 1;
  }
  return count;
}

/** 取出 byDay 里落在某个前缀（年 / 月）内的所有天聚合。 */
function daysWithPrefix(byDay, prefix) {
  const out = [];
  for (const [dayKey, aggregate] of Object.entries(byDay)) {
    if (dayKey.startsWith(prefix)) out.push(aggregate);
  }
  return out;
}

/** 某个模型在给定的这组天里出现了几天 —— 「用了几种模型」之外的另一个有用维度。 */
function countModelDays(days, modelId) {
  let count = 0;
  for (const aggregate of days) {
    if (aggregate.models && aggregate.models[modelId]) count += 1;
  }
  return count;
}

/**
 * 把一个聚合桶里的 models 子桶压成视图要的扁平列表。
 *
 * 桶自己就带 models 子桶（mergeAggregate 会一路并上来），所以「本月按模型」
 * 不需要再扫一遍原始记录，直接读本月那个桶即可 —— 这也是三级数字自洽的来源。
 *
 * @param {object} aggregate 已含 models 子桶的桶（全量 / 某年 / 某月 / 某天）
 * @param {(modelId: string) => number} daysOf 该模型在这个桶覆盖范围内出现在多少天里
 */
function summarizeModels(aggregate, daysOf) {
  const grandTotal = aggregate.tokens.total || 0;
  return Object.entries(aggregate.models || {})
    .map(([modelId, model]) => ({
      modelId,
      replies: model.replies,
      tokens: model.tokens,
      durationMs: model.durationMs,
      avgSpeed: model.speedCount > 0 ? Math.round(model.speedSum / model.speedCount) : null,
      peakSpeed: model.peak,
      implausible: model.implausible,
      cacheHitRate: cacheHitRate(model.tokens),
      firstAt: model.firstAt,
      lastAt: model.lastAt,
      share: grandTotal > 0 ? Math.round((model.tokens.total / grandTotal) * 1000) / 10 : 0,
      days: daysOf(modelId),
    }))
    .sort((left, right) => right.tokens.total - left.tokens.total);
}

/**
 * 三个周期（日 / 月 / 年）各自的看板数据。
 *
 * 为什么要有这一层：看板上的柱状图与「模型用量」原本是**固定的**——柱状图永远是
 * 近 30 天，模型列表永远是全历史累计。于是点「月 / 年」时只有四个主数字在动，
 * 下面两块纹丝不动，看起来就像切换失灵。这里把每个周期要的东西一次备齐
 * （四个主数字 / 柱状图 / 按模型明细），视图切换时整块换掉。
 *
 * 口径是「当前周期」：今天 / 本月 / 今年。当前周期没有记录时给全零并标 empty，
 * 而不是悄悄退回最近一个有记录的周期——那会让「今日」下面挂着昨天的数字。
 *
 * 柱状图跟着周期换粒度：日→每天、月→每月、年→每年，都取最近 MAX_CHART_DAYS 个桶。
 * 当前周期的柱子由视图高亮（今天 / 本月 / 今年）；点柱子可切到那个桶。
 */
/**
 * 柱状图窗口内每个桶的明细，供「点柱子切换」使用。
 *
 * 为什么要单独给一份：四个主数字与模型列表原本只反映**当前周期**（今天 / 本月 / 今年）。
 * 但柱子画的是最近 30 个桶，用户点第 5 根柱子时想看的是那一天的明细，不是今天的。
 * 这里把窗口内每个桶的 summary 与 models 一起备好，视图点击后直接换数据源即可，
 * 不必再回插件进程重算（那要走一次设置往返，点击会明显卡顿）。
 *
 * 只覆盖最近 MAX_CHART_DAYS 个桶：柱子只有这么多，而明细表按最新在前也只展示
 * 最近 14 行，两者都在这个窗口内，所以既够用又不会让快照无谓膨胀。
 */
function bucketDetails({ keys, lookup, currentKey, activeDaysOf, modelsOf }) {
  return keys.slice(-MAX_CHART_DAYS).map((key) => ({
    key,
    current: key === currentKey,
    summary: summarizeAggregate(lookup[key], activeDaysOf(key)),
    models: modelsOf(key),
  }));
}
function buildPeriods({ byDay, byMonth, byYear, dayKeys, now }) {
  const today = localDayKey(now) || "";
  const monthKey = today.slice(0, 7);
  const yearKey = today.slice(0, 4);

  /** 升序取最近 N 个桶，画成柱状图。 */
  const chartOf = (keys, lookup) =>
    keys.slice(-MAX_CHART_DAYS).map((key) => ({
      key,
      total: lookup[key].tokens.total,
      replies: lookup[key].replies,
      avgSpeed: averageSpeed(lookup[key]),
    }));

  const monthKeys = Object.keys(byMonth).sort();
  const yearKeys = Object.keys(byYear).sort();

  const dayBucket = byDay[today];
  const monthBucket = byMonth[monthKey];
  const yearBucket = byYear[yearKey];

  return {
    day: {
      key: today,
      empty: !dayBucket,
      summary: summarizeAggregate(dayBucket || emptyAggregate(), dayBucket ? 1 : 0),
      chart: chartOf(dayKeys, byDay),
      models: summarizeModels(dayBucket || emptyAggregate(), (id) => countModelDays([dayBucket], id)),
      buckets: bucketDetails({
        keys: dayKeys,
        lookup: byDay,
        currentKey: today,
        activeDaysOf: () => 1,
        modelsOf: (key) => summarizeModels(byDay[key], (id) => countModelDays([byDay[key]], id)),
      }),
    },
    month: {
      key: monthKey,
      empty: !monthBucket,
      summary: summarizeAggregate(monthBucket || emptyAggregate(), countDays(byDay, monthKey, 7)),
      chart: chartOf(monthKeys, byMonth),
      models: summarizeModels(monthBucket || emptyAggregate(), (id) =>
        countModelDays(daysWithPrefix(byDay, monthKey), id),
      ),
      buckets: bucketDetails({
        keys: monthKeys,
        lookup: byMonth,
        currentKey: monthKey,
        activeDaysOf: (key) => countDays(byDay, key, 7),
        modelsOf: (key) => summarizeModels(byMonth[key], (id) => countModelDays(daysWithPrefix(byDay, key), id)),
      }),
    },
    year: {
      key: yearKey,
      empty: !yearBucket,
      summary: summarizeAggregate(yearBucket || emptyAggregate(), countDays(byDay, yearKey, 4)),
      chart: chartOf(yearKeys, byYear),
      models: summarizeModels(yearBucket || emptyAggregate(), (id) =>
        countModelDays(daysWithPrefix(byDay, yearKey), id),
      ),
      buckets: bucketDetails({
        keys: yearKeys,
        lookup: byYear,
        currentKey: yearKey,
        activeDaysOf: (key) => countDays(byDay, key, 4),
        modelsOf: (key) => summarizeModels(byYear[key], (id) => countModelDays(daysWithPrefix(byDay, key), id)),
      }),
    },
  };
}

/** 把一个聚合桶压成视图要的扁平数字，避免把嵌套的 models 传进快照。 */
function summarizeAggregate(aggregate, activeDays) {
  return {
    replies: aggregate.replies,
    tokens: { ...aggregate.tokens },
    durationMs: aggregate.durationMs,
    avgSpeed: averageSpeed(aggregate),
    peakSpeed: aggregate.peak,
    implausible: aggregate.implausible,
    cacheHitRate: cacheHitRate(aggregate.tokens),
    firstAt: aggregate.firstAt,
    lastAt: aggregate.lastAt,
    estimated: aggregate.estimated,
    subagent: aggregate.subagent,
    durationReported: aggregate.durationReported,
    durationGap: aggregate.durationGap,
    durationUnknown: aggregate.durationUnknown,
    modelCount: Object.keys(aggregate.models || {}).length,
    activeDays,
  };
}

module.exports = {
  CACHE_VERSION,
  MAX_CHART_DAYS,
  MAX_SNAPSHOT_DAYS,
  MIN_PLAUSIBLE_DURATION_MS,
  TOKEN_FIELDS,
  addRecordToAggregate,
  addTokens,
  aggregateHistory,
  averageSpeed,
  buildPeriods,
  cacheHitRate,
  countModelDays,
  daysWithPrefix,
  emptyAggregate,
  emptyModelAggregate,
  emptyTokens,
  estimateOutput,
  isPlausibleSpeedSample,
  mergeAggregate,
  readCache,
  scanFileIntoDays,
  summarizeAggregate,
  summarizeModels,
  writeCache,
};
