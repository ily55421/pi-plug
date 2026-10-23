/**
 * A11y Audit 逻辑测试（纯 Node，无第三方依赖）。
 *
 * 跑法：node --test tests/core.test.mjs
 *
 * 样例树严格按宿主 `flattenAxTree`（browser-cdp.ts:72-110）的真实输出格式构造：
 *   - e12 Button "提交"
 *     - e13 Generic
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_FINDINGS,
  auditTree,
  isMeaninglessName,
  parseTree,
  renderReport,
} from "../lib/audit.cjs";

/** 按宿主格式拼一棵树。 */
function tree(lines) {
  return lines.join("\n");
}

/* ------------------------------------------------------------ 解析 */

test("解析宿主格式：uid / role / name / depth", () => {
  const nodes = parseTree(
    tree([
      '- e1 RootWebArea "示例页"',
      '  - e2 heading "标题"',
      '    - e3 StaticText "正文"',
      "- e4 Button",
    ]),
  );

  assert.equal(nodes.length, 4);
  assert.deepEqual(
    nodes.map((n) => n.uid),
    ["e1", "e2", "e3", "e4"],
  );
  assert.equal(nodes[0].role, "rootwebarea");
  assert.equal(nodes[0].name, "示例页");
  assert.equal(nodes[1].depth, 1);
  assert.equal(nodes[2].depth, 2);
  assert.equal(nodes[3].name, "", "没有 name 时为空串");
});

test("名称里的转义被还原", () => {
  const nodes = parseTree('- e1 Button "say \\"hi\\""');
  assert.equal(nodes[0].name, 'say "hi"');
});

test("空树与非法输入不抛错", () => {
  assert.deepEqual(parseTree(""), []);
  assert.deepEqual(parseTree(undefined), []);
  assert.deepEqual(parseTree("(empty)"), []);
  assert.deepEqual(parseTree("不是树的随便文本"), []);
});

test("无法解析的行被跳过，不污染节点列表", () => {
  const nodes = parseTree(tree(['[page#A1B2]', '- e1 Button "ok"', "garbage line"]));
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].uid, "e1");
});

/* ------------------------------------------------------------ 无信息量名称 */

test("占位名称被判为无信息量", () => {
  for (const name of ["click here", "Read more", "×", "→", "123", "提交", "更多", "详情"]) {
    assert.equal(isMeaninglessName(name), true, name);
  }
});

test("正常名称不算无信息量", () => {
  for (const name of ["提交订单", "Delete account", "Close dialog"]) {
    assert.equal(isMeaninglessName(name), false, name);
  }
});

test("空名称不归入「无信息量」（缺失另有专项）", () => {
  assert.equal(isMeaninglessName(""), false);
  assert.equal(isMeaninglessName("   "), false);
});

/* ------------------------------------------------------------ 审计：缺名称 */

test("可交互元素缺名称 → high", () => {
  const r = auditTree(tree(['- e1 Button', '- e2 link "首页"']));
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].severity, "high");
  assert.equal(r.findings[0].kind, "interactive-without-name");
  assert.equal(r.findings[0].uid, "e1");
});

test("各类可交互角色都会检出", () => {
  const roles = ["button", "link", "checkbox", "textbox", "combobox", "tab", "switch", "slider"];
  // 补一个 heading：否则会额外触发页面级 no-headings 检查，干扰本用例的计数断言。
  const r = auditTree(tree(['- e0 heading "标题"', ...roles.map((role, i) => `- e${i + 1} ${role}`)]));
  assert.equal(r.findings.length, roles.length, r.findings.map((f) => f.kind).join(","));
});

test("有名称的可交互元素不报", () => {
  const r = auditTree(tree(['- e1 Button "保存"', '- e2 link "文档"']));
  assert.equal(r.findings.length, 0);
});

test("图像缺名称 → medium（并说明可能是装饰性）", () => {
  const r = auditTree(tree(["- e1 image"]));
  assert.equal(r.findings[0].severity, "medium");
  assert.equal(r.findings[0].kind, "image-without-name");
  assert.match(r.findings[0].detail, /decorative/);
});

test("占位名称的可交互元素 → medium", () => {
  const r = auditTree(tree(['- e1 Button "click here"']));
  assert.equal(r.findings[0].kind, "meaningless-name");
  assert.equal(r.findings[0].severity, "medium");
});

/* ------------------------------------------------------------ 审计：页面级 */

test("没有标题且节点不少 → 报 no-headings", () => {
  const r = auditTree(
    tree(['- e1 Generic "a"', '- e2 Generic "b"', '- e3 Generic "c"', '- e4 Generic "d"', '- e5 Generic "e"', '- e6 Generic "f"']),
  );
  assert.ok(r.findings.some((f) => f.kind === "no-headings"));
  assert.equal(r.headings, 0);
});

