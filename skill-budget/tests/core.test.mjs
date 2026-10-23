/**
 * Skill Budget 逻辑测试（纯 Node，无第三方依赖）。
 *
 * 跑法：node --test tests/core.test.mjs
 *
 * 样例系统提示按宿主 plugin-skills-prompt.ts 的真实输出渲染，
 * 不是自造的简化版 —— 否则解析器只对自造格式成立。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  SKILLS_HEADING,
  auditSkills,
  dedupeSkillsSection,
  estimateTokens,
  normalizeText,
  parseSkillsSection,
  renderReport,
  similarity,
} from "../extension/core.mjs";

/**
 * 按宿主 pluginSkillsPrompt 的真实渲染方式造系统提示：
 *   # Skills
 *   <空行>
 *   Plugins have taught you …
 *   <空行>
 *   - `<id>` — <name>: <description>
 */
function hostPrompt(skills, { before = "# System\n\nYou are helpful.", after = "# Tools\n\n..." } = {}) {
  const intro =
    "Plugins have taught you the following skills. Each entry is a set of instructions you can load with the `Skill` tool by passing its exact id. When a task matches a skill's description, load the skill first and follow it; do not guess at its content. Load each skill at most once per task.";
  const header = [SKILLS_HEADING, "", intro].join("\n");
  const entries = skills.map((s) => `- \`${s.id}\` — ${s.name}${s.description ? `: ${s.description}` : ""}`);
  return [before, "", header, "", ...entries, "", after].join("\n");
}

/* ------------------------------------------------------------ 解析 */

test("解析出技能段的条目、id 与描述", () => {
  const prompt = hostPrompt([
    { id: "a/one", name: "One", description: "Does the first thing." },
    { id: "b/two", name: "Two", description: "Does the second thing." },
  ]);
  const parsed = parseSkillsSection(prompt);

  assert.equal(parsed.found, true);
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0].id, "a/one");
  assert.equal(parsed.entries[0].body, "One: Does the first thing.");
  assert.ok(parsed.before.startsWith("# System"));
  assert.ok(parsed.after.trimStart().startsWith("# Tools"), "after 允许带前导空行，但必须原样保留后续段落");
});

test("没有技能段时明确返回 found=false", () => {
  const parsed = parseSkillsSection("# System\n\nnothing here");
  assert.equal(parsed.found, false);
  assert.equal(parsed.entries.length, 0);
});

test("空输入与非法输入不抛错", () => {
  assert.equal(parseSkillsSection("").found, false);
  assert.equal(parseSkillsSection(undefined).found, false);
  assert.equal(parseSkillsSection(null).found, false);
  assert.equal(parseSkillsSection(42).found, false);
});

test("技能段后的下一个一级标题不会被吞掉", () => {
  const prompt = hostPrompt([{ id: "a/one", name: "One", description: "d" }]);
  const parsed = parseSkillsSection(prompt);
  assert.ok(parsed.after.includes("# Tools"));
  assert.ok(!parsed.section.includes("# Tools"));
});

test("没有 description 的条目同样能解析", () => {
  const prompt = hostPrompt([{ id: "a/nodesc", name: "NoDesc" }]);
  const parsed = parseSkillsSection(prompt);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].body, "NoDesc");
});

test("CRLF 换行同样能解析", () => {
  const prompt = hostPrompt([{ id: "a/one", name: "One", description: "d" }]).replace(/\n/g, "\r\n");
  const parsed = parseSkillsSection(prompt);
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].id, "a/one");
});

/* ------------------------------------------------------------ token 估算 */

test("token 估算把 CJK 按 1 字符 1 token 计", () => {
  assert.equal(estimateTokens("你好世界"), 4);
});

test("token 估算把 ASCII 按 4 字符 1 token 计", () => {
  assert.equal(estimateTokens("abcdefgh"), 2);
  assert.equal(estimateTokens(""), 0);
});

test("token 估算对非法输入返回 0", () => {
  assert.equal(estimateTokens(undefined), 0);
  assert.equal(estimateTokens(null), 0);
});

/* ------------------------------------------------------------ 重复检测 */

test("同一 id 出现两次 → 报告为完全重复并算出浪费量", () => {
  const prompt = hostPrompt([
    { id: "dup/x", name: "X", description: "Same text here." },
    { id: "dup/x", name: "X", description: "Same text here." },
  ]);
  const report = auditSkills(prompt);

  assert.equal(report.duplicates.length, 1);
  assert.equal(report.duplicates[0].id, "dup/x");
  assert.equal(report.duplicates[0].count, 2);
  assert.ok(report.duplicates[0].wastedTokens > 0);
});

