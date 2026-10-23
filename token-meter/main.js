/*
 * Token 计量 —— 插件进程入口。
 *
 * 职责：把宿主本地记录（会话转录本 + pi.sqlite 的 turns 表）算成一个紧凑快照，
 * 通过 pi.plugin.setSettings 发布；两个界面只负责渲染这份快照：
 *   views/index.html   右侧工作面板里的完整仪表盘（contributes.views）
 *   views/widget.html  透明置顶的速度浮窗（ui.shape = "widget"）
 *
 * 为什么走「设置」这条通道：视图页拿到的是 window.pluginBridge，面板桥只暴露
 * 固定通道，没有任何「读用量」的通道（宿主 API 白名单里也没有）。官方插件
 * pi.token-insights 用的就是这个范式，这里沿用。
 *
 * 关于浮窗位置：宿主不提供设置插件窗口坐标的 API（setBounds 只属于 browser.*
 * 与 views.*），所以插件无法把浮窗钉到输入框左下角。浮窗由用户拖动定位，
 * 位置由用户自己固定；宿主在浮窗上注入 drag-region，并接管右键菜单。
 *
 * 隐私：全程只读本地文件、不联网、不上传。快照里只有会话 id 前 8 位、模型 id、
 * token 计数与时间戳，没有任何消息正文、工具参数或项目路径。
 *
 * 权限：ui.view（面板）+ ui.panel（浮窗）。读宿主记录走本进程内的原生 Node fs，
 * 宿主的权限网关不介入原生 Node 调用；这是刻意的取舍，因此本插件对宿主严格只读。
 */

"use strict";

const path = require("node:path");
const { homedir } = require("node:os");
const {
  DEFAULT_TAIL_BYTES,
  applyGapFallback,
  buildSnapshotFromEntries,
  hostRootFromDataPath,
  readCompletedTurnUsage,
  readSessionIndex,
  readTailEntries,
  scanSessionFile,
} = require("./host-read");
const { aggregateHistory } = require("./history");

/**
 * 本插件的版本号，随快照一起发布，供视图做自检。
 *
 * 为什么需要它：宿主在「安装插件包」时只重载插件进程，**不会**销毁已有的视图
 * webview（只有停用 / 卸载 / 崩溃 / dev 重载才销毁）。所以覆盖安装后，工作面板里
 * 跑的仍是安装前那份页面——数据是新的，界面却是旧的。视图拿这个版本号与自己的
 * 内置版本比对，发现落后就自行 reload，用户不必手动停用再启用。
 */
const PLUGIN_VERSION = require("./manifest.json").version;

/** 可见刷新节奏：1.2s 足够跟上流式回复，又不会把磁盘读爆。 */
const POLL_MS = 1200;
/** 主题/语言变化的检查节奏。 */
const APPEARANCE_POLL_MS = 3000;
/** 快照发布时保留的最近回复条数。 */
const RECENT_LIMIT = 20;

/**
 * 累计统计的刷新节奏。
 *
 * 为什么是 60 秒而不是跟实时快照同频：累计统计要读**所有**会话文件（本次核对为
 * 56 个 / 214 MB）。虽然 history.js 按文件指纹做了缓存、稳态只需几毫秒，但首次
 * 冷扫约 2.6 秒，放进 1.2 秒的轮询里会直接把插件进程拖住。年度 / 月度 / 日度这类
 * 数字本来也不需要秒级新鲜度。
 */
const HISTORY_POLL_MS = 60000;
/** 累计统计的缓存文件名，落在插件自己的数据目录。 */
const HISTORY_CACHE_FILE = "history-cache.json";

/** 本插件注册的命令 id；注册与注销共用一份，避免两处漂移。 */
const COMMAND_IDS = ["tokenMeter.openWidget", "tokenMeter.summary"];

/** 插件设置里的三个键，与 views/*.js 保持一致。 */
const KEY_SNAPSHOT = "meterSnapshot";
const KEY_APPEARANCE = "hostAppearance";
const KEY_HISTORY = "meterHistory";

let pollTimer = null;
let appearanceTimer = null;
let historyTimer = null;
/** 浮窗当前是否已打开；宿主没有查询接口，只能自己记账。 */
let widgetOpen = false;

