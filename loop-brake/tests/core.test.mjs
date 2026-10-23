/**
 * Loop Brake 逻辑测试（纯 Node，无第三方依赖）。
 *
 * 跑法：node --test tests/core.test.mjs
 *
 * 每条用例对应一个真实误判场景，不是为凑覆盖率而写。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  COUNT_CEILING,
  LoopBrake,
  canonicalize,
  describe,
  fingerprint,
  normalizeSettings,
} from "../extension/core.mjs";

/* ---------------------------------------------------------------- 指纹 */

test("对象键顺序不同但语义相同 → 同一身份", () => {
  const a = fingerprint("Read", { file_path: "/a.txt", offset: 1 });
  const b = fingerprint("Read", { offset: 1, file_path: "/a.txt" });
  assert.equal(a, b);
});

test("数组顺序不同 → 不同身份（顺序是语义的一部分）", () => {
  const a = fingerprint("Bash", { argv: ["git", "status"] });
  const b = fingerprint("Bash", { argv: ["status", "git"] });
  assert.notEqual(a, b);
});

test("工具不同 → 不同身份，即使入参相同", () => {
  assert.notEqual(fingerprint("Read", { p: 1 }), fingerprint("Grep", { p: 1 }));
});

test("超长字符串：前 2048 字符相同、尾部不同 → 不同身份", () => {
  const base = "x".repeat(3000);
  assert.notEqual(fingerprint("Write", { content: `${base}A` }), fingerprint("Write", { content: `${base}B` }));
});

test("超长字符串参与指纹后长度受限", () => {
  const huge = "y".repeat(100_000);
  const fp = fingerprint("Write", { content: huge });
  assert.ok(fp.length < 3000, `指纹长度 ${fp.length} 应远小于 100k`);
});

test("循环引用不抛错", () => {
  const loop = { name: "self" };
  loop.self = loop;
  const fp = fingerprint("Custom", loop);
  assert.equal(typeof fp, "string");
  assert.ok(fp.includes("[depth:"), "循环引用应在深度上限处打标记");
});

test("undefined / null / 空对象三者的身份互不相同", () => {
  const ids = new Set([
    fingerprint("T", undefined),
    fingerprint("T", null),
    fingerprint("T", {}),
  ]);
  assert.equal(ids.size, 3);
});

test("数字 1 与 1.0 视为同一身份", () => {
  assert.equal(fingerprint("T", { n: 1 }), fingerprint("T", { n: 1.0 }));
});

test("键数量超限时指纹仍稳定且带标记", () => {
  const wide = {};
  for (let i = 0; i < 100; i += 1) wide[`k${i}`] = i;
  const fp = fingerprint("T", wide);
  assert.ok(fp.includes("~(keys:100)"));
  assert.equal(fp, fingerprint("T", wide));
});

test("canonicalize 对函数与 symbol 类型不崩", () => {
  assert.equal(canonicalize(() => 1), "[function]");
  assert.equal(canonicalize(Symbol("s")), "[symbol]");
});

/* ---------------------------------------------------------------- 设置净化 */

test("默认设置符合预期", () => {
  assert.deepEqual(normalizeSettings(undefined), {
    enabled: true,
    threshold: 3,
    mode: "warn",
    ignoreTools: [],
  });
});

test("脏设置回落默认，不允许把闸门意外关掉", () => {
  const bad = normalizeSettings({ threshold: "abc", mode: "nonsense", enabled: "yes", ignoreTools: 42 });
  assert.equal(bad.threshold, 3);
  assert.equal(bad.mode, "warn");
  assert.equal(bad.enabled, true);
  assert.deepEqual(bad.ignoreTools, []);
});

test("阈值越界回落（<2 或 >20）", () => {
  assert.equal(normalizeSettings({ threshold: 1 }).threshold, 3);
  assert.equal(normalizeSettings({ threshold: 99 }).threshold, 3);
  assert.equal(normalizeSettings({ threshold: 5 }).threshold, 5);
  assert.equal(normalizeSettings({ threshold: 2 }).threshold, 2);
  assert.equal(normalizeSettings({ threshold: 20 }).threshold, 20);
});

test("enabled:false 是唯一被尊重的关闭方式", () => {
  assert.equal(normalizeSettings({ enabled: false }).enabled, false);
});

/* ---------------------------------------------------------------- 闸门行为 */

test("warn 模式：第 1、2 次放行，第 3 次警告，第 4 次阻断", () => {
  const brake = new LoopBrake();
  const args = ["Read", { file_path: "/a.txt" }];

  assert.equal(brake.observe(...args).action, "allow");
  assert.equal(brake.observe(...args).action, "allow");
  assert.equal(brake.observe(...args).action, "warn");
  assert.equal(brake.observe(...args).action, "block");
});

test("block 模式：第 3 次直接阻断，没有警告阶段", () => {
  const brake = new LoopBrake({ settings: { mode: "block" } });
  const args = ["Read", { file_path: "/a.txt" }];

  assert.equal(brake.observe(...args).action, "allow");
  assert.equal(brake.observe(...args).action, "allow");
  assert.equal(brake.observe(...args).action, "block");
});

