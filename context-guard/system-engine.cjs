"use strict";
const { normalize, systemMatches, signature } = require("./config.cjs");
function validId(id) { return typeof id === "string" && id.length > 0 && id.length <= 512; }
function numeric(value) { return Number.isSafeInteger(value) && value >= 0; }
function errorInfo(error) {
  const raw = String(error?.errorCode || error?.code || "");
  const text = String(error?.message || "");
  if (raw === "AGENT_BUSY" || /already has an active turn/i.test(text)) return { code: "AGENT_BUSY", message: "会话正在运行，已延后压缩；没有中断任务。" };
  if (/PERMISSION|CONFIRMATION/.test(raw)) return { code: "PERMISSION_DENIED", message: "请在插件页授予 desktop.control 权限并重新加载插件。" };
  if (raw === "RESULT_UNKNOWN" || /TIMEOUT/.test(raw) || /timed? out|timeout/i.test(text)) return { code: "RESULT_UNKNOWN", message: "系统压缩结果暂未确认，请先刷新状态；不会自动重复执行。" };
  return { code: "COMPACTION_FAILED", message: "系统压缩未完成，已暂停自动重试；可在空闲时手动重试或使用 /compact。" };
}
function countOf(telemetry, control) {
  if (telemetry?.schemaVersion !== 2 || !numeric(telemetry.requestSerial)) return null;
  const base = Math.max(numeric(telemetry.checkpointSerial) ? telemetry.checkpointSerial : 0, numeric(control.baseSerial) ? control.baseSerial : 0);
  return telemetry.requestSerial >= base ? telemetry.requestSerial - base : null;
}
function createSystemEngine({ getSettings, readTelemetry, readControl, writeControl, getCapabilities, invoke, now = Date.now, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const flights = new Map();
  const cache = new Map();
  const handled = new Set();
  let disposed = false;
  async function controlOf(id) {
    if (!cache.has(id)) cache.set(id, await readControl(id) || {});
    return cache.get(id);
  }
  async function store(id, control) { cache.set(id, control); await writeControl(id, control); }
  async function snapshot(sessionId) {
    const settings = normalize(await getSettings());
    const capabilities = await getCapabilities();
    if (!validId(sessionId)) return { phase: "waiting", capability: capabilities.available ? "system" : "permissionRequired", systemAvailable: false, compressionMode: settings.compressionMode, count: null, threshold: settings.threshold, message: "打开一个普通桌面会话后可使用系统压缩。" };
    const [telemetry, control] = await Promise.all([readTelemetry(sessionId), controlOf(sessionId)]);
    const isNative = sessionId.startsWith("native-pi:");
    const systemAvailable = capabilities.available && !isNative;
    const t = telemetry?.schemaVersion === 2 && telemetry.sessionId === sessionId ? telemetry : {};
    const count = countOf(t, control);
    const lastCompactAt = Math.max(t.lastCompactAt || 0, control.lastCompactAt || 0) || null;
    const base = { sessionId, systemAvailable, capability: systemAvailable ? "system" : isNative && t.capability === "native" ? "native" : "permissionRequired", compressionMode: settings.compressionMode,
      count, countExact: t.countExact === true && numeric(t.requestSerial) && count !== null, threshold: settings.threshold, model: t.model || null, lastCompactAt, updatedAt: now() };
    if (settings.compressionMode === "dedicated") return { ...base, capability: t.capability === "native" ? "native" : "unsupported", phase: t.capability === "native" ? t.phase || "waiting" : "unsupported", message: t.capability === "native" ? t.message : "当前桌面会话不支持独立摘要模型；请选择系统原生压缩，或直接点击立即系统压缩。" };
    if (!systemAvailable) return { ...base, phase: "unsupported", message: isNative ? "当前是 Native Pi 会话，请使用该会话自身的 /compact；桌面系统命令只处理普通会话。" : capabilities.message };
    if (flights.has(sessionId)) return { ...base, phase: "compacting", message: "系统原生压缩执行中，主模型保持不变。" };
    try {
      const live = (await invoke("agent/getStatus", [sessionId]))?.status;
      if (!live || typeof live.isRunning !== "boolean") return { ...base, phase: "waiting", systemAvailable: false, message: "尚不能确认会话运行状态，请刷新后再压缩。" };
      if (live.isRunning) return { ...base, phase: live.activity?.phase === "compacting" ? "compacting" : "busy", message: live.activity?.phase === "compacting" ? "系统正在压缩上下文。" : "会话正在运行，空闲后可系统压缩；不会中断当前任务。" };
    } catch { return { ...base, phase: "error", systemAvailable: false, message: "系统状态查询失败，请刷新后再试；仍可使用 /compact。" }; }
    if (control.phase === "success" && control.settingsSignature === signature(settings) && now() - control.updatedAt < 30000) return { ...base, phase: "success", message: control.message };
    if (!settings.enabled) return { ...base, phase: "disabled", message: "自动规则已关闭；仍可点击立即系统压缩。" };
    if (!systemMatches(t.model, settings)) return { ...base, phase: "notMatched", message: "当前主模型未匹配规则，系统手动压缩仍可使用。" };
    if (control.blocked && control.settingsSignature === signature(settings) && (!t.lastCompactAt || t.lastCompactAt <= control.updatedAt)) return { ...base, phase: "cooldown", message: control.message };
    if (t.queued && count >= settings.threshold) return { ...base, phase: "queued", message: "已请求系统压缩；工具循环中执行，或在本轮任务结束后补执行。" };
    return { ...base, phase: "ready", message: count === null ? "系统压缩可用；旧会话可先立即压缩一次建立计数基线。" : `已记录 ${count} 次模型轮次。计数可能不完整，不包含 HTTP 内部重试。` };
  }
  async function perform(sessionId, options) {
    let telemetry = await readTelemetry(sessionId) || {};
    const settings = normalize(await getSettings());
    const sig = signature(settings);
    const automatic = options.manual !== true;
    const previous = await controlOf(sessionId);
    if (automatic && (!systemMatches(telemetry.model, settings) || options.expectedSignature && options.expectedSignature !== sig)) return { ok: false, code: "CANCELLED", message: "规则已经关闭或变更，未发起系统压缩。" };
    const capabilities = await getCapabilities();
    if (!capabilities.available || sessionId.startsWith("native-pi:")) return { ok: false, code: "UNSUPPORTED", message: capabilities.message || "此会话不能使用桌面系统压缩。" };
    if (automatic && previous.blocked && previous.settingsSignature === sig && (!telemetry.lastCompactAt || telemetry.lastCompactAt <= previous.updatedAt)) return { ok: false, code: "COOLDOWN", message: "已暂停自动重试，请手动压缩或调整配置。" };
    try {
      const state = (await invoke("agent/getStatus", [sessionId]))?.status;
      if (!state || typeof state.isRunning !== "boolean") return { ok: false, code: "STATUS_UNKNOWN", message: "无法确认会话空闲状态，未发起压缩。" };
      if (state.isRunning) return { ok: false, code: "AGENT_BUSY", message: "会话正在运行，等待结束后再压缩。" };
      await store(sessionId, { ...previous, phase: "compacting", blocked: false, settingsSignature: sig, updatedAt: now() });
      const current = normalize(await getSettings());
      telemetry = await readTelemetry(sessionId) || {};
      if (disposed || automatic && (!systemMatches(telemetry.model, current) || signature(current) !== sig)) return { ok: false, code: "CANCELLED", message: "规则已经关闭或变更，未发起压缩。" };
      if (automatic) {
        const count = countOf(telemetry, previous);
        const limit = telemetry.limitExceeded === true && current.rescueOnLimit && (telemetry.limitAt || 0) > Math.max(previous.lastCompactAt || 0, telemetry.lastCompactAt || 0);
        if (!(count !== null && count >= current.threshold) && !limit) return { ok: false, code: "NOT_DUE", message: "本轮已压缩或尚未达到阈值，跳过重复请求。" };
      }
      // 官方命令会再次检查忙碌状态；不调用 abort，不修改模型，也不发送新消息。
      const result = await invoke("agent/compact", [{ sessionId }]);
      if (result?.accepted !== true) throw Object.assign(new Error("unconfirmed"), { code: "RESULT_UNKNOWN" });
      const completedAt = now();
      const next = { ...previous, phase: "success", blocked: false, settingsSignature: signature(await getSettings()),
        baseSerial: numeric(telemetry.requestSerial) ? telemetry.requestSerial : 0, lastCompactAt: completedAt, updatedAt: completedAt,
        message: "系统压缩已完成，主模型保持不变；现在可以点击继续或发送下一条请求。" };
      try { await store(sessionId, next); } catch { next.message += " 本地状态保存失败，请刷新确认。"; }
      return { ok: true, runtime: { ...(await snapshot(sessionId)), phase: "success", message: next.message, lastCompactAt: completedAt } };
    } catch (error) {
      const info = errorInfo(error);
      const next = { ...previous, phase: info.code === "AGENT_BUSY" ? "queued" : "cooldown", blocked: info.code !== "AGENT_BUSY", settingsSignature: sig, message: info.message, updatedAt: now() };
      try { await store(sessionId, next); } catch { /* 原始结果已保留在当前进程缓存，不盲目重试。 */ }
      return { ok: false, ...info };
    }
  }
  async function compact(sessionId, options = {}) {
    if (!validId(sessionId)) return { ok: false, code: "NO_SESSION", message: "请先打开目标会话。" };
    if (disposed) return { ok: false, code: "UNLOADED", message: "插件已卸载。" };
    if (flights.has(sessionId)) return { ok: false, code: "AGENT_BUSY", message: "该会话已在压缩，请勿重复点击。" };
    // 在第一个 await 之前加锁，阻止手动和自动请求重复执行。
    const operation = Promise.resolve().then(() => perform(sessionId, options));
    flights.set(sessionId, operation);
    try { return await operation; } finally { if (flights.get(sessionId) === operation) flights.delete(sessionId); }
  }
  async function onTurnEnded(raw) {
    const event = raw?.payload || raw;
    if (disposed || !validId(event?.sessionId) || typeof event.turnId !== "string" || event.reason === "aborted") return;
    const token = JSON.stringify([event.sessionId, event.turnId]);
    if (handled.has(token)) return;
    handled.add(token); if (handled.size > 512) handled.delete(handled.values().next().value);
    // 宿主完成通知和扩展的私有文件落盘是独立通道，给最后一条遥测有限的刷新机会。
    await delay(120);
    const settings = normalize(await getSettings());
    if (!settings.enabled || settings.compressionMode !== "system") return;
    let telemetry = await readTelemetry(event.sessionId) || {};
    if (event.reason === "error" && settings.rescueOnLimit && !telemetry.limitExceeded) {
      await delay(120); telemetry = await readTelemetry(event.sessionId) || {};
    }
    const control = await controlOf(event.sessionId);
    const count = countOf(telemetry, control);
    const limit = telemetry.limitExceeded === true && settings.rescueOnLimit && (telemetry.limitAt || 0) > Math.max(control.lastCompactAt || 0, telemetry.lastCompactAt || 0);
    if (event.reason === "error" && !limit) return;
    if (!limit && !(count !== null && count >= settings.threshold)) return;
    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (disposed) return;
      result = await compact(event.sessionId, { expectedSignature: signature(settings) });
      if (result?.code !== "AGENT_BUSY") return result;
      if (attempt < 2) await delay(200);
    }
    return result;
  }
  return { snapshot, compact, onTurnEnded, dispose() { disposed = true; } };
}
module.exports = { createSystemEngine, countOf, errorInfo };
