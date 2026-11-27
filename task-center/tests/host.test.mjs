import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// PI_PLUGIN_HOST_ENTRY 指向已安装版本或源码中的宿主进程，默认不依赖其他仓库。
const hostEntry = process.env.PI_PLUGIN_HOST_ENTRY;
test("实际宿主进程：加载、会话隔离、快照、损坏数据、取消和卸载", { skip: !hostEntry, timeout: 15000 }, async () => {
  assert.ok(process.env.PI_SCRATCH_DIR, "集成测试需要 PI_SCRATCH_DIR");
  const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR, "task-center-host-data-"));
  const pluginPath = fileURLToPath(new URL("..", import.meta.url));
  const manifest = JSON.parse(await readFile(join(pluginPath, "manifest.json"), "utf8"));
  const file = join(directory, "settings.json");
  const registered = new Map(), pending = new Map();
  let settings = {}, active = "A", sequence = 0, delayed = false, release = null;
  const child = fork(resolve(hostEntry), [], { stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, TMP: directory, TEMP: directory } });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  child.on("message", async (message) => {
    if (message.t === "res") {
      const callback = pending.get(message.id);
      pending.delete(message.id);
      if (callback) message.ok ? callback.resolve(message.value) : callback.reject(Object.assign(new Error(message.error?.message), { code: message.error?.code }));
    } else if (message.t === "call") {
      try {
        let value;
        const input = message.args?.[0];
        switch (message.api) {
          case "agent.registerTool": registered.set(input.name, input); break;
          case "agent.unregisterTool": registered.delete(input); break;
          case "commands.register": case "commands.unregister": case "ui.showToast": break;
          case "plugin.getDataPath":
            if (delayed) await new Promise((done) => { release = done; });
            value = directory; break;
          case "plugin.getSettings": value = settings; break;
          case "plugin.setSettings": settings = { ...settings, ...input }; await writeFile(file, JSON.stringify(settings, null, 2)); break;
          case "session.getActive": value = active ? { id: active } : null; break;
          case "ui.revealView": assert.equal(input.viewId, "tasks"); value = { revealed: true }; break;
          default: throw new Error(`未模拟宿主 API：${message.api}`);
        }
        if (child.connected) child.send({ t: "res", id: message.id, ok: true, value: value ?? null });
      } catch (error) {
        if (child.connected) child.send({ t: "res", id: message.id, ok: false, error: { code: "HOST_TEST_ERROR", message: error.message } });
      }
    }
  });
  child.on("exit", () => {
    for (const callback of pending.values()) callback.reject(new Error(`宿主提前退出：${stderr}`));
    pending.clear();
  });
  const request = (message) => new Promise((resolve, reject) => {
    const id = `test-${++sequence}`; pending.set(id, { resolve, reject }); child.send({ ...message, id });
  });
  const tool = (name, args, sessionId = "A", invocationId = `invoke-${++sequence}`) => request({ t: "call", method: "tool.execute", invocationId, payload: { name, args, sessionId, turnId: "turn", mode: "agent" } });
  const task = (content) => ({ content, status: "pending", priority: "medium" });
  try {
    await request({ t: "init", pluginId: manifest.id, pluginPath, main: manifest.main, manifest });
    assert.equal(registered.size, 2);
    const first = await tool("todo_write", { todos: [task("A任务")], expectedRevision: 0 });
    assert.equal(first.ok, true);
    await tool("todo_write", { todos: [task("B任务")] }, "B");
    assert.equal((await tool("todo_read", {})).todos[0].content, "A任务");
    active = "B";
    const panel = await request({ t: "call", method: "panel.invoke", payload: { channel: "taskCenter.snapshot", payload: {} } });
    assert.equal(panel.todos[0].content, "B任务");
    const conflict = await tool("todo_write", { todos: [], expectedRevision: 0 }); assert.equal(conflict.code, "REVISION_CONFLICT");
    await writeFile(file, "{broken");
    assert.equal((await tool("todo_read", {})).code, "STATE_CORRUPT");
    assert.equal((await tool("todo_write", { todos: [] })).code, "STATE_CORRUPT");
    assert.equal(await readFile(file, "utf8"), "{broken");
    await writeFile(file, JSON.stringify(settings));
    delayed = true;
    const cancelId = "cancel-me";
    const inFlight = tool("todo_write", { todos: [task("不应保存")] }, "A", cancelId);
    while (!release) await new Promise((done) => setImmediate(done));
    child.send({ t: "cancel", invocationId: cancelId, reason: "测试用户中止" });
    const cancelled = await inFlight; assert.equal(cancelled.ok, false);
    delayed = false; release();
    assert.equal((await tool("todo_read", {})).todos[0].content, "A任务");
    await request({ t: "call", method: "command.run", payload: { id: "taskCenter.open" } });
    await request({ t: "call", method: "lifecycle.unload", payload: {} });
    assert.equal(registered.size, 0); assert.equal(stderr, "");
  } finally {
    if (release) release();
    if (child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
    await rm(directory, { recursive: true, force: true });
  }
});
