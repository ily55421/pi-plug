import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../renderer/panel.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");

class Events {
  handlers = new Map();
  addEventListener(name, fn) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    this.handlers.get(name).add(fn);
  }
  removeEventListener(name, fn) { this.handlers.get(name)?.delete(fn); }
  emit(name, value) { for (const fn of [...(this.handlers.get(name) || [])]) fn(value); }
  get size() { return [...this.handlers.values()].reduce((n, set) => n + set.size, 0); }
}

class Element {
  dataset = {};
  style = {};
  attributes = {};
  children = [];
  hidden = false;
  _text = "";
  writes = 0;
  set textContent(value) {
    this._text = String(value);
    this.children = [];
    this.writes++;
  }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  set innerHTML(_) { throw new Error("不允许通过 innerHTML 写入任务文本"); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  append(...children) { this.children.push(...children); }
}

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function snapshot(overrides = {}) {
  return {
    ok: true, sessionId: "session-a", runId: "run-a", revision: 1, updatedAt: 1700000000000,
    total: 2, finished: 1, percent: 50, remainingCount: 1,
    counts: { pending: 1, in_progress: 0, completed: 1, cancelled: 0 },
    current: { content: "待办事项", status: "pending", priority: "medium" },
    todos: [
      { content: "完成事项", status: "completed", priority: "high" },
      { content: "待办事项", status: "pending", priority: "low" },
    ],
    legacyAvailable: false, archived: false, capacity: null, ...overrides,
  };
}
const emptySession = (id = "session-b") => snapshot({
  sessionId: id, runId: null, revision: 0, updatedAt: null,
  total: 0, finished: 0, percent: 0, remainingCount: 0,
  counts: { pending: 0, in_progress: 0, completed: 0, cancelled: 0 },
  current: null, todos: [],
});

function setup({ events = true, missingBridge = false, hidden = false, appearance = { base: "dark", locale: "zh-CN" } } = {}) {
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], new Element()]));
  const document = new Events();
  document.hidden = hidden;
  document.body = new Element();
  document.documentElement = new Element();
  document.getElementById = (id) => {
    assert.ok(nodes.has(id), `HTML 缺少元素 ${id}`);
    return nodes.get(id);
  };
  document.createElement = () => new Element();
  const window = new Events();
  window.matchMedia = () => ({ matches: false });
  const pushed = new Events();
  const calls = [];
  const requests = [];
  const appearanceRequests = [];
  const sessionRequests = [];
  let activeSession = "session-a";
  let appearanceHandler = () => appearance;
  const bridge = {
    invoke(channel, payload) {
      calls.push({ channel, payload });
      if (channel === "app.getAppearance") {
        appearanceRequests.push(payload);
        return appearanceHandler();
      }
      if (channel === "session.getActive") {
        sessionRequests.push(payload);
        return activeSession === null ? null : { id: activeSession };
      }
      assert.equal(channel, "taskCenter.snapshot");
      const request = deferred();
      requests.push({ ...request, payload, settled: false });
      return request.promise;
    },
  };
  if (events) bridge.on = (event, handler) => {
    pushed.addEventListener(event, handler);
    return () => pushed.removeEventListener(event, handler);
  };
  if (!missingBridge) window.pluginBridge = bridge;
  let clock = 0;
  let sequence = 0;
  const timers = new Map();
  const setTimeout = (fn, ms) => {
    const id = ++sequence;
    timers.set(id, { fn, time: clock + ms });
    return id;
  };
  const clearTimeout = (id) => timers.delete(id);
  vm.runInNewContext(source, { window, document, setTimeout, clearTimeout }, { filename: "panel.js" });
  return {
    window, document, pushed, calls, requests, appearanceRequests, sessionRequests, timers,
    node: (id) => nodes.get(id),
    setAppearanceHandler: (fn) => { appearanceHandler = fn; },
    setActiveSession: (id) => { activeSession = id; },
    async resolve(value, index) {
      // 首次刷新要先取会话身份，请求会晚一个微任务出现；只解析最新的未解析请求。
      const pick = () => (Number.isInteger(index) ? requests[index] : requests[requests.length - 1]);
      let target = pick();
      for (let attempt = 0; attempt < 5 && (!target || target.settled); attempt++) {
        await flush();
        target = pick();
      }
      assert.ok(target && !target.settled, "没有可解析的快照请求");
      target.settled = true;
      target.resolve(value);
      await flush();
    },
    async tick(ms) {
      await flush();
      const end = clock + ms;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.time <= end).sort((a, b) => a[1].time - b[1].time)[0];
        if (!next) break;
        const [id, timer] = next;
        clock = timer.time;
        timers.delete(id);
        timer.fn();
        await flush();
      }
      clock = end;
    },
    async visibility(value) {
      document.hidden = value;
      document.emit("visibilitychange");
      await flush();
    },
  };
}

