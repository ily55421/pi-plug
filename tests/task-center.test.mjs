/*
 * local.task-center 的纯函数测试。
 *
 * 用 node:test + node:assert/strict，通过 createRequire 直接加载 CJS 插件源码
 * （插件不依赖宿主环境，__test 导出的都是纯函数）。
 *
 * 运行（在工作区根执行）：node --test tests/task-center.test.mjs
 */

import { createRequire } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.join(path.resolve(here, ".."), "task-center");

const mod = require(path.join(pluginRoot, "main.js"));
const { normalizeTodos, summarize, formatForAgent, oneLine } = mod.__test;

test("normalizeTodos 修补可推断字段，丢弃空条目", () => {
  const result = normalizeTodos([
    { content: "  读  代码 ", status: "in_progress" },
    { content: "写测试", status: "bogus", priority: "high" },
    { content: "   ", status: "pending" },
    null,
  ]);
  assert.equal(result.todos.length, 2, "空 content 与 null 被丢弃");
  assert.equal(result.todos[0].content, "读 代码", "空白被压成单空格");
  assert.equal(result.todos[0].priority, "medium", "缺 priority 补 medium");
  assert.equal(result.todos[1].status, "pending", "非法 status 降级为 pending");
  assert.equal(result.todos[1].priority, "high", "合法 priority 保留");
  assert.equal(result.dropped, 2);
});

test("normalizeTodos 对结构性错误报错", () => {
  assert.throws(() => normalizeTodos("nope"), /must be an array/);
  assert.throws(() => normalizeTodos([{ content: "" }]), /non-empty content/);
  assert.throws(
    () => normalizeTodos(Array.from({ length: 201 }, (_, i) => ({ content: `t${i}` }))),
    /too many tasks/,
  );
});

test("normalizeTodos 允许清空清单", () => {
  const result = normalizeTodos([]);
  assert.deepEqual(result.todos, []);
  assert.equal(result.dropped, 0);
});

test("summarize 统计完成度、当前项与剩余项", () => {
  const summary = summarize([
    { content: "a", status: "completed", priority: "high" },
    { content: "b", status: "in_progress", priority: "high" },
    { content: "c", status: "pending", priority: "low" },
    { content: "d", status: "cancelled", priority: "low" },
  ]);
  assert.equal(summary.total, 4);
  assert.equal(summary.finished, 2, "completed + cancelled 都算已结束");
  assert.equal(summary.percent, 50);
  assert.equal(summary.counts.in_progress, 1);
  assert.equal(summary.current.content, "b", "优先取 in_progress");
  assert.deepEqual(summary.remaining.map((t) => t.content), ["b", "c"]);
});

test("summarize 在无 in_progress 时取第一个 pending", () => {
  const summary = summarize([
    { content: "x", status: "completed", priority: "low" },
    { content: "y", status: "pending", priority: "low" },
  ]);
  assert.equal(summary.current.content, "y");
});

test("summarize 处理空清单不除零", () => {
  const summary = summarize([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.percent, 0);
  assert.equal(summary.current, null);
});

test("formatForAgent 输出可读清单，空清单给指引", () => {
  const text = formatForAgent({
    todos: [
      { content: "a", status: "completed", priority: "high" },
      { content: "b", status: "in_progress", priority: "high" },
      { content: "c", status: "pending", priority: "low" },
      { content: "d", status: "cancelled", priority: "low" },
    ],
    updatedAt: 1700000000000,
  });
  assert.match(text, /共 4 项/);
  assert.match(text, /完成度 50%/);
  assert.match(text, /2\. \[in_progress\] \(high\) b/);
  assert.match(text, /更新时间：/);

  assert.match(formatForAgent({ todos: [], updatedAt: null }), /任务清单为空/);
});

test("oneLine 归一化空白", () => {
  assert.equal(oneLine("  a\n\n b\t c  "), "a b c");
  assert.equal(oneLine(null), "");
  assert.equal(oneLine(undefined), "");
});