/** 上一次扫描的会话文件与结果，用于增量合并与发布去重。 */
const cache = {
  file: null,
  sessionId: null,
  entries: [],
  malformedLines: 0,
  records: 0,
  bytes: 0,
  mtimeMs: null,
  /** 已发布的实时快照指纹，避免无谓写盘。 */
  publishedKey: null,
  appearanceKey: null,
  /** 累计统计的发布指纹。 */
  historyKey: null,
  /** 上次读数据库时对应的「最新回复 id」，用来决定是否需要重读 turns。 */
  turnsForLatestId: undefined,
};

/* ------------------------------------------------------------------ 工具 */

/** 解析宿主根目录；getDataPath 失败时退回 ~/.pi-desktop。 */
async function resolveHostRoot() {
  try {
    const dataPath = await pi.plugin.getDataPath();
    if (dataPath) return hostRootFromDataPath(dataPath);
  } catch {
    // 拿不到就退回默认位置，下面仍然会做存在性检查。
  }
  return path.join(homedir(), ".pi-desktop");
}

/**
 * 读宿主的主题/语言偏好。
 *
 * 宿主把它存在 kv 表（ns='app', key='app'）的 value_json 里。拿不到就返回
 * system，两个界面都会自己回退到 prefers-color-scheme。
 */
function readAppearance(hostRoot) {
  let sqlite;
  try {
    sqlite = require("node:sqlite");
  } catch {
    return { base: "system", locale: null, ok: false, reason: "NO_SQLITE" };
  }
  let db = null;
  try {
    db = new sqlite.DatabaseSync(path.join(hostRoot, "pi.sqlite"), { readOnly: true });
    const row = db.prepare("SELECT value_json FROM kv WHERE ns = ? AND key = ? LIMIT 1").get("app", "app");
    const parsed = row?.value_json ? JSON.parse(String(row.value_json)) : null;
    const theme = String(parsed?.theme ?? "").trim();
    const locale = String(parsed?.language ?? "").trim() || null;
    // plugin:<id>:<themeId> 这类插件主题由宿主解析成具体明暗，这里只当「跟随系统」。
    const base = theme === "light" || theme === "dark" ? theme : "system";
    return { base, locale, ok: Boolean(parsed), reason: parsed ? null : "NO_SETTINGS" };
  } catch (error) {
    return { base: "system", locale: null, ok: false, reason: error?.code || "READ_FAILED" };
  } finally {
    try {
      db?.close();
    } catch {
      /* 关闭失败没有可做的事 */
    }
  }
}

async function publishAppearance(hostRoot) {
  const appearance = readAppearance(hostRoot);
  const key = `${appearance.base}|${appearance.locale}|${appearance.ok}`;
  if (key === cache.appearanceKey) return;
  cache.appearanceKey = key;
  try {
    await pi.plugin.setSettings({ [KEY_APPEARANCE]: appearance });
  } catch {
    // 发布失败只影响配色跟随，下次轮询会重试。
  }
}

/* -------------------------------------------------------------- 扫描与合并 */

/** 首次（或切换会话后）完整扫描。 */
function fullScan(hostRoot) {
  const index = readSessionIndex(hostRoot);
  if (!index.ok || !index.active) {
    return { ok: false, reason: index.error || "NO_ACTIVE_SESSION", sessionFiles: index.sessions?.length || 0 };
  }
  const scan = scanSessionFile(index.active.file, { now: Date.now() });
  if (!scan.ok) return { ok: false, reason: scan.error || "SCAN_FAILED", sessionFiles: index.sessions.length };

  cache.file = index.active.file;
  cache.sessionId = scan.sessionId;
  cache.entries = scan.entries;
  cache.malformedLines = scan.malformedLines;
  cache.records = scan.records;
  cache.bytes = scan.bytes;
  cache.mtimeMs = scan.mtimeMs;

  return { ok: true, sessionFiles: index.sessions.length, added: undefined };
}

/**
 * 增量刷新：只读文件尾部，按 id 去重后追加。
 *
 * 两个兜底条件会退回完整扫描：
 *   1) 活跃会话换了（mtime 最新的文件变了）
 *   2) 文件增长量超过一个尾部窗口，说明尾部读不全，可能漏记录
 */
