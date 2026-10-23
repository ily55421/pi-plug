/**
 * local.trajectory — 插件进程入口。
 *
 * 职责：把视图的 onPanelInvoke 通道分发到 engine.js 的索引引擎上。
 * 视图 ↔ 插件进程的自定义 RPC 是宿主已验证的范式（pi.terminal 的 pty.*、
 * IDEA Git 的 git/* 都走这条路），比把大 JSON 写进设置再轮询便宜得多。
 *
 * 权限：只声明 ui.view。读会话转录本走本进程内的原生 Node fs（宿主的
 * 权限网关不介入原生 Node 调用，这是官方插件 pi.token-insights /
 * local.token-meter 已采用的取舍），因此本插件对宿主严格只读，
 * 只写自己数据目录下的缓存。不联网、不注册 agent 工具。
 */

"use strict";

const path = require("node:path");
const fsp = require("node:fs/promises");
const os = require("node:os");
const engine = require("./engine");

/** 与 manifest.json 的 contributes.commands 一致。 */
const COMMAND_ID = "local.trajectory.rebuild";

/** 索引缓存写在插件自己的数据目录下：<dataPath>/cache/trajectory/。 */
let cacheDir = null;
/** 宿主会话目录：~/.pi-desktop/sessions（按数据目录推导，失败时退回默认）。 */
let sessionsDir = null;
let unloaded = false;
/** 同一文件的重建成去重表，避免 list/timeline 并发时重复建。 */
const inflight = new Map();
/** 外观（明暗/语言）缓存，宿主 API 读取有成本，做 3s TTL。 */
let appearanceCache = { at: 0, value: null };

/* ------------------------------------------------------------- 目录解析 */

/** dataPath = <root>/plugins/data/<id> → 上溯三级得到宿主数据根。 */
function hostRootFromDataPath(dataPath) {
  let p = String(dataPath);
  for (let i = 0; i < 3; i++) p = path.dirname(p);
  return p;
}

async function resolveDirs() {
  let dataPath = null;
  try {
    dataPath = await pi.plugin.getDataPath();
  } catch {
    /* 拿不到就退回默认布局 */
  }
  const root = dataPath ? hostRootFromDataPath(dataPath) : path.join(os.homedir(), ".pi-desktop");
  cacheDir = path.join(dataPath || path.join(root, "plugins", "data", "local.trajectory"), "cache");
  sessionsDir = path.join(root, "sessions");
}

function validFileName(name) {
  return (
    typeof name === "string" &&
    /^[A-Za-z0-9._-]+\.jsonl$/.test(name) &&
    !name.endsWith(".revisions.jsonl")
  );
}

function filePathOf(name) {
  return path.join(sessionsDir, name);
}

