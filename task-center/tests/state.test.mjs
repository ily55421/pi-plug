import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import state from "../state.cjs";

const entry = new URL("../main.js", import.meta.url);
const source = readFileSync(entry, "utf8");
const require = createRequire(entry);
const task = (content = "任务", status = "pending") => ({ content, status, priority: "medium" });
const ctx = (sessionId = "A", signal) => ({ sessionId, signal });
const copy = (value) => structuredClone(value);
function fixture(initial = {}) {
  let settings = copy(initial), active = "A", reads = 0, saves = 0;
  const tools = new Map(), commands = new Map();
  const hooks = { read: null, save: null, active: null };
  const pi = {
    plugin: {
      async getDataPath() { return "mock-private-dir"; },
      async getSettings() { reads++; if (hooks.read) await hooks.read(); return copy(settings); },
      async setSettings(partial) { saves++; if (hooks.save) await hooks.save(); settings = { ...settings, ...copy(partial) }; },
    },
    agent: { async registerTool(tool) { tools.set(tool.name, tool); }, async unregisterTool(name) { tools.delete(name); } },
    commands: { async register(command) { commands.set(command.id, command); }, async unregister(name) { commands.delete(name); } },
    session: { async getActive() { if (hooks.active) return hooks.active(); return active ? { id: active } : null; } },
    ui: { async showToast() {}, async revealView() {} },
  };
  const testRequire = (name) => name === "./storage.cjs" ? {
    MAX_BYTES: 8 * 1024 * 1024,
    readSettingsFile: () => pi.plugin.getSettings(),
  } : require(name);
  const sandbox = { module: { exports: {} }, require: testRequire, pi, Buffer };
  vm.runInNewContext(source, sandbox, { filename: entry.pathname });
  const api = sandbox.module.exports;
  return {
    api, pi, hooks, tools, commands,
    write: (args, context = ctx()) => api.__test.executeTodoWrite(args, context),
    read: (args = {}, context = ctx()) => api.__test.executeTodoRead(args, context),
    panel: (args = {}) => api.onPanelInvoke("taskCenter.snapshot", args),
    get settings() { return copy(settings); }, set settings(value) { settings = copy(value); },
    get saves() { return saves; }, get reads() { return reads; }, set active(value) { active = value; },
  };
}
const defer = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test("按调用会话隔离，不受当前可见会话影响", async () => {
  const f = fixture(); f.active = "B";
  await f.write({ todos: [task("A任务")] }, ctx("A"));
  await f.write({ todos: [task("B任务")] }, ctx("B"));
  assert.equal((await f.read({}, ctx("A"))).todos[0].content, "A任务");
  assert.equal((await f.read({}, ctx("B"))).todos[0].content, "B任务");
  assert.equal((await f.panel()).todos[0].content, "B任务");
});
test("缺少会话不读写，不使用全局回退", async () => {
  const f = fixture();
  assert.equal((await f.write({ todos: [] }, {})).code, "SESSION_REQUIRED");
  assert.equal((await f.read({}, {})).code, "SESSION_REQUIRED");
  assert.equal(f.reads, 0); assert.equal(f.saves, 0);
});
test("跨会话并发读改写串行，所有清单均保留", async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => f.write({ todos: [task(`任务${i}`)] }, ctx(`s${i}`))));
  assert.ok(results.every((r) => r.ok));
  assert.equal(Object.keys(f.settings.todoSessions.sessions).length, 12);
});
test("同版本并发更新仅一个成功，过期版本不能覆盖", async () => {
  const f = fixture();
  const first = await f.write({ todos: [task()], expectedRevision: 0 });
  const results = await Promise.all([
    f.write({ todos: [task("更新1")], expectedRevision: first.revision }),
    f.write({ todos: [task("更新2")], expectedRevision: first.revision }),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.find((r) => !r.ok).code, "REVISION_CONFLICT");
  assert.equal((await f.read()).todos[0].content, "更新1");
});
test("相同清单不保存、不增加版本；新计划更换runId", async () => {
  const f = fixture();
  const first = await f.write({ todos: [task()] });
  const same = await f.write({ todos: [task()] });
  assert.equal(same.revision, first.revision); assert.equal(same.unchanged, true); assert.equal(f.saves, 1);
  const next = await f.write({ todos: [task()], newPlan: true });
  assert.notEqual(next.runId, first.runId); assert.equal(next.revision, first.revision + 1);
});
test("已结束计划开始新工作时自动生成新runId", async () => {
  const f = fixture();
  const first = await f.write({ todos: [task("旧", "completed")] });
  const next = await f.write({ todos: [task("新")] });
  assert.notEqual(first.runId, next.runId);
});
test("读取异常显式失败，保存时读取异常不会覆盖数据", async () => {
  const f = fixture(); await f.write({ todos: [task()] });
  const before = f.settings;
  f.hooks.read = () => { throw new Error("故障"); };
  assert.equal((await f.read()).code, "STORAGE_READ_FAILED");
  assert.equal((await f.write({ todos: [] })).code, "STORAGE_READ_FAILED");
  assert.deepEqual(f.settings, before);
});
test("保存失败不污染状态，队列可以继续重试", async () => {
  const f = fixture();
  f.hooks.save = () => { throw new Error("磁盘错误"); };
  assert.equal((await f.write({ todos: [task()] })).code, "STORAGE_WRITE_FAILED");
  f.hooks.save = null;
  assert.equal((await f.write({ todos: [task("恢复")] })).revision, 1);
});
test("等待读取期间取消，保存前检查signal", async () => {
  const f = fixture(); const gate = defer(); const entered = defer(); const controller = new AbortController();
  f.hooks.read = async () => { entered.resolve(); await gate.promise; };
  const pending = f.write({ todos: [task()] }, ctx("A", controller.signal));
  await entered.promise; controller.abort(); gate.resolve();
  assert.equal((await pending).code, "ABORTED"); assert.equal(f.saves, 0);
});
test("读取等待在途写入完成", async () => {
  const f = fixture(); const gate = defer(); const entered = defer();
  f.hooks.save = async () => { entered.resolve(); await gate.promise; };
  const writing = f.write({ todos: [task("新数据")] });
  await entered.promise;
  const reading = f.read(); gate.resolve(); await writing;
  assert.equal((await reading).todos[0].content, "新数据");
});
test("损坏状态拒绝读取与覆盖", async () => {
  for (const bad of [null, { version: 99, sessions: {} }, { version: 2, sessions: [] }, { version: 2, sessions: { "session:A": { runId: "r", revision: 1, updatedAt: 1, todos: [task("x", "oops")] } } }]) {
    const f = fixture({ todoSessions: bad });
    assert.equal((await f.read()).code, "STATE_CORRUPT");
    assert.equal((await f.write({ todos: [] })).code, "STATE_CORRUPT"); assert.equal(f.saves, 0);
  }
});
test("旧全局清单保留，绝不自动归入任意会话", async () => {
  const legacy = { todos: [task("旧任务")], version: 1 };
  const f = fixture({ todoState: legacy, guardEnabled: false });
  const read = await f.read();
  assert.equal(read.total, 0); assert.equal(read.legacyAvailable, true);
  await f.write({ todos: [task("新任务")] });
  assert.deepEqual(f.settings.todoState, legacy); assert.equal(f.settings.guardEnabled, false);
});
test("完成与取消共同计入结束比例，面板和工具一致", async () => {
  const f = fixture(); await f.write({ todos: [task("完成", "completed"), task("取消", "cancelled")] });
  const read = await f.read(), panel = await f.panel();
  assert.equal(read.percent, 100); assert.equal(read.finished, 2); assert.equal(read.counts.completed, 1);
  assert.deepEqual(copy(read.counts), copy(panel.counts)); assert.equal(panel.percent, read.percent);
});
test("summary不含全文，full不重复remaining和message", async () => {
  const f = fixture(); await f.write({ todos: [task()] });
  assert.equal((await f.read({ detail: "summary" })).todos, undefined);
  const full = await f.read(); assert.equal(full.todos.length, 1); assert.equal(full.remaining, undefined); assert.equal(full.message, undefined);
});
test("快照只允许可见会话，忽略客户端伪造的sessionId", async () => {
  const f = fixture(); await f.write({ todos: [task("A任务")] });
  f.active = "B";
  assert.equal((await f.panel({ sessionId: "A" })).sessionId, "B");
  f.active = null; assert.equal((await f.panel()).code, "NO_ACTIVE_SESSION");
});
test("读取快照期间切换会话，不返回旧会话数据", async () => {
  const f = fixture(); let count = 0;
  f.hooks.active = () => ({ id: ++count === 1 ? "A" : "B" });
  const result = await f.panel(); assert.equal(result.code, "SESSION_CHANGED"); assert.equal(result.todos, undefined);
});
test("快照相同版本只返回未变化标记，其他会话不能命中", async () => {
  const f = fixture(); const initial = await f.write({ todos: [task()] });
  const result = await f.panel({ knownSessionId: "A", knownRunId: initial.runId, knownRevision: initial.revision });
  assert.equal(result.unchanged, true); assert.equal(result.todos, undefined);
  f.active = "B";
  assert.equal((await f.panel({ knownSessionId: "A", knownRunId: initial.runId, knownRevision: initial.revision })).unchanged, undefined);
});
test("边界校验禁止空白、非字符串、超限及多项进行中", async () => {
  const f = fixture();
  for (const todos of [[task(" ")], [task({})], [task("x".repeat(501))], Array.from({ length: 201 }, () => task()), [task("1", "in_progress"), task("2", "in_progress")]]) {
    assert.equal((await f.write({ todos })).ok, false);
  }
  assert.equal(f.saves, 0);
  const result = await f.write({ todos: [{ content: " a\n b ", status: "bad", priority: "bad" }] });
  assert.equal(result.ok, true); assert.equal(result.notes.length, 2);
  assert.equal((await f.read()).todos[0].content, "a b");
});
test("特殊会话名称不能污染对象原型", async () => {
  const f = fixture();
  await f.write({ todos: [task()] }, ctx("__proto__"));
  assert.equal((await f.read({}, ctx("__proto__"))).total, 1);
  assert.equal({}.todos, undefined);
});
test("工具注册直接复用manifest，卸载清理", async () => {
  const f = fixture(); await f.api.onLoad();
  const manifest = require("./manifest.json");
  assert.deepEqual(f.tools.get("todo_write").schema, manifest.contributes.agentTools[0].schema);
  assert.deepEqual(f.tools.get("todo_read").planSafeActions, ["read"]);
  await f.api.onUnload(); assert.equal(f.tools.size, 0); assert.equal(f.commands.size, 0);
});
test("插件在ESM父目录中可以直接CommonJS加载", () => {
  assert.equal(typeof require("./main.js").onLoad, "function");
  assert.equal(state.summarize([]).percent, 0);
});
test("容量检查包含宿主格式化空白，紧凑JSON可容纳但落盘会超限时拒绝保存", async () => {
  const limit = 8 * 1024 * 1024;
  const f = fixture({ padding: "x".repeat(limit - 1500) });
  const todos = Array.from({ length: 15 }, (_, i) => task(`t${i}`));
  const candidate = { ...f.settings, todoSessions: { version: 2, sessions: { "session:A": { todos, runId: "x".repeat(36), revision: 1, updatedAt: Date.now() } } } };
  assert.ok(Buffer.byteLength(JSON.stringify(candidate)) < limit);
  assert.ok(Buffer.byteLength(JSON.stringify(candidate, null, 2)) > limit);
  assert.equal((await f.write({ todos })).code, "STATE_TOO_LARGE");
  assert.equal(f.saves, 0);
});