function incrementalScan(hostRoot) {
  const index = readSessionIndex(hostRoot);
  if (!index.ok || !index.active) {
    return { ok: false, reason: index.error || "NO_ACTIVE_SESSION", sessionFiles: index.sessions?.length || 0 };
  }
  const active = index.active;
  if (active.file !== cache.file) return fullScan(hostRoot);

  const grew = active.size - cache.bytes;
  if (grew > DEFAULT_TAIL_BYTES) return fullScan(hostRoot);
  if (grew <= 0 && active.mtimeMs === cache.mtimeMs) {
    // 文件没动，直接复用上一次的结果，省掉一次读盘。
    return { ok: true, sessionFiles: index.sessions.length, added: 0 };
  }

  const tail = readTailEntries(active.file, { sessionId: cache.sessionId, now: Date.now() });
  if (!tail.ok) {
    // 尾部读失败（文件被替换、权限变化等）就退回完整扫描。
    return fullScan(hostRoot);
  }

  const known = new Set(cache.entries.map((entry) => entry.id).filter(Boolean));
  let added = 0;
  for (const entry of tail.entries) {
    if (entry.id && known.has(entry.id)) continue;
    cache.entries.push(entry);
    if (entry.id) known.add(entry.id);
    added += 1;
  }
  cache.malformedLines += tail.malformedLines;
  cache.records += tail.records;
  cache.bytes = tail.size;
  cache.mtimeMs = tail.mtimeMs;

  // 新记录可能让上一条的「间隔估算」变得可算，所以合并后统一重跑一次。
  if (added > 0) applyGapFallback(cache.entries);

  return { ok: true, sessionFiles: index.sessions.length, added };
}

/** 组装并发布快照。返回快照本身，便于命令与测试复用。 */
async function publishSnapshot(hostRoot, options = {}) {
  const scan = options.full ? fullScan(hostRoot) : incrementalScan(hostRoot);
  const now = Date.now();

  if (!scan.ok) {
    const snapshot = {
      ok: false,
      pluginVersion: PLUGIN_VERSION,
      generatedAt: now,
      source: "transcript",
      reason: scan.reason,
      session: null,
      latest: null,
      recent: [],
      sqlite: { available: false, error: "NOT_READ", completedTurns: 0, remainder: null },
      diagnostics: { malformedLines: 0, records: 0, scannedBytes: 0, sessionFiles: scan.sessionFiles || 0 },
    };
    await publish(snapshot);
    return snapshot;
  }

  // 快照发布节奏远高于回合完成节奏，数据库只在「最新一条回复变了」时才值得读，
  // 否则每次轮询都开一次库是纯浪费。
  const latestId = cache.entries.length ? (cache.entries[cache.entries.length - 1]?.id ?? null) : null;
  let turns = null;
  if (options.full || latestId !== cache.turnsForLatestId) {
    turns = readCompletedTurnUsage(hostRoot);
    cache.turnsForLatestId = latestId;
  }

  const snapshot = buildSnapshotFromEntries({
    ok: true,
    now,
    entries: cache.entries,
    sessionId: cache.sessionId,
    fileMtimeMs: cache.mtimeMs,
    fileSize: cache.bytes,
    malformedLines: cache.malformedLines,
    records: cache.records,
    scannedBytes: cache.bytes,
    sessionFiles: scan.sessionFiles,
    readMode: scan.added === undefined ? "full" : "tail",
    limit: RECENT_LIMIT,
    turns,
  });
  // 视图靠这个字段判断自己是不是安装前的旧页面（见 PLUGIN_VERSION 的注释）。
  snapshot.pluginVersion = PLUGIN_VERSION;
  await publish(snapshot);
  return snapshot;
}