/** 同一文件的索引构建去重；热加载后的并发调用共享同一个 Promise。 */
async function loadIndexShared(file, opts) {
  const key = file + "|" + JSON.stringify(opts || {});
  if (inflight.has(key)) return inflight.get(key);
  const p = engine.loadIndex(file, cacheDir, opts).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/* --------------------------------------------------------------- 外观 */

async function readAppearanceFromKv() {
  try {
    const sqlite = require("node:sqlite");
    let root = path.dirname(path.dirname(sessionsDir));
    const db = new sqlite.DatabaseSync(path.join(root, "pi.sqlite"), { readOnly: true });
    try {
      const row = db.prepare("SELECT value_json FROM kv WHERE ns = ? AND key = ? LIMIT 1").get("app", "app");
      const parsed = row && row.value_json ? JSON.parse(String(row.value_json)) : null;
      const theme = String(parsed && parsed.theme ? parsed.theme : "").trim();
      const locale = String(parsed && parsed.language ? parsed.language : "").trim() || null;
      const base = theme === "light" || theme === "dark" ? theme : "system";
      return { base, locale, source: "kv" };
    } finally {
      try {
        db.close();
      } catch {
        /* 关闭失败没有可做的事 */
      }
    }
  } catch {
    return { base: "system", locale: null, source: "fallback" };
  }
}

async function readAppearance() {
  const now = Date.now();
  if (appearanceCache.value && now - appearanceCache.at < 3000) return appearanceCache.value;
  let value = null;
  try {
    value = await pi.app.getAppearance();
  } catch {
    /* 宿主版本没有该 API 时走 kv 表 */
  }
  if (!value || !value.base) value = await readAppearanceFromKv();
  appearanceCache = { at: now, value };
  return value;
}

/* --------------------------------------------------------- 宿主会话信号 */

/**
 * 读宿主权威信号（pi.sqlite，只读）：
 *   sessions 表 → Map<id, {title, deletedAt}>（对齐宿主侧栏显示名）；
 *   messages 表 → 最近一条真人输入（role=user）的会话 id —— 「当前会话」一级信号。
 * 失败时返回 {sessions:null, currentId:null}，引擎自动降级（index-user → mtime）。
 */
let hostFactsCache = { at: 0, value: null };

async function readHostFacts() {
  const now = Date.now();
  if (hostFactsCache.value && now - hostFactsCache.at < 2000) return hostFactsCache.value;
  const value = readHostFactsNow();
  hostFactsCache = { at: now, value };
  return value;
}

function readHostFactsNow() {
  let root = sessionsDir ? path.dirname(path.dirname(sessionsDir)) : null;
  if (!root) return { sessions: null, currentId: null };
  let sqlite;
  try {
    sqlite = require("node:sqlite");
  } catch {
    return { sessions: null, currentId: null };
  }
  let db = null;
  try {
    db = new sqlite.DatabaseSync(path.join(root, "pi.sqlite"), { readOnly: true });
    const map = new Map();
    for (const row of db.prepare("SELECT id, title, deleted_at FROM sessions").all()) {
      map.set(String(row.id), {
        title: row.title ? String(row.title) : null,
        deletedAt: row.deleted_at == null ? null : Number(row.deleted_at),
      });
    }
    let currentId = null;
    try {
      const hit = db
        .prepare("SELECT session_id FROM messages WHERE role = 'user' ORDER BY created_at DESC LIMIT 1")
        .get();
      if (hit && hit.session_id) currentId = String(hit.session_id);
    } catch {
    /* 老版本宿主没有 messages 表：降级 */
    }
    return { sessions: map, currentId };
  } catch {
    return { sessions: null, currentId: null };
  } finally {
    try {
      db?.close();
    } catch {
    /* 关闭失败没有可做的事 */
    }
  }
}

/* ------------------------------------------------------------- 通道实现 */

async function handleList() {
  const facts = await readHostFacts();
  return engine.listSessions(sessionsDir, cacheDir, {
    hostSessions: facts.sessions,
    hostCurrentId: facts.currentId,
  });
}

async function handleTimeline(payload) {
  if (!validFileName(payload && payload.file)) return { ok: false, error: "BAD_FILE" };
  const file = filePathOf(payload.file);
  const { index } = await loadIndexShared(file, { allowBuild: true });
  return engine.timelineFrom(index);
}

async function handleTurn(payload) {
  if (!validFileName(payload && payload.file)) return { ok: false, error: "BAD_FILE" };
  if (!Number.isFinite(payload && payload.turnN)) return { ok: false, error: "BAD_TURN" };
  const file = filePathOf(payload.file);
  const { index } = await loadIndexShared(file, { allowBuild: true });
  return engine.turnItems(file, index, payload.turnN, {
    offset: payload.offset,
    limit: payload.limit,
  });
}

async function handleBlock(payload) {
  if (!validFileName(payload && payload.file)) return { ok: false, error: "BAD_FILE" };
  const p = payload || {};
  if (!Number.isFinite(p.off) || !Number.isFinite(p.len) || !Number.isInteger(p.bi)) {
    return { ok: false, error: "BAD_RANGE" };
  }
  if (p.off < 0 || p.len <= 0 || p.bi < 0 || p.bi > 4096) return { ok: false, error: "BAD_RANGE" };
  return engine.blockAt(filePathOf(p.file), p.off, p.len, p.bi);
}

async function handleAppearance() {
  const value = await readAppearance();
  return { ok: true, ...value };
}

/** 强制重建（单个或全部）。全部重建放后台跑，完成时 toast。 */
async function handleRebuild(payload) {
  if (payload && validFileName(payload.file)) {
    const file = filePathOf(payload.file);
    const index = await engine.buildIndex(file);
    try {
      const fsp2 = require("node:fs/promises");
      await fsp2.writeFile(path.join(cacheDir, "idx", payload.file + ".json"), JSON.stringify(index), "utf8");
    } catch {
      /* 缓存写失败不影响返回 */
    }
    return { ok: true, file: payload.file, turns: index.turns.length };
  }
  // 全部重建：立即返回，后台逐个做。
  void rebuildAllInBackground().catch(() => undefined);
  return { ok: true, started: true };
}

async function rebuildAllInBackground() {
  if (unloaded) return;
  let names = [];
  try {
    names = (await fsp.readdir(sessionsDir)).filter(
      (n) => n.endsWith(".jsonl") && !n.endsWith(".revisions.jsonl"),
    );
  } catch {
    return;
  }
  let done = 0;
  for (const name of names) {
    if (unloaded) return;
    try {
      await engine.buildIndex(path.join(sessionsDir, name));
      done++;
    } catch {
      /* 单个失败继续下一个 */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    await pi.ui.showToast(`轨迹回放：已重建 ${done}/${names.length} 个会话索引`, "info");
  } catch {
    /* toast 失败无所谓 */
  }
}

/** 启动时后台预热：把还没有缓存的索引补齐，避免首次打开视图卡顿。 */
async function warmup() {
  let names = [];
  try {
    names = (await fsp.readdir(sessionsDir)).filter(
      (n) => n.endsWith(".jsonl") && !n.endsWith(".revisions.jsonl"),
    );
  } catch {
    return;
  }
  const stats = [];
  for (const name of names) {
    try {
      stats.push({ name, st: await fsp.stat(path.join(sessionsDir, name)) });
    } catch {
      /* 忽略已消失的文件 */
    }
  }
  stats.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  for (const { name } of stats) {
    if (unloaded) return;
    try {
      await loadIndexShared(path.join(sessionsDir, name), { allowBuild: true });
    } catch {
      /* 预热失败留给按需路径重试 */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/* --------------------------------------------------------------- 生命周期 */

async function onLoad() {
  unloaded = false;
  await resolveDirs();
  await pi.commands.register({
    id: COMMAND_ID,
    title: "轨迹回放：重建全部会话索引",
    keywords: ["trajectory", "replay", "session", "timeline", "轨迹", "回放", "索引"],
    category: "Data",
    run: async () => {
      await pi.ui.showToast("轨迹回放：后台重建索引中，完成后会提醒", "info");
      void rebuildAllInBackground().catch(() => undefined);
    },
  });
  // 预热不阻塞 onLoad（15s 上限），也不在乎完成度——按需路径自会兜底。
  void warmup().catch(() => undefined);
}

async function onUnload() {
  unloaded = true;
  try {
    await pi.commands.unregister(COMMAND_ID);
  } catch {
    /* 已经没了 */
  }
  inflight.clear();
}

/**
 * 面板桥把宿主不认识的通道原样转发到这里。所有分支都返回 {ok, ...}，
 * 抛错也兜成 {ok:false, error}，视图侧永远拿到可判定的形状。
 */
async function onPanelInvoke(channel, payload) {
  try {
    switch (channel) {
      case "trajectory.list":
        return await handleList();
      case "trajectory.timeline":
        return await handleTimeline(payload);
      case "trajectory.turn":
        return await handleTurn(payload);
      case "trajectory.block":
        return await handleBlock(payload);
      case "trajectory.appearance":
        return await handleAppearance();
      case "trajectory.rebuild":
        return await handleRebuild(payload);
      default:
        return { ok: false, error: "UNKNOWN_CHANNEL" };
    }
  } catch (error) {
    return { ok: false, error: error && error.message ? String(error.message) : String(error) };
  }
}

module.exports = { onLoad, onUnload, onPanelInvoke };
