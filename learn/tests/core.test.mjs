/**
 * Learn 逻辑测试（纯 Node，无第三方依赖）。
 *
 * 跑法：node --test tests/core.test.mjs
 *
 * 重点覆盖三类：作用域推荐不越界、校验闸门不放过垃圾、merge 不破坏既有文件。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_FILE_BYTES,
  isWithin,
  mergeInsight,
  normalizePath,
  recommendScope,
  summarizeFile,
  validateInsight,
} from "../extension/core.mjs";

/* ------------------------------------------------------------ 路径与越界 */

test("normalizePath 统一分隔符并去尾斜杠", () => {
  assert.equal(normalizePath("C:\\work\\proj"), "C:/work/proj");
  assert.equal(normalizePath("C:/work/proj/"), "C:/work/proj");
  assert.equal(normalizePath(""), "");
  assert.equal(normalizePath(undefined), "");
});

test("isWithin 用分段比较，不会把 /a/bc 当成 /a/b 的子路径", () => {
  assert.equal(isWithin("/a/b", "/a/b"), true);
  assert.equal(isWithin("/a/b", "/a/b/c"), true);
  assert.equal(isWithin("/a/b", "/a/bc"), false);
  assert.equal(isWithin("/a/b", "/a"), false);
  assert.equal(isWithin("", "/a"), false);
});

test("Windows 路径同样按分段判断", () => {
  assert.equal(isWithin("C:\\work", "C:\\work\\src\\a.ts"), true);
  assert.equal(isWithin("C:\\work", "C:\\workspace\\a.ts"), false);
});

/* ------------------------------------------------------------ 作用域推荐 */

test("给 file 时推荐该文件所在目录", () => {
  const r = recommendScope({ workspaceRoot: "/w", file: "/w/src/auth/login.ts" });
  assert.equal(r.ok, true);
  assert.equal(r.directory, "/w/src/auth");
  assert.equal(r.relative, "src/auth");
});

test("给 directory 时优先用它", () => {
  const r = recommendScope({ workspaceRoot: "/w", directory: "/w/packages/core", file: "/w/other/a.ts" });
  assert.equal(r.directory, "/w/packages/core");
});

test("workspace-relative 路径与 root 拼接（按参数说明传相对路径必须可用）", () => {
  const byFile = recommendScope({ workspaceRoot: "/w", file: "src/api.ts" });
  assert.equal(byFile.ok, true, JSON.stringify(byFile));
  assert.equal(byFile.directory, "/w/src");

  const byDir = recommendScope({ workspaceRoot: "/w", directory: "packages/core" });
  assert.equal(byDir.ok, true, JSON.stringify(byDir));
  assert.equal(byDir.directory, "/w/packages/core");

  // 相对路径里的 .. 消解后越界仍要拒绝
  const escape = recommendScope({ workspaceRoot: "/w", directory: "../outside" });
  assert.equal(escape.ok, false);
});

test("都没给时落到 workspace 根", () => {
  const r = recommendScope({ workspaceRoot: "/w" });
  assert.equal(r.ok, true);
  assert.equal(r.directory, "/w");
  assert.equal(r.relative, ".");
});

test("越界一律拒绝（不写工作区外）", () => {
  for (const input of [
    { workspaceRoot: "/w", file: "/etc/passwd" },
    { workspaceRoot: "/w", directory: "/w/../outside" },
    { workspaceRoot: "/w", directory: "/w2/x" },
    { workspaceRoot: "C:\\w", file: "D:\\other\\a.ts" },
  ]) {
    assert.equal(recommendScope(input).ok, false, JSON.stringify(input));
  }
});

test("缺 workspaceRoot 时拒绝", () => {
  assert.equal(recommendScope({ file: "/w/a.ts" }).ok, false);
  assert.equal(recommendScope(undefined).ok, false);
});

test("盘符根下的文件不越界", () => {
  const r = recommendScope({ workspaceRoot: "C:\\", file: "C:\\a.ts" });
  assert.equal(r.ok, true);
});

/* ------------------------------------------------------------ 洞见校验 */

test("正常洞见通过并保留多行", () => {
  const v = validateInsight("Commit must include the generated client; run bun run generate first.");
  assert.equal(v.ok, true);
  assert.ok(v.insight.includes("bun run generate"));
});

test("空、过短、无文字都被拒", () => {
  assert.equal(validateInsight("").ok, false);
  assert.equal(validateInsight("   ").ok, false);
  assert.equal(validateInsight("TODO").ok, false);
  assert.equal(validateInsight("!!! ??? ...").ok, false);
  assert.equal(validateInsight(undefined).ok, false);
});

test("超长被拒（AGENTS.md 每次会话都进提示，不能写小作文）", () => {
  const long = "a".repeat(601);
  const v = validateInsight(long);
  assert.equal(v.ok, false);
  assert.match(v.reason, /limit/);
});

test("会话细节被拒：时间戳 / 会话 id / 谁提出的", () => {
  for (const text of [
    "At 2026-10-22T21:06 the build broke because of a stale lock.",
    "Session 3f2a9c1b8e showed the cache was cold.",
    "The user asked me to use pnpm instead of npm here.",
    "好的，我明白了，这就改。",
  ]) {
    assert.equal(validateInsight(text).ok, false, text);
  }
});

test("显然事实被拒", () => {
  assert.equal(validateInsight("TypeScript is a programming language.").ok, false);
  assert.equal(validateInsight("use npm").ok, false);
});