test("使用服务端 finished/percent，安全渲染文本", async () => {
  const env = setup();
  await env.resolve(snapshot({
    total: 2, finished: 2, percent: 100, remainingCount: 0, current: null,
    counts: { pending: 0, in_progress: 0, completed: 1, cancelled: 1 },
    todos: [
      { content: "<img src=x onerror=alert(1)>", status: "completed", priority: "high" },
      { content: "取消事项", status: "cancelled", priority: "low" },
    ],
  }));
  assert.equal(env.node("count").textContent, "已结束 2/2 · 100%");
  assert.equal(env.node("breakdown").textContent, "完成 1 · 取消 1");
  assert.equal(env.node("progress").style.width, "100%");
  assert.equal(env.node("progressBar").attributes["aria-valuenow"], "100");
  assert.equal(env.node("list").children[0].children[1].textContent, "<img src=x onerror=alert(1)>");
  assert.equal(env.node("currentRow").hidden, true);
  assert.deepEqual(env.calls.map((call) => call.channel).sort(), ["app.getAppearance", "session.getActive", "session.getActive", "taskCenter.snapshot"]);
});

test("读取失败保留旧数据并标注过期，unchanged 恢复且不重建列表", async () => {
  const env = setup();
  await env.resolve(snapshot());
  const item = env.node("list").children[0];
  env.window.emit("focus");
  await env.resolve({ ok: false, code: "STORAGE_READ_FAILED", message: "文件读取失败" });
  assert.equal(env.node("list").children[0], item);
  assert.equal(env.document.body.dataset.stale, "true");
  assert.match(env.node("notice").textContent, /数据已过期.*文件读取失败/);
  assert.equal(env.node("notice").dataset.kind, "error");
  env.window.emit("focus");
  assert.deepEqual(JSON.parse(JSON.stringify(env.requests.at(-1).payload)), {
    knownSessionId: "session-a", knownRunId: "run-a", knownRevision: 1, sessionId: "session-a",
  });
  await env.resolve({ ok: true, unchanged: true, sessionId: "session-a", runId: "run-a", revision: 1 });
  assert.equal(env.node("notice").hidden, true);
  assert.equal(env.document.body.dataset.stale, "false");
  assert.equal(env.node("list").children[0], item);
});

test("Promise 拒绝保留数据，格式损坏也标注过期", async () => {
  const env = setup();
  await env.resolve(snapshot());
  env.window.emit("focus");
  await flush();
  const failing = env.requests.at(-1);
  failing.settled = true;
  failing.reject(new Error("IPC closed"));
  await flush();
  assert.equal(env.node("list").children.length, 2);
  assert.match(env.node("notice").textContent, /数据已过期/);
  env.window.emit("focus");
  await env.resolve({ ok: true, sessionId: "session-a", todos: [] });
  assert.equal(env.node("list").children.length, 2);
  assert.match(env.node("notice").textContent, /格式异常/);
});

