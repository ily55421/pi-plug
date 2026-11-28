"use strict";
const { readFile, writeFile, mkdir, rename, rm } = require("node:fs/promises");
const { join } = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { normalize, validate } = require("./config.cjs");
const { createSystemEngine } = require("./system-engine.cjs");
let writes = Promise.resolve();
let engine = null;
const statusName = id => `status-${createHash("sha256").update(id).digest("hex").slice(0, 24)}.json`;
const controlName = id => statusName(id).replace("status-", "system-");
async function readJson(name) {
  try {
    const raw = await readFile(join(await pi.plugin.getDataPath(), name), "utf8");
    if (raw.length > 32768) throw new Error("状态记录过大。");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("状态格式无效。");
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw Object.assign(new Error("插件状态读取失败，请刷新或重新加载插件。"), { code: "STATE_CORRUPT" });
  }
}
async function writeJson(name, value) {
  const dir = await pi.plugin.getDataPath();
  const file = join(dir, name);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await mkdir(dir, { recursive: true });
  try { await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }).catch(() => {}); }
}
async function capabilities() {
  if (typeof pi.desktop?.listOperations !== "function" || typeof pi.desktop?.invoke !== "function") return { available: false, message: "需要宿主提供 desktop.control 和 agent/compact 接口；仍可使用系统 /compact。" };
  try {
    const operations = await pi.desktop.listOperations();
    const ids = new Set(operations.map(row => row.id));
    return ids.has("agent/compact") && ids.has("agent/getStatus") ? { available: true } : { available: false, message: "当前宿主没有开放系统压缩操作，请使用 /compact 或升级宿主。" };
  } catch { return { available: false, message: "请在插件页授予新增的 desktop.control 权限并重新加载插件；系统自身的 /compact 不受影响。" }; }
}
function system() {
  if (!engine) engine = createSystemEngine({
    getSettings: () => pi.plugin.getSettings(),
    readTelemetry: async id => { const value = await readJson(statusName(id)); return value.sessionId === id ? value : {}; },
    readControl: id => readJson(controlName(id)),
    writeControl: (id, value) => writeJson(controlName(id), value),
    getCapabilities: capabilities,
    invoke: (operation, args) => pi.desktop.invoke({ operation, args }),
  });
  return engine;
}
async function models() {
  const rows = await pi.models.list();
  return (Array.isArray(rows) ? rows : []).map(row => ({ key: row.key, providerId: row.providerId, providerName: row.providerName, modelId: row.modelId, label: row.label }));
}
async function activeId() {
  const active = typeof pi.session?.getActive === "function" ? await pi.session.getActive() : null;
  return typeof active?.sessionId === "string" ? active.sessionId : typeof active?.id === "string" ? active.id : null;
}
async function runtimeStatus() {
  const id = await activeId();
  const result = await system().snapshot(id);
  if (await activeId() !== id) return { phase: "waiting", systemAvailable: false, message: "会话已切换，请刷新状态。" };
  return result;
}
async function compactActive(expectedId) {
  const id = await activeId();
  if (!id) return { ok: false, code: "NO_SESSION", message: "请先打开要压缩的会话。" };
  if (expectedId !== undefined && expectedId !== id) return { ok: false, code: "SESSION_CHANGED", message: "会话已切换，请刷新后再操作；没有压缩其他会话。" };
  await writes;
  if (await activeId() !== id) return { ok: false, code: "SESSION_CHANGED", message: "会话已切换，未开始压缩。" };
  return system().compact(id, { manual: true });
}
async function onPanelInvoke(channel, payload) {
  try {
    if (channel === "guard.snapshot") {
      await writes;
      const [settings, catalog, runtime] = await Promise.allSettled([pi.plugin.getSettings(), models(), runtimeStatus()]);
      if (settings.status === "rejected") throw new Error("配置读取失败，请刷新重试。");
      const warnings = catalog.status === "rejected" ? ["模型目录暂不可用；系统模式不选择模型仍可保存，关闭规则不受影响。"] : [];
      return { ok: true, settings: normalize(settings.value), models: catalog.status === "fulfilled" ? catalog.value : [], warnings,
        runtime: runtime.status === "fulfilled" ? runtime.value : { phase: "error", systemAvailable: false, message: "状态读取失败，请刷新重试。" } };
    }
    if (channel === "guard.status") return { ok: true, runtime: await runtimeStatus() };
    if (channel === "guard.compact") {
      if (!payload || typeof payload.sessionId !== "string") throw new Error("请刷新并确认目标会话。");
      return compactActive(payload.sessionId);
    }
    if (channel === "guard.save") {
      const settings = validate(payload);
      const operation = writes.then(async () => {
        const selected = [];
        if (settings.sourceProvider && settings.sourceModelId) selected.push([settings.sourceProvider, settings.sourceModelId]);
        if (settings.compressionMode === "dedicated") selected.push([settings.compressionProvider, settings.compressionModelId]);
        if (settings.enabled && selected.length) {
          const catalog = await models();
          for (const [provider, model] of selected) if (!catalog.some(row => row.providerId === provider && row.modelId === model)) throw new Error(`模型不可用：${provider} / ${model}。请先在宿主中配置该模型。`);
        }
        await pi.plugin.setSettings(settings);
        return { ok: true, settings: normalize(await pi.plugin.getSettings()) };
      });
      writes = operation.catch(() => undefined);
      return await operation;
    }
    throw new Error("不支持的插件接口。");
  } catch (error) { return { ok: false, code: error.code || "GUARD_ERROR", message: error instanceof Error ? error.message : "插件操作失败。" }; }
}
function turnEnded(event) { void system().onTurnEnded(event).catch(() => {}); }
async function onLoad() {
  await pi.commands.register({ id: "context-guard.open", title: "续航压缩：配置与状态", keywords: ["压缩", "续航", "compact", "100"], run: () => pi.ui.openPanel({ title: "续航压缩" }) });
  await pi.commands.register({ id: "context-guard.compact", title: "续航压缩：立即系统压缩", keywords: ["压缩", "compact", "100"], run: async () => {
    const result = await compactActive();
    await pi.ui.showToast(result.ok ? "系统压缩完成，现在可以继续。" : result.message, result.ok ? "info" : "warn");
  } });
  pi.events?.on?.("session:turnEnded", turnEnded);
}
async function onUnload() {
  pi.events?.off?.("session:turnEnded", turnEnded);
  engine?.dispose(); engine = null;
  await pi.commands.unregister("context-guard.open");
  await pi.commands.unregister("context-guard.compact");
}
module.exports = { onLoad, onUnload, onPanelInvoke, statusName, controlName, turnEnded };
