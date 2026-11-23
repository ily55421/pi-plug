"use strict";

/**
 * local.fastsh —— POSIX 快速通道
 *
 * 通过 stdio 上的逐行 JSON 协议驱动常驻的 bin/fastsh.exe（内嵌 mvdan.cc/sh v3）。
 * 目标：把轻量命令的单次开销从 PowerShell 7 的 ~270ms 降到 ~1ms。
 *
 * 设计约束：
 * - daemon 随插件启动、随插件退出，崩溃后下次调用自动重启；
 * - 任何 daemon 侧故障都不阻塞 Agent，一律返回 fallback=true 让它改用内置 Bash；
 * - 本插件不读项目文件、不联网、不碰凭据。
 */

const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");

const DAEMON_PATH = path.join(__dirname, "bin", "fastsh.exe");
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 600000;
const MIN_TIMEOUT_MS = 1000;
const START_TIMEOUT_MS = 10000;
const MAX_BATCH = 20;

let proc = null;
let starting = null;
let reqId = 0;
/** @type {Map<number, {resolve:Function, reject:Function}>} */
const pending = new Map();

/* ------------------------------------------------------------ daemon 生命周期 */

function failAll(err) {
  if (pending.size === 0) return;
  const entries = Array.from(pending.values());
  pending.clear();
  for (const p of entries) p.reject(err);
}

function dispatch(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // 忽略非 JSON 噪声行
  }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  p.resolve(msg);
}

function startDaemon() {
  if (proc && !proc.killed && proc.exitCode === null) return Promise.resolve();
  if (starting) return starting;

  starting = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    let child;
    try {
      child = spawn(DAEMON_PATH, [], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      starting = null;
      finish(err);
      return;
    }
    proc = child;

    child.on("error", (err) => {
      if (proc === child) {
        proc = null;
        starting = null;
      }
      failAll(err);
      finish(err);
    });

    child.on("exit", (code) => {
      if (proc === child) {
        proc = null;
        starting = null;
      }
      failAll(new Error("fastsh 守护进程退出 code=" + code));
    });

    child.on("spawn", () => finish());

    readline.createInterface({ input: child.stdout }).on("line", dispatch);
    // daemon 自身的 stderr 只是诊断噪声，丢弃以免污染宿主日志
    child.stderr.on("data", () => {});
    // 必须吸收 stdin 的 error：daemon 被杀后写管道会抛 EPIPE，
    // 没有 handler 会变成未捕获的 'error' 事件把整个插件进程打崩。
    child.stdin.on("error", () => {});

    setTimeout(() => finish(new Error("fastsh 守护进程启动超时")), START_TIMEOUT_MS);
  });

  return starting;
}

function send(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = ++reqId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("fastsh 请求超时（" + timeoutMs + "ms）"));
    }, timeoutMs + 5000);

    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });

    try {
      proc.stdin.write(JSON.stringify(Object.assign({ id }, request)) + "\n");
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(err);
    }
  });
}

/* ------------------------------------------------------------------ 工具执行 */

/**
 * 解析工作目录。宿主不同版本的 workspace API 形状不一致，这里按可能性依次尝试，
 * 全部拿不到才退回插件进程 cwd。
 *
 * 这里必须拿到真实工作区：之前只试 pi.workspace.get() 一种形状，真实宿主下拿不到，
 * 于是静默退回 process.cwd()——那是 PI-Desktop 安装目录。结果是 rm/cp/mv 这类
 * 相对路径命令会打在安装目录里，属于安全问题。
 */
async function resolveCwd(requested) {
  if (typeof requested === "string" && requested.trim()) return requested.trim();

  const pick = (v) => {
    if (!v) return null;
    if (typeof v === "string") return v.trim() || null;
    for (const k of ["root", "path", "directory", "cwd", "workspaceRoot", "rootPath"]) {
      const s = v[k];
      if (typeof s === "string" && s.trim()) return s.trim();
    }
    return null;
  };

  try {
    const ws = globalThis.pi && pi.workspace;
    if (ws) {
      for (const m of ["get", "getActive", "current", "resolve"]) {
        if (typeof ws[m] === "function") {
          const s = pick(await ws[m]());
          if (s) return s;
        }
      }
      const s = pick(ws);
      if (s) return s;
    }
  } catch {
    /* 忽略，继续往下退 */
  }
  return process.cwd();
}

function normalizeTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(n), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}
/** 自计时统一保留 2 位小数，便于直接比较。 */
const round2 = (v) => Math.round(v * 100) / 100;

