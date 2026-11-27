"use strict";

const { readFile, stat } = require("node:fs/promises");
const { join } = require("node:path");
const { fail, record } = require("./state.cjs");
const MAX_BYTES = 8 * 1024 * 1024;

// 只访问宿主返回的插件私有目录，绕开宿主 getSettings 对损坏 JSON 的默认值回退。
async function readSettingsFile(directory) {
  try {
    const path = join(directory, "settings.json");
    if ((await stat(path)).size > MAX_BYTES) fail("STATE_TOO_LARGE", "插件设置超过 8 MiB 读取上限。");
    const raw = await readFile(path);
    if (raw.length > MAX_BYTES) fail("STATE_TOO_LARGE", "插件设置超过 8 MiB 读取上限。");
    const parsed = JSON.parse(raw.toString("utf8"));
    if (!record(parsed)) fail("STATE_CORRUPT", "插件设置格式损坏。");
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    if (error.code === "STATE_TOO_LARGE" || error.code === "STATE_CORRUPT") throw error;
    fail(error instanceof SyntaxError ? "STATE_CORRUPT" : "STORAGE_READ_FAILED", "插件私有设置读取失败，不能据此判断清单为空。");
  }
}
module.exports = { readSettingsFile, MAX_BYTES };