for (const code of ["NO_ACTIVE_SESSION", "SESSION_CHANGED"]) {
  test(`${code} 清除旧会话和缓存身份提示`, async () => {
    const env = setup();
    await env.resolve(snapshot({ current: { content: "当前任务", status: "in_progress", priority: "high" } }));
    env.window.emit("focus");
    await env.resolve({ ok: false, code });
    assert.equal(env.node("list").children.length, 0);
    assert.equal(env.node("count").textContent, "—");
    assert.equal(env.node("currentRow").hidden, true);
    assert.equal(env.node("currentText").textContent, "");
    assert.equal(env.node("progress").style.width, "0%");
    assert.equal(env.document.body.dataset.stale, "false");
    assert.equal(env.node("notice").hidden, false);
    env.window.emit("focus");
    await flush();
    assert.deepEqual(Object.keys(env.requests.at(-1).payload), ["sessionId"]);
  });
}

test("检测到会话切换或无活动会话时立即清空旧快照", async () => {
  const env = setup();
  await env.resolve(snapshot());

  env.setActiveSession("session-b");
  env.window.emit("focus");
  await flush();
  assert.equal(env.node("list").children.length, 0);
  assert.equal(env.node("count").textContent, "—");
  assert.equal(env.requests.at(-1).payload.sessionId, "session-b");
  await env.resolve(emptySession("session-b"));
  assert.equal(env.node("count").textContent, "已结束 0/0 · 0%");

  env.setActiveSession(null);
  env.window.emit("focus");
  await flush();
  assert.equal(env.node("list").children.length, 0);
  assert.equal(env.requests.at(-1).payload.noActiveSession, true);
  await env.resolve({ ok: false, code: "NO_ACTIVE_SESSION" });
  assert.equal(env.node("count").textContent, "—");
});

test("会话切换期间的迟到快照被丢弃并立即重新读取", async () => {
  const env = setup();
  await env.resolve(snapshot());
  env.window.emit("focus");
  await flush();
  assert.equal(env.requests.length, 2);
  env.setActiveSession("session-b");
  await env.resolve(snapshot({ revision: 2 }), 1);
  assert.equal(env.node("list").children.length, 0);
  assert.equal(env.requests.length, 3);
  assert.equal(env.requests.at(-1).payload.sessionId, "session-b");
  await env.resolve(emptySession("session-b"), 2);
  assert.equal(env.node("count").textContent, "已结束 0/0 · 0%");
});

test("新会话无清单是成功空态，旧清单和统计被清除", async () => {
  const env = setup();
  await env.resolve(snapshot());
  await env.tick(3000);
  await env.resolve(emptySession("session-b"));
  assert.equal(env.node("list").children.length, 0);
  assert.equal(env.node("count").textContent, "已结束 0/0 · 0%");
  assert.equal(env.node("empty").hidden, false);
  assert.match(env.node("emptyHint").textContent, /todo_write/);
  assert.equal(env.node("notice").hidden, true);
});

test("清单已结束时降低轮询频率，未完成时保持3秒", async () => {
  const settled = setup();
  await settled.resolve(snapshot({ finished: 2, percent: 100, remainingCount: 0, counts: { pending: 0, in_progress: 0, completed: 1, cancelled: 1 } }));
  await settled.tick(19999);
  assert.equal(settled.requests.length, 1);
  await settled.tick(1);
  assert.equal(settled.requests.length, 2);

  const active = setup();
  await active.resolve(snapshot());
  await active.tick(2999);
  assert.equal(active.requests.length, 1);
  await active.tick(1);
  assert.equal(active.requests.length, 2);
});

test("回合结束事件立即刷新，在途请求不并发重复发送", async () => {
  const env = setup();
  await env.resolve(snapshot());
  assert.equal(env.requests.length, 1);
  env.pushed.emit("session:turnEnded", { sessionId: "session-a", turnId: "t1", reason: "completed" });
  await flush();
  assert.equal(env.requests.length, 2);
  env.pushed.emit("session:turnEnded", { sessionId: "session-a", turnId: "t2", reason: "completed" });
  await flush();
  assert.equal(env.requests.length, 2, "请求进行中不重复发起");
  await env.resolve(snapshot({ revision: 2 }));
  assert.equal(env.node("list").children.length, 2);
});