test("不同 id 但描述相同 → 报告为近重复", () => {
  const text =
    "This skill explains how to triage incoming bug reports, group them by component, and assign an owner without adding labels.";
  const prompt = hostPrompt([
    { id: "adm/completion-discipline", name: "完成度自检", description: text },
    { id: "local.adm-discipline/completion-discipline", name: "完成度自检", description: text },
  ]);
  const report = auditSkills(prompt);

  assert.equal(report.duplicates.length, 0, "id 不同，不算完全重复");
  assert.equal(report.nearDuplicates.length, 1, "两两相似应收敛成一个簇，而不是多对");
  const cluster = report.nearDuplicates[0];
  assert.equal(cluster.members.length, 2);
  assert.equal(cluster.redundantCount, 1);
  assert.equal(cluster.similarity, 1);
  assert.ok(cluster.reclaimableTokens > 0);
});

test("描述差异很大 → 不报近重复（避免误报）", () => {
  const prompt = hostPrompt([
    { id: "a/one", name: "One", description: "Build a Rust CLI with clap and serde." },
    { id: "b/two", name: "Two", description: "配一张中文说明的海报，用温暖配色。" },
  ]);
  const report = auditSkills(prompt);
  assert.equal(report.nearDuplicates.length, 0);
});

test("近重复阈值可调；调高后同一对不再命中", () => {
  const base =
    "Summarise the session into sections: goal, progress, decisions, next steps, and critical context.";
  const variant = `${base} Keep every section even when it is empty.`;
  const prompt = hostPrompt([
    { id: "a/x", name: "X", description: base },
    { id: "b/x", name: "X", description: variant },
  ]);

  assert.equal(auditSkills(prompt, { nearThreshold: 0.5 }).nearDuplicates.length, 1);
  assert.equal(auditSkills(prompt, { nearThreshold: 0.999 }).nearDuplicates.length, 0);
});

test("非法阈值回落默认值而不是禁用检测", () => {
  const text = "Identical description used twice in two different plugins for the same purpose.";
  const prompt = hostPrompt([
    { id: "a/x", name: "X", description: text },
    { id: "b/x", name: "X", description: text },
  ]);
  for (const bad of [0, -1, 5, "abc", null]) {
    assert.equal(auditSkills(prompt, { nearThreshold: bad }).nearDuplicates.length, 1);
  }
});

/* ------------------------------------------------------------ 汇总 */

test("汇总给出技能数、段落成本与占比，并标注是估算", () => {
  const prompt = hostPrompt([
    { id: "a/one", name: "One", description: "First description." },
    { id: "b/two", name: "Two", description: "Second description." },
  ]);
  const report = auditSkills(prompt);

  assert.equal(report.found, true);
  assert.equal(report.estimate, true, "必须标注是估算，不能假装精确");
  assert.equal(report.totals.skills, 2);
  assert.ok(report.totals.sectionTokens > 0);
  assert.ok(report.totals.promptTokens > report.totals.sectionTokens);
  assert.ok(report.totals.sharePercent > 0 && report.totals.sharePercent < 100);
});

test("没有技能段时汇总全为 0 且不抛错", () => {
  const report = auditSkills("# System\n\nnothing");
  assert.equal(report.found, false);
  assert.equal(report.totals.skills, 0);
  assert.equal(report.totals.sharePercent, 0);
});

/* ------------------------------------------------------------ 报告文案 */

test("报告含技能数、占比与「估算」字样", () => {
  const prompt = hostPrompt([{ id: "a/one", name: "One", description: "d".repeat(400) }]);
  const text = renderReport(auditSkills(prompt));

  assert.ok(text.includes("Skills advertised: 1"));
  assert.ok(text.includes("estimate"));
  assert.ok(/Skills section: ~\d+ tokens/.test(text));
});

test("模板化近重复收敛为单簇，不按两两配对数虚报", () => {
  const skills = Array.from({ length: 15 }, (_, i) => ({
    id: `p/s${i}`,
    name: `S${i}`,
    description: `Description number ${i} with enough text.`,
  }));
  const report = auditSkills(hostPrompt(skills));

  // 模板化文案会连成 1 个簇（而不是 19 对）；具体成员数取决于文案差异，
  // 这里只断言「收敛」与「不虚报」两件事，不钉死成员数。
  assert.equal(report.nearDuplicates.length, 1, "相似应连成一个簇，而不是两两配对");
  assert.ok(report.nearDuplicates[0].members.length >= 2);
  assert.equal(
    report.nearDuplicates[0].redundantCount,
    report.nearDuplicates[0].members.length - 1,
    "可回收条数必须是簇内成员数减一",
  );
  // 可回收量上限：除保留一条外的全部
  const allButOne = report.entries
    .slice()
    .sort((a, b) => b.tokens - a.tokens)
    .slice(1)
    .reduce((sum, e) => sum + e.tokens, 0);
  assert.ok(
    report.nearDuplicates[0].reclaimableTokens <= allButOne,
    `可回收 ${report.nearDuplicates[0].reclaimableTokens} 不应超过上限 ${allButOne}`,
  );
});

