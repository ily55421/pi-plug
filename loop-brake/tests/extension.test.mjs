/**
 * Agent extension 接线测试。
 *
 * 用一个假的 `pi` 对象模拟宿主 ExtensionAPI，跑真实的 extension 入口，
 * 验证「event → 判定 → 返回给宿主的形状」这条链是通的。
 *
 * 这不是端到端测试（没有起真实 PI-Desktop），但它覆盖了插件自己
 * 能负责的全部逻辑：事件订阅、返回值形状、异常兜底、状态清理。
 *
 * 跑法：node --test tests/extension.test.mjs
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import loopBrake from "../extension/index.mjs";

const PLUGIN_DATA_DIR = "local.loop-brake";

/**
 * 在临时数据目录里跑一段测试。
 * values 为 undefined 表示不写 settings.json（插件走 manifest 默认值）。
 */
async function runWithSettings(values, fn) {
  const dir = mkdtempSync(join(tmpdir(), "plg-data-"));
  const previous = process.env.PI_DESKTOP_DATA_DIR;
  process.env.PI_DESKTOP_DATA_DIR = dir;
  if (values !== undefined) {
    const pluginDir = join(dir, "plugins", "data", PLUGIN_DATA_DIR);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "settings.json"), JSON.stringify(values), "utf8");
  }
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_DESKTOP_DATA_DIR;
    else process.env.PI_DESKTOP_DATA_DIR = previous;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响结论。
    }
  }
}

function runWithDefaults(fn) {
  return runWithSettings(undefined, fn);
}


/**
 * 设置现在走宿主的 plugins/data/<id>/settings.json。
 * 测试用 PI_DESKTOP_DATA_DIR 指向临时目录，隔离且不污染真实配置。
 */
const PLUGIN_DATA_KEY = "local.loop-brake";

function withSettingsDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "plg-data-"));
  const previous = process.env.PI_DESKTOP_DATA_DIR;
  process.env.PI_DESKTOP_DATA_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_DESKTOP_DATA_DIR;
    else process.env.PI_DESKTOP_DATA_DIR = previous;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响结论。
    }
  }
}

/** 写该插件的 settings.json；不写则插件用 manifest 默认值。 */
function writeSettings(dir, values) {
  const pluginDir = join(dir, "plugins", "data", PLUGIN_DATA_KEY);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "settings.json"), JSON.stringify(values), "utf8");
}


/**
 * 造一个假 pi：记录注册了哪些 handler / tool / command，
 * 并提供 emit 以模拟宿主触发事件。
 */
function fakePi() {
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const logs = [];

  const pi = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    log(level, message, extra) {
      logs.push({ level, message, extra });
    },
    /** 模拟宿主 emit：返回最后一个非 undefined 的结果（与 runner 的累加语义一致）。 */
    async emit(event, payload, ctx) {
      let acc;
      for (const handler of handlers.get(event) ?? []) {
        const next = await handler(payload, ctx);
        if (next !== undefined) acc = next;
      }
      return acc;
    },
    handlers,
    tools,
    commands,
    logs,
  };
  return pi;
}

/** 本插件的 ctx 形状：会话 id 只能经 sessionManager 拿。 */
function fakeCtx(sessionId = "sess-1") {
  return {
    sessionManager: { getSessionId: () => sessionId },
    ui: { notify() {} },
    cwd: "C:\\work",
  };
}

/* ------------------------------------------------------------ 注册面 */

test("注册了三个事件、一个只读工具、一个重置命令", () => {
  const pi = fakePi();
  loopBrake(pi);

  assert.deepEqual([...pi.handlers.keys()].sort(), ["context", "session_shutdown", "tool_call"]);
  assert.deepEqual([...pi.tools.keys()], ["loop_brake_status"]);
  assert.deepEqual([...pi.commands.keys()], ["loop-brake-reset"]);
  // 只读工具声明为无参，必须带 parameters 字段（runner 的 ToolDefinitionLike 要求）。
  assert.equal(typeof pi.tools.get("loop_brake_status").parameters, "object");
});

/* ------------------------------------------------------------ 主闸接线 */

