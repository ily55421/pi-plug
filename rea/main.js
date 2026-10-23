/*
 * REA 逆向工程 —— 插件进程入口（local.rea）。
 *
 * 职责分两块：
 *
 * 1. 接入 REA 的本地 MCP 服务器。这一条**不需要**在 main.js 里写任何代码：
 *    manifest.json 的 contributes.mcpServers 声明了 `node launcher.cjs`，宿主在
 *    插件加载时按 mcp.server.local 权限把它作为子进程拉起、完成 MCP 握手，并把
 *    发现的工具以 `plugin_<插件id安全化>_<serverId>_<工具名>` 的形式注册进客户端
 *    工具表。REA 的 170 个工具因此可直接被 ToolSearch 发现并调用。
 *
 * 2. 提供插件自己的东西：
 *    - rea_tools：读**打包在插件内**的离线工具目录（catalog.json），让 Agent 在
 *      不依赖 MCP 连接的情况下查清工具名、分组与参数，再决定调哪个 REA 工具。
 *    - 三条命令：检查运行时状态、复制工具清单、安装运行时。
 *    - 工具箱视图（views/index.html）：面板里浏览/搜索 170 个工具。
 *
 * 关于命令能做什么、不能做什么（重要）：
 * 插件进程的 `pi` 对象**没有**「打开某个停靠视图」的 API —— ui.openPanel() 只对
 * 声明了 ui.panel 的浮动面板有效，对 contributes.views 的停靠视图会抛 NOT_FOUND。
 * 所以这里不提供「打开面板」这种做不到的命令；面板本身由用户在工作面板里切换
 * （Mod+J → 「REA 工具箱」）。命令只做进程内能真正完成的事。
 *
 * 权限取舍：ui.view（视图）+ agent.tool.register（rea_tools）+ agent.prompt.inject
 * （技能）+ mcp.server.local（本地 MCP 服务器）+ clipboard.write（复制工具清单）。
 * 目录数据打包在插件内由视图直接加载，因此不需要任何 fs / net 权限。
 */

"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const CATALOG = require("./catalog.json");
const runtime = require("./runtime.js");

/** 固定的 REA 版本；与启动器、安装命令共用一份，避免漂移。 */
const REA_VERSION = runtime.REA_VERSION;

/** 本插件注册的命令 id，注册与注销共用一份，避免两处漂移。 */
const COMMAND_IDS = ["rea.status", "rea.copyToolList", "rea.prepareRuntime"];

/** rea_tools 默认返回条数上限。 */
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 170;

/**
 * MCP 工具的客户端全名。
 *
 * 宿主对插件声明的 MCP 工具统一加前缀 `plugin_<插件id安全化>_<serverId>_<工具名>`，
 * 其中「安全化」是把 [^a-zA-Z0-9_] 换成下划线（见宿主 pluginToolName 的实现）。
 * 插件 id 是 local.rea → local_rea，serverId 是 rea，所以前缀固定为
 * `plugin_local_rea_rea_`。这里算出来给 Agent 直接抄，省得它猜错。
 */
const CLIENT_TOOL_PREFIX = `plugin_${"local.rea".replace(/[^a-zA-Z0-9_]/g, "_")}_${"rea".replace(/[^a-zA-Z0-9_]/g, "_")}_`;

/** 按名字/标题/描述/分组做不区分大小写的包含匹配。 */
function matches(tool, needle) {
  if (!needle) return true;
  return (
    tool.name.toLowerCase().includes(needle) ||
    (tool.title || "").toLowerCase().includes(needle) ||
    (tool.description || "").toLowerCase().includes(needle) ||
    (tool.group || "").toLowerCase().includes(needle)
  );
}

/** 组 id → 中文标签，用于结果里给出可读的分组名。 */
function groupLabels() {
  const map = new Map();
  for (const group of CATALOG.groups) map.set(group.id, group.label);
  return map;
}

/** 把一条目录记录压成 Agent 用得上的紧凑形状。 */
function toAgentEntry(tool, labels) {
  const params = (tool.params || []).map((p) => {
    const required = p.required ? "" : "?";
    const bits = [`${p.name}${required}: ${p.type}`];
    if (p.enum && p.enum.length) bits.push(`(${p.enum.slice(0, 8).join(" | ")})`);
    return bits.join(" ");
  });
  return {
    tool: tool.name,
    clientTool: CLIENT_TOOL_PREFIX + tool.name,
    group: tool.group,
    groupLabel: labels.get(tool.group) || tool.group,
    title: tool.title || undefined,
    description: tool.description || undefined,
    args: params.length ? params : undefined,
    required: tool.required && tool.required.length ? tool.required : undefined,
    readOnly: tool.readOnly === true ? true : undefined,
  };
}