/** 只在数据真的变了时写设置：每次写都会落盘，不必要地写就是白白占用磁盘。 */
async function publish(snapshot) {
  const key = JSON.stringify([
    snapshot.ok,
    snapshot.reason || null,
    snapshot.session ? snapshot.session.replies : 0,
    snapshot.session ? snapshot.session.totals.total : 0,
    snapshot.latest ? snapshot.latest.id : null,
    snapshot.latest ? snapshot.latest.tokensPerSecond : null,
    snapshot.sqlite?.remainder?.turns || 0,
  ]);
  if (key === cache.publishedKey) return;
  cache.publishedKey = key;
  try {
    await pi.plugin.setSettings({ [KEY_SNAPSHOT]: snapshot });
  } catch (error) {
    cache.publishedKey = null; // 让下一次轮询重试
    throw error;
  }
}

/* -------------------------------------------------------------- 累计统计 */

/**
 * 读插件自己的数据目录，用于放累计统计的缓存。
 *
 * 这里写的是**插件自己的**目录（宿主通过 getDataPath 给的位置），不是宿主目录：
 * 本插件对宿主始终只读，唯一的写入落在自己的沙箱内。
 */
async function historyCacheFile() {
  try {
    const dataPath = await pi.plugin.getDataPath();
    if (dataPath) return path.join(String(dataPath), HISTORY_CACHE_FILE);
  } catch {
    // 拿不到目录就退化成「每次全量重扫」，功能不受影响，只是慢一点。
  }
  return null;
}

/**
 * 聚合跨会话历史并发布。
 *
 * 与实时快照分开的原因见 HISTORY_POLL_MS 的注释：这份数据要读所有会话文件，
 * 冷扫约 2.6 秒，不能跟着 1.2 秒的轮询走。稳态下按文件指纹命中缓存，只需几毫秒。
 */
async function publishHistory(hostRoot, options = {}) {
  const cacheFile = await historyCacheFile();
  // now 可注入：跨天 / 跨月 / 跨年的行为需要能在测试里确定性地复现，
  // 不能依赖「测试正好跑在某一天」。
  const history = aggregateHistory(hostRoot, {
    cacheFile,
    force: options.force === true,
    ...(Number.isFinite(options.now) ? { now: options.now } : {}),
  });
  if (!history.ok) {
    return history;
  }
  // 只有数字变了才写设置：写设置会落盘，不必要地写纯属浪费。
  // 刻意不含 files.rescanned —— 那是缓存诊断信息，冷扫转热缓存时它从 N 变 0，
  // 而用户看得见的数字一个都没动，不该因此再落一次盘。
  // 指纹里必须带上「当前周期」的三个 key：跨天 / 跨月 / 跨年后总量可能一条都没变
  // （用户还没说话），但「今日」「本月」已经该归零了。不含它就会一直显示昨天的数字。
  const key = JSON.stringify([
    history.totals?.replies || 0,
    history.totals?.tokens?.total || 0,
    history.days.length,
    history.models.length,
    history.periods?.day?.key || null,
    history.periods?.month?.key || null,
    history.periods?.year?.key || null,
  ]);
  if (key === cache.historyKey && !options.force) return history;
  cache.historyKey = key;
  try {
    await pi.plugin.setSettings({ [KEY_HISTORY]: history });
  } catch (error) {
    cache.historyKey = null; // 让下一次重试
    throw error;
  }
  return history;
}

/* ------------------------------------------------------------------ 浮窗 */

/** 打开速度浮窗。宿主对已存在的插件窗口是「聚焦」，所以重复调用是安全的。 */
async function openWidget() {
  try {
    await pi.ui.openPanel();
    widgetOpen = true;
    return true;
  } catch (error) {
    await pi.ui.showToast(`Token 计量：打开浮窗失败（${error?.message ?? error}）`, "warn");
    return false;
  }
}

async function closeWidget() {
  try {
    await pi.ui.closePanel();
    widgetOpen = false;
    return true;
  } catch {
    // 窗口已经不在了
    widgetOpen = false;
    return false;
  }
}

/** 当前速度的一句话摘要，命令与 Toast 共用。 */
function speedSentence(snapshot) {
  if (!snapshot.ok || !snapshot.latest) return null;
  const latest = snapshot.latest;
  const speed = Number.isFinite(latest.tokensPerSecond) ? Math.round(latest.tokensPerSecond) : null;
  if (speed === null) return `本次输出 ${latest.outputTokens} tok（速度未知）`;
  const prefix = latest.tokensPerSecondEstimated ? "约 " : "";
  const seconds = Number.isFinite(latest.durationMs) ? (latest.durationMs / 1000).toFixed(1) : null;
  return `${prefix}${speed} tokens/s · 输出 ${latest.outputTokens} tok${seconds ? ` · 用时 ${seconds}s` : ""}`;
}

