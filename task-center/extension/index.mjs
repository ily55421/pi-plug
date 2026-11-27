import { homedir } from "node:os";
import { join } from "node:path";
import state from "../state.cjs";
import storage from "../storage.cjs";
import { decideResidue, isSuccessfulProgress, normalizeSettings, remainingOf, summarizeGuard } from "./core.mjs";

const PLUGIN_ID = "local.task-center";
function pluginDataDir() {
  return join(process.env.PI_DESKTOP_DATA_DIR || join(homedir(), ".pi-desktop"), "plugins", "data", PLUGIN_ID);
}
async function readSettings() {
  return storage.readSettingsFile(pluginDataDir());
}
function guardSettings(settings) {
  return normalizeSettings({ enabled: settings.guardEnabled, maxNudges: settings.maxNudges, stallLimit: settings.stallLimit });
}
function sessionKeyOf(event, ctx) {
  const fromCtx = ctx?.sessionManager?.getSessionId?.();
  return state.sessionIdOf({ sessionId: fromCtx ?? event?.sessionId });
}
function freshGuard(runId = null) {
  return { runId, nudges: 0, stall: 0, stopped: false, running: false, sideEffect: false, failed: false, baseline: null, pending: null, last: null, error: null };
}
function failedMessage(message) {
  return message?.role === "assistant" && ["aborted", "error"].includes(message.stopReason);
}

// 每个 Runner 各自持有状态；测试可注入只读设置源，无需接触真实用户数据。
export default function taskCenterGuard(pi, options = {}) {
  const load = options.readSettings ?? readSettings;
  const guards = new Map();
  let queue = Promise.resolve();
  const serial = (handler) => (event, ctx) => {
    const result = queue.then(() => handler(event, ctx));
    queue = result.catch(() => undefined);
    return result;
  };
  function guardFor(id) {
    if (!guards.has(id)) guards.set(id, freshGuard());
    return guards.get(id);
  }
  function adopt(id, snapshot) {
    const guard = guardFor(id);
    if (guard.runId !== snapshot.runId) {
      const next = freshGuard(snapshot.runId);
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

  pi.on("before_agent_start", serial(async (event, ctx) => {
    let id;
    try {
      id = sessionKeyOf(event, ctx);
      const settings = await load();
      const snapshot = state.snapshot(settings, id);
      const limits = guardSettings(settings);
      let guard = adopt(id, snapshot);
      if (!limits.enabled) {
        guard = freshGuard(snapshot.runId);
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
      guard.last = { action: pending.action, reason: pending.reason ?? null, at: Date.now() };
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
      const settings = await load();
      const snapshot = state.snapshot(settings, id);
      const current = adopt(id, snapshot);
      if (current !== guard) return undefined; // 运行内新建了计划，先建立下一轮基线。
      const verdict = decideResidue({ todos: snapshot.todos, beforeTodos: guard.baseline?.todos, sideEffect: guard.sideEffect, nudges: guard.nudges, stall: guard.stall, stopped: guard.stopped, settings: guardSettings(settings) });
      guard.stall = verdict.stall;
      guard.error = null;
      if (!snapshot.remainingCount || !guardSettings(settings).enabled) {
        guards.set(id, freshGuard(snapshot.runId));
      } else if (verdict.progressed) {
        guard.last = { action: "progress", reason: null, at: Date.now() };
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
    description: "读取当前会话守卫的计数、待投递提示与读取错误；不会续跑或停止模型。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_callId, _params, _signal, _onUpdate, ctx) {
      await queue;
      try {
        const id = sessionKeyOf(undefined, ctx);
        const settings = await load();
        const snapshot = state.snapshot(settings, id);
        const guard = guards.get(id)?.runId === snapshot.runId ? guards.get(id) : freshGuard(snapshot.runId);
        const limits = guardSettings(settings);
        const details = { ok: !guard.error, sessionId: id, runId: snapshot.runId, settings: limits, nudges: guard.nudges, stall: guard.stall, unfinished: remainingOf(snapshot.todos).length, stopped: guard.stopped, pending: guard.pending?.action ?? null, last: guard.last, error: guard.error };
        return { content: [{ type: "text", text: guard.error ? `守卫状态读取曾失败：${guard.error.message}` : summarizeGuard({ todos: snapshot.todos, ...guard, settings: limits }) }], details, ...(guard.error ? { isError: true } : {}) };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error.message }], details: { ok: false, code: error.code || "GUARD_ERROR" } };
      }
    },
  });
}
export { readSettings, pluginDataDir, sessionKeyOf, guardSettings };