/** rea_tools 的查询实现。 */
function queryCatalog(args) {
  const labels = groupLabels();
  const rawQuery = typeof args?.query === "string" ? args.query.trim().toLowerCase() : "";
  const group = typeof args?.group === "string" ? args.group.trim() : "";
  const requested = Number.isFinite(args?.limit) ? Math.floor(args.limit) : DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(MAX_LIMIT, requested));

  const knownGroups = new Set(CATALOG.groups.map((g) => g.id));
  if (group && !knownGroups.has(group)) {
    return {
      ok: false,
      error: `unknown group "${group}"`,
      groups: CATALOG.groups,
    };
  }

  const hits = CATALOG.tools.filter(
    (tool) => (!group || tool.group === group) && matches(tool, rawQuery),
  );
  const shown = hits.slice(0, limit).map((tool) => toAgentEntry(tool, labels));

  return {
    ok: true,
    package: `${CATALOG.packageName}@${CATALOG.packageVersion}`,
    protocolVersion: CATALOG.protocolVersion,
    catalogGeneratedAt: CATALOG.generatedAt,
    totalTools: CATALOG.toolCount,
    matched: hits.length,
    returned: shown.length,
    truncated: hits.length > shown.length,
    // 只在没有过滤时给全量分组表，避免每次查询都塞一遍
    groups: rawQuery || group ? undefined : CATALOG.groups,
    tools: shown,
    note:
      "Call a REA tool with its clientTool name. The local MCP server starts on first use; " +
      "the first call may take several seconds while REA's runtime loads.",
  };
}

/* ------------------------------------------------------------------ 命令 */

/**
 * 检查 REA 运行时状态，并把结论报给用户。
 *
 * 为什么需要这条命令：MCP 服务器的连接状态**不通过面板桥暴露**，所以工具没出现
 * 时用户只能猜。这里用与启动器**同一份**定位逻辑（runtime.js）如实回答：
 * 找到哪一份 REA、版本、装在哪、走的是哪条候选路径；没找到就列出试过的全部路径
 * 和修复方式。
 *
 * 注意它只能回答「运行时在不在」——工具是否已注册进工具表由宿主在握手时决定，
 * 插件进程看不到，所以这里不编造一个连接状态。
 */
async function reportStatus() {
  const { root, tried } = runtime.locateRea();

  if (!root) {
    const message = [
      `REA：未找到可用的运行时（试过 ${tried.length} 条路径）。`,
      "请执行命令「REA：准备运行时」安装，或手动运行 npm install -g rea-agents@6.4.0，",
      "然后重新加载插件。",
    ].join(" ");
    await pi.ui.showToast(message, "error").catch(() => undefined);
    return { ok: false, found: false, tried };
  }

  const version = runtime.versionOf(root);
  const source = runtime.sourceLabel(root);
  await pi.ui
    .showToast(`REA：运行时就绪 · rea-agents@${version} · 来源：${source}`, "info")
    .catch(() => undefined);

  return {
    ok: true,
    found: true,
    version,
    path: root,
    source,
    expectedVersion: REA_VERSION,
    versionMatches: version === REA_VERSION,
    catalogTools: CATALOG.toolCount,
    toolNamePrefix: CLIENT_TOOL_PREFIX,
    checkedPaths: tried,
  };
}

/**
 * 把全部工具的可调用名复制到剪贴板。
 *
 * 申请 clipboard.write 就是为了这条命令能**真的复制**：一份 170 行的清单，用户
 * 多半是想粘到别处（另一个 agent、文档、脚本）。视图面板里也有同样的按钮，但那
 * 需要先打开面板；命令面板一条命令直达更快。
 */
async function copyToolList() {
  const names = CATALOG.tools.map((tool) => CLIENT_TOOL_PREFIX + tool.name);
  const text = names.join("\n");
  try {
    await pi.clipboard.writeText(text);
    await pi.ui
      .showToast(`REA：已复制 ${names.length} 个工具名到剪贴板`, "info")
      .catch(() => undefined);
    return { ok: true, copied: names.length };
  } catch (error) {
    await pi.ui
      .showToast(
        `REA：复制失败（${error?.message ?? error}）。可在「REA 工具箱」面板里点「复制清单」。`,
        "error",
      )
      .catch(() => undefined);
    return { ok: false, count: names.length };
  }
}

/**
 * 把 REA 安装到插件自己的数据目录，供 launcher.cjs 直接 node 启动。
 *
 * 为什么需要这一步：宿主的 MCP 握手有 10 秒硬超时，而 `npx -y rea-agents mcp`
 * 实测 9–13 秒，处在超时边缘甚至直接超时——握手失败的工具不会注册进工具表，
 * Agent 就看不到它们。直接 node 启动只要 4–7 秒，稳在超时内，所以 launcher.cjs
 * 优先找一份**已安装**的 REA；这里就是那份安装的产地。
 *
 * 为什么不在 launcher 里顺手装：安装要几十秒，远超握手超时，放在启动路径上
 * 只会让每次启动都超时。安装必须是显式的、由用户触发的动作。
 *
 * 实现说明：插件进程是独立的 Node 进程，可以直接用 node:child_process（宿主
 * 的权限网关只覆盖宿主 API，不介入原生 Node 调用；pi.terminal 等插件同理）。
 * 命令参数里只有常量版本号与宿主给的路径，没有用户输入，因此不存在注入面。
 */
