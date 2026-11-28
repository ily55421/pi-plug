import { randomUUID } from "node:crypto";
import config from "../config.cjs";
const { normalize, systemMatches, signature } = config;
const PLUGIN_ID = "local.context-guard";
export function limitError(message) {
  if (message?.stopReason !== "error" && message?.status !== "error") return false;
  const text = [message.errorMessage, message.error?.code, message.error?.message,
    ...(Array.isArray(message.content) ? message.content.filter(block => block?.type === "text").map(block => block.text) : [])].filter(value => typeof value === "string").join("\n");
  return /session_turn_limit_exceeded|this conversation has reached\s+\d+\s+model turns|当前会话模型已回复\s*100\s*轮/i.test(text);
}
const numeric = value => Number.isSafeInteger(value) && value >= 0;
export function createSystemTracker({ readSettings, readState = () => ({}), readControl = () => ({}), publish, now, isNative, autoRequests }) {
  const sessions = new Map();
  const instanceId = randomUUID();
  function stateFor(ctx) {
    let id;
    try { id = ctx.sessionManager.getSessionId(); } catch { return null; }
    if (typeof id !== "string" || !id) return null;
    if (!sessions.has(id)) {
      let previous = {};
      try { previous = readState(id) || {}; } catch { /* 旧状态无法确认时从观察计数起步。 */ }
      const valid = previous.schemaVersion === 2 && previous.sessionId === id;
      sessions.set(id, { sessionId: id, requestSerial: valid && numeric(previous.requestSerial) ? previous.requestSerial : 0,
        checkpointSerial: valid && numeric(previous.checkpointSerial) ? previous.checkpointSerial : 0,
        countExact: false, queued: false, running: false, lastIndex: null, lastCompactAt: valid ? previous.lastCompactAt || null : null,
        limitExceeded: valid && previous.limitExceeded === true, limitAt: valid ? previous.limitAt || 0 : 0, blockedSignature: null });
    }
    const state = sessions.get(id);
    try {
      const control = readControl(id);
      if (control?.lastCompactAt > (state.lastCompactAt || 0)) {
        state.lastCompactAt = control.lastCompactAt;
        if (numeric(control.baseSerial) && control.baseSerial <= state.requestSerial) state.checkpointSerial = Math.max(state.checkpointSerial, control.baseSerial);
        state.limitExceeded = false; state.limitAt = 0; state.queued = false; state.countExact = true; state.blockedSignature = null;
      }
    } catch { /* 不把状态读取失败伪造成压缩成功。 */ }
    return state;
  }
  function desktopQueue(ctx) {
    try {
      return !isNative(ctx) && typeof ctx.compact === "function" && ctx.sessionManager.getLeafId?.() === null
        && Array.isArray(ctx.sessionManager.getBranch?.()) && ctx.sessionManager.getBranch().length === 0;
    } catch { return false; }
  }
  function report(ctx, state, settings, phase, message) {
    if (!state) return Promise.resolve();
    const snapshot = { schemaVersion: 2, instanceId, sessionId: state.sessionId, capability: isNative(ctx) ? "native" : "system",
      compressionMode: "system", phase, message, requestSerial: state.requestSerial, checkpointSerial: state.checkpointSerial,
      count: Math.max(0, state.requestSerial - state.checkpointSerial), countExact: state.countExact,
      queued: state.queued, running: state.running, limitExceeded: state.limitExceeded, limitAt: state.limitAt,
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, api: ctx.model.api } : null,
      threshold: settings.threshold, lastCompactAt: state.lastCompactAt, updatedAt: now(), settingsSignature: signature(settings) };
    try {
      const short = !settings.enabled ? "系统模式 · 自动规则关闭" : state.queued ? "系统压缩已排队" : `系统压缩 · 已记录 ${snapshot.count} 轮`;
      ctx.ui?.setStatus?.(PLUGIN_ID, `续航压缩：${short}`);
    } catch { /* 无界面宿主也能工作。 */ }
    return Promise.resolve(publish(snapshot)).catch(() => {});
  }
  function phaseFor(ctx, settings, state) {
    if (!settings.enabled) return ["disabled", "系统压缩可用，自动规则已关闭。"];
    if (!systemMatches(ctx.model, settings)) return ["notMatched", "当前模型未匹配规则，系统手动压缩不受影响。"];
    if (state.blockedSignature === signature(settings)) return ["cooldown", "本轮系统压缩失败，暂停自动排队；可手动重试。"];
    if (state.queued) return ["queued", "已请求系统压缩，等待本轮内的原生压缩或任务结束后的补执行。"];
    return ["ready", "正在记录模型轮次；使用宿主原生压缩，不需要独立摘要模型。"];
  }
  function requestDesktop(ctx, state, settings) {
    if (!systemMatches(ctx.model, settings) || state.queued || state.blockedSignature === signature(settings)
      || state.requestSerial - state.checkpointSerial < settings.threshold || !desktopQueue(ctx)) return;
    // 桌面兼容层的 compact() 仅置 pending。同步调用，早于后续模型轮次；不捕获 ctx 到定时器。
    const latest = readSettings();
    if (latest?.then || signature(latest) !== signature(settings)) return;
    state.queued = true; autoRequests.set(state.sessionId, signature(settings));
    try { ctx.compact(); }
    catch { state.queued = false; state.blockedSignature = signature(settings); autoRequests.delete(state.sessionId); }
  }
  function current(raw) { return normalize(raw); }
  function refresh(_event, ctx, raw) {
    const state = stateFor(ctx); if (!state) return;
    const settings = current(raw);
    return report(ctx, state, settings, ...phaseFor(ctx, settings, state));
  }
  const handlers = {
    session_start: refresh,
    session_switch: refresh,
    model_select: refresh,
    agent_start(_event, ctx, raw) { const state = stateFor(ctx); if (state) state.running = true; return refresh(_event, ctx, raw); },
    turn_start(event, ctx, raw) {
      const state = stateFor(ctx); if (!state) return;
      const settings = current(raw);
      const index = Number.isInteger(event.turnIndex) ? event.turnIndex : event.timestamp;
      if (index !== undefined && state.lastIndex === index) return;
      state.lastIndex = index; state.running = true; state.requestSerial++;
      requestDesktop(ctx, state, settings);
      return report(ctx, state, settings, ...phaseFor(ctx, settings, state));
    },
    turn_end(event, ctx, raw) {
      const state = stateFor(ctx); if (!state) return;
      const settings = current(raw);
      if (limitError(event.message)) { state.limitExceeded = true; state.limitAt = now(); }
      requestDesktop(ctx, state, settings);
      return report(ctx, state, settings, ...phaseFor(ctx, settings, state));
    },
    message_end(event, ctx, raw) {
      if (!limitError(event.message)) return;
      const state = stateFor(ctx); if (!state) return;
      state.limitExceeded = true; state.limitAt = now();
      return report(ctx, state, current(raw), "queued", "检测到 session_turn_limit_exceeded；任务结束后按规则调用系统压缩。");
    },
    agent_end(_event, ctx, raw) { return refresh(_event, ctx, raw); },
    agent_settled(_event, ctx, raw) {
      const state = stateFor(ctx); if (!state) return;
      state.running = false;
      const settings = current(raw);
      if (isNative(ctx) && systemMatches(ctx.model, settings) && !state.queued && state.requestSerial - state.checkpointSerial >= settings.threshold
        && state.blockedSignature !== signature(settings) && ctx.isIdle?.() && !ctx.hasPendingMessages?.()) {
        state.queued = true; autoRequests.set(state.sessionId, signature(settings));
        ctx.compact({ onError: () => { state.queued = false; state.blockedSignature = signature(settings); autoRequests.delete(state.sessionId); }, onComplete: () => { state.queued = false; } });
      }
      return report(ctx, state, settings, ...phaseFor(ctx, settings, state));
    },
    session_before_compact(_event, ctx, raw) {
      const state = stateFor(ctx); if (!state) return;
      // 返回 undefined，明确让宿主执行自己的压缩，而非要求自定义摘要契约。
      return report(ctx, state, current(raw), "compacting", "宿主正在执行系统原生压缩，主模型保持不变。").then(() => undefined);
    },
    session_compact(_event, ctx, raw) {
      const state = stateFor(ctx); if (!state) return;
      state.checkpointSerial = state.requestSerial; state.countExact = true; state.queued = false;
      state.limitExceeded = false; state.limitAt = 0; state.blockedSignature = null; state.lastCompactAt = now();
      autoRequests.delete(state.sessionId);
      return report(ctx, state, current(raw), "success", "系统压缩已完成，主模型保持不变；可以继续。" );
    },
    session_compact_failed(_event, ctx, raw) {
      const state = stateFor(ctx); if (!state) return;
      state.queued = false; state.blockedSignature = signature(raw); autoRequests.delete(state.sessionId);
      return report(ctx, state, current(raw), "cooldown", "宿主压缩失败，计数未重置；请在空闲后手动重试。" );
    },
    session_shutdown(_event, ctx) {
      try { const id = ctx.sessionManager.getSessionId(); sessions.delete(id); autoRequests.delete(id); ctx.ui?.setStatus?.(PLUGIN_ID, undefined); } catch { /* 会话可能已释放。 */ }
    },
  };
  return { handlers, cancel(id) { const state = sessions.get(id); if (state) state.queued = false; autoRequests.delete(id); } };
}
