import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import state from "../state.cjs";
import storage from "../storage.cjs";

const entry = new URL("../main.js", import.meta.url);
const source = readFileSync(entry, "utf8");
const require = createRequire(entry);
const task = (content = "任务", status = "pending") => ({ content, status, priority: "medium" });
const ctx = (sessionId = "A", signal) => ({ sessionId, signal });
const copy = (value) => structuredClone(value);
const pause = () => new Promise((done) => setTimeout(done, 5));

// 夹具复刻宿主语义：getDataPath 返回真实私有目录，setSettings 浅合并并以两空格缩进落盘。
async function fixture(initial = {}) {
  assert.ok(process.env.PI_SCRATCH_DIR, "请由 PI scratch 运行，避免写系统临时目录");
  const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR, "task-center-state-"));
  const settingsPath = join(directory, "settings.json");
  let settings = copy(initial);
  const persist = () => { writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8"); storage.invalidate(directory); };
  persist();
  let active = "A", saves = 0, paths = 0;
  const tools = new Map(), commands = new Map();
  const hooks = { save: null, active: null, path: null };
  const pi = {
    plugin: {
      async getDataPath() { paths++; if (hooks.path) await hooks.path(); return directory; },
      async getSettings() { return copy(settings); },
      async setSettings(partial) {
        saves++;
        if (hooks.save) await hooks.save();
        settings = { ...settings, ...copy(partial) };
        persist();
      },
    },
    agent: { async registerTool(tool) { tools.set(tool.name, tool); }, async unregisterTool(name) { tools.delete(name); } },
    commands: { async register(command) { commands.set(command.id, command); }, async unregister(name) { commands.delete(name); } },
    session: { async getActive() { if (hooks.active) return hooks.active(); return active ? { id: active } : null; } },
    ui: { async showToast() {}, async revealView() {} },
  };
  const sandbox = { module: { exports: {} }, require, pi, Buffer };
  vm.runInNewContext(source, sandbox, { filename: entry.pathname });
  const api = sandbox.module.exports;
  const f = {
    api, pi, hooks, tools, commands, directory, settingsPath,
    write: (args, context = ctx()) => api.__test.executeTodoWrite(args, context),
    read: (args = {}, context = ctx()) => api.__test.executeTodoRead(args, context),
    history: (args = {}, context = ctx()) => api.__test.executeTodoHistory(args, context),
    panel: (args = {}) => api.onPanelInvoke("taskCenter.snapshot", args),
    file: (sessionId, archived) => storage.fileOf(directory, sessionId, archived),
    stored: async () => JSON.parse(await readFile(settingsPath, "utf8")),
    index: () => settings.todoSessions?.index ?? {},
    export: (hash) => api.__test.storage.encodeSession(hash, { runId: "r", revision: 1, updatedAt: 1, todos: [] }),
    cleanup: () => rm(directory, { recursive: true, force: true }),
    get settings() { return copy(settings); },
    set settings(value) { settings = copy(value); persist(); },
    get saves() { return saves; }, get paths() { return paths; },
    set active(value) { active = value; },
  };
  return f;
}
const defer = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test("按调用会话隔离，不受当前可见会话影响", async () => {
  const f = await fixture();
  try {
    f.active = "B";
    await f.write({ todos: [task("A任务")] }, ctx("A"));
    await f.write({ todos: [task("B任务")] }, ctx("B"));
    assert.equal((await f.read({}, ctx("A"))).todos[0].content, "A任务");
    assert.equal((await f.read({}, ctx("B"))).todos[0].content, "B任务");
    assert.equal((await f.panel()).todos[0].content, "B任务");
    assert.equal(Object.keys(f.index()).length, 2);
  } finally { await f.cleanup(); }
});

test("缺少会话不读写，不使用全局回退", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.write({ todos: [] }, {})).code, "SESSION_REQUIRED");
    assert.equal((await f.read({}, {})).code, "SESSION_REQUIRED");
    assert.equal(f.saves, 0); assert.equal(f.paths, 0);
  } finally { await f.cleanup(); }
});

test("跨会话并发读改写串行，所有清单均保留", async () => {
  const f = await fixture();
  try {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => f.write({ todos: [task(`任务${i}`)] }, ctx(`s${i}`))));
    assert.ok(results.every((result) => result.ok));
    assert.equal(Object.keys(f.index()).length, 12);
    for (let i = 0; i < 12; i++) assert.equal((await f.read({}, ctx(`s${i}`))).todos[0].content, `任务${i}`);
  } finally { await f.cleanup(); }
});

