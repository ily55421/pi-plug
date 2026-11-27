import { homedir } from "node:os";
import { join } from "node:path";
import state from "../state.cjs";
import storage from "../storage.cjs";
import { decideResidue, isSuccessfulProgress, normalizeSettings, remainingOf, summarizeGuard } from "./core.mjs";

const PLUGIN_ID = "local.task-center";
// 守卫状态只用于当前运行期计数：超时或超过容量后丢弃，避免长期运行无限增长。
const GUARD_TTL_MS = 30 * 60 * 1000;
const MAX_GUARDS = 100;
function pluginDataDir() {
  return join(process.env.PI_DESKTOP_DATA_DIR || join(homedir(), ".pi-desktop"), "plugins", "data", PLUGIN_ID);
}
async function readSettings() {
  return storage.readSettingsFile(pluginDataDir());
}
async function readState(directory, settings, sessionId) {
  return storage.readState(directory, settings, sessionId);
}
function guardSettings(settings) {
  return normalizeSettings({ enabled: settings.guardEnabled, maxNudges: settings.maxNudges, stallLimit: settings.stallLimit });
}
function sessionKeyOf(event, ctx) {
  const fromCtx = ctx?.sessionManager?.getSessionId?.();
  return state.sessionIdOf({ sessionId: fromCtx ?? event?.sessionId });
}
function freshGuard(runId = null, at = 0) {
  return { runId, nudges: 0, stall: 0, stopped: false, running: false, sideEffect: false, failed: false, baseline: null, pending: null, last: null, error: null, touchedAt: at };
}
function failedMessage(message) {
  return message?.role === "assistant" && ["aborted", "error"].includes(message.stopReason);
}

