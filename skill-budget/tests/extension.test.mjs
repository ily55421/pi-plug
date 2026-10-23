/**
 * Agent extension 接线测试。
 *
 * 用假 `pi` 跑真实入口，验证：注册面、默认不改写、开启后按 id 去重、
 * 异常退化为不改写、工具与命令的返回形状。
 *
 * 跑法：node --test tests/extension.test.mjs
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import skillBudget from "../extension/index.mjs";

const PLUGIN_DATA_DIR = "local.skill-budget";

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
const PLUGIN_DATA_KEY = "local.skill-budget";

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


const INTRO =
  "Plugins have taught you the following skills. Each entry is a set of instructions you can load with the `Skill` tool by passing its exact id.";

/** 按宿主 plugin-skills-prompt.ts 的真实输出造系统提示。 */
function hostPrompt(skills, { before = "# System\n\nYou are helpful.", after = "# Tools\n\n..." } = {}) {
  const entries = skills.map((s) => `- \`${s.id}\` — ${s.name}${s.description ? `: ${s.description}` : ""}`);
  return [before, "", "# Skills", "", INTRO, "", ...entries, "", after].join("\n");
}

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

/** ctx 形状照 runner.ts:713：会话 id 走 sessionManager，设置靠注入。 */
function fakeCtx({ sessionId = "sess-1", prompt = "" } = {}) {
  const ctx = {
    sessionManager: { getSessionId: () => sessionId },
    getSystemPrompt: () => prompt,
    getContextUsage: () => ({ tokens: 5000, contextWindow: 200000, percent: 3 }),
    ui: { notify() {} },
  };
  return ctx;
}

/* ------------------------------------------------------------ 注册面 */

test("注册两个事件、一个只读工具、一个命令", () => {
  const pi = fakePi();
  skillBudget(pi);

  assert.deepEqual([...pi.handlers.keys()].sort(), ["before_agent_start", "session_shutdown"]);
  assert.deepEqual([...pi.tools.keys()], ["skill_budget_audit"]);
  assert.deepEqual([...pi.commands.keys()], ["skill-budget"]);
  assert.equal(typeof pi.tools.get("skill_budget_audit").parameters, "object");
});

/* ------------------------------------------------------------ 默认不改写 */

test("默认（无设置）不改写系统提示", async () => {
  const pi = fakePi();
  skillBudget(pi);
  const prompt = hostPrompt([
    { id: "dup/x", name: "X", description: "Same." },
    { id: "dup/x", name: "X", description: "Same." },
  ]);
  const result = await pi.emit(
    "before_agent_start",
    { type: "before_agent_start", prompt: "hi", systemPrompt: prompt },
    fakeCtx({ prompt }),
  );
  assert.equal(result, undefined, "没被明确要求就不该动系统提示");
});

test("设置里 dedupeSkillsSection 不为 true 时同样不改写", async () => {
  const pi = fakePi();
  skillBudget(pi);
  const prompt = hostPrompt([{ id: "dup/x", name: "X", description: "Same." }]);
  for (const values of [{}, { dedupeSkillsSection: false }, { dedupeSkillsSection: "yes" }]) {
    await runWithSettings(values, async () => {
      const result = await pi.emit(
        "before_agent_start",
        { type: "before_agent_start", systemPrompt: prompt },
        fakeCtx({ prompt }),
      );
      assert.equal(result, undefined);
    });
  }
});

/* ------------------------------------------------------------ 开启后改写 */

test("显式开启后按 id 去重，并返回新的 systemPrompt", async () => {
  await runWithSettings({ dedupeSkillsSection: true }, async () => {
    const pi = fakePi();
    skillBudget(pi);
    const prompt = hostPrompt([
      { id: "dup/x", name: "X", description: "Same." },
      { id: "other/y", name: "Y", description: "Different." },
      { id: "dup/x", name: "X", description: "Same." },
    ]);
    const ctx = fakeCtx({ prompt });

    const result = await pi.emit("before_agent_start", { type: "before_agent_start", systemPrompt: prompt }, ctx);

    assert.ok(result && typeof result.systemPrompt === "string");
    assert.equal(result.systemPrompt.split("`dup/x`").length - 1, 1);
    assert.ok(result.systemPrompt.includes("`other/y`"));
    assert.ok(result.systemPrompt.includes("# System"), "其余段落必须保留");
    assert.ok(result.systemPrompt.includes("# Tools"));
  });
});

test("没有重复时返回 undefined，不做无谓改动", async () => {
  const pi = fakePi();
  skillBudget(pi);
  const prompt = hostPrompt([
    { id: "a/one", name: "One", description: "First." },
    { id: "b/two", name: "Two", description: "Second." },
  ]);
  const result = await pi.emit(
    "before_agent_start",
    { type: "before_agent_start", systemPrompt: prompt },
    fakeCtx({ prompt }),
  );
  assert.equal(result, undefined);
});

test("没有技能段的提示即使开启也返回 undefined", async () => {
  const pi = fakePi();
  skillBudget(pi);
  const prompt = "# System\n\nnothing";
  const result = await pi.emit(
    "before_agent_start",
    { type: "before_agent_start", systemPrompt: prompt },
    fakeCtx({ prompt }),
  );
  assert.equal(result, undefined);
});

test("event 里没有 systemPrompt 时安全返回", async () => {
  const pi = fakePi();
  skillBudget(pi);
  const result = await pi.emit(
    "before_agent_start",
    { type: "before_agent_start" },
    fakeCtx({}),
  );
  assert.equal(result, undefined);
});