test("隐藏完全暂停，恢复立即刷新快照和主题，无事件通道使用低频回退", async () => {
  const env = setup({ events: false });
  await env.resolve(snapshot());
  await env.tick(2999);
  assert.equal(env.requests.length, 1);
  await env.visibility(true);
  assert.equal(env.timers.size, 0);
  const calls = env.calls.length;
  await env.tick(120000);
  env.window.emit("focus");
  assert.equal(env.calls.length, calls);
  await env.visibility(false);
  assert.equal(env.requests.length, 2);
  assert.equal(env.appearanceRequests.length, 2);
  await env.resolve(snapshot());
  await env.tick(30000);
  assert.equal(env.appearanceRequests.length, 3);
  assert.ok(env.requests.length >= 3);
});

test("隐藏时的在途响应被丢弃，恢复请求等待旧请求结束且不重叠", async () => {
  const env = setup();
  await env.visibility(true);
  await env.visibility(false);
  assert.equal(env.requests.length, 1);
  await env.resolve(snapshot(), 0);
  assert.equal(env.node("list").children.length, 0);
  assert.equal(env.requests.length, 2);
  await env.resolve(snapshot({ sessionId: "session-b" }));
  assert.equal(env.node("list").children.length, 2);
});

test("串行刷新：慢请求期间无定时器，重复聚焦合并，完成后按间隔轮询", async () => {
  const env = setup();
  await flush();
  for (let i = 0; i < 5; i++) env.window.emit("focus");
  await env.tick(15000);
  assert.equal(env.requests.length, 1);
  await env.resolve(snapshot());
  await env.tick(2999);
  assert.equal(env.requests.length, 1);
  await env.tick(1);
  assert.equal(env.requests.length, 2);
  for (let i = 0; i < 5; i++) env.window.emit("focus");
  await env.tick(10000);
  assert.equal(env.requests.length, 2);
});

test("主题推送更新语言，无主题轮询，迟到的主题读取不能覆盖推送", async () => {
  const env = setup();
  const pending = deferred();
  await env.resolve(snapshot());
  env.setAppearanceHandler(() => pending.promise);
  await env.visibility(true);
  await env.visibility(false);
  env.pushed.emit("appearance:changed", { base: "light", locale: "en-US" });
  pending.resolve({ base: "dark", locale: "zh-CN" });
  await flush();
  assert.equal(env.document.documentElement.dataset.base, "light");
  assert.equal(env.document.documentElement.lang, "en");
  assert.equal(env.node("title").textContent, "Task Center");
  assert.equal(env.node("count").textContent, "Finished 1/2 · 50%");
  assert.equal(env.node("breakdown").textContent, "Completed 1 · Cancelled 0");
  assert.equal(env.timers.size, 0);
});

test("卸载清理订阅和定时器，迟到的快照和主题均不写 DOM", async () => {
  const env = setup();
  await env.resolve(snapshot());
  const theme = deferred();
  env.setAppearanceHandler(() => theme.promise);
  await env.visibility(true);
  await env.visibility(false);
  const count = env.node("count").textContent;
  const writes = env.node("list").writes;
  env.window.emit("pagehide");
  assert.equal(env.timers.size, 0);
  assert.equal(env.pushed.size, 0);
  assert.equal(env.window.size, 0);
  assert.equal(env.document.size, 0);
  await env.resolve(emptySession());
  theme.resolve({ base: "light", locale: "en-US" });
  await flush();
  assert.equal(env.node("count").textContent, count);
  assert.equal(env.node("list").writes, writes);
  assert.equal(env.document.documentElement.dataset.base, "dark");
  await env.tick(60000);
  assert.equal(env.requests.length, 2);
  assert.equal(env.timers.size, 0);
});

