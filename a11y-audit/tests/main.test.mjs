/**
 * A11y Audit 接线测试：用假 pi 驱动真实的 onLoad / onUnload。
 *
 * 跑法：node --test tests/main.test.mjs
 *
 * 不连真浏览器：`pi.browser.snapshot` 由测试提供，
 * 覆盖「有树 / 空树 / 抛错」三条真实分支，以及注册与回收。
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const plugin = require("../main.js");

/** 宿主 flattenAxTree 的真实输出形态。 */
const SAMPLE_TREE = [
  '- e1 RootWebArea "示例页"',
  '  - e2 heading "欢迎"',
  "  - e3 Button",
  '  - e4 link "首页"',
  "  - e5 image",
  '  - e6 Button "click here"',
].join("\n");

/** 假 pi：记录注册面。 */
function fakePi({ tree = SAMPLE_TREE, throws } = {}) {
  const tools = new Map();
  const commands = new Map();
  const notices = [];
  const pi = {
    agent: {
      async registerTool(definition) {
        tools.set(definition.name, definition);
      },
      async unregisterTool(name) {
        tools.delete(name);
      },
    },
    commands: {
      register(id, options) {
        commands.set(id, options);
      },
      unregister(id) {
        commands.delete(id);
      },
    },
    browser: {
      async snapshot() {
        if (throws) throw throws instanceof Error ? throws : new Error(String(throws));
        return { tree, url: "https://example.test/", title: "示例页" };
      },
    },
    ui: {
      notify(text) {
        notices.push(text);
      },
    },
  };
  return { pi, tools, commands, notices };
}

/* ------------------------------------------------------------ 注册与回收 */

test("onLoad 注册一个工具与一个命令", async () => {
  const { pi, tools, commands } = fakePi();
  await plugin.onLoad(pi);
  assert.deepEqual([...tools.keys()], ["a11y_audit"]);
  assert.deepEqual([...commands.keys()], ["a11yAudit.open"]);
});

test("onLoad 注册的工具带 risk 与 schema", async () => {
  const { pi, tools } = fakePi();
  await plugin.onLoad(pi);
  const tool = tools.get("a11y_audit");
  assert.equal(tool.risk, "low");
  assert.equal(typeof tool.schema, "object");
  assert.equal(typeof tool.execute, "function");
});

test("onUnload 精确回收注册过的工具与命令", async () => {
  const { pi, tools, commands } = fakePi();
  await plugin.onLoad(pi);
  await plugin.onUnload(pi);
  assert.equal(tools.size, 0);
  assert.equal(commands.size, 0);
});

/* ------------------------------------------------------------ 工具执行 */

test("有树时返回统计与 findings", async () => {
  const { pi, tools } = fakePi();
  await plugin.onLoad(pi);
  const result = await tools.get("a11y_audit").execute({});

  assert.equal(result.ok, true);
  assert.equal(result.nodes, 6);
  assert.equal(result.page.url, "https://example.test/");
  // e3 Button 与 e5 image 无名称，e6 占位名称
  assert.equal(result.totals.high, 1, "无名称按钮应为 high");
  assert.ok(result.totals.medium >= 2, "缺 alt 图片与占位名称应为 medium");
  assert.match(result.message, /Accessibility tree: 6 node/);
  assert.match(result.message, /Not checked/);
});

test("findings 里带 uid、role 与说明", async () => {
  const { pi, tools } = fakePi();
  await plugin.onLoad(pi);
  const result = await tools.get("a11y_audit").execute({});
  const missing = result.findings.find((f) => f.kind === "interactive-without-name");
  assert.ok(missing);
  assert.equal(missing.uid, "e3");
  assert.equal(missing.role, "button");
  assert.match(missing.detail, /no accessible name/);
});

test("maxFindings 生效", async () => {
  const many = Array.from({ length: 12 }, (_, i) => `- e${i + 1} Button`).join("\n");
  const { pi, tools } = fakePi({ tree: many });
  await plugin.onLoad(pi);
  const result = await tools.get("a11y_audit").execute({ maxFindings: 3 });
  assert.equal(result.findings.length, 3);
  assert.ok(result.totals.total >= 12);
});

test("空树时给出明确说明而不是空结果", async () => {
  const { pi, tools } = fakePi({ tree: "(empty)" });
  await plugin.onLoad(pi);
  const result = await tools.get("a11y_audit").execute({});
  assert.equal(result.ok, true);
  assert.match(result.message, /tree is empty/i);
  assert.deepEqual(result.findings, []);
});

test("没有浏览器面板时把错误翻译成人话", async () => {
  const { pi, tools } = fakePi({ throws: new Error("no guest attached") });
  await plugin.onLoad(pi);
  const result = await tools.get("a11y_audit").execute({});
  assert.equal(result.ok, false);
  assert.match(result.message, /no browser panel is open/i);
  assert.ok(!result.message.includes("no guest attached"), "不应把原始栈术语丢给模型");
});

test("白名单拒绝时说明是宿主限制", async () => {
  const { pi, tools } = fakePi({ throws: new Error("method not allowed by allowlist") });
  await plugin.onLoad(pi);
  const result = await tools.get("a11y_audit").execute({});
  assert.equal(result.ok, false);
  assert.match(result.message, /allowlist/);
});

test("报告超长时被截断并说明", async () => {
  // 造一棵足够大的树，让报告超过 MAX_REPORT_CHARS
  const many = Array.from({ length: 200 }, (_, i) => `- e${i + 1} Button`).join("\n");
  const { pi, tools } = fakePi({ tree: many });
  await plugin.onLoad(pi);
  const result = await tools.get("a11y_audit").execute({ maxFindings: 60 });
  assert.ok(result.message.length <= plugin.__test.MAX_REPORT_CHARS + 120);
  assert.match(result.message, /Accessibility tree:/);
});

/* ------------------------------------------------------------ 命令 */

test("命令把摘要写进 ui.notify", async () => {
  const { pi, commands, notices } = fakePi();
  await plugin.onLoad(pi);
  await commands.get("a11yAudit.open").run();
  assert.equal(notices.length, 1);
  assert.match(notices[0], /high/);
  assert.match(notices[0], /6 node/);
});

test("命令在空面板时说明情况", async () => {
  const { pi, commands, notices } = fakePi({ tree: "" });
  await plugin.onLoad(pi);
  await commands.get("a11yAudit.open").run();
  assert.match(notices[0], /empty or not rendered/);
});

test("命令在浏览器抛错时也不抛，只提示", async () => {
  const { pi, commands, notices } = fakePi({ throws: new Error("detached") });
  await plugin.onLoad(pi);
  await assert.doesNotReject(() => commands.get("a11yAudit.open").run());
  assert.match(notices[0], /no browser panel is open/i);
});

/* ------------------------------------------------------------ 只读性 */

test("审计过程不调用任何写操作", async () => {
  const { pi, tools } = fakePi();
  const calls = [];
  // 包一层，记录被调用过的 browser 方法
  const original = pi.browser;
  pi.browser = {
    snapshot: (...args) => {
      calls.push("snapshot");
      return original.snapshot(...args);
    },
    navigate: () => {
      calls.push("navigate");
      throw new Error("should not be called");
    },
    evaluate: () => {
      calls.push("evaluate");
      throw new Error("should not be called");
    },
    screenshot: () => {
      calls.push("screenshot");
      throw new Error("should not be called");
    },
    cdp: () => {
      calls.push("cdp");
      throw new Error("should not be called");
    },
  };

  await plugin.onLoad(pi);
  await tools.get("a11y_audit").execute({});
  assert.deepEqual(calls, ["snapshot"], "只应调用 snapshot");
});
