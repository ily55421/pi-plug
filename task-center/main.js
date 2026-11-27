"use strict";

const { randomUUID } = require("node:crypto");
const state = require("./state.cjs");
const storage = require("./storage.cjs");
const manifest = require("./manifest.json");

// Different sessions share one index, so read/modify/write operations are serialized in-process.
let writes = Promise.resolve();
let dataDirectory = null;
const SETTINGS_DEFAULTS = Object.fromEntries(manifest.contributes.settings.map((setting) => [setting.key, setting.default]));

function cancelled(ctx) {
  if (ctx?.signal?.aborted) state.fail("ABORTED", "调用已取消，未保存任务清单。");
}
function errorResult(error) {
  return {
    ok: false, code: error.code || "TASK_CENTER_ERROR", message: error.message || "任务中心操作失败。",
    retryable: ["STORAGE_READ_FAILED", "STORAGE_WRITE_FAILED", "STORAGE_ROLLBACK_FAILED", "PURGE_PARTIAL", "ABORTED"].includes(error.code),
  };
}
// getDataPath is host IPC and remains stable for the process lifetime; failed results are not cached.
async function dataPath() {
  if (typeof pi.plugin.getDataPath !== "function") state.fail("HOST_UNSUPPORTED", "宿主缺少插件私有数据路径接口。");
  if (!dataDirectory) {
    const pending = (async () => {
      const directory = await pi.plugin.getDataPath();
      if (typeof directory !== "string" || !directory) state.fail("STORAGE_READ_FAILED", "插件私有数据路径不可用。");
      return directory;
    })();
    pending.catch(() => { if (dataDirectory === pending) dataDirectory = null; });
    dataDirectory = pending;
  }
  return dataDirectory;
}
function enqueue(operation) {
  const result = writes.then(operation);
  writes = result.catch(() => undefined);
  return result;
}
function retentionLimit(settings) {
  const raw = settings?.maxStoredSessions;
  const value = typeof raw === "number" || typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= 1 && value <= 1000 ? Math.floor(value) : SETTINGS_DEFAULTS.maxStoredSessions;
}
function settingsBytes(settings) {
  return Buffer.byteLength(JSON.stringify({ ...SETTINGS_DEFAULTS, ...settings }, null, 2), "utf8");
}
function storeOf(settings) {
  const store = state.storeOf(settings);
  storage.validateIndex(store.index);
  return store;
}
async function capacityOf(settings, directory) {
  const archiveFiles = await storage.archiveInventory(directory);
  return storage.capacityOf(settings, { settingsBytes: settingsBytes(settings), archiveFiles });
}
async function loadSettings(directory) {
  try { return await storage.readSettingsFile(directory); }
  catch (error) {
    if (["STATE_CORRUPT", "STATE_TOO_LARGE", "STORAGE_READ_FAILED"].includes(error.code)) throw error;
    state.fail("STORAGE_READ_FAILED", "任务清单读取失败，无法确认是否还有剩余任务。请稍后重试。");
  }
}
async function snapshotOf(directory, settings, sessionId) {
  const session = await storage.readState(directory, settings, sessionId);
  return state.snapshotOf(session, sessionId, {
    legacyAvailable: state.legacyAvailable(settings), capacity: await capacityOf(settings, directory),
  });
}
function compact(snapshot) {
  const { ok, sessionId, runId, revision, updatedAt, total, counts, finished, percent, remainingCount, current, legacyAvailable, archived, capacity } = snapshot;
  return {
    ok, sessionId, runId, revision, updatedAt, total, counts, finished, percent, remainingCount,
    current: current?.content ?? null, legacyAvailable, archived, capacity,
  };
}