test("报告条目数受 maxEntries 限制", () => {
  const skills = Array.from({ length: 15 }, (_, i) => ({
    id: `p/s${i}`,
    name: `S${i}`,
    description: `Description number ${i} with enough text.`,
  }));
  const text = renderReport(auditSkills(hostPrompt(skills)), { maxEntries: 3 });
  // 只数「Heaviest entries」小节内的条目，避免把别的段落算进来。
  const block = (text.split("Heaviest entries")[1] ?? "").split("Near-duplicate")[0];
  const entries = block.split("\n").filter((line) => line.startsWith("- p/s"));
  assert.equal(entries.length, 3);
});

test("没有技能段时报告给出明确说明，而不是空串", () => {
  const text = renderReport(auditSkills("nothing"));
  assert.ok(text.includes("# Skills"));
  assert.ok(text.length > 20);
});

/* ------------------------------------------------------------ 去重 */

test("去重只合并同 id，并保持其余文本原样", () => {
  const prompt = hostPrompt([
    { id: "dup/x", name: "X", description: "Same." },
    { id: "other/y", name: "Y", description: "Different." },
    { id: "dup/x", name: "X", description: "Same." },
  ]);
  const { deduped, removed } = dedupeSkillsSection(prompt);

  assert.equal(removed, 1);
  assert.ok(deduped.includes("`dup/x`"));
  assert.ok(deduped.includes("`other/y`"));
  assert.equal(deduped.split("`dup/x`").length - 1, 1, "dup/x 应只剩一条");
  assert.ok(deduped.includes("# System"), "前置段必须保留");
  assert.ok(deduped.includes("# Tools"), "后置段必须保留");
});

test("去重后审计结果里不再有完全重复", () => {
  const prompt = hostPrompt([
    { id: "dup/x", name: "X", description: "Same." },
    { id: "dup/x", name: "X", description: "Same." },
  ]);
  const { deduped } = dedupeSkillsSection(prompt);
  assert.equal(auditSkills(deduped).duplicates.length, 0);
});

test("去重不动近重复：那是人的判断，不该静默删", () => {
  const text = "Identical description used by two different plugin ids for the very same purpose.";
  const prompt = hostPrompt([
    { id: "a/x", name: "X", description: text },
    { id: "b/x", name: "X", description: text },
  ]);
  const { deduped, removed } = dedupeSkillsSection(prompt);
  assert.equal(removed, 0);
  assert.ok(deduped.includes("`a/x`"));
  assert.ok(deduped.includes("`b/x`"));
});

test("没有技能段的提示去重后原样返回", () => {
  const prompt = "# System\n\nnothing";
  assert.equal(dedupeSkillsSection(prompt).deduped, prompt);
  assert.equal(dedupeSkillsSection(prompt).removed, 0);
});

test("去重保留 CRLF 风格", () => {
  const prompt = hostPrompt([
    { id: "dup/x", name: "X", description: "Same." },
    { id: "dup/x", name: "X", description: "Same." },
  ]).replace(/\n/g, "\r\n");
  const { deduped } = dedupeSkillsSection(prompt);
  assert.ok(deduped.includes("\r\n"));
  assert.equal(/\r\n/.test(deduped), true);
});

/* ------------------------------------------------------------ 相似度基础 */

test("归一化忽略大小写、标点与多余空白", () => {
  assert.equal(normalizeText("Hello,  WORLD!!"), "hello world");
  assert.equal(normalizeText("`a` *b*"), "a b");
});

test("相似度：完全相同为 1，完全不同接近 0", () => {
  assert.equal(similarity("same text", "same text"), 1);
  assert.ok(similarity("完全不同的内容", "unrelated english words") < 0.2);
});

test("相似度对语序不敏感（bigram 集合）", () => {
  const a = similarity("alpha beta gamma delta", "delta gamma beta alpha");
  // bigram 集合对换序不敏感，但首尾边界会产生少量新 bigram，因此接近 1 而非恰好 1。
  assert.ok(a >= 0.9, `换序后相似度应 >= 0.9，实际 ${a}`);
  assert.ok(a > similarity("alpha beta gamma delta", "alpha beta gamma epsilon"));
});