test("初始隐藏不请求；缺失 bridge 显示明确错误", async () => {
  const hidden = setup({ hidden: true });
  assert.equal(hidden.calls.length, 0);
  await hidden.visibility(false);
  assert.equal(hidden.requests.length, 1);
  assert.equal(hidden.appearanceRequests.length, 1);
  const missing = setup({ missingBridge: true });
  assert.match(missing.node("notice").textContent, /无法连接宿主.*pluginBridge/);
  assert.equal(missing.node("notice").hidden, false);
  assert.equal(missing.timers.size, 0);
});

test("拒绝自相矛盾或越界的快照，保留上次成功内容", async () => {
  const env = setup();
  await env.resolve(snapshot());
  const item = env.node("list").children[0];
  const bad = [
    snapshot({ total: 5 }),
    snapshot({ counts: { pending: 9, in_progress: 0, completed: 1, cancelled: 0 } }),
    snapshot({ percent: 90 }),
    snapshot({ finished: 0 }),
    snapshot({ todos: [{ content: "x", status: "weird", priority: "high" }], total: 1, finished: 0, percent: 0, counts: { pending: 1, in_progress: 0, completed: 0, cancelled: 0 }, remainingCount: 1, current: null }),
    snapshot({ current: { content: "已完成", status: "completed", priority: "high" } }),
    snapshot({ capacity: { usedBytes: 1, limitBytes: 2 } }),
    snapshot({ todos: Array.from({ length: 201 }, (_, i) => ({ content: `t${i}`, status: "pending", priority: "low" })), total: 201 }),
  ];
  for (const value of bad) {
    env.window.emit("focus");
    await env.resolve(value);
    assert.equal(env.node("list").children[0], item, "非法快照不能替换现有内容");
    assert.match(env.node("notice").textContent, /格式异常/);
  }
});

test("容量接近上限时提示归档，且不被普通状态覆盖", async () => {
  const env = setup();
  await env.resolve(snapshot({ capacity: { usedBytes: 7000000, limitBytes: 8388608, percent: 83, warning: true } }));
  assert.equal(env.node("notice").hidden, false);
  assert.match(env.node("notice").textContent, /83%/);
  assert.equal(env.node("notice").dataset.kind, "warn");
  env.window.emit("focus");
  await env.resolve(snapshot({ capacity: { usedBytes: 100, limitBytes: 8388608, percent: 0, warning: false } }));
  assert.equal(env.node("notice").hidden, true);
});

test("连续读取失败按3/6/15/30秒退避，成功后恢复常规间隔", async () => {
  const env = setup();
  await env.resolve({ ok: false, code: "STORAGE_READ_FAILED" });
  await env.tick(2999);
  assert.equal(env.requests.length, 1);
  await env.tick(1);
  assert.equal(env.requests.length, 2);
  await env.resolve({ ok: false, code: "STORAGE_READ_FAILED" });
  await env.tick(5999);
  assert.equal(env.requests.length, 2);
  await env.tick(1);
  assert.equal(env.requests.length, 3);
  await env.resolve({ ok: false, code: "STORAGE_READ_FAILED" });
  await env.tick(14999);
  assert.equal(env.requests.length, 3);
  await env.tick(1);
  assert.equal(env.requests.length, 4);
  await env.resolve({ ok: false, code: "STORAGE_READ_FAILED" });
  await env.tick(29999);
  assert.equal(env.requests.length, 4);
  await env.tick(1);
  assert.equal(env.requests.length, 5);
  await env.resolve(snapshot());
  await env.tick(2999);
  assert.equal(env.requests.length, 5);
  await env.tick(1);
  assert.equal(env.requests.length, 6);
});

test("HTML 使用外部脚本、hidden 优先样式、固定高度与无障碍进度条", () => {
  assert.match(html, /<script src="panel\.js"><\/script>/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(html, /height:\s*100vh/);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-valuemin="0" aria-valuemax="100"/);
  assert.match(html, /\.notice\[data-kind="warn"\]/);
});