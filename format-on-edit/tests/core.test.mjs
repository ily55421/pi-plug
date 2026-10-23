/**
 * Format on Edit 逻辑测试（纯 Node，无第三方依赖）。
 *
 * 跑法：node --test tests/core.test.mjs
 *
 * tag 用例的两个来源：
 *   1. 与 Rust 侧 `tag.rs` 的单元测试断言对齐（长度、大写 hex、稳定性、尾随空白/CRLF 无关）；
 *   2. 交叉验证向量：用 std-only Rust 程序复刻 `hash_input`，对 18 个边界输入
 *      与 JS 实现逐值比对（见 README「验证」一节的记录）。下列硬编码值即来自该比对。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  FORMATTERS,
  formatNotice,
  formatterFor,
  isSkippedPath,
  planFormat,
  supportedExtensions,
  tagOf,
} from "../extension/core.mjs";

/* ------------------------------------------------------------ tag：与 Rust 对齐 */

test("tag 是 4 位大写 hex", () => {
  const tag = tagOf("hello\n");
  assert.equal(tag.length, 4);
  assert.match(tag, /^[0-9A-F]{4}$/);
});

test("tag 对同一输入稳定", () => {
  assert.equal(tagOf("hello\n"), tagOf("hello\n"));
});

test("有无结尾换行是不同的 tag（行集合不同）", () => {
  assert.notEqual(tagOf("hello\n"), tagOf("hello"));
});

test("尾随空格与 tab 不影响 tag", () => {
  assert.equal(tagOf("a  \nb\t\n"), tagOf("a\nb\n"));
});

test("CRLF 与孤立 CR 都归一成 LF，不影响 tag", () => {
  assert.equal(tagOf("a\r\nb\r\n"), tagOf("a\nb\n"));
  assert.equal(tagOf("a\rb\r"), tagOf("a\nb\n"));
});

test("BOM 被剥掉，不影响 tag", () => {
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello\n", "utf8")]);
  assert.equal(tagOf(bom), tagOf("hello\n"));
});

test("传入 Buffer 与传入等值字符串得到同一 tag", () => {
  assert.equal(tagOf(Buffer.from("a\nb\n", "utf8")), tagOf("a\nb\n"));
});

test("开头空格属于内容，会影响 tag", () => {
  assert.notEqual(tagOf("  x\n"), tagOf("x\n"));
});

test("交叉验证向量：与 Rust hash_input + SHA-256 的结果逐值一致", () => {
  // 这些值来自 std-only Rust 程序复刻 hash_input 后算出的 tag（18/18 一致）。
  const vectors = [
    ["hello\n", "BE03"],
    ["hello", "9824"],
    ["", "B855"],
    ["\n", "546B"],
    ["\n\n", "B070"],
    ["a\nb\n", "59A2"],
    ["a\nb", "3C78"],
    ["a  \nb\t\n", "59A2"],
    ["a\r\nb\r\n", "59A2"],
    ["a\rb\rc\r", "E4D2"],
    ["  leading spaces kept\n", "044D"],
    ["trailing   \n", "F858"],
    ["\t\t\n", "546B"],
    ['fn main() {\n    println!("hi");\n}\n', "DF07"],
    ["中文内容\n第二行  \n", "24D8"],
    ["mixed\r\nline\nendings\r\n", "2F58"],
    ["no trailing newline at all", "C041"],
    ["   \n   \n   \n", "2167"],
  ];
  for (const [input, expected] of vectors) {
    assert.equal(tagOf(input), expected, `tag(${JSON.stringify(input)})`);
  }
});

test("非字符串/非 Buffer 输入退化为空内容，不抛错", () => {
  assert.equal(tagOf(undefined), tagOf(""));
  assert.equal(tagOf(null), tagOf(""));
  assert.equal(tagOf(42), tagOf(""));
});

/* ------------------------------------------------------------ formatter 表 */

test("按扩展名找到 formatter", () => {
  assert.equal(formatterFor("a.ts").id, "prettier");
  assert.equal(formatterFor("a.py").id, "ruff");
  assert.equal(formatterFor("a.go").id, "gofmt");
  assert.equal(formatterFor("a.rs").id, "rustfmt");
  assert.equal(formatterFor("a.sh").id, "shfmt");
});

test("扩展名大小写不敏感", () => {
  assert.equal(formatterFor("A.TS").id, "prettier");
});

test("无扩展名或未知扩展名返回 null", () => {
  assert.equal(formatterFor("Makefile"), null);
  assert.equal(formatterFor("a.xyz"), null);
  assert.equal(formatterFor(""), null);
  assert.equal(formatterFor(undefined), null);
});

test("表里不含「必须有项目配置文件才能正确工作」的 formatter", () => {
  // 刻意排除：clang-format / ocamlformat / pint / prettier-without-config 的变体
  const ids = FORMATTERS.map((f) => f.id);
  for (const excluded of ["clang-format", "ocamlformat", "pint", "rubocop", "ktlint"]) {
    assert.ok(!ids.includes(excluded), `${excluded} 不应在表里`);
  }
});

test("扩展名清单非空且去重排序", () => {
  const exts = supportedExtensions();
  assert.ok(exts.length > 20);
  assert.equal(new Set(exts).size, exts.length);
  assert.deepEqual(exts, [...exts].sort());
});

/* ------------------------------------------------------------ 跳过路径 */

test("生成物与依赖目录被跳过", () => {
  for (const p of [
    "node_modules/pkg/a.ts",
    "dist/out.js",
    "build/x.css",
    "target/debug/a.rs",
    ".git/config",
    "vendor/lib.py",
    "coverage/report.html",
    "C:\\proj\\node_modules\\x\\a.js",
  ]) {
    assert.equal(isSkippedPath(p), true, p);
  }
});