function formatResult(r, command, timings) {
  const base = {
    command,
    ok: r.ok === true,
    exitCode: typeof r.exitCode === "number" ? r.exitCode : null,
    // 自计时口径：pluginMs=execute 全流程；cwdMs=resolveCwd 耗时；daemonMs=daemon 内 handle 耗时。
    // 宿主级计时受并发归因污染，这组字段不依赖宿主日志，可直接做 IPC 分解：
    // pluginMs − daemonMs ≈ IPC + cwd 解析 + 序列化等插件侧开销。
    timings: timings || null,
    durationMs: typeof r.durationMs === "number" ? r.durationMs : null,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
  };

  if (r.fallback) {
    return Object.assign(base, {
      fallback: true,
      fallbackReason: r.reason || "unknown",
      message:
        "这条命令需要 PowerShell 语义（" +
        (r.reason || "unknown") +
        "），快速通道已拒绝执行而不是硬跑。请改用内置 Bash 工具重跑相同命令，不要在本工具重试。",
    });
  }

  return Object.assign(base, {
    fallback: false,
    message: base.ok
      ? "执行成功。"
      : "执行失败，退出码 " + base.exitCode + "。",
  });
}

function isTransportError(err) {
  const m = (err && err.message) || "";
  return /EPIPE|ECONNRESET|ERR_STREAM_DESTROYED|守护进程退出|启动超时/.test(m);
}

/** 执行单条命令（含传输故障重试）。timings 以本条命令起点计，批量时各条独立。 */
async function runOne(command, cwd, timeoutMs, cwdMs) {
  const t0 = performance.now();
  // 传输层故障（daemon 被杀、管道断开）时清理并重试一次，
  // startDaemon 会自动把 daemon 拉起来；其余错误直接回退给内置 Bash。
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await startDaemon();
      const r = await send({ command, cwd, timeoutMs }, timeoutMs);
      return formatResult(r, command, {
        pluginMs: round2(performance.now() - t0),
        cwdMs,
        daemonMs: typeof r.durationMs === "number" ? r.durationMs : null,
      });
    } catch (err) {
      if (attempt === 0 && isTransportError(err)) {
        proc = null;
        starting = null;
        continue;
      }
      const reason = err && err.message ? err.message : String(err);
      return {
        command,
        ok: false,
        timings: {
          pluginMs: round2(performance.now() - t0),
          cwdMs,
          daemonMs: null,
        },
        fallback: true,
        fallbackReason: "daemon_unavailable",
        message:
          "快速通道当前不可用（" +
          reason +
          "）。请改用内置 Bash 工具执行这条命令。",
      };
    }
  }
  // 理论不可达
  return {
    command,
    ok: false,
    fallback: true,
    fallbackReason: "daemon_unavailable",
    message: "快速通道当前不可用。请改用内置 Bash 工具执行这条命令。",
  };
}

async function executeFastsh(args) {
  const t0 = performance.now();
  const rawBatch = args && Array.isArray(args.commands) ? args.commands : null;
  const single = args && typeof args.command === "string" ? args.command.trim() : "";

  // commands 优先于 command；两者都缺则回退
  let list;
  let isBatch = false;
  if (rawBatch && rawBatch.length) {
    list = rawBatch.map((c) => (typeof c === "string" ? c.trim() : "")).filter(Boolean);
    isBatch = true;
    if (!list.length) {
      return {
        ok: false,
        fallback: true,
        fallbackReason: "empty_command",
        message: "commands 数组里没有有效命令。请改用内置 Bash 工具。",
      };
    }
    if (list.length > MAX_BATCH) {
      return {
        ok: false,
        fallback: true,
        fallbackReason: "batch_too_large",
        message: "批量一次最多 " + MAX_BATCH + " 条命令（收到 " + list.length + " 条）。请拆成多次调用。",
      };
    }
  } else if (single) {
    list = [single];
  } else {
    return {
      ok: false,
      fallback: true,
      fallbackReason: "empty_command",
      message: "缺少 command 或 commands 参数。请改用内置 Bash 工具。",
    };
  }

  const tCwd = performance.now();
  const cwd = await resolveCwd(args && args.cwd);
  const cwdMs = round2(performance.now() - tCwd);
  const timeoutMs = normalizeTimeout(args && args.timeoutMs);

  if (!isBatch) {
    return runOne(list[0], cwd, timeoutMs, cwdMs);
  }

  // 批量：顺序执行（保持命令间顺序语义），一次工具调用摊薄宿主地板与模型轮次
  const results = [];
  for (const cmd of list) {
    results.push(await runOne(cmd, cwd, timeoutMs, cwdMs));
  }
  const okCount = results.filter((r) => r.ok).length;
  return {
    ok: okCount === results.length,
    batch: true,
    count: results.length,
    okCount,
    results,
    timings: { pluginMs: round2(performance.now() - t0), cwdMs },
    message:
      "批量执行 " + results.length + " 条命令，" + okCount + " 条成功。各条结果按顺序在 results 数组中。",
  };
}