// Migrate legacy inline state only on a write path; read-only operations keep using the fallback.
async function migrateInline(directory, settings, store) {
  if (!state.record(store.sessions)) state.fail("STATE_CORRUPT", "旧版会话清单存储格式损坏，原数据未覆盖。");
  let index = {};
  for (const [key, value] of Object.entries(store.sessions)) {
    const sessionId = typeof key === "string" && key.startsWith("session:") ? key.slice("session:".length) : "";
    if (!sessionId) state.fail("STATE_CORRUPT", "旧版会话清单包含无法识别的会话键，未迁移任何数据。");
    const session = state.validateSession(value, { sessionId });
    const payload = storage.encodeSession(sessionId, session);
    const existing = await storage.readState(directory, {}, sessionId);
    if (!existing || existing.revision <= session.revision) await storage.writeSessionFile(directory, sessionId, payload);
    index = storage.nextIndex(index, sessionId, session, payload.bytes.length, state.summarize(session.todos));
  }
  const nextStore = { version: state.VERSION, index };
  try { await pi.plugin.setSettings({ [state.KEY]: nextStore }); }
  catch { storage.invalidate(directory); state.fail("STORAGE_WRITE_FAILED", "旧版会话迁移未完成，原数据未覆盖，请重试。"); }
  storage.invalidate(directory);
  storage.noteMigration();
  return { ...settings, [state.KEY]: nextStore };
}
async function writableSettings(directory) {
  const settings = await loadSettings(directory);
  const store = settings[state.KEY];
  if (state.record(store) && store.version === state.LEGACY_VERSION) return migrateInline(directory, settings, store);
  return settings;
}

// Persist the session file first, then the index. Cancellation compensates both sides when possible.
async function commit(directory, settings, store, sessionId, session, previous, ctx) {
  const payload = storage.encodeSession(sessionId, session);
  if (payload.bytes.length > storage.MAX_SESSION_BYTES) {
    state.fail("STATE_TOO_LARGE", "单个会话清单超过 2 MiB 上限，未保存。请拆分或缩短任务列表。");
  }
  const planned = storage.planRetention(
    storage.nextIndex(store.index, sessionId, session, payload.bytes.length, state.summarize(session.todos)),
    { keepSessionId: sessionId, maxStored: retentionLimit(settings) },
  );
  const nextStore = { version: state.VERSION, index: planned.index };
  const capacity = await capacityOf({ ...settings, [state.KEY]: nextStore }, directory);
  if (capacity.usedBytes > storage.MAX_BYTES) {
    state.fail("STATE_TOO_LARGE", "全部会话清单（含归档）超过 8 MiB 预算，未保存。请执行 taskCenter.purgeArchived 手动清理已归档会话。");
  }

  let sessionWriteStarted = false;
  let settingsWriteStarted = false;
  let indexCommitted = false;
  try {
    cancelled(ctx);
    sessionWriteStarted = true;
    await storage.writeSessionFile(directory, sessionId, payload);
    cancelled(ctx);
    settingsWriteStarted = true;
    await pi.plugin.setSettings({ [state.KEY]: nextStore });
    indexCommitted = true;
    cancelled(ctx);
  } catch (error) {
    let rollbackError = null;
    const aborting = error?.code === "ABORTED" || error?.code === "PLUGIN_TOOL_ABORTED" || ctx?.signal?.aborted;
    if (settingsWriteStarted) {
      let needsIndexRollback = indexCommitted || aborting;
      if (!needsIndexRollback) {
        try {
          storage.invalidate(directory);
          const persisted = await loadSettings(directory);
          needsIndexRollback = JSON.stringify(persisted[state.KEY]) === JSON.stringify(nextStore);
        } catch { needsIndexRollback = true; }
      }
      if (needsIndexRollback) {
        try { await pi.plugin.setSettings({ [state.KEY]: store }); }
        catch (failure) { rollbackError = failure; }
      }
    }
    if (sessionWriteStarted) {
      try { await storage.restoreSession(directory, sessionId, previous); }
      catch (failure) { rollbackError ??= failure; }
    }
    storage.invalidate(directory);
    if (rollbackError) state.fail("STORAGE_ROLLBACK_FAILED", "写入后的自动回滚未能确认。请先重新读取任务和历史状态，再继续修改。");
    if (aborting) state.fail("ABORTED", "调用已取消，未保存任务清单。");
    state.fail("STORAGE_WRITE_FAILED", "任务清单保存失败，请读取当前版本后重试。");
  }
  storage.invalidate(directory);
  for (const hash of planned.archive) await storage.archiveSessionFile(directory, hash);
  return state.snapshotOf(session, sessionId, { legacyAvailable: state.legacyAvailable(settings), capacity });
}