test("连续语义：中间夹一次别的调用就清零（分页读取不被误杀）", () => {
  const brake = new LoopBrake();
  const read = { file_path: "/a.txt" };

  brake.observe("Read", read); // 1
  brake.observe("Read", read); // 2
  brake.observe("Grep", { pattern: "x" }); // 打断连续段
  const fourth = brake.observe("Read", read); // 重新从 1 开始
  assert.equal(fourth.action, "allow");
  assert.equal(fourth.count, 1);
});

test("报警后仍继续 → 之后的每一次都阻断，不会退回放行", () => {
  const brake = new LoopBrake();
  const args = ["Grep", { pattern: "todo" }];
  brake.observe(...args);
  brake.observe(...args);
  assert.equal(brake.observe(...args).action, "warn");
  assert.equal(brake.observe(...args).action, "block");
  assert.equal(brake.observe(...args).action, "block");
  assert.equal(brake.observe(...args).action, "block");
});

test("触顶后计数不无限增长", () => {
  const brake = new LoopBrake({ settings: { threshold: 2 } });
  const args = ["T", { a: 1 }];
  for (let i = 0; i < COUNT_CEILING + 50; i += 1) brake.observe(...args);
  assert.ok(brake.snapshot().consecutive <= COUNT_CEILING);
});

test("ignoreTools 里的工具永不止损", () => {
  const brake = new LoopBrake({ settings: { ignoreTools: ["Poll"] } });
  const args = ["Poll", { id: 7 }];
  for (let i = 0; i < 10; i += 1) {
    assert.equal(brake.observe(...args).action, "allow");
  }
});

test("ignoreTools 只对同名工具生效，不影响其他工具", () => {
  const brake = new LoopBrake({ settings: { ignoreTools: ["Poll"] } });
  const args = ["Read", { p: 1 }];
  brake.observe(...args);
  brake.observe(...args);
  assert.equal(brake.observe(...args).action, "warn");
});

test("闸门关闭后不计数、不阻断", () => {
  const brake = new LoopBrake({ settings: { enabled: false } });
  const args = ["Read", { p: 1 }];
  for (let i = 0; i < 10; i += 1) {
    assert.equal(brake.observe(...args).action, "allow");
  }
  assert.equal(brake.snapshot().stats.checked, 0);
});

test("reset 之后重新从 1 开始", () => {
  const brake = new LoopBrake();
  const args = ["Read", { p: 1 }];
  brake.observe(...args);
  brake.observe(...args);
  brake.reset();
  assert.equal(brake.observe(...args).count, 1);
});

test("updateSettings 会清空连续段并采用新阈值", () => {
  const brake = new LoopBrake();
  const args = ["Read", { p: 1 }];
  brake.observe(...args);
  brake.observe(...args);
  brake.updateSettings({ threshold: 2 });
  // 改设置必须清空连续段：否则用户收紧阈值会立刻误伤下一个调用。
  assert.equal(brake.snapshot().consecutive, 0);
  assert.equal(brake.observe(...args).action, "allow"); // 新连续段的第 1 次
  // 默认仍是 warn 模式：新阈值下第 2 次先警告，第 3 次才阻断。
  assert.equal(brake.observe(...args).action, "warn");
  assert.equal(brake.observe(...args).action, "block");
});
test("统计计数与实际判定一致", () => {
  const brake = new LoopBrake();
  const args = ["Read", { p: 1 }];
  brake.observe(...args);
  brake.observe(...args);
  brake.observe(...args); // warn
  brake.observe(...args); // block
  const { stats } = brake.snapshot();
  assert.equal(stats.checked, 4);
  assert.equal(stats.warned, 1);
  assert.equal(stats.blocked, 1);
  assert.equal(stats.lastBlocked.tool, "Read");
});

/* ---------------------------------------------------------------- 文案 */

test("警告文案包含工具名、次数与下一步动作", () => {
  const brake = new LoopBrake({ settings: { mode: "block" } });
  const args = ["Grep", { pattern: "foo" }];
  brake.observe(...args);
  brake.observe(...args);
  const { reason } = brake.observe(...args);
  assert.ok(reason.includes("Grep"));
  assert.ok(reason.includes("3"));
  assert.ok(/change the arguments|different strategy|tell the user/i.test(reason));
});

test("describe 不泄露长内容", () => {
  const long = "z".repeat(500);
  const text = describe({ content: long });
  assert.ok(text.length < 120, `描述长度 ${text.length} 应被截断`);
  assert.ok(text.includes("content="));
});

test("describe 覆盖无参 / 空对象 / 数组 / 非对象", () => {
  assert.equal(describe(undefined), "no arguments");
  assert.equal(describe(null), "no arguments");
  assert.equal(describe({}), "empty arguments");
  assert.ok(describe([1, 2, 3]).includes("length 3"));
  assert.ok(describe("raw").includes("string arguments"));
});