async function prepareRuntime() {
  let runtimeDir;
  try {
    const dataPath = await pi.plugin.getDataPath();
    if (!dataPath) throw new Error("no data path");
    runtimeDir = path.join(String(dataPath), "runtime");
  } catch (error) {
    await pi.ui
      .showToast(`REA：拿不到插件数据目录（${error?.message ?? error}）`, "error")
      .catch(() => undefined);
    return { ok: false, error: "no-data-path" };
  }

  const npmCli = findNpmCli();
  if (!npmCli) {
    await pi.ui
      .showToast(
        "REA：找不到 npm。请先安装 Node.js，或手动执行 npm install -g rea-agents@6.4.0",
        "error",
      )
      .catch(() => undefined);
    return { ok: false, error: "no-npm" };
  }

  await pi.ui
    .showToast(`REA：正在下载 rea-agents@${REA_VERSION}，请稍候…`, "info")
    .catch(() => undefined);

  return await new Promise((resolve) => {
    let stderrTail = "";
    let settled = false;
    const child = spawn(
      process.execPath,
      [npmCli, "install", `rea-agents@${REA_VERSION}`, "--prefix", runtimeDir, "--no-audit", "--no-fund"],
      { cwd: runtimeDir, env: process.env, windowsHide: true },
    );

    const finish = async (result) => {
      if (settled) return;
      settled = true;
      if (result.ok) {
        await pi.ui
          .showToast("REA：运行时已就绪，重新加载插件后工具即可用", "info")
          .catch(() => undefined);
      } else {
        await pi.ui
          .showToast(`REA：运行时安装失败（${result.detail}）`, "error")
          .catch(() => undefined);
      }
      resolve(result);
    };

    child.stderr.on("data", (chunk) => {
      stderrTail += String(chunk);
      if (stderrTail.length > 2000) stderrTail = stderrTail.slice(-2000);
    });
    child.on("error", (error) => {
      void finish({ ok: false, error: "spawn-failed", detail: error.message });
    });
    child.on("close", (code) => {
      void finish(
        code === 0
          ? { ok: true, runtimeDir }
          : { ok: false, error: "npm-failed", detail: `exit ${code}: ${stderrTail.trim().split("\n").slice(-3).join(" ")}` },
      );
    });
  });
}

/**
 * 定位 npm 的 CLI 入口，走 node 直接执行。
 *
 * 刻意不 spawn `npm.cmd`：Windows 上 .cmd 需要 shell，而 shell 会把参数当命令串
 * 再解析一遍。用 node + npm-cli.js 可以保持参数原样传递。
 */
function findNpmCli() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* 忽略：继续试下一个 */
    }
  }
  return null;
}

/* ---------------------------------------------------------------- 生命周期 */

async function onLoad() {
  await pi.agent.registerTool({
    name: "rea_tools",
    description:
      "List or search REA's reverse-engineering tool catalog offline (native binaries, " +
      "JavaScript/Electron, .NET, Android, firmware, websites, network captures, evidence " +
      "comparison). Pass `query` to filter, or omit it for every tool grouped by area. Each " +
      "entry carries argument names, which are required, and the exact client tool name to " +
      "call. Use it before reaching for a REA tool so you call the right one with the right " +
      "arguments. Reads a catalog bundled in the plugin; no network, no filesystem.",
    risk: "low",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description:
            "Case-insensitive keywords matched against tool name, title, description and group label. Omit to list everything.",
        },
        group: {
          type: "string",
          description:
            "Restrict to one group id (for example native, javascript, android, evidence). Omit to see all groups.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LIMIT,
          description: `Maximum entries to return. Defaults to ${DEFAULT_LIMIT}.`,
        },
      },
    },
    execute: async (args) => queryCatalog(args),
  });

  await pi.commands.register({
    id: "rea.status",
    title: "REA：检查运行时状态",
    keywords: ["rea", "status", "runtime", "doctor", "状态", "检查", "诊断"],
    run: reportStatus,
  });

  await pi.commands.register({
    id: "rea.copyToolList",
    title: "REA：复制全部工具名到剪贴板",
    keywords: ["rea", "tools", "copy", "工具", "复制", "清单"],
    run: copyToolList,
  });

  await pi.commands.register({
    id: "rea.prepareRuntime",
    title: "REA：准备运行时（下载 rea-agents）",
    keywords: ["rea", "runtime", "install", "prepare", "运行时", "安装", "下载"],
    run: prepareRuntime,
  });
}

async function onUnload() {
  for (const id of COMMAND_IDS) {
    try {
      await pi.commands.unregister(id);
    } catch {
      /* 已经不存在 */
    }
  }
  try {
    await pi.agent.unregisterTool("rea_tools");
  } catch {
    /* 已经不存在 */
  }
}

module.exports = {
  onLoad,
  onUnload,
  __internal: { queryCatalog, CLIENT_TOOL_PREFIX, reportStatus, copyToolList },
};
