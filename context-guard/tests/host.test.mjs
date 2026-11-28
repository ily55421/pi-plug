import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { DEFAULTS } = require("../config.cjs");
const host = require("../main.cjs");
let dir; let stored = {}; let active = "session-a";
const calls = []; const commands = new Map(); const listeners = new Map();
const rows = [
  { key: "source/model", providerId: "source", modelId: "model", label: "主模型" },
  { key: "summary/model", providerId: "summary", modelId: "model", label: "压缩模型" },
];
const configured = { ...DEFAULTS, compressionMode: "dedicated", enabled: true, sourceProvider: "source", sourceModelId: "model", compressionProvider: "summary", compressionModelId: "model" };
before(async () => {
  if (!process.env.PI_SCRATCH_DIR) throw new Error("运行测试须设置 PI_SCRATCH_DIR。");
  dir = await mkdtemp(join(process.env.PI_SCRATCH_DIR, "context-guard-test-"));
  globalThis.pi = {
    models: { list: async () => rows },
    plugin: { getSettings: async () => ({ ...stored }), setSettings: async partial => { stored = { ...stored, ...partial }; }, getDataPath: async () => dir },
    session: { getActive: async () => ({ sessionId: active }) },
    desktop: { listOperations: async () => [{ id: "agent/getStatus" }, { id: "agent/compact" }], invoke: async request => {
      calls.push(request);
      if (request.operation === "agent/getStatus") return { status: { isRunning: false } };
      assert.equal(request.operation, "agent/compact"); return { accepted: true };
    } },
    commands: { register: async value => commands.set(value.id, value), unregister: async id => commands.delete(id) },
    events: { on: (name, fn) => listeners.set(name, fn), off: name => listeners.delete(name) }, ui: { showToast: async () => {}, openPanel: async () => {} },
  };
});
after(async () => { await host.onUnload(); delete globalThis.pi; await rm(dir, { recursive: true, force: true }); });

test("无遥测时显示系统能力和未知计数，不捏造压缩成功", async () => {
  const result = await host.onPanelInvoke("guard.snapshot");
  assert.equal(result.ok, true); assert.equal(result.settings.enabled, false);
  assert.equal(result.runtime.phase, "disabled"); assert.equal(result.runtime.count, null); assert.equal(result.runtime.systemAvailable, true);
  assert.equal(result.models.length, 2);
});
test("高级模式保存校验目标模型并回读持久化设置", async () => {
  assert.equal((await host.onPanelInvoke("guard.save", configured)).ok, true);
  const result = await host.onPanelInvoke("guard.save", { ...configured, compressionModelId: "missing" });
  assert.equal(result.ok, false); assert.equal(stored.compressionModelId, "model");
});
test("关闭时允许保留已不可用的模型", async () => {
  const result = await host.onPanelInvoke("guard.save", { ...configured, enabled: false, compressionModelId: "removed" });
  assert.equal(result.ok, true); assert.equal(stored.enabled, false);
});
test("状态按会话隔离，畸形文件明确返回错误", async () => {
  stored = { ...DEFAULTS };
  await writeFile(join(dir, host.statusName(active)), JSON.stringify({ schemaVersion: 2, sessionId: active, phase: "ready", requestSerial: 12, checkpointSerial: 0 }));
  assert.equal((await host.onPanelInvoke("guard.status")).runtime.count, 12);
  active = "session-b";
  assert.equal((await host.onPanelInvoke("guard.status")).runtime.count, null);
  await writeFile(join(dir, host.statusName(active)), "not json");
  assert.equal((await host.onPanelInvoke("guard.status")).code, "STATE_CORRUPT");
});
test("模型目录临时失败不锁住系统保存与关闭规则", async () => {
  active = "session-c";
  const original = pi.models.list; pi.models.list = async () => { throw new Error("offline"); };
  try {
    const snapshot = await host.onPanelInvoke("guard.snapshot");
    assert.equal(snapshot.ok, true); assert.equal(snapshot.warnings.length, 1);
    assert.equal((await host.onPanelInvoke("guard.save", { ...DEFAULTS, enabled: true })).ok, true);
    assert.equal((await host.onPanelInvoke("guard.save", { ...DEFAULTS, enabled: false })).ok, true);
  } finally { pi.models.list = original; }
});
test("手动系统压缩绑定目标会话，切换后拒绝，关闭规则仍可手动执行", async () => {
  const before = calls.length;
  const wrong = await host.onPanelInvoke("guard.compact", { sessionId: "old-session" });
  assert.equal(wrong.code, "SESSION_CHANGED"); assert.equal(calls.length, before);
  const result = await host.onPanelInvoke("guard.compact", { sessionId: active });
  assert.equal(result.ok, true); assert.equal(result.runtime.phase, "success");
  assert.deepEqual(calls.at(-1), { operation: "agent/compact", args: [{ sessionId: active }] });
  assert.ok(calls.every(call => ["agent/compact", "agent/getStatus"].includes(call.operation)));
});
test("命令和结算事件在加载时注册、卸载时清理", async () => {
  await host.onLoad(); assert.ok(commands.has("context-guard.compact")); assert.ok(listeners.has("session:turnEnded"));
  await host.onUnload(); assert.equal(commands.size, 0); assert.equal(listeners.size, 0);
});
test("任意通道和额外配置被拒绝，路径仅使用哈希", async () => {
  assert.equal((await host.onPanelInvoke("bad.channel")).ok, false);
  assert.equal((await host.onPanelInvoke("guard.save", { ...configured, secret: "x" })).ok, false);
  assert.match(host.statusName("../../outside"), /^status-[a-f0-9]{24}\.json$/);
  assert.match(host.controlName("../../outside"), /^system-[a-f0-9]{24}\.json$/);
});
