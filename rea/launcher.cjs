#!/usr/bin/env node
/*
 * REA 启动器 —— MCP stdio 入口。
 *
 * 为什么需要这一层：
 *
 * 宿主的 MCP 握手有 10 秒硬超时（MCP_CONNECT_TIMEOUT_MS），握手失败的工具
 * **不会**注册进工具表，也就不会出现在 Agent 的工具列表里。而 `npx -y
 * rea-agents mcp` 实测要 9–13 秒（npx 自身解析 + 依赖树加载），处在超时边缘
 * 甚至直接超时；直接 `node dist/main.js` 只要 4–5 秒。
 *
 * 所以这里不用 npx，而是自己定位一份**已安装**的 REA，用 node 直接起它的
 * MCP 入口。定位逻辑在 runtime.js 里，与插件进程共用同一份实现——两边各写
 * 一份必然漂移，而漂移的后果是「面板说找到了、启动器却找不到」。
 *
 * 找不到时退出码 1 并把修复方式写到 stderr（宿主会把子进程 stderr 记进插件
 * 审计日志）。真正的安装动作不在这里做——安装要几十秒，远超握手超时，
 * 放在这里只会让每次启动都超时。安装由插件命令「REA：准备运行时」负责。
 */

"use strict";

const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { locateRea, versionOf, missingRuntimeMessage } = require("./runtime.js");

async function main() {
  const { root, tried } = locateRea();

  if (!root) {
    process.stderr.write(missingRuntimeMessage(tried) + "\n");
    process.exit(1);
  }

  const entry = join(root, "dist", "main.js");
  process.stderr.write(
    `[rea-launcher] using rea-agents@${versionOf(root)} at ${root}\n`,
  );

  // REA 的编译入口导出 runEntrypoint()，由它接管 stdio 的 MCP 协议。
  const mod = await import(pathToFileURL(entry).href);
  if (typeof mod.runEntrypoint !== "function") {
    process.stderr.write(`[rea-launcher] ${entry} does not export runEntrypoint()\n`);
    process.exit(1);
  }
  await mod.runEntrypoint();
}

main().catch((error) => {
  process.stderr.write(
    `[rea-launcher] failed to start REA: ${error && error.stack ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