test("真实事件链路：第 3 次相同调用返回 warn 提示，第 4 次返回 block", async () => {
  const pi = fakePi();
  loopBrake(pi);
  const ctx = fakeCtx("sess-a");
  const event = { type: "tool_call", toolName: "Read", toolCallId: "t1", input: { file_path: "/a.txt" } };

  assert.equal(await pi.emit("tool_call", event, ctx), undefined);
  assert.equal(await pi.emit("tool_call", event, ctx), undefined);

  // 第 3 次：warn 模式只记录警告，不放任返回 block。
  const third = await pi.emit("tool_call", event, ctx);
  assert.equal(third, undefined, "warn 阶段不应阻断");

  // 第 4 次：阻断，且形状必须是宿主认识的 { block, reason }。
  const fourth = await pi.emit("tool_call", event, ctx);
  assert.equal(fourth.block, true);
  assert.equal(typeof fourth.reason, "string");
  assert.ok(fourth.reason.includes("Read"));
});

test("不同入参不会累积：连续段按身份区分", async () => {
  const pi = fakePi();
  loopBrake(pi);
  const ctx = fakeCtx("sess-b");

  for (let i = 0; i < 10; i += 1) {
    const result = await pi.emit(
      "tool_call",
      { type: "tool_call", toolName: "Read", toolCallId: `t${i}`, input: { file_path: `/f${i}.txt` } },
      ctx,
    );
    assert.equal(result, undefined);
  }
});

test("状态工具调用本身不被闸门拦下", async () => {
  const pi = fakePi();
  loopBrake(pi);
  const ctx = fakeCtx("sess-c");
  const event = { type: "tool_call", toolName: "loop_brake_status", toolCallId: "t", input: {} };

  for (let i = 0; i < 10; i += 1) {
    assert.equal(await pi.emit("tool_call", event, ctx), undefined);
  }
});

test("会话隔离：A 会话撞线不影响 B 会话", async () => {
  const pi = fakePi();
  loopBrake(pi);
  const event = { type: "tool_call", toolName: "Grep", toolCallId: "t", input: { pattern: "x" } };

  const a = fakeCtx("sess-a");
  const b = fakeCtx("sess-b");

  await pi.emit("tool_call", event, a);
  await pi.emit("tool_call", event, a);
  await pi.emit("tool_call", event, a); // a 警告

  // b 是全新会话，第一次调用必须放行。
  assert.equal(await pi.emit("tool_call", event, b), undefined);
});

/* ------------------------------------------------------------ 警告递进上下文 */

test("warn 之后，context 事件把提醒加进消息列表（只加一次）", async () => {
  const pi = fakePi();
  loopBrake(pi);
  const ctx = fakeCtx("sess-d");
  const event = { type: "tool_call", toolName: "Glob", toolCallId: "t", input: { pattern: "**/*.ts" } };

  await pi.emit("tool_call", event, ctx);
  await pi.emit("tool_call", event, ctx);
  await pi.emit("tool_call", event, ctx); // 撞线 → 攒下警告

  const messages = [{ role: "user", content: "hi" }];
  const result = await pi.emit("context", { type: "context", messages }, ctx);

  assert.ok(Array.isArray(result?.messages), "context 应返回替换后的消息列表");
  assert.equal(result.messages.length, 2);
  const injected = result.messages[1];
  assert.equal(injected.role, "system");
  assert.ok(injected.content.includes("[loop-brake]"));
  assert.ok(injected.content.includes("Glob"));

  // 原数组不应被就地修改（我们 slice 过）。
  assert.equal(messages.length, 1);

  // 第二次 context：警告已消费，不再注入。
  const second = await pi.emit("context", { type: "context", messages }, ctx);
  assert.equal(second, undefined);
});

test("没有待发警告时 context 原样返回 undefined（不做无谓侵入）", async () => {
  const pi = fakePi();
  loopBrake(pi);
  const ctx = fakeCtx("sess-e");
  const result = await pi.emit("context", { type: "context", messages: [] }, ctx);
  assert.equal(result, undefined);
});

/* ------------------------------------------------------------ 状态工具与命令 */

