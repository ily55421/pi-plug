/**
 * 读插件设置。
 *
 * 为什么是这样读的：agent extension 运行在 Agent sidecar，它的 ctx 上没有
 * settings 字段（宿主 TrustedExtensionBridge 接口里没有），所以拿不到
 * `pi.plugin.getSettings()`。但宿主把用户设置落在一个固定路径的 JSON 里：
 *
 *   <PI_DESKTOP_DATA_DIR | ~/.pi-desktop>/plugins/data/<id 非 [a-zA-Z0-9._-] 替换为 _>/settings.json
 *   （plugin-runtime.ts:4030 pluginDataDir，:4705 读取时以 manifest default 兜底）
 *
 * 内容就是扁平的 {key: value}。这里照那个路径读，读不到或读坏就用默认值 ——
 * 设置问题绝不能让插件失效。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN_ID = "local.learn";

const DEFAULTS = {
  "learnAppend": false
};

/** 宿主对 id 的目录名清洗规则：非 [a-zA-Z0-9._-] 一律换成下划线。 */
function dataDirName(pluginId) {
  return String(pluginId).replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** 插件数据目录。 */
function pluginDataDir() {
  const root = process.env.PI_DESKTOP_DATA_DIR ? process.env.PI_DESKTOP_DATA_DIR : join(homedir(), ".pi-desktop");
  return join(root, "plugins", "data", dataDirName(PLUGIN_ID));
}

/**
 * 读设置，与 DEFAULTS 合并。
 * 每次调用都重读：用户改完设置立刻生效，不需要重启插件。
 */
function readPluginSettings() {
  try {
    const raw = readFileSync(join(pluginDataDir(), "settings.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...DEFAULTS };
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export { DEFAULTS, PLUGIN_ID, pluginDataDir, readPluginSettings };
