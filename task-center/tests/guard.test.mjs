import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import guardExtension, { readSettings, sessionKeyOf } from "../extension/index.mjs";
import { decideResidue, isSuccessfulProgress, madeProgress, normalizeSettings, NOTICE, NOTICE_STOPPED } from "../extension/core.mjs";

const task = (content = "任务", status = "pending") => ({ content, status, priority: "medium" });
function fixture(options = {}) {
  let settings = { todoSessions: { version: 2, sessions: {} } }, failure = null;
  const handlers = new Map(), tools = new Map();
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerTool(tool) { tools.set(tool.name, tool); },
  };
  const api = guardExtension(pi, { async readSettings() { if (failure) throw failure; return structuredClone(settings); }, archiveInventory: async () => new Map(), ...options });
  const ctx = (id = "A") => ({ sessionManager: { getSessionId: () => id } });
  const emit = (name, event = {}, id = "A") => handlers.get(name)?.({ type: name, ...event }, ctx(id));
  const put = (todos = [task()], { id = "A", runId = "run-A", revision = 1 } = {}) => {
    settings.todoSessions.sessions[`session:${id}`] = { todos, runId, revision, updatedAt: 1 };
  };
  const status = (id = "A") => tools.get("todo_guard_status").execute("call", {}, undefined, undefined, ctx(id));
  return {
    emit, put, status, api,
    guards: api.guards,
    start: (id = "A") => emit("before_agent_start", { systemPrompt: "base" }, id),
    settle: async (id = "A") => { await emit("agent_end", { messages: [] }, id); await emit("agent_settled", {}, id); },
    tool: (toolName, details, isError = false, id = "A") => emit("tool_result", { toolName, details, isError }, id),
    get settings() { return settings; }, set failure(error) { failure = error; },
  };
}