test("有标题时不报 no-headings", () => {
  const r = auditTree(tree(['- e1 heading "标题"', '- e2 Generic "a"', '- e3 Generic "b"', '- e4 Generic "c"', '- e5 Generic "d"', '- e6 Generic "e"']));
  assert.ok(!r.findings.some((f) => f.kind === "no-headings"));
  assert.equal(r.headings, 1);
});

test("节点少时不报 no-headings（避免噪声）", () => {
  const r = auditTree(tree(["- e1 Generic"]));
  assert.ok(!r.findings.some((f) => f.kind === "no-headings"));
});

test("内容多但零交互角色 → 报 no-interactive-roles", () => {
  const lines = Array.from({ length: 12 }, (_, i) => `- e${i + 1} StaticText "text ${i}"`);
  const r = auditTree(tree(lines));
  assert.ok(r.findings.some((f) => f.kind === "no-interactive-roles"));
  assert.equal(r.interactive, 0);
});

/* ------------------------------------------------------------ 汇总与排序 */

test("findings 按严重度排序：high 在前", () => {
  const r = auditTree(
    tree(['- e1 image', '- e2 Button', '- e3 Button "click here"']),
  );
  const severities = r.findings.map((f) => f.severity);
  const firstMedium = severities.indexOf("medium");
  const lastHigh = severities.lastIndexOf("high");
  assert.ok(lastHigh < firstMedium, `排序错误: ${severities.join(",")}`);
});

test("totals 统计各严重度与总数", () => {
  const r = auditTree(tree(["- e1 Button", "- e2 Button", '- e3 image "ok"']));
  assert.equal(r.totals.high, 2);
  assert.equal(r.totals.total, 2);
  assert.equal(r.totals.truncated, false);
});

test("maxFindings 截断但总数仍如实统计", () => {
  // 补一个 heading：避免页面级 no-headings 检查把总数从 10 抬到 11。
  const lines = ['- e0 heading "标题"', ...Array.from({ length: 10 }, (_, i) => `- e${i + 1} Button`)];
  const r = auditTree(tree(lines), { maxFindings: 3 });
  assert.equal(r.findings.length, 3);
  assert.equal(r.totals.total, 10);
  assert.equal(r.totals.truncated, true);
});

test("maxFindings 不能超过硬上限", () => {
  const lines = Array.from({ length: MAX_FINDINGS + 20 }, (_, i) => `- e${i + 1} Button`);
  const r = auditTree(tree(lines), { maxFindings: 9999 });
  assert.equal(r.findings.length, MAX_FINDINGS);
});

test("roleCounts 如实统计", () => {
  const r = auditTree(tree(['- e1 Button "a"', '- e2 Button "b"', '- e3 image "c"']));
  assert.equal(r.roleCounts.button, 2);
  assert.equal(r.roleCounts.image, 1);
});

/* ------------------------------------------------------------ 诚实边界 */

test("notCovered 明确列出做不到的检查项", () => {
  const r = auditTree(tree(['- e1 Button "ok"']));
  assert.ok(Array.isArray(r.notCovered) && r.notCovered.length >= 4);
  const joined = r.notCovered.join(" | ");
  assert.match(joined, /contrast/);
  assert.match(joined, /focus order/i);
  assert.match(joined, /aria/i);
});

test("空树不崩，且仍带 notCovered", () => {
  const r = auditTree("");
  assert.equal(r.nodes, 0);
  assert.equal(r.findings.length, 0);
  assert.ok(r.notCovered.length > 0);
});

/* ------------------------------------------------------------ 报告 */

test("报告含统计、findings 与「未检查项」", () => {
  const text = renderReport(auditTree(tree(["- e1 Button", '- e2 heading "标题"'])));
  assert.match(text, /Accessibility tree: 2 node/);
  assert.match(text, /Findings: 1 high/);
  assert.match(text, /\[high\] e1 \(button\)/);
  assert.match(text, /Not checked/);
});

test("无问题时报告明确说没发现，而不是空串", () => {
  const text = renderReport(auditTree(tree(['- e1 Button "保存"', '- e2 heading "标题"'])));
  assert.match(text, /No name-related problems/);
});

test("maxDetail 限制明细条数", () => {
  const lines = Array.from({ length: 8 }, (_, i) => `- e${i + 1} Button`);
  const text = renderReport(auditTree(tree(lines)), { maxDetail: 2 });
  const bullets = text.split("\n").filter((line) => line.startsWith("- ["));
  assert.equal(bullets.length, 2);
  assert.match(text, /more finding\(s\) not shown/);
});

test("renderReport 对非法输入不抛", () => {
  assert.doesNotThrow(() => renderReport(undefined));
  assert.equal(typeof renderReport(null), "string");
});
