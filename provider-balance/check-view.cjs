/*
 * 视图页静态自检（离线，不依赖宿主）：
 *   1. 内联 <script> 能被 JS 解析
 *   2. 代码里引用的每个 DOM id 都真的存在于 HTML
 *   3. 没有残留的 TODO / 调试输出
 *   4. 声明的 bridge 通道与 main.js 的 onPanelInvoke 分支一一对应
 *
 * 运行：node check-view.cjs
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log("  ok  " + name);
  } else {
    failed += 1;
    console.log("  FAIL " + name + (detail ? "\n       " + detail : ""));
  }
}

const html = fs.readFileSync(path.join(__dirname, "views", "index.html"), "utf8");
const mainJs = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");

/* 1. 内联脚本语法 */
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
check("找到内联 script 块", Boolean(scriptMatch));
const code = scriptMatch ? scriptMatch[1] : "";
let syntaxOk = true;
let syntaxError = "";
try {
  new Function(code);
} catch (error) {
  syntaxOk = false;
  syntaxError = error.message;
}
check("内联 JS 语法可解析（" + code.length + " 字符）", syntaxOk, syntaxError);

/* 2. DOM id 引用完整性 */
const referenced = new Set();
for (const m of code.matchAll(/\$\("([^"]+)"\)/g)) referenced.add(m[1]);
const missing = [];
for (const id of referenced) {
  if (!new RegExp('id="' + id + '"').test(html)) missing.push(id);
}
check(
  "引用的 DOM id 全部存在（" + referenced.size + " 个：" + [...referenced].join(", ") + "）",
  missing.length === 0,
  missing.length ? "缺失: " + missing.join(", ") : "",
);

/* 3. 无调试残留 */
const debugHits = [];
if (/console\.(log|debug)\(/.test(code)) debugHits.push("视图里有 console.log/debug");
if (/debugger\s*;/.test(code)) debugHits.push("视图里有 debugger");
if (/TODO|FIXME|XXX/.test(code)) debugHits.push("视图里有 TODO/FIXME");
if (/console\.(log|debug)\(/.test(mainJs)) debugHits.push("main.js 里有 console.log/debug");
check("无调试残留", debugHits.length === 0, debugHits.join("; "));

/* 4. bridge 通道与插件进程分支对应 */
const viewChannels = new Set();
for (const m of code.matchAll(/invoke\("([^"]+)"/g)) viewChannels.add(m[1]);
const handlerChannels = new Set();
for (const m of mainJs.matchAll(/case "([^"]+)":/g)) handlerChannels.add(m[1]);
const unhandled = [...viewChannels].filter((c) => !handlerChannels.has(c));
const unused = [...handlerChannels].filter((c) => !viewChannels.has(c));
check(
  "视图调用的通道都被插件进程处理（视图 " + [...viewChannels].join(", ") + "）",
  unhandled.length === 0,
  unhandled.length ? "插件进程未处理: " + unhandled.join(", ") : "",
);
check(
  "插件进程的通道都被视图使用（进程 " + [...handlerChannels].join(", ") + "）",
  unused.length === 0,
  unused.length ? "视图未使用: " + unused.join(", ") : "",
);

/* 5. 视图不越权：不得写设置、不得直接联网 */
const violations = [];
if (/pluginBridge[\s\S]{0,40}setSettings/.test(code)) violations.push("视图试图写设置");
if (/\bfetch\(/.test(code)) violations.push("视图试图直接联网");
if (/XMLHttpRequest/.test(code)) violations.push("视图用了 XHR");
if (/localStorage/.test(code)) violations.push("视图用了 localStorage");
check("视图守边界（只读、不联网）", violations.length === 0, violations.join("; "));

/* 6. manifest 与文件一致性 */
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8"));
check("manifest.main 指向存在的文件", fs.existsSync(path.join(__dirname, manifest.main)));
const viewEntries = (manifest.contributes.views || []).map((v) => v.entry);
check(
  "contributes.views 的 entry 都存在（" + viewEntries.join(", ") + "）",
  viewEntries.every((e) => fs.existsSync(path.join(__dirname, e))),
);
check("net.domains 已声明（net.fetch 的前提）", Array.isArray(manifest.net?.domains) && manifest.net.domains.length > 0);
check(
  "声明了 net.fetch 权限",
  (manifest.permissions || []).includes("net.fetch"),
);
check(
  "每个声明权限都在使用（ui.view ↔ views，net.fetch ↔ 联网）",
  (manifest.permissions || []).includes("ui.view") && viewEntries.length > 0 && /pi\.net\.fetch/.test(mainJs),
);

console.log("");
if (failed) {
  console.log("失败 " + failed + " 项");
  process.exit(1);
}
console.log("视图自检全部通过");