test("中文洞见正常通过", () => {
  const v = validateInsight("改完 public 协议后必须运行 bun run generate，否则客户端与服务器会漂移。");
  assert.equal(v.ok, true);
});

test("首尾空行被压掉，保留内部换行", () => {
  const v = validateInsight("\n\n第一行有效内容\n\n第二行有效内容\n\n");
  assert.equal(v.ok, true);
  assert.equal(v.insight, "第一行有效内容\n\n第二行有效内容");
});

/* ------------------------------------------------------------ merge */

test("空文件建出 Learned 段", () => {
  const r = mergeInsight("", "Never edit the generated client by hand.");
  assert.equal(r.ok, true);
  assert.equal(r.added, true);
  assert.ok(r.content.startsWith("## Learned"));
  assert.ok(r.content.includes("- Never edit the generated client by hand."));
});

test("已有 Learned 段时追加到段内末尾", () => {
  const existing = ["# Project", "", "Some intro.", "", "## Learned", "", "- first thing."].join("\n");
  const r = mergeInsight(existing, "Second durable thing to remember.");
  assert.equal(r.added, true);
  assert.ok(r.content.indexOf("- first thing.") < r.content.indexOf("- Second durable thing"));
  // 原有内容一字不改
  assert.ok(r.content.includes("# Project"));
  assert.ok(r.content.includes("Some intro."));
});

test("Learned 段后面还有别的段时，插在 Learned 段内而不是文件末尾", () => {
  const existing = ["## Learned", "", "- old.", "", "## Other", "", "other content"].join("\n");
  const r = mergeInsight(existing, "A new learned bullet here.");
  const learnedPos = r.content.indexOf("## Learned");
  const otherPos = r.content.indexOf("## Other");
  const bulletPos = r.content.indexOf("- A new learned bullet here.");
  assert.ok(learnedPos < bulletPos && bulletPos < otherPos, r.content);
});

test("没有 Learned 段时在文件末尾新建", () => {
  const existing = ["# Project", "", "Rules here."].join("\n");
  const r = mergeInsight(existing, "Something durable and useful.");
  assert.ok(r.content.startsWith("# Project"));
  assert.ok(r.content.includes("## Learned"));
  assert.ok(r.content.indexOf("## Learned") > r.content.indexOf("Rules here."));
});

test("完全重复不再写入", () => {
  const existing = ["## Learned", "", "- Never edit generated files."].join("\n");
  const r = mergeInsight(existing, "Never edit generated files.");
  assert.equal(r.duplicate, true);
  assert.equal(r.added, false);
  assert.equal(r.content, existing);
});

test("重复检测忽略首尾空白", () => {
  const existing = ["## Learned", "", "-   Never edit generated files.  "].join("\n");
  assert.equal(mergeInsight(existing, "  Never edit generated files.  ").duplicate, true);
});

test("多行洞见：续行有缩进，且同一条不再写第二遍", () => {
  const twoLines = "Regenerate the client with bun run generate.\nSkipping it breaks the build.";
  const first = mergeInsight("", twoLines);
  assert.equal(first.added, true);
  // 续行缩进 2 空格，列表项不被拆断
  assert.ok(first.content.includes("- Regenerate the client with bun run generate.\n  Skipping it breaks the build."));
  // 多行洞见是含 \n 的整条，逐行比对匹配不到 —— 必须靠规范化后整条比对拦截
  const second = mergeInsight(first.content, twoLines);
  assert.equal(second.duplicate, true, "多行洞见同样不能写第二遍");
  assert.equal(second.added, false);
});

test("多行洞见换行风格不同也算重复（规范化空白）", () => {
  const existing = ["## Learned", "", "- Regenerate the client with bun run generate.", "  Skipping it breaks the build."].join("\n");
  const r = mergeInsight(existing, "Regenerate the client with bun run generate.\nSkipping it breaks the build.");
  assert.equal(r.duplicate, true);
});

test("保留 CRLF 风格", () => {
  const existing = ["# P", "", "- a"].join("\r\n");
  const r = mergeInsight(existing, "New bullet for crlf file.");
  assert.ok(r.content.includes("\r\n"));
  assert.equal(/\n(?!\r)/.test(r.content.replace(/\r\n/g, "")), false);
});

test("超出体积上限时拒绝，而不是静默截断", () => {
  const big = "x".repeat(MAX_FILE_BYTES - 10);
  const r = mergeInsight(big, "This bullet pushes it over the limit for sure.");
  assert.equal(r.ok, false);
  assert.match(r.reason, /limit/);
});

test("Learned 段只有标题时插入也保持可读（标题后有空行）", () => {
  const existing = ["## Learned"].join("\n");
  const r = mergeInsight(existing, "First bullet in an empty section.");
  const lines = r.content.split("\n");
  assert.equal(lines[0], "## Learned");
  assert.equal(lines[1], "");
  assert.ok(lines[2].startsWith("- "));
});

/* ------------------------------------------------------------ 汇总 */

test("summarizeFile 给出体积、行数与 Learned 条数", () => {
  const text = ["# P", "", "## Learned", "", "- a", "- b"].join("\n");
  const s = summarizeFile(text);
  assert.ok(s.bytes > 0);
  assert.equal(s.lines, 6);
  assert.equal(s.learnedItems, 2);
  assert.ok(s.budgetPercent > 0 && s.budgetPercent < 100);
});

test("summarizeFile 对空内容不崩", () => {
  const s = summarizeFile("");
  assert.equal(s.bytes, 0);
  assert.equal(s.learnedItems, 0);
  assert.equal(summarizeFile(undefined).bytes, 0);
});