async function executeTodoWrite(args, ctx) {
  try {
    const sessionId = state.sessionIdOf(ctx);
    cancelled(ctx);
    const { todos, notes } = state.normalizeTodos(args?.todos);
    if (args?.expectedRevision !== undefined && (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0)) {
      state.fail("INVALID_REVISION", "expectedRevision 必须是非负安全整数。");
    }
    if (args?.newPlan !== undefined && typeof args.newPlan !== "boolean") state.fail("INVALID_ARGUMENT", "newPlan 必须是布尔值。");
    return await enqueue(async () => {
      cancelled(ctx);
      const directory = await dataPath();
      const settings = await writableSettings(directory);
      cancelled(ctx);
      const store = storeOf(settings);
      const previous = await storage.readState(directory, settings, sessionId);
      if (args.expectedRevision !== undefined && args.expectedRevision !== previous.revision) {
        return { ok: false, code: "REVISION_CONFLICT", revision: previous.revision, runId: previous.runId, message: "清单已被更新，请先 todo_read，再合并并使用最新 revision 提交。" };
      }
      const newPlan = args.newPlan === true || !previous.runId ||
        (state.summarize(previous.todos).remainingCount === 0 && state.summarize(todos).remainingCount > 0);
      if (!newPlan && JSON.stringify(previous.todos) === JSON.stringify(todos)) {
        return { ...compact(await snapshotOf(directory, settings, sessionId)), unchanged: true, notes };
      }
      if (previous.revision >= Number.MAX_SAFE_INTEGER) state.fail("REVISION_LIMIT", "清单版本已达上限，请导出数据后联系维护者。");
      const next = {
        todos, runId: newPlan ? randomUUID() : previous.runId,
        revision: previous.revision + 1, updatedAt: Date.now(),
      };
      return { ...compact(await commit(directory, settings, store, sessionId, next, previous, ctx)), notes };
    });
  } catch (error) { return errorResult(error); }
}

async function executeTodoRead(args, ctx) {
  try {
    const sessionId = state.sessionIdOf(ctx);
    cancelled(ctx);
    if (args?.detail !== undefined && !["summary", "full"].includes(args.detail)) state.fail("INVALID_ARGUMENT", "detail 只能为 summary 或 full。");
    await writes;
    const directory = await dataPath();
    const settings = await loadSettings(directory);
    cancelled(ctx);
    const snapshot = await snapshotOf(directory, settings, sessionId);
    if (args?.detail === "summary") return compact(snapshot);
    return { ...compact(snapshot), todos: snapshot.todos };
  } catch (error) { return errorResult(error); }
}

// The Agent tool is read-only. Permanent deletion is exposed only as a dedicated user-invoked command.
function historyIndexOf(settings) {
  const legacy = settings?.[state.KEY];
  if (state.record(legacy) && legacy.version === state.LEGACY_VERSION) {
    if (!state.record(legacy.sessions)) state.fail("STATE_CORRUPT", "旧版会话清单存储格式损坏，原数据未覆盖。");
    let index = {};
    for (const [key, value] of Object.entries(legacy.sessions)) {
      const sessionId = typeof key === "string" && key.startsWith("session:") ? key.slice("session:".length) : "";
      if (!sessionId) state.fail("STATE_CORRUPT", "旧版会话清单包含无法识别的会话键，未读取任何历史数据。");
      const session = state.validateSession(value, { sessionId });
      const payload = storage.encodeSession(sessionId, session);
      index = storage.nextIndex(index, sessionId, session, payload.bytes.length, state.summarize(session.todos));
    }
    return index;
  }
  return storeOf(settings).index;
}