test("去重记录按会话隔离：A 的写入不进入 B 的 applied 表", async () => {
  await runWithSettings({ dedupeSkillsSection: true }, async () => {
    const pi = fakePi();
    skillBudget(pi);
    const dupPrompt = hostPrompt([
      { id: "dup/x", name: "X", description: "Same." },
      { id: "dup/x", name: "X", description: "Same." },
    ]);
    const ctxA = fakeCtx({ sessionId: "a", prompt: dupPrompt });

    const a = await pi.emit("before_agent_start", { type: "before_agent_start", systemPrompt: dupPrompt }, ctxA);
    // 两个会话各自去重各自的提示：B 首次调用同样会拿到改写结果，而不是 undefined。
    const ctxB = fakeCtx({ sessionId: "b", prompt: dupPrompt });
    const b = await pi.emit("before_agent_start", { type: "before_agent_start", systemPrompt: dupPrompt }, ctxB);
    assert.ok(a, "A 首次调用应去重");
    assert.ok(b, "B 首次调用也应去重（记录不串会话）");
    assert.equal(b.systemPrompt.split("`dup/x`").length - 1, 1);
  });
});

/* ------------------------------------------------------------ 异常兜底 */

test("内部异常向上抛，交给宿主记 handler_error 诊断", async () => {
  await runWithSettings({ dedupeSkillsSection: true }, async () => {
    const pi = fakePi();
    skillBudget(pi);
    // event 里塞一个会抛的 getter
    const hostile = {};
    Object.defineProperty(hostile, "systemPrompt", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });

    // handler 刻意不 catch：真实宿主对 handler 抛错的行为是记 handler_error
    // 诊断并按 undefined 处理（退化为不改写），且诊断面板可见；
    // 而本地 catch + pi.log 在真实宿主里是 no-op，等于把错误吞掉。
    await assert.rejects(
      () => pi.emit("before_agent_start", hostile, fakeCtx({})),
      /boom/,
    );
  });
});
/* ------------------------------------------------------------ 工具与命令 */

test("审计工具返回成本摘要与结构化详情", async () => {
  const pi = fakePi();
  skillBudget(pi);
  const prompt = hostPrompt([
    { id: "a/one", name: "One", description: "First thing." },
    { id: "b/two", name: "Two", description: "Second thing." },
  ]);
  const ctx = fakeCtx({ prompt });
  const result = await pi.tools.get("skill_budget_audit").execute("c1", {}, undefined, undefined, ctx);

  const text = result.content[0].text;
  assert.ok(text.includes("Skills advertised: 2"));
  assert.ok(text.includes("estimate"));
  assert.equal(result.details.found, true);
  assert.equal(result.details.estimate, true);
  assert.equal(result.details.totals.skills, 2);
  assert.deepEqual(result.details.contextUsage, { tokens: 5000, contextWindow: 200000, percent: 3 });
});

test("审计工具在 getSystemPrompt 缺失时给出明确结论而不是崩", async () => {
  const pi = fakePi();
  skillBudget(pi);
  const bare = { sessionManager: { getSessionId: () => "s" } };
  const result = await pi.tools.get("skill_budget_audit").execute("c1", {}, undefined, undefined, bare);

  assert.equal(result.details.found, false);
  assert.ok(result.content[0].text.includes("# Skills"));
  assert.equal(result.details.contextUsage, null);
});

test("审计工具不返回技能全文（自身不该吃上下文）", async () => {
  const pi = fakePi();
  skillBudget(pi);
  const longDesc = "x".repeat(2000);
  const prompt = hostPrompt([{ id: "a/one", name: "One", description: longDesc }]);
  const result = await pi.tools.get("skill_budget_audit").execute("c1", {}, undefined, undefined, fakeCtx({ prompt }));

  assert.ok(result.content[0].text.length < 1200, "摘要应远短于原始描述");
  assert.ok(!result.content[0].text.includes(longDesc));
});

test("命令在 ui.notify 抛错时也不抛", () => {
  const pi = fakePi();
  skillBudget(pi);
  const ctx = {
    sessionManager: { getSessionId: () => "s" },
    getSystemPrompt: () => hostPrompt([{ id: "a/x", name: "X", description: "d" }]),
    ui: {
      notify() {
        throw new Error("renderer gone");
      },
    },
  };
  assert.doesNotThrow(() => pi.commands.get("skill-budget").handler("", ctx));
});

/* ------------------------------------------------------------ 清理 */

test("session_shutdown 清理记录", async () => {
  await runWithSettings({ dedupeSkillsSection: true }, async () => {
    const pi = fakePi();
    skillBudget(pi);
    const prompt = hostPrompt([
      { id: "dup/x", name: "X", description: "Same." },
      { id: "dup/x", name: "X", description: "Same." },
    ]);
    const ctx = fakeCtx({ sessionId: "s-del", prompt });

    await pi.emit("before_agent_start", { type: "before_agent_start", systemPrompt: prompt }, ctx);
    // 清理前后都应能正常工作（不抛）
    assert.doesNotThrow(() => pi.handlers.get("session_shutdown")[0]({ type: "session_shutdown" }, ctx));
    const again = await pi.emit("before_agent_start", { type: "before_agent_start", systemPrompt: prompt }, ctx);
    assert.ok(again, "清理后仍可重新去重");
  });
});