test("状态工具报告默认阈值与计数", async () => {
  const pi = fakePi();
  loopBrake(pi);
  const ctx = fakeCtx("sess-f");
  const tool = pi.tools.get("loop_brake_status");

  const result = await tool.execute("c1", {}, undefined, undefined, ctx);
  const text = result.content[0].text;

  assert.ok(text.includes("threshold: 3"));
  assert.ok(text.includes("mode: warn"));
  assert.ok(text.includes("enabled: true"));
  assert.ok(text.includes("consecutive identical calls: 0"));
  assert.equal(typeof result.details.snapshot, "object");
});

test("状态工具反映真实计数", async () => {
  const pi = fakePi();
  loopBrake(pi);
  const ctx = fakeCtx("sess-g");
  const event = { type: "tool_call", toolName: "Read", toolCallId: "t", input: { p: 1 } };

  await pi.emit("tool_call", event, ctx);
  await pi.emit("tool_call", event, ctx);

  const tool = pi.tools.get("loop_brake_status");
  const result = await tool.execute("c1", {}, undefined, undefined, ctx);
  assert.ok(result.content[0].text.includes("consecutive identical calls: 2"));
});

test("重置命令清空计数，逃生口可用", async () => {
  const pi = fakePi();
  loopBrake(pi);
  const ctx = fakeCtx("sess-h");
  const event = { type: "tool_call", toolName: "Read", toolCallId: "t", input: { p: 1 } };

  await pi.emit("tool_call", event, ctx);
  await pi.emit("tool_call", event, ctx);
  await pi.emit("tool_call", event, ctx); // warn
  const blocked = await pi.emit("tool_call", event, ctx);
  assert.equal(blocked.block, true);

  pi.commands.get("loop-brake-reset").handler("", ctx);

  // 重置后同一调用重新从 1 开始，不再阻断。
  const after = await pi.emit("tool_call", event, ctx);
  assert.equal(after, undefined);
});

test("命令在 ui.notify 抛错时仍然完成重置", async () => {
  const pi = fakePi();
  loopBrake(pi);
  const ctx = {
    sessionManager: { getSessionId: () => "sess-i" },
    ui: {
      notify() {
        throw new Error("renderer gone");
      },
    },
  };
  const event = { type: "tool_call", toolName: "Read", toolCallId: "t", input: { p: 1 } };
  await pi.emit("tool_call", event, ctx);
  await pi.emit("tool_call", event, ctx);
  await pi.emit("tool_call", event, ctx);

  // 不抛错即为通过；随后计数应已归零。
  assert.doesNotThrow(() => pi.commands.get("loop-brake-reset").handler("", ctx));
  const tool = pi.tools.get("loop_brake_status");
  const result = await tool.execute("c1", {}, undefined, undefined, ctx);
  assert.ok(result.content[0].text.includes("consecutive identical calls: 0"));
});

/* ------------------------------------------------------------ 健壮性 */

test("session_shutdown 释放该会话状态", async () => {
  const pi = fakePi();
  loopBrake(pi);
  const ctx = fakeCtx("sess-j");
  const event = { type: "tool_call", toolName: "Read", toolCallId: "t", input: { p: 1 } };

  await pi.emit("tool_call", event, ctx);
  await pi.emit("tool_call", event, ctx);
  await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

  // 清理后重新计数：第一次调用放行。
  assert.equal(await pi.emit("tool_call", event, ctx), undefined);
  const tool = pi.tools.get("loop_brake_status");
  const result = await tool.execute("c1", {}, undefined, undefined, ctx);
  assert.ok(result.content[0].text.includes("consecutive identical calls: 1"));
});

test("ctx 缺 sessionManager 时退回兜底键而不是崩", async () => {
  const pi = fakePi();
  loopBrake(pi);
  const bare = {}; // 完全没有 sessionManager
  const event = { type: "tool_call", toolName: "Read", toolCallId: "t", input: { p: 1 } };

  assert.equal(await pi.emit("tool_call", event, bare), undefined);
  assert.equal(await pi.emit("tool_call", event, bare), undefined);
  // 第 3 次进入 warn 阶段，仍不阻断。
  assert.equal(await pi.emit("tool_call", event, bare), undefined);
  // 第 4 次阻断 —— 说明兜底键确实在累积状态。
  const blocked = await pi.emit("tool_call", event, bare);
  assert.equal(blocked.block, true);
});

