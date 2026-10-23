/*
 * REA 运行时定位 —— launcher.cjs 与 main.js 共用的唯一实现。
 *
 * 抽出来是因为两个地方都要回答同一个问题：「本机哪份 REA 能跑？」
 *   - launcher.cjs：MCP 启动时要用它把 REA 拉起来
 *   - main.js：状态命令要如实告诉用户找到了什么、没找到时怎么修
 * 两处各写一份必然漂移，所以只留这一份。
 */

"use strict";

const { existsSync, readdirSync, readFileSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");
const { homedir } = require("node:os");

/** 与 manifest.json 的 id 一致，用于定位插件自己的数据目录。 */
const PLUGIN_ID = "local.rea";

/** 固定的 REA 版本；安装与文档共用一份，避免行为漂移。 */
const REA_VERSION = "6.4.0";

/** 候选目录里，REA 包的相对位置。 */
const PACKAGE_SUBPATH = "rea-agents";

/**
 * 插件数据目录下的运行时位置。
 *
 * 根目录必须与宿主的 pluginDataDir() 算法一致：优先 PI_DESKTOP_DATA_DIR
 * （宿主在启动时注入，可覆盖安装位置），否则回落到 ~/.pi-desktop。
 * 插件 id 里的字符由宿主做同样的安全化替换，这里照做以免两处不一致。
 */
function managedRuntimeRoot() {
  const dataRoot = process.env.PI_DESKTOP_DATA_DIR || join(homedir(), ".pi-desktop");
  const safePluginId = PLUGIN_ID.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(dataRoot, "plugins", "data", safePluginId, "runtime");
}

/**
 * 从本文件自身位置反推数据根。
 *
 * 已安装插件的位置固定为 <dataRoot>/plugins/installed/<id>/，所以上溯三级
 * 就是 dataRoot。这条候选在宿主自定义了数据目录、而 PI_DESKTOP_DATA_DIR
 * 又没传进子进程时仍然能命中。
 *
 * dev 加载的插件（目录在别处）会算出一个不存在的路径，isUsableRea 直接判否，
 * 不会误用——因此多这一条是零风险的。
 */
function derivedRuntimeRoots() {
  try {
    const dataRoot = resolve(__dirname, "..", "..", "..");
    const safePluginId = PLUGIN_ID.replace(/[^a-zA-Z0-9._-]/g, "_");
    return [join(dataRoot, "plugins", "data", safePluginId, "runtime")];
  } catch {
    return [];
  }
}

/** 一个候选目录是否真的能跑：需要 package.json 与编译产物同时存在。 */
function isUsableRea(root) {
  if (!root) return false;
  try {
    if (!existsSync(join(root, "package.json"))) return false;
    if (!existsSync(join(root, "dist", "main.js"))) return false;
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return pkg && pkg.name === "rea-agents";
  } catch {
    return false;
  }
}

/** 读取一份 REA 的版本号，用于日志与诊断。 */
function versionOf(root) {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version || "unknown";
  } catch {
    return "unknown";
  }
}

/** node 安装前缀下的全局 node_modules。 */
function globalNodeModules() {
  const exe = process.execPath;
  const dir = dirname(exe);
  const candidates = [
    // Windows / 常规 Node 安装
    join(dir, "node_modules"),
    // POSIX：bin/node -> lib/node_modules
    resolve(dir, "..", "lib", "node_modules"),
  ];
  const appData = process.env.APPDATA;
  if (appData) candidates.push(join(appData, "npm", "node_modules"));
  return candidates;
}

/** npx 缓存里出现过的 rea-agents 安装。 */
function npxCacheCandidates() {
  const cacheRoots = [];
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) cacheRoots.push(join(localAppData, "npm-cache"));
  if (process.env.npm_config_cache) cacheRoots.push(process.env.npm_config_cache);

  const found = [];
  for (const cacheRoot of cacheRoots) {
    const npxDir = join(cacheRoot, "_npx");
    if (!existsSync(npxDir)) continue;
    let entries = [];
    try {
      entries = readdirSync(npxDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      found.push(join(npxDir, entry.name, "node_modules", PACKAGE_SUBPATH));
    }
  }
  return found;
}

/** 每个候选的来源标签，供状态命令说明「用的是哪一份」。 */
function sourceLabel(root) {
  try {
    if (process.env.REA_PACKAGE_ROOT && resolve(root) === resolve(process.env.REA_PACKAGE_ROOT)) {
      return "REA_PACKAGE_ROOT 环境变量";
    }
    const managed = join(managedRuntimeRoot(), "node_modules", PACKAGE_SUBPATH);
    if (resolve(root) === resolve(managed)) return "插件数据目录（由「准备运行时」安装）";
    for (const dir of derivedRuntimeRoots()) {
      if (resolve(root) === resolve(join(dir, "node_modules", PACKAGE_SUBPATH))) {
        return "插件数据目录（从插件自身位置反推）";
      }
    }
    for (const dir of globalNodeModules()) {
      if (resolve(root) === resolve(join(dir, PACKAGE_SUBPATH))) return "全局 node_modules";
    }
    if (/[\\/]_npx[\\/]/.test(root)) return "npx 缓存";
  } catch {
    /* 标签只是展示信息，算不出来就不给 */
  }
  return "未知来源";
}

/** 按优先级列出所有候选，返回第一个可用的。 */
function locateRea() {
  const tried = [];
  const roots = [];

  if (process.env.REA_PACKAGE_ROOT) {
    roots.push(process.env.REA_PACKAGE_ROOT);
  }
  roots.push(join(managedRuntimeRoot(), "node_modules", PACKAGE_SUBPATH));
  for (const dir of derivedRuntimeRoots()) {
    roots.push(join(dir, "node_modules", PACKAGE_SUBPATH));
  }
  for (const dir of globalNodeModules()) roots.push(join(dir, PACKAGE_SUBPATH));
  for (const dir of npxCacheCandidates()) roots.push(dir);

  for (const root of roots) {
    tried.push(root);
    if (isUsableRea(root)) return { root, tried };
  }
  return { root: null, tried };
}

/** 找不到时的说明。 */
function missingRuntimeMessage(tried) {
  return [
    "REA runtime not found. Checked:",
    ...tried.map((p) => "  - " + p),
    "",
    `Fix: run the plugin command "REA: prepare runtime"`,
    `(or run: npm install -g rea-agents@${REA_VERSION}), then reload the plugin.`,
    "",
    "Why not npx: PI-Desktop aborts the MCP handshake after 10s, and npx takes",
    "9-13s to resolve and load REA, so its tools would never register.",
  ].join("\n");
}

module.exports = {
  PLUGIN_ID,
  REA_VERSION,
  PACKAGE_SUBPATH,
  managedRuntimeRoot,
  derivedRuntimeRoots,
  isUsableRea,
  versionOf,
  sourceLabel,
  locateRea,
  missingRuntimeMessage,
};