test("正常源码路径不被跳过", () => {
  for (const p of ["src/a.ts", "a.ts", "packages/core/src/x.py", "C:\\work\\src\\main.rs"]) {
    assert.equal(isSkippedPath(p), false, p);
  }
});

test("名字里含 dist 但不是目录的路径不误杀", () => {
  assert.equal(isSkippedPath("src/distance.ts"), false);
  assert.equal(isSkippedPath("src/building.ts"), false);
});

/* ------------------------------------------------------------ 决策闸门（fail-closed） */

test("非写文件工具一律不格式化", () => {
  for (const toolName of ["Read", "Grep", "Glob", "Bash", "todo_write", ""]) {
    const plan = planFormat({ toolName, args: { file_path: "a.ts" } });
    assert.equal(plan.format, false);
  }
});

test("工具调用失败时不格式化", () => {
  const plan = planFormat({ toolName: "Edit", args: { file_path: "a.ts" }, isError: true });
  assert.equal(plan.format, false);
  assert.match(plan.reason, /failed/);
});

test("缺 file_path 不格式化", () => {
  assert.equal(planFormat({ toolName: "Edit", args: {} }).format, false);
  assert.equal(planFormat({ toolName: "Edit" }).format, false);
});

test("生成物目录不格式化", () => {
  const plan = planFormat({ toolName: "Edit", args: { file_path: "node_modules/x/a.ts" }, exists: () => true });
  assert.equal(plan.format, false);
  assert.match(plan.reason, /generated|dependency/);
});

test("没有对应 formatter 不格式化", () => {
  const plan = planFormat({ toolName: "Edit", args: { file_path: "a.unknownext" }, exists: () => true });
  assert.equal(plan.format, false);
  assert.match(plan.reason, /no formatter/);
});

test("需要项目依赖但项目没声明 → 不格式化", () => {
  const plan = planFormat({ toolName: "Edit", args: { file_path: "a.ts" }, exists: () => false });
  assert.equal(plan.format, false);
  assert.match(plan.reason, /does not declare prettier/);
});

test("无法检查项目依赖时 → 不格式化（宁可少做）", () => {
  const plan = planFormat({ toolName: "Edit", args: { file_path: "a.ts" } });
  assert.equal(plan.format, false);
  assert.match(plan.reason, /could not be checked/);
});

test("exists 抛错时 → 不格式化", () => {
  const plan = planFormat({
    toolName: "Edit",
    args: { file_path: "a.ts" },
    exists: () => {
      throw new Error("fs down");
    },
  });
  assert.equal(plan.format, false);
});

test("全部条件满足才格式化", () => {
  const plan = planFormat({ toolName: "Edit", args: { file_path: "src/a.ts" }, exists: () => true });
  assert.equal(plan.format, true);
  assert.equal(plan.formatter.id, "prettier");
  assert.equal(plan.filePath, "src/a.ts");
});

test("不需要项目依赖的 formatter（gofmt/rustfmt/shfmt）即使没有 exists 也能通过", () => {
  for (const file of ["a.go", "a.rs", "a.sh"]) {
    const plan = planFormat({ toolName: "Write", args: { file_path: file } });
    assert.equal(plan.format, true, file);
  }
});

test("Edit 与 Write 都会被考虑，其他工具不会", () => {
  assert.equal(planFormat({ toolName: "Edit", args: { file_path: "a.go" } }).format, true);
  assert.equal(planFormat({ toolName: "Write", args: { file_path: "a.go" } }).format, true);
  assert.equal(planFormat({ toolName: "MultiEdit", args: { file_path: "a.go" } }).format, false);
});

/* ------------------------------------------------------------ 提示文案 */

test("提示里给出新 tag 与下一步动作", () => {
  const text = formatNotice({ filePath: "src/a.ts", oldTag: "AAAA", newTag: "BBBB", formatterId: "prettier" });
  assert.ok(text.includes("prettier"));
  assert.ok(text.includes("src/a.ts"));
  assert.ok(text.includes("AAAA"));
  assert.ok(text.includes("BBBB"));
  assert.ok(/tag in your next Edit/i.test(text));
});

test("tag 未变时只给当前 tag，不说「变了」", () => {
  const text = formatNotice({ filePath: "a.ts", oldTag: "AAAA", newTag: "AAAA" });
  assert.ok(text.includes("Current file tag: AAAA"));
  assert.ok(!text.includes("changed from"));
});

test("行数变化会写出来（含正负号）", () => {
  assert.ok(formatNotice({ filePath: "a.ts", newTag: "BBBB", changedLines: 3 }).includes("+3"));
  assert.ok(formatNotice({ filePath: "a.ts", newTag: "BBBB", changedLines: -2 }).includes("-2"));
  assert.ok(formatNotice({ filePath: "a.ts", newTag: "BBBB", changedLines: 0 }).includes("0"));
});

test("未知 tag 时不编造，明确写 unknown", () => {
  const text = formatNotice({ filePath: "a.ts" });
  assert.ok(text.includes("<unknown>"));
});

test("提示文案保持简短（不把文件内容倒进上下文）", () => {
  const text = formatNotice({ filePath: "a.ts", oldTag: "AAAA", newTag: "BBBB", formatterId: "prettier", changedLines: 5 });
  assert.ok(text.length < 500, `长度 ${text.length}`);
});

test("formatNotice 对空输入不抛错", () => {
  assert.doesNotThrow(() => formatNotice(undefined));
  assert.doesNotThrow(() => formatNotice({}));
});