test("连续30轮真实进展不会产生提醒或耗尽预算", () => {
  let result = { nudges: 0, stall: 0 };
  for (let i = 0; i < 30; i++) {
    result = decideResidue({ ...result, todos: [task()], sideEffect: true });
    assert.equal(result.action, "none"); assert.equal(result.nudges, 0); assert.equal(result.stall, 0);
  }
});
test("成功编辑与明确变更算进展，只读Bash、失败与后台启动不算", () => {
  assert.equal(isSuccessfulProgress("Edit", false), true);
  assert.equal(isSuccessfulProgress("Write", true), false);
  assert.equal(isSuccessfulProgress("Bash", false, { exitCode: 0 }), false);
  assert.equal(isSuccessfulProgress("Bash", false, { exitCode: 0, changedFiles: ["a"] }), true);
  for (const details of [{ changed: true, exitCode: 1 }, { changed: true, ok: false }, { changed: true, backgroundTaskId: "job" }, { changed: true, unchanged: true }]) {
    assert.equal(isSuccessfulProgress("Bash", false, details), false);
  }
});
test("完成或取消原任务算进展，删除、重写、改名和重复任务减少不算", () => {
  for (const status of ["completed", "cancelled"]) assert.equal(madeProgress({ beforeTodos: [task()], todos: [task("任务", status)] }), true);
  for (const todos of [[], [task()], [task("改名", "completed")]]) assert.equal(madeProgress({ beforeTodos: [task()], todos }), false);
  assert.equal(madeProgress({ beforeTodos: [task(), task("任务", "completed")], todos: [task("任务", "completed")] }), false);
  for (const status of ["completed", "cancelled"]) {
    assert.equal(madeProgress({ beforeTodos: [task()], todos: [task(), task("任务", status)] }), false);
  }
});
test("第N次无进展准确命中上限，原因与提醒总量分开", () => {
  const verdict = decideResidue({ todos: [task()], stall: 2, settings: { stallLimit: 3 } });
  assert.equal(verdict.action, "stopped"); assert.equal(verdict.reason, "stall_limit"); assert.equal(verdict.stall, 3);
  const capped = decideResidue({ todos: [task()], nudges: 2, settings: { maxNudges: 2, stallLimit: 10 } });
  assert.equal(capped.reason, "reminder_limit"); assert.ok(capped.text.includes("提醒次数上限"));
  assert.equal(decideResidue({ todos: [task()], sideEffect: true, nudges: 2, settings: { maxNudges: 2 } }).action, "none");
});
test("空清单、已结束和关闭守卫清零；达到上限不重复提示", () => {
  for (const input of [{ todos: [] }, { todos: [task("x", "completed")] }, { todos: [task()], settings: { enabled: false } }]) {
    const result = decideResidue({ nudges: 5, stall: 2, ...input });
    assert.equal(result.action, "none"); assert.equal(result.nudges, 0); assert.equal(result.stall, 0);
  }
  assert.equal(decideResidue({ todos: [task()], stopped: true }).action, "none");
});
test("设置边界拒绝布尔阈值、超限、无穷值；文本只预览前三项", () => {
  assert.deepEqual(normalizeSettings({ maxNudges: true, stallLimit: Infinity }), { enabled: true, maxNudges: 10, stallLimit: 3 });
  assert.equal(normalizeSettings({ maxNudges: "2", stallLimit: 99 }).maxNudges, 2);
  const result = decideResidue({ todos: Array.from({ length: 5 }, (_, i) => task(`任务${i}`)) });
  assert.equal(result.text.split("\n").filter((line) => line.startsWith("- ")).length, 3);
});
test("只启动不结束不累计；结束后仅准备提示，下次启动投递", async () => {
  const f = fixture(); f.put();
  assert.equal(await f.start(), undefined);
  assert.equal(await f.start(), undefined);
  assert.equal((await f.status()).details.stall, 0);
  await f.settle();
  let status = (await f.status()).details;
  assert.equal(status.stall, 1); assert.equal(status.nudges, 0); assert.equal(status.pending, "nudge");
  const result = await f.start();
  assert.ok(result.systemPrompt.startsWith("base\n\n")); assert.ok(result.systemPrompt.includes(`[${NOTICE}]`));
  status = (await f.status()).details; assert.equal(status.nudges, 1); assert.equal(status.pending, null);
});
test("重复结束事件只结算一次", async () => {
  const f = fixture(); f.put(); await f.start(); await f.settle(); await f.settle();
  assert.equal((await f.status()).details.stall, 1);
});
test("编辑推进不提醒；只读shell仍能检测停滞", async () => {
  const f = fixture(); f.put();
  for (let i = 0; i < 15; i++) {
    assert.equal(await f.start(), undefined); await f.tool("Edit", {}); await f.settle();
  }
  assert.equal((await f.status()).details.nudges, 0);
  await f.start(); await f.tool("Bash", { exitCode: 0 }); await f.settle();
  assert.equal((await f.status()).details.stall, 1);
});
test("任务完成转换清零停滞，删掉未完成任务不伪造进展", async () => {
  const f = fixture(); f.put([task("a"), task("b")]); await f.start();
  f.put([task("a", "completed"), task("b")], { revision: 2 }); await f.settle();
  assert.equal((await f.status()).details.stall, 0);
  await f.start(); f.put([task("b")], { revision: 3 }); await f.settle();
  assert.equal((await f.status()).details.stall, 1);
});
test("收束提示只投递一次，不实际续跑或终止模型", async () => {
  const f = fixture(); f.put(); f.settings.stallLimit = 1;
  await f.start(); await f.settle();
  assert.ok((await f.start()).systemPrompt.includes(`[${NOTICE_STOPPED}]`));
  await f.settle(); assert.equal(await f.start(), undefined); await f.settle();
  const status = (await f.status()).details;
  assert.equal(status.stopped, true); assert.equal(status.pending, null); assert.equal(status.stall, 1);
});
test("新计划和新会话不继承旧预算", async () => {
  const f = fixture(); f.put(); await f.start(); await f.settle(); await f.start(); await f.settle();
  f.put([task("新目标")], { runId: "new", revision: 2 });
  assert.equal(await f.start(), undefined); assert.equal((await f.status()).details.nudges, 0);
  f.put([task("B任务")], { id: "B", runId: "B" });
  assert.equal(await f.start("B"), undefined); assert.equal((await f.status("B")).details.stall, 0);
});
test("运行内新建计划不惩罚创建清单本身", async () => {
  const f = fixture(); await f.start(); f.put(); await f.settle();
  assert.equal((await f.status()).details.stall, 0); assert.equal(await f.start(), undefined);
});
test("结束到下次启动之间的更新会使旧提示失效", async () => {
  const f = fixture(); f.put(); await f.start(); await f.settle();
  f.put([task("更新后的任务")], { revision: 2 }); assert.equal(await f.start(), undefined);
  assert.equal((await f.status()).details.nudges, 0);
});
test("用户中止或模型错误不累计停滞", async () => {
  for (const stopReason of ["aborted", "error"]) {
    const f = fixture(); f.put(); await f.start();
    await f.emit("message_end", { message: { role: "assistant", stopReason } }); await f.settle();
    assert.equal((await f.status()).details.stall, 0); assert.equal(await f.start(), undefined);
  }
});
test("读取错误显式暴露，保持已用预算，恢复后可继续", async () => {
  const f = fixture(); f.put(); await f.start(); await f.settle(); await f.start();
  f.failure = Object.assign(new Error("读取失败"), { code: "STORAGE_READ_FAILED" });
  await f.settle(); assert.equal((await f.status()).isError, true);
  f.failure = null;
  const status = await f.status(); assert.equal(status.details.nudges, 1); assert.equal(status.details.ok, false);
  await f.start(); assert.equal((await f.status()).details.ok, true);
});
test("关闭开关清理待提醒；关闭会话清理本地状态", async () => {
  const f = fixture(); f.put(); await f.start(); await f.settle(); f.settings.guardEnabled = false;
  assert.equal(await f.start(), undefined); assert.equal((await f.status()).details.nudges, 0);
  f.settings.guardEnabled = true; await f.start(); await f.settle();
  await f.emit("session_shutdown"); assert.equal(await f.start(), undefined);
});
test("会话身份以宿主ctx为准，缺少身份不共享回退状态", () => {
  assert.equal(sessionKeyOf({ sessionId: "伪造" }, { sessionManager: { getSessionId: () => "真实" } }), "真实");
  assert.throws(() => sessionKeyOf({}, {}), { code: "SESSION_REQUIRED" });
});
test("真实文件读取区分未建立、损坏和新格式状态", async () => {
  assert.ok(process.env.PI_SCRATCH_DIR, "请由 PI scratch 运行，避免写系统临时目录");
  const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR, "task-center-guard-"));
  const previous = process.env.PI_DESKTOP_DATA_DIR;
  process.env.PI_DESKTOP_DATA_DIR = directory;
  try {
    assert.deepEqual(await readSettings(), {});
    const pluginDir = join(directory, "plugins", "data", "local.task-center"); await mkdir(pluginDir, { recursive: true });
    const path = join(pluginDir, "settings.json");
    await writeFile(path, "{broken", "utf8"); await assert.rejects(readSettings(), { code: "STATE_CORRUPT" });
    await writeFile(path, JSON.stringify({ guardEnabled: false }), "utf8"); assert.equal((await readSettings()).guardEnabled, false);
  } finally {
    if (previous === undefined) delete process.env.PI_DESKTOP_DATA_DIR; else process.env.PI_DESKTOP_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
test("同一计划收束后即使恢复进展也不重复收束提醒", async () => {
  const f = fixture(); f.put(); f.settings.stallLimit = 1;
  await f.start(); await f.settle();
  assert.ok((await f.start()).systemPrompt.includes(`[${NOTICE_STOPPED}]`));
  await f.tool("Edit", {}); await f.settle();
  assert.equal(await f.start(), undefined); await f.settle();
  assert.equal(await f.start(), undefined);
  assert.equal((await f.status()).details.stopped, true);
});

test("守卫状态按空闲TTL清理，运行中或有待投递提醒的不回收", async () => {
  let clock = 10_000;
  const f = fixture({ now: () => clock, guardTtlMs: 1000, maxGuards: 100 });
  await f.tool("Edit", {}, false, "b");
  await f.tool("Edit", {}, false, "c");
  assert.equal(f.guards.size, 2);
  clock += 5000;
  await f.tool("Edit", {}, false, "d");
  assert.deepEqual([...f.guards.keys()], ["d"]);
  // 运行中的守卫不回收
  f.put([task()], { id: "p" });
  await f.start("p");
  assert.equal(f.guards.get("p").running, true);
  clock += 5000;
  await f.tool("Edit", {}, false, "e");
  assert.equal(f.guards.has("p"), true);
  // 有待投递提醒的守卫不回收
  await f.settle("p");
  assert.equal(f.guards.get("p").pending.action, "nudge");
  clock += 60_000;
  await f.tool("Edit", {}, false, "f");
  assert.equal(f.guards.has("p"), true);
});

test("守卫数量超过上限时按最久未使用回收，当前会话始终保留", async () => {
  const f = fixture({ now: () => 0, maxGuards: 3 });
  for (const id of ["a", "b", "c", "d", "e"]) await f.tool("Edit", {}, false, id);
  // 上限之外最多多保留一个正在处理的会话。
  assert.ok(f.guards.size <= 4, `守卫数量应受上限约束，实际 ${f.guards.size}`);
  assert.equal(f.guards.has("e"), true);
  assert.equal(f.guards.has("a"), false);
});

test("守卫状态工具暴露容量与存储指标，读取失败仍然显式报错", async () => {
  const f = fixture({ now: () => 0 });
  f.put();
  const ok = await f.status();
  assert.equal(ok.details.ok, true);
  assert.ok(ok.details.capacity && typeof ok.details.capacity.usedBytes === "number");
  assert.ok(ok.details.storage && typeof ok.details.storage.settingsReads === "number");
  f.failure = Object.assign(new Error("读取失败"), { code: "STORAGE_READ_FAILED" });
  const failed = await f.status();
  assert.equal(failed.isError, true);
  assert.equal(failed.details.code, "STORAGE_READ_FAILED");
});