/* ---------------------------------------------------------------- 生命周期 */

async function onLoad() {
  const hostRoot = await resolveHostRoot();

  // 主题先发布：两个界面首帧就能用对配色。
  await publishAppearance(hostRoot);

  // 首扫必须快，否则 onLoad 会超时（上限 15s）。转录本读取是同步的，
  // 单个会话文件通常几百 KB 到几 MB，远在预算内。
  await publishSnapshot(hostRoot, { full: true }).catch(() => undefined);

  pollTimer = setInterval(() => {
    void publishSnapshot(hostRoot).catch(() => undefined);
  }, POLL_MS);
  pollTimer.unref?.();

  appearanceTimer = setInterval(() => {
    void publishAppearance(hostRoot);
  }, APPEARANCE_POLL_MS);
  appearanceTimer.unref?.();

  // 累计统计：首帧先算一次（冷扫约 2.6 秒，但 onLoad 有 15 秒预算），
  // 之后走 60 秒的慢节奏。这里 await 一次是值得的：面板一打开就有年/月/日数字，
  // 而不是先显示空看板再补。
  await publishHistory(hostRoot).catch(() => undefined);
  historyTimer = setInterval(() => {
    void publishHistory(hostRoot).catch(() => undefined);
  }, HISTORY_POLL_MS);
  historyTimer.unref?.();
  await pi.commands.register({
    id: COMMAND_IDS[0],
    title: "Token 计量：显示/隐藏速度浮窗",
    keywords: ["token", "tokens", "speed", "tps", "hud", "浮窗", "速度", "计量"],
    category: "Productivity",
    run: async () => {
      if (widgetOpen) {
        await closeWidget();
        await pi.ui.showToast("Token 计量：已隐藏速度浮窗", "info");
        return;
      }
      const opened = await openWidget();
      if (opened) {
        await pi.ui.showToast("Token 计量：浮窗已显示，拖动它到你想固定的位置即可", "info");
      }
    },
  });

  await pi.commands.register({
    id: COMMAND_IDS[1],
    title: "Token 计量：查看本次生成速度",
    keywords: ["token", "tokens", "speed", "tps", "usage", "用量", "速度", "计量"],
    category: "Productivity",
    run: async () => {
      const snapshot = await publishSnapshot(hostRoot, { full: true });
      const sentence = speedSentence(snapshot);
      await pi.ui.showToast(
        sentence ? `Token 计量：${sentence}` : "Token 计量：当前会话还没有可统计的回复",
        "info",
      );
    },
  });

  // 浮窗默认打开，这样装完就能立刻看到速度并拖到固定位置。
  // 不希望它常驻的话，用「显示/隐藏速度浮窗」命令关掉即可（本次运行内有效）。
  await openWidget();
}

async function onUnload() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  if (appearanceTimer) clearInterval(appearanceTimer);
  appearanceTimer = null;
  if (historyTimer) clearInterval(historyTimer);
  historyTimer = null;
  for (const id of COMMAND_IDS) {
    try {
      await pi.commands.unregister(id);
    } catch {
      // 已经没了
    }
  }
}

module.exports = {
  onLoad,
  onUnload,
  __test: {
    COMMAND_IDS,
    HISTORY_POLL_MS,
    fullScan,
    incrementalScan,
    publishSnapshot,
    publishHistory,
    readAppearance,
    resolveHostRoot,
    speedSentence,
    resetCache: () => {
      cache.file = null;
      cache.sessionId = null;
      cache.entries = [];
      cache.malformedLines = 0;
      cache.records = 0;
      cache.bytes = 0;
      cache.mtimeMs = null;
      cache.publishedKey = null;
      cache.appearanceKey = null;
      cache.historyKey = null;
      cache.turnsForLatestId = undefined;
    },
  },
};