/* ------------------------------------------------------------ 设置热更新 */

test("设置签名不变时不得重置连续计数（回归：每次对齐设置曾把计数清零）", async () => {
  await runWithDefaults(async () => {
    const pi = fakePi();
    loopBrake(pi);
    const ctx = fakeCtx("sess-hot");
    const event = { type: "tool_call", toolName: "Read", toolCallId: "t", input: { p: 1 } };

    // 默认阈值 3 + warn：第 1-3 次放行，第 4 次阻断。
    // 如果每次调用都重读设置并 updateSettings（内部会 reset），计数永远到不了 4。
    assert.equal(await pi.emit("tool_call", event, ctx), undefined);
    assert.equal(await pi.emit("tool_call", event, ctx), undefined);
    assert.equal(await pi.emit("tool_call", event, ctx), undefined);
    const blocked = await pi.emit("tool_call", event, ctx);
    assert.equal(blocked?.block, true, "连续第 4 次必须阻断——计数不能被设置对齐清零");
  });
});

test("改 settings.json 后下一次调用立即生效（热更新）", async () => {
  await runWithSettings({ enabled: true, threshold: 3, mode: "warn" }, async (dataDir) => {
    const pi = fakePi();
    loopBrake(pi);
    const ctx = fakeCtx("sess-hot2");
    const event = { type: "tool_call", toolName: "Read", toolCallId: "t", input: { p: 1 } };

    await pi.emit("tool_call", event, ctx);
    await pi.emit("tool_call", event, ctx);

    // 改成阈值 2 + 直接阻断。改设置会触发 updateSettings（内部 reset 计数），
    // 这是刻意的：阈值语义变了就该重新数。所以第 3 次调用 consecutive=1 放行，
    // 第 4 次起 consecutive=2 ≥ 新阈值 2，必须被拦。
    writeSettings(dataDir, { enabled: true, threshold: 2, mode: "block" });
    assert.equal(await pi.emit("tool_call", event, ctx), undefined, "改设置后的第一次调用重新计数，放行");
    const blocked = await pi.emit("tool_call", event, ctx);
    assert.equal(blocked?.block, true, "新阈值 2 生效：连续第 2 次即阻断");
  });
});

test("事件缺 toolName 时直接放行，不计数", async () => {
  const pi = fakePi();
  loopBrake(pi);
  const ctx = fakeCtx("sess-k");
  for (let i = 0; i < 10; i += 1) {
    assert.equal(await pi.emit("tool_call", { type: "tool_call" }, ctx), undefined);
    assert.equal(await pi.emit("tool_call", undefined, ctx), undefined);
  }
});

test("处理器内部异常被吞掉并记 warn 日志，绝不阻断正常调用", async () => {
  const pi = fakePi();
  loopBrake(pi);
  const ctx = fakeCtx("sess-l");

  // 造一个会让 fingerprint 抛错的入参：getter 抛异常。
  const hostile = { p: 1 };
  Object.defineProperty(hostile, "boom", {
    enumerable: true,
    get() {
      throw new Error("getter exploded");
    },
  });

  const result = await pi.emit(
    "tool_call",
    { type: "tool_call", toolName: "Read", toolCallId: "t", input: hostile },
    ctx,
  );
  assert.equal(result, undefined, "内部异常必须退化为放行");
  assert.equal(pi.logs.length, 1);
  assert.equal(pi.logs[0].level, "warn");
});

test("状态工具的 notes 不含大段入参内容（不泄露）", async () => {
  const pi = fakePi();
  loopBrake(pi);
  const ctx = fakeCtx("sess-m");
  const long = "x".repeat(5000);
  const event = { type: "tool_call", toolName: "Write", toolCallId: "t", input: { content: long } };

  await pi.emit("tool_call", event, ctx);
  await pi.emit("tool_call", event, ctx);
  await pi.emit("tool_call", event, ctx); // warn，攒下含入参缩略的文案
  const result = await pi.emit("context", { type: "context", messages: [] }, ctx);
  const injected = result.messages[0].content;
  assert.ok(injected.length < 600, `注入文案长度 ${injected.length} 应远小于 5000`);
});