// 每个 Runner 各自持有状态；测试可注入只读设置源，无需接触真实用户数据。
export default function taskCenterGuard(pi, options = {}) {
  const load = options.readSettings ?? readSettings;
  const loadSession = options.readState ?? readState;
  const listArchives = options.archiveInventory ?? storage.archiveInventory;
  const now = options.now ?? (() => Date.now());
  const ttlMs = Number.isSafeInteger(options.guardTtlMs) && options.guardTtlMs > 0 ? options.guardTtlMs : GUARD_TTL_MS;
  const maxGuards = Number.isSafeInteger(options.maxGuards) && options.maxGuards > 0 ? options.maxGuards : MAX_GUARDS;
  const guards = new Map();
  let queue = Promise.resolve();
  const serial = (handler) => (event, ctx) => {
    const result = queue.then(async () => {
      let id;
      try { id = sessionKeyOf(event, ctx); } catch { /* 无有效会话时仍然清理其他会话的陈旧状态。 */ }
      pruneGuards(id);
      return handler(event, ctx);
    });
    queue = result.catch(() => undefined);
    return result;
  };
  function guardFor(id) {
    let guard = guards.get(id);
    if (!guard) {
      guard = freshGuard(null, now());
      guards.set(id, guard);
    }
    guard.touchedAt = now();
    return guard;
  }
  // 正在运行或有待投递提醒的守卫不会被回收，避免丢失计数与提示。
  function pruneGuards(currentId) {
    const at = now();
    for (const [id, guard] of guards) {
      if (id === currentId || guard.running || guard.pending) continue;
      if (at - guard.touchedAt > ttlMs) guards.delete(id);
    }
    if (guards.size <= maxGuards) return;
    const candidates = [...guards]
      .filter(([id, guard]) => id !== currentId && !guard.running)
      .sort((a, b) => a[1].touchedAt - b[1].touchedAt);
    for (const [id] of candidates.slice(0, guards.size - maxGuards)) guards.delete(id);
  }
  function adopt(id, snapshot) {
    const guard = guardFor(id);
    if (guard.runId !== snapshot.runId) {
      const next = freshGuard(snapshot.runId, now());
      guards.set(id, next);
      return next;
    }
    return guard;
  }
  function recordError(id, error) {
    if (!id) return;
    const guard = guardFor(id);
    guard.running = false;
    guard.pending = null;
    guard.error = { code: error.code || "GUARD_ERROR", message: error.message };
  }
  // Load the file inventory as well as the index so archived bytes count against the same budget.
  async function inspect(id) {
    const settings = await load();
    const directory = pluginDataDir();
    const [session, archiveFiles] = await Promise.all([
      loadSession(directory, settings, id), listArchives(directory),
    ]);
    const snapshot = state.snapshotOf(session, id, {
      legacyAvailable: state.legacyAvailable(settings), capacity: storage.capacityOf(settings, { archiveFiles }),
    });
    return { settings, snapshot, limits: guardSettings(settings) };
  }

  pi.on("before_agent_start", serial(async (event, ctx) => {
    let id;
    try {
      id = sessionKeyOf(event, ctx);
      const { snapshot, limits } = await inspect(id);
      let guard = adopt(id, snapshot);
      if (!limits.enabled) {
        guard = freshGuard(snapshot.runId, now());
        guards.set(id, guard);
        return undefined;
      }
      const pending = guard.pending;
      guard.pending = null;
      guard.error = null;
      guard.running = true;
      guard.failed = false;
      guard.sideEffect = false;
      guard.baseline = snapshot;
      // 下一轮前计划已变更或已完成，就不再投递过期提示。
      if (!pending || pending.runId !== snapshot.runId || pending.revision !== snapshot.revision || !snapshot.remainingCount) return undefined;
      guard.nudges = pending.nudges;
      if (pending.action === "stopped") guard.stopped = true;
      guard.last = { action: pending.action, reason: pending.reason ?? null, at: now() };
      const original = typeof event?.systemPrompt === "string" ? event.systemPrompt : "";
      return { systemPrompt: `${original}${original ? "\n\n" : ""}[${pending.notice}] ${pending.text}` };
    } catch (error) { recordError(id, error); return undefined; }
  }));

  pi.on("tool_result", serial(async (event, ctx) => {
    let id;
    try {
      id = sessionKeyOf(event, ctx);
      const guard = guardFor(id);
      if (guard.running && isSuccessfulProgress(event?.toolName, event?.isError === true, event?.details)) guard.sideEffect = true;
    } catch (error) { recordError(id, error); }
    return undefined;
  }));
  pi.on("message_end", serial(async (event, ctx) => {
    try { if (failedMessage(event?.message)) guardFor(sessionKeyOf(event, ctx)).failed = true; } catch { /* 无有效会话时不共享计数。 */ }
  }));
  pi.on("agent_end", serial(async (event, ctx) => {
    try { if (event?.messages?.some(failedMessage) || ["aborted", "error"].includes(event?.reason)) guardFor(sessionKeyOf(event, ctx)).failed = true; } catch { /* 仅记录结束原因。 */ }
  }));
  pi.on("agent_settled", serial(async (event, ctx) => {
    let id;
    try {
      id = sessionKeyOf(event, ctx);
      const guard = guardFor(id);
      if (!guard.running) return undefined; // 重复结束事件不重复结算。
      guard.running = false;
      guard.pending = null;
      if (guard.failed || ["aborted", "error"].includes(event?.reason)) return undefined;
      // 结算必须以最新状态为准，因此这里总是重新读取（命中缓存时不会重复读盘）。
      const { settings, snapshot, limits } = await inspect(id);
      const current = adopt(id, snapshot);
      if (current !== guard) return undefined; // 运行内新建了计划，先建立下一轮基线。
      const verdict = decideResidue({ todos: snapshot.todos, beforeTodos: guard.baseline?.todos, sideEffect: guard.sideEffect, nudges: guard.nudges, stall: guard.stall, stopped: guard.stopped, settings: limits });
      guard.stall = verdict.stall;
      guard.error = null;
      if (!snapshot.remainingCount || !limits.enabled) {
        guards.set(id, freshGuard(snapshot.runId, now()));
      } else if (verdict.progressed) {
        guard.last = { action: "progress", reason: null, at: now() };
      } else if (verdict.action !== "none") {
        guard.pending = { ...verdict, runId: snapshot.runId, revision: snapshot.revision };
      }
    } catch (error) { recordError(id, error); }
    return undefined;
  }));
  pi.on("session_shutdown", serial(async (event, ctx) => {
    try { guards.delete(sessionKeyOf(event, ctx)); } catch { /* 无共享回退状态。 */ }
  }));

  pi.registerTool({
    name: "todo_guard_status", label: "任务守卫状态",
    description: "读取当前会话守卫的计数、待投递提示、读取错误、容量占用与存储指标；不会续跑或停止模型。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_callId, _params, _signal, _onUpdate, ctx) {
      await queue;
      try {
        const id = sessionKeyOf(undefined, ctx);
        const { snapshot, limits } = await inspect(id);
        const guard = guards.get(id)?.runId === snapshot.runId ? guards.get(id) : freshGuard(snapshot.runId, now());
        const details = {
          ok: !guard.error, sessionId: id, runId: snapshot.runId, settings: limits,
          nudges: guard.nudges, stall: guard.stall, unfinished: remainingOf(snapshot.todos).length,
          stopped: guard.stopped, pending: guard.pending?.action ?? null, last: guard.last, error: guard.error,
          capacity: snapshot.capacity, storage: storage.metrics(),
        };
        return { content: [{ type: "text", text: guard.error ? `守卫状态读取曾失败：${guard.error.message}` : summarizeGuard({ todos: snapshot.todos, ...guard, settings: limits }) }], details, ...(guard.error ? { isError: true } : {}) };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error.message }], details: { ok: false, code: error.code || "GUARD_ERROR" } };
      }
    },
  });
  return { guards, pruneGuards };
}
export { readSettings, pluginDataDir, sessionKeyOf, guardSettings, GUARD_TTL_MS, MAX_GUARDS };