test("同版本并发更新仅一个成功，过期版本不能覆盖", async () => {
  const f = await fixture();
  try {
    const first = await f.write({ todos: [task()], expectedRevision: 0 });
    const results = await Promise.all([
      f.write({ todos: [task("更新1")], expectedRevision: first.revision }),
      f.write({ todos: [task("更新2")], expectedRevision: first.revision }),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.find((result) => !result.ok).code, "REVISION_CONFLICT");
    assert.equal((await f.read()).todos[0].content, "更新1");
  } finally { await f.cleanup(); }
});

test("相同清单不保存、不增加版本；新计划更换runId", async () => {
  const f = await fixture();
  try {
    const first = await f.write({ todos: [task()] });
    const same = await f.write({ todos: [task()] });
    assert.equal(same.revision, first.revision); assert.equal(same.unchanged, true); assert.equal(f.saves, 1);
    const next = await f.write({ todos: [task()], newPlan: true });
    assert.notEqual(next.runId, first.runId); assert.equal(next.revision, first.revision + 1);
  } finally { await f.cleanup(); }
});

test("已结束计划开始新工作时自动生成新runId", async () => {
  const f = await fixture();
  try {
    const first = await f.write({ todos: [task("旧", "completed")] });
    const next = await f.write({ todos: [task("新")] });
    assert.notEqual(first.runId, next.runId);
  } finally { await f.cleanup(); }
});

test("设置文件损坏时读取与保存都显式失败，原文件不被覆盖", async () => {
  const f = await fixture();
  try {
    await f.write({ todos: [task()] });
    writeFileSync(f.settingsPath, "{broken", "utf8");
    storage.invalidate(f.directory);
    assert.equal((await f.read()).code, "STATE_CORRUPT");
    assert.equal((await f.write({ todos: [] })).code, "STATE_CORRUPT");
    assert.equal(f.saves, 1);
    assert.equal(readFileSync(f.settingsPath, "utf8"), "{broken");
  } finally { await f.cleanup(); }
});

test("保存失败回滚会话文件，队列可以继续重试", async () => {
  const f = await fixture();
  try {
    f.hooks.save = () => { throw new Error("磁盘错误"); };
    assert.equal((await f.write({ todos: [task()] })).code, "STORAGE_WRITE_FAILED");
    // "报失败即未生效"：既不写索引，也不留下会话文件。
    assert.equal(Object.keys(f.index()).length, 0);
    assert.equal(existsSync(f.file("A")), false);
    assert.equal((await f.read()).revision, 0);
    f.hooks.save = null;
    assert.equal((await f.write({ todos: [task("恢复")] })).revision, 1);
    assert.equal((await f.read()).todos[0].content, "恢复");
  } finally { await f.cleanup(); }
});

test("等待读取期间取消，保存前检查signal", async () => {
  const f = await fixture();
  try {
    const gate = defer(); const entered = defer(); const controller = new AbortController();
    f.hooks.path = async () => { entered.resolve(); await gate.promise; };
    const pending = f.write({ todos: [task()] }, ctx("A", controller.signal));
    await entered.promise; controller.abort(); gate.resolve();
    assert.equal((await pending).code, "ABORTED");
    assert.equal(f.saves, 0); assert.equal(existsSync(f.file("A")), false);
  } finally { await f.cleanup(); }
});

test("读取等待在途写入完成", async () => {
  const f = await fixture();
  try {
    const gate = defer(); const entered = defer();
    f.hooks.save = async () => { entered.resolve(); await gate.promise; };
    const writing = f.write({ todos: [task("新数据")] });
    await entered.promise;
    const reading = f.read(); gate.resolve(); await writing;
    assert.equal((await reading).todos[0].content, "新数据");
  } finally { await f.cleanup(); }
});

test("损坏状态拒绝读取与覆盖（索引与会话文件）", async () => {
  for (const bad of [null, { version: 99, sessions: {} }, { version: 2, sessions: [] }, { version: 3, index: [] }]) {
    const f = await fixture({ todoSessions: bad });
    try {
      assert.equal((await f.read()).code, "STATE_CORRUPT");
      assert.equal((await f.write({ todos: [] })).code, "STATE_CORRUPT");
      assert.equal(f.saves, 0);
    } finally { await f.cleanup(); }
  }
  const broken = await fixture();
  try {
    await broken.write({ todos: [task()] });
    const file = broken.file("A");
    const body = JSON.parse(readFileSync(file, "utf8"));
    body.todos = [{ content: "x", status: "oops", priority: "medium" }];
    writeFileSync(file, JSON.stringify(body), "utf8");
    storage.invalidate(broken.directory, "A");
    assert.equal((await broken.read()).code, "STATE_CORRUPT");
    assert.equal((await broken.write({ todos: [] })).code, "STATE_CORRUPT");
  } finally { await broken.cleanup(); }
  const mismatched = await fixture();
  try {
    await mismatched.write({ todos: [task()] });
    const file = mismatched.file("A");
    const body = JSON.parse(readFileSync(file, "utf8"));
    body.sessionId = "另一个会话";
    writeFileSync(file, JSON.stringify(body), "utf8");
    storage.invalidate(mismatched.directory, "A");
    assert.equal((await mismatched.read()).code, "STATE_CORRUPT");
  } finally { await mismatched.cleanup(); }
});

test("旧全局清单保留，绝不自动归入任意会话", async () => {
  const legacy = { todos: [task("旧任务")], version: 1 };
  const f = await fixture({ todoState: legacy, guardEnabled: false });
  try {
    const read = await f.read();
    assert.equal(read.total, 0); assert.equal(read.legacyAvailable, true);
    await f.write({ todos: [task("新任务")] });
    assert.deepEqual(f.settings.todoState, legacy); assert.equal(f.settings.guardEnabled, false);
  } finally { await f.cleanup(); }
});

test("旧版内联存储只读可用，写入时迁移为每会话文件", async () => {
  const inline = {
    version: 2,
    sessions: { "session:A": { runId: "run-a", revision: 3, updatedAt: 1000, todos: [task("旧会话")] } },
  };
  const f = await fixture({ todoSessions: inline });
  try {
    const read = await f.read();
    assert.equal(read.todos[0].content, "旧会话");
    assert.equal(read.revision, 3);
    assert.equal(f.saves, 0, "只读路径不触发迁移写入");
    const written = await f.write({ todos: [task("新步骤")], expectedRevision: 3 });
    assert.equal(written.ok, true); assert.equal(written.revision, 4);
    const stored = await f.stored();
    assert.equal(stored.todoSessions.version, 3);
    assert.equal(Object.keys(stored.todoSessions.index).length, 1);
    assert.equal(existsSync(f.file("A")), true);
    assert.equal((await f.read()).todos[0].content, "新步骤");
  } finally { await f.cleanup(); }
});

test("超过保留数量的旧会话只归档不删除，重新写入会回到常规目录", async () => {
  const f = await fixture({ maxStoredSessions: 2 });
  try {
    await f.write({ todos: [task("一")] }, ctx("s1"));
    await pause();
    await f.write({ todos: [task("二")] }, ctx("s2"));
    await pause();
    await f.write({ todos: [task("三")] }, ctx("s3"));
    const archived = Object.values(f.index()).filter((entry) => entry.archived === true);
    assert.equal(archived.length, 1);
    const oldest = archived[0].id;
    assert.equal(existsSync(f.file(oldest)), false);
    assert.equal(existsSync(f.file(oldest, true)), true);
    const restored = await f.read({}, ctx(oldest));
    assert.equal(restored.ok, true); assert.equal(restored.archived, true);
    assert.equal(restored.todos[0].content, oldest === "s1" ? "一" : "二");
    const rewritten = await f.write({ todos: [task("改后")], expectedRevision: restored.revision }, ctx(oldest));
    assert.equal(rewritten.ok, true);
    assert.equal(existsSync(f.file(oldest)), true);
    assert.equal(existsSync(f.file(oldest, true)), false);
  } finally { await f.cleanup(); }
});

test("文件未变化时复用解析结果，外部改动后重新读取", async () => {
  const f = await fixture();
  try {
    await f.write({ todos: [task()] });
    storage.resetMetrics();
    await f.read();
    const first = storage.metrics();
    await f.read();
    const second = storage.metrics();
    assert.equal(second.sessionReads, first.sessionReads + 1);
    assert.equal(second.fileReads, first.fileReads, "缓存命中时不再读盘");
    assert.ok(second.cacheHits > first.cacheHits);
    const file = f.file("A");
    const body = JSON.parse(readFileSync(file, "utf8"));
    body.todos = [task("外部进程写入的更名任务")];
    writeFileSync(file, JSON.stringify(body), "utf8");
    assert.equal((await f.read()).todos[0].content, "外部进程写入的更名任务");
  } finally { await f.cleanup(); }
});

test("todo_history 只读列出归档；专用命令清理失败可重试", async () => {
  const f = await fixture({ maxStoredSessions: 1 });
  try {
    await f.write({ todos: [task("一")] }, ctx("s1"));
    await pause();
    await f.write({ todos: [task("二")] }, ctx("s2"));
    const list = await f.history({ action: "list" });
    assert.equal(list.ok, true);
    assert.equal(list.sessions.length, 2);
    assert.equal(list.sessions.filter((session) => session.archived).length, 1);
    assert.ok(list.capacity.usedBytes > 0);
    const archivedId = list.sessions.find((session) => session.archived).id;
    assert.equal(existsSync(f.file(archivedId, true)), true);
    assert.equal((await f.history({ action: "purge", confirm: true })).code, "INVALID_ARGUMENT");
    assert.equal(existsSync(f.file(archivedId, true)), true, "Agent 工具不得永久删除归档");

    await f.api.onLoad();
    const purge = f.commands.get("taskCenter.purgeArchived").run;
    let saveCalls = 0;
    f.hooks.save = () => { saveCalls++; if (saveCalls === 2) throw new Error("index write failed"); };
    const interrupted = await purge();
    assert.equal(interrupted.code, "STORAGE_WRITE_FAILED");
    assert.equal(existsSync(f.file(archivedId, true)), false, "失败后已清理文件不可恢复，但索引应保留待重试标记");
    const pending = await f.history({ action: "list" });
    assert.equal(pending.sessions.find((entry) => entry.id === archivedId).purgePending, true);

    f.hooks.save = null;
    const retried = await purge();
    assert.equal(retried.ok, true);
    assert.equal((await f.history({ action: "list" })).sessions.length, 1);
  } finally { await f.cleanup(); }
});

test("预算耗尽时拒绝写入，且不留下半个会话文件", async () => {
  const f = await fixture();
  try {
    const big = Array.from({ length: 200 }, (_, index) => task(`任务${index}` + "x".repeat(460)));
    let accepted = 0, rejected = null;
    for (let index = 0; index < 120 && !rejected; index++) {
      const result = await f.write({ todos: big, newPlan: true }, ctx(`s${index}`));
      if (result.ok) accepted++;
      else { rejected = result; assert.equal(result.code, "STATE_TOO_LARGE"); }
    }
    assert.ok(accepted > 50, `预算应允许相当多会话，实际 ${accepted}`);
    const files = (await readdir(join(f.directory, "sessions"))).filter((name) => name.endsWith(".json"));
    assert.equal(files.length, accepted, "被拒绝的写入不能留下文件");
    assert.equal(Object.keys(f.index()).length, accepted);
  } finally { await f.cleanup(); }
});

test("完成与取消共同计入结束比例，面板和工具一致", async () => {
  const f = await fixture();
  try {
    await f.write({ todos: [task("完成", "completed"), task("取消", "cancelled")] });
    const read = await f.read(), panel = await f.panel();
    assert.equal(read.percent, 100); assert.equal(read.finished, 2); assert.equal(read.counts.completed, 1);
    assert.deepEqual(copy(read.counts), copy(panel.counts)); assert.equal(panel.percent, read.percent);
    assert.ok(panel.capacity.usedBytes > 0);
  } finally { await f.cleanup(); }
});

test("summary不含全文，full不重复remaining和message", async () => {
  const f = await fixture();
  try {
    await f.write({ todos: [task()] });
    assert.equal((await f.read({ detail: "summary" })).todos, undefined);
    const full = await f.read();
    assert.equal(full.todos.length, 1); assert.equal(full.remaining, undefined); assert.equal(full.message, undefined);
  } finally { await f.cleanup(); }
});

test("快照只允许可见会话，忽略客户端伪造的sessionId", async () => {
  const f = await fixture();
  try {
    await f.write({ todos: [task("A任务")] });
    f.active = "B";
    assert.equal((await f.panel({ sessionId: "A" })).sessionId, "B");
    f.active = null; assert.equal((await f.panel()).code, "NO_ACTIVE_SESSION");
  } finally { await f.cleanup(); }
});

test("读取快照期间切换会话，不返回旧会话数据", async () => {
  const f = await fixture();
  try {
    let count = 0;
    f.hooks.active = () => ({ id: ++count === 1 ? "A" : "B" });
    const result = await f.panel();
    assert.equal(result.code, "SESSION_CHANGED"); assert.equal(result.todos, undefined);
  } finally { await f.cleanup(); }
});

test("快照相同版本只返回未变化标记，其他会话不能命中", async () => {
  const f = await fixture();
  try {
    const initial = await f.write({ todos: [task()] });
    const result = await f.panel({ knownSessionId: "A", knownRunId: initial.runId, knownRevision: initial.revision });
    assert.equal(result.unchanged, true); assert.equal(result.todos, undefined);
    f.active = "B";
    assert.equal((await f.panel({ knownSessionId: "A", knownRunId: initial.runId, knownRevision: initial.revision })).unchanged, undefined);
  } finally { await f.cleanup(); }
});

test("边界校验禁止空白、非字符串、超限及多项进行中", async () => {
  const f = await fixture();
  try {
    for (const todos of [[task(" ")], [task({})], [task("x".repeat(501))], Array.from({ length: 201 }, () => task()), [task("1", "in_progress"), task("2", "in_progress")]]) {
      assert.equal((await f.write({ todos })).ok, false);
    }
    assert.equal(f.saves, 0);
    const result = await f.write({ todos: [{ content: " a\n b ", status: "bad", priority: "bad" }] });
    assert.equal(result.ok, true); assert.equal(result.notes.length, 2);
    assert.equal((await f.read()).todos[0].content, "a b");
  } finally { await f.cleanup(); }
});

test("特殊会话名称不能污染对象原型，也不能逃出会话目录", async () => {
  const f = await fixture();
  try {
    for (const id of ["__proto__", "../../逃逸"]) {
      await f.write({ todos: [task()] }, ctx(id));
      assert.equal((await f.read({}, ctx(id))).total, 1);
    }
    assert.equal({}.todos, undefined);
    assert.equal(existsSync(join(f.directory, "逃逸.json")), false);
  } finally { await f.cleanup(); }
});

test("工具注册直接复用manifest，卸载清理", async () => {
  const f = await fixture();
  try {
    await f.api.onLoad();
    const manifest = require("./manifest.json");
    assert.equal(manifest.version, "0.4.1");
    assert.deepEqual(copy(manifest.permissions), ["ui.view", "agent.tool.register", "agent.prompt.inject", "agent.extension"]);
    assert.deepEqual(manifest.contributes.commands.map((command) => command.id), ["taskCenter.open", "taskCenter.purgeArchived"]);
    assert.deepEqual(copy(manifest.contributes.agentTools[2].schema.properties.action.enum), ["list"]);
    assert.deepEqual(f.tools.get("todo_write").schema, manifest.contributes.agentTools[0].schema);
    assert.deepEqual(f.tools.get("todo_read").planSafeActions, ["read"]);
    assert.deepEqual(f.tools.get("todo_history").planSafeActions, ["list"]);
    assert.equal((await f.history({ action: "purge", confirm: true })).code, "INVALID_ARGUMENT");
    await f.api.onUnload();
    assert.equal(f.tools.size, 0); assert.equal(f.commands.size, 0);
  } finally { await f.cleanup(); }
});

test("插件在ESM父目录中可以直接CommonJS加载", () => {
  assert.equal(typeof require("./main.js").onLoad, "function");
  assert.equal(state.summarize([]).percent, 0);
});

test("提交期间取消会回滚会话文件和索引", async () => {
  const f = await fixture();
  try {
    await f.write({ todos: [task("原始")] });
    const gate = defer(); const entered = defer(); const controller = new AbortController();
    f.hooks.save = async () => { entered.resolve(); await gate.promise; };
    const pending = f.write({ todos: [task("不应保存")], expectedRevision: 1 }, ctx("A", controller.signal));
    await entered.promise;
    controller.abort();
    gate.resolve();
    assert.equal((await pending).code, "ABORTED");
    const read = await f.read();
    assert.equal(read.todos[0].content, "原始");
    assert.equal(read.revision, 1);
    const indexEntry = f.index()[storage.hashOf("A")];
    assert.equal(indexEntry.revision, 1, "索引必须与回滚后的会话文件版本一致");
  } finally { f.hooks.save = null; await f.cleanup(); }
});

test("todo_history 只读查看旧版内联数据，不在查询时触发迁移", async () => {
  const inline = { version: 2, sessions: { "session:A": { runId: "run-a", revision: 2, updatedAt: 1000, todos: [task("旧")] } } };
  const f = await fixture({ todoSessions: inline });
  try {
    const list = await f.history({ action: "list" });
    assert.equal(list.ok, true);
    assert.equal(list.sessions.length, 1);
    assert.equal(list.sessions[0].id, "A");
    assert.equal(f.saves, 0);
    assert.equal((await f.stored()).todoSessions.version, 2);
    assert.equal((await f.read()).todos[0].content, "旧");
    const written = await f.write({ todos: [task("新")] }, ctx("A"));
    assert.equal(written.ok, true);
    assert.equal((await f.stored()).todoSessions.version, 3);
    assert.equal(existsSync(f.file("A")), true);
  } finally { await f.cleanup(); }
});