async function executeTodoHistory(args, ctx) {
  try {
    state.sessionIdOf(ctx);
    const action = args?.action ?? "list";
    if (action !== "list") state.fail("INVALID_ARGUMENT", "todo_history 仅支持只读 list；永久清理请手动执行 taskCenter.purgeArchived。");
    return await enqueue(async () => {
      const directory = await dataPath();
      const settings = await loadSettings(directory);
      const index = historyIndexOf(settings);
      const entries = Object.entries(index)
        .sort((a, b) => (Number(b[1].updatedAt) || 0) - (Number(a[1].updatedAt) || 0));
      return {
        ok: true, total: entries.length, capacity: await capacityOf(settings, directory),
        sessions: entries.slice(0, 50).map(([, entry]) => ({
          id: entry.id, revision: entry.revision, updatedAt: entry.updatedAt,
          bytes: entry.bytes, total: entry.total, remaining: entry.remaining,
          archived: entry.archived, purgePending: entry.purgePending === true,
        })),
      };
    });
  } catch (error) { return errorResult(error); }
}

// The explicit command is the user confirmation boundary. A pending marker makes partial cleanup retryable.
async function executeArchivePurgeCommand() {
  try {
    return await enqueue(async () => {
      const directory = await dataPath();
      const settings = await writableSettings(directory);
      const store = storeOf(settings);
      const hashes = Object.entries(store.index)
        .filter(([, entry]) => entry.archived === true)
        .map(([hash]) => hash);
      const indexedHashes = new Set(Object.keys(store.index));

      if (!hashes.length) {
        const orphaned = await storage.purgeOrphanedArchives(directory, indexedHashes);
        return orphaned.failed.length
          ? { ok: false, code: "PURGE_PARTIAL", removed: orphaned.removed, pending: orphaned.failed.length, message: "部分未登记归档文件仍未清理；再次执行此命令可重试。" }
          : { ok: true, removed: orphaned.removed, message: "没有已登记归档会话；已清理旧版遗留归档文件。" };
      }

      const pendingIndex = { ...store.index };
      for (const hash of hashes) pendingIndex[hash] = { ...pendingIndex[hash], purgePending: true };
      try { await pi.plugin.setSettings({ [state.KEY]: { version: state.VERSION, index: pendingIndex } }); }
      catch { storage.invalidate(directory); state.fail("STORAGE_WRITE_FAILED", "无法记录清理状态，尚未删除归档文件；请稍后重试。"); }
      storage.invalidate(directory);

      const files = await storage.purgeArchived(directory, hashes);
      const orphaned = await storage.purgeOrphanedArchives(directory, new Set(Object.keys(pendingIndex)));
      const removedHashes = new Set(files.removed);
      const finalIndex = { ...pendingIndex };
      for (const hash of removedHashes) delete finalIndex[hash];
      try { await pi.plugin.setSettings({ [state.KEY]: { version: state.VERSION, index: finalIndex } }); }
      catch {
        storage.invalidate(directory);
        state.fail("STORAGE_WRITE_FAILED", "文件清理已开始，索引保留 purgePending 标记；再次执行此命令可安全完成清理。");
      }
      storage.invalidate(directory);

      const removed = files.removed.length + orphaned.removed;
      const pending = files.failed.length + orphaned.failed.length;
      if (pending) {
        return { ok: false, code: "PURGE_PARTIAL", removed, pending, message: "部分归档文件仍未清理；索引保留待清理状态，再次执行此命令可重试。" };
      }
      return { ok: true, removed, message: `已永久清理 ${removed} 个归档文件。` };
    });
  } catch (error) { return errorResult(error); }
}