/* -------------------------------------------------------------------- 生命周期 */

async function onLoad() {
  await pi.agent.registerTool({
    name: "fastsh_run",
    description:
      "Run a POSIX shell command through the embedded fast interpreter (mvdan.cc/sh v3) in a resident daemon. " +
      "Use this instead of the Bash tool for lightweight commands: it costs tens of milliseconds end-to-end instead of the ~400ms a PowerShell cold start takes, " +
      "and it ships 29 native coreutils (ls/cat/cp/mv/rm/mkdir/touch/wc/head/tail/grep/sed/sort/uniq/find/stat/env/dirname/basename/tr/sleep/date/seq). " +
      "Write native POSIX syntax with forward-slash paths. " +
      "Output up to 8MB is returned safely (larger output is truncated with a note, never hangs). " +
      "It runs in the current workspace root by default, same as the Bash tool. " +
      "If the result has fallback=true, do NOT retry here: call the Bash tool instead, because this command was refused as needing PowerShell semantics " +
      "(reasons: pwsh_env_var, pwsh_cmdlet, pwsh_param, pwsh_operator, pwsh_script, pwsh_array, pwsh_block, win_backslash_path, win_relative_path, posix_parse_error, command_not_found, cwd_not_found, daemon_unavailable). " +
      "Prefer this tool for read-only inspection (ls, cat, grep, find, wc, head, tail, stat, pwd) and simple pipelines; " +
      "use the Bash tool for anything touching PowerShell, cmdlets, .ps1 scripts, Windows backslash paths, or long-running builds. " +
      "To batch several quick commands in ONE call, pass `commands` (array of strings, up to 20): they run sequentially " +
      "in order and each result comes back in `results[]` with its own stdout/exitCode — use this to save round-trips. " +
      "Batched commands do NOT short-circuit on failure: if one fails the rest still run (see okCount), so send " +
      "commands one at a time when a later command depends on an earlier one's success.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "A single POSIX command, e.g. 'ls -la' or 'cat package.json | head -20'. Use forward-slash paths and POSIX syntax. Provide either command or commands.",
        },
        commands: {
          type: "array",
          items: { type: "string" },
          description:
            "Batch of POSIX commands (max 20) run sequentially in one call; results return in results[] in order. Use instead of command for multiple quick inspections. Batched commands do NOT short-circuit on failure: if one fails the rest still run (see okCount); send them one at a time when a later command depends on an earlier one's success.",
        },
        cwd: {
          type: "string",
          description: "Optional working directory. Defaults to the current workspace root.",
        },
        timeoutMs: {
          type: "number",
          description: "Optional per-command timeout in milliseconds (1000-600000). Defaults to 60000.",
        },
      },
      required: [],
    },
    execute: executeFastsh,
  });

  // 预热：插件加载时就拉起 daemon，避免第一次工具调用付启动成本
  startDaemon().catch(() => {});
}

async function onUnload() {
  try {
    await pi.agent.unregisterTool("fastsh_run");
  } catch {
    /* 宿主可能已经卸载 */
  }

  const child = proc;
  proc = null;
  starting = null;
  failAll(new Error("插件已卸载"));

  if (child && !child.killed) {
    try {
      child.stdin.write(JSON.stringify({ id: ++reqId, shutdown: true }) + "\n");
    } catch {
      /* 管道可能已断开 */
    }
    try {
      child.kill();
    } catch {
      /* 进程可能已退出 */
    }
  }
}

module.exports = {
  onLoad,
  onUnload,
  // 导出纯函数供单元测试直接断言，不依赖宿主环境。
  // daemonPid 让测试能精确杀掉自己那份 daemon，而不是用 taskkill /IM 误杀宿主里的。
  __test: {
    normalizeTimeout,
    formatResult,
    resolveCwd,
    DAEMON_PATH,
    daemonPid: () => (proc && proc.pid ? proc.pid : null),
  },
};