// The panel gets its session identity from the bridge when the plugin process cannot query it directly.
let lastSessionId = null;
function rememberTurn(event) {
  const id = event?.sessionId ?? event?.payload?.sessionId;
  if (typeof id === "string" && id && id.length <= 512) lastSessionId = id;
}
async function identityOf(payload) {
  if (payload?.noActiveSession === true) state.fail("NO_ACTIVE_SESSION", "当前没有打开的会话。");
  if (typeof pi.session?.getActive === "function") {
    const active = await pi.session.getActive();
    const id = active?.sessionId ?? active?.id;
    if (typeof id === "string" && id) return { id: state.sessionIdOf({ sessionId: id }), fromHost: true };
  }
  if (typeof payload?.sessionId === "string" && payload.sessionId) {
    return { id: state.sessionIdOf({ sessionId: payload.sessionId }), fromHost: false };
  }
  if (lastSessionId) return { id: state.sessionIdOf({ sessionId: lastSessionId }), fromHost: false };
  state.fail("NO_ACTIVE_SESSION", "当前没有打开的会话。");
}

async function onPanelInvoke(channel, payload) {
  try {
    if (channel !== "taskCenter.snapshot") state.fail("UNKNOWN_CHANNEL", "不支持的任务中心接口。");
    if (payload !== undefined && !state.record(payload)) state.fail("INVALID_ARGUMENT", "快照参数必须为对象。");
    const { id: sessionId, fromHost } = await identityOf(payload);
    await writes;
    const directory = await dataPath();
    const settings = await loadSettings(directory);
    const result = await snapshotOf(directory, settings, sessionId);
    if (fromHost && (await identityOf()).id !== sessionId) state.fail("SESSION_CHANGED", "会话已切换，正在刷新任务。");
    if (payload?.knownSessionId === sessionId && payload?.knownRunId === result.runId &&
        payload?.knownRevision === result.revision) {
      return { ok: true, unchanged: true, sessionId, runId: result.runId, revision: result.revision };
    }
    return result;
  } catch (error) { return errorResult(error); }
}

const handlers = { todo_write: executeTodoWrite, todo_read: executeTodoRead, todo_history: executeTodoHistory };

async function runOpenCommand() {
  try {
    const sessionId = lastSessionId ?? (typeof pi.session?.getActive === "function" ? (await identityOf()).id : null);
    if (typeof pi.ui.revealView === "function") {
      await pi.ui.revealView(sessionId ? { viewId: "tasks", sessionId } : { viewId: "tasks" });
    } else {
      await pi.ui.showToast("打开右侧面板 → 任务，查看当前会话清单。", "info");
    }
  } catch (error) { await pi.ui.showToast(error.message, "error"); }
}
async function runArchivePurgeCommand() {
  const result = await executeArchivePurgeCommand();
  await pi.ui.showToast(result.message || "归档清理操作已完成。", result.ok ? "info" : "error");
  return result;
}

async function onLoad() {
  for (const descriptor of manifest.contributes.agentTools) {
    await pi.agent.registerTool({ ...descriptor, execute: handlers[descriptor.name] });
  }
  if (typeof pi.events?.on === "function") {
    try { pi.events.on("session:turnEnded", rememberTurn); } catch { /* Older hosts may not expose event subscriptions. */ }
  }
  const commandRunners = {
    "taskCenter.open": runOpenCommand,
    "taskCenter.purgeArchived": runArchivePurgeCommand,
  };
  for (const descriptor of manifest.contributes.commands) {
    const run = commandRunners[descriptor.id];
    if (run) await pi.commands.register({ ...descriptor, run });
  }
}
async function onUnload() {
  await writes;
  await Promise.allSettled([
    ...manifest.contributes.agentTools.map((tool) => pi.agent.unregisterTool(tool.name)),
    ...manifest.contributes.commands.map((command) => pi.commands.unregister(command.id)),
  ]);
}
module.exports = {
  onLoad, onUnload, onPanelInvoke,
  __test: { ...state, storage, executeTodoRead, executeTodoWrite, executeTodoHistory, executeArchivePurgeCommand, retentionLimit },
};
