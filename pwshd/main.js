"use strict";

/**
 * local.pwshd —— 常驻 PowerShell 快速通道
 *
 * 通过 stdio 上的逐行协议驱动一个常驻的 pwsh 进程（server.ps1）。
 * 目的：消掉每次 Bash 调用约 249ms 的 pwsh 冷启动，把轻量 PowerShell 命令从 ~443ms 降到 ~60ms。
 *
 * 设计约束：
 * - 每条命令在独立 Runspace 中执行，状态隔离，等价于"每次新开 pwsh -NoProfile"；
 * - daemon 侧是 Runspace 并发池（server.ps1 -Workers），并发工具调用不再排队；
 * - 任何 daemon 侧故障都不阻塞 Agent，一律返回 fallback=true 让它改用内置 Bash；
 * - 每命令超时由 worker 自行收口（exitCode=124）；插件侧杀进程重建仅作最后兜底；
 * - 本插件不读项目文件、不联网、不碰凭据。
 */

const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");

const SERVER_PATH = path.join(__dirname, "server.ps1");
const PWSH_EXE = "pwsh";
const PWSH_WORKERS = 4;
const PWSH_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SERVER_PATH, "-Workers", String(PWSH_WORKERS)];

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 600000;
const MIN_TIMEOUT_MS = 1000;
const START_TIMEOUT_MS = 15000;
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
  // 诊断插桩：把"请求写入 → 收到响应行"的 IPC 往返耗时回传给 execute 层，
  // 用于分解并发场景下 pluginMs 与 daemonMs 之间的缺口。定位后可移除。
  if (typeof p.writeAt === "number") {
    msg.ipcMs = round2(performance.now() - p.writeAt);
  }
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
      child = spawn(PWSH_EXE, PWSH_ARGS, {
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
      failAll(new Error("pwshd 守护进程退出 code=" + code));
    });

    child.on("spawn", () => finish());

    readline.createInterface({ input: child.stdout }).on("line", dispatch);
    // daemon 的 stderr 只是诊断噪声，丢弃以免污染宿主日志
    child.stderr.on("data", () => {});
    // 必须吸收 stdin 的 error：daemon 被杀后写管道会抛 EPIPE，
    // 没有 handler 会变成未捕获的 'error' 事件把整个插件进程打崩。
    child.stdin.on("error", () => {});

    setTimeout(() => finish(new Error("pwshd 守护进程启动超时")), START_TIMEOUT_MS);
  });

  return starting;
}

function encodeRequest(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64") + "\n";
}

function send(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!proc || proc.killed) {
      reject(new Error("pwshd 守护进程不可用"));
      return;
    }
    const id = ++reqId;
    // 比命令超时多留 5s 余量：worker 会先在超时点自行收口（124）；
    // 走到这里说明 worker 也卡住了，只能杀掉整个 daemon 重建（最后兜底）。
    const timer = setTimeout(() => {
      pending.delete(id);
      killDaemon();
      reject(new Error("pwshd 请求超时（" + timeoutMs + "ms）"));
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
      // 诊断插桩：记录请求写入管道的时刻，供 dispatch 计算 IPC 往返 ipcMs
      writeAt: performance.now(),
    });

    try {
      proc.stdin.write(encodeRequest(Object.assign({ id }, request)));
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(err);
    }
  });
}

function killDaemon() {
  const child = proc;
  proc = null;
  starting = null;
  failAll(new Error("pwshd 守护进程已终止"));
  if (child && !child.killed) {
    try {
      child.kill();
    } catch {
      /* 进程可能已退出 */
    }
  }
}

/* ------------------------------------------------------------------ 工具执行 */

/**
 * 解析工作目录。宿主不同版本的 workspace API 形状不一致，这里按可能性依次尝试，
 * 全部拿不到才退回插件进程 cwd。
 *
 * 必须拿到真实工作区：拿不到就退回 process.cwd()，那是 PI-Desktop 安装目录，
 * 结果 Relative 路径的 Remove-Item / Copy-Item 会打在安装目录里。
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
    durationMs: typeof r.durationMs === "number" ? r.durationMs : null,
    // 自计时口径：pluginMs=execute 全流程；cwdMs=resolveCwd 耗时；daemonMs=server.ps1 内 durationMs。
    // 宿主级计时受并发归因污染，这组字段不依赖宿主日志，可直接做 IPC 分解：
    // pluginMs − daemonMs ≈ IPC + cwd 解析 + 响应序列化等插件侧开销。
    timings: timings || null,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
  };

  if (r.explicitExit === true) {
    base.note =
      "命令里包含 exit，Runspace 管道被提前终止，具体退出码无法透传（已按 1 上报）。需要精确退出码时请改用内置 Bash。";
  }

  if (r.fallback) {
    return Object.assign(base, {
      fallback: true,
      fallbackReason: r.reason || "unknown",
      message:
        "这条命令没能走常驻通道（" +
        (r.reason || "unknown") +
        "），没有执行。请改用内置 Bash 工具重跑相同命令，不要在本工具重试。",
    });
  }

  return Object.assign(base, {
    fallback: false,
    message: base.ok ? "执行成功。" : "执行失败，退出码 " + base.exitCode + "。",
  });
}

function isTransportError(err) {
  const m = (err && err.message) || "";
  return /EPIPE|ECONNRESET|ERR_STREAM_DESTROYED|守护进程退出|启动超时|不可用/.test(m);
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
        // ipcMs=请求写入管道到收到响应行的往返（含 daemon 读取排队），诊断插桩字段
        ipcMs: typeof r.ipcMs === "number" ? r.ipcMs : null,
      });
    } catch (err) {
      if (attempt === 0 && isTransportError(err)) {
        killDaemon();
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
          "常驻 PowerShell 通道当前不可用（" + reason + "）。请改用内置 Bash 工具执行这条命令。",
      };
    }
  }

  // 理论上不可达
  return {
    command,
    ok: false,
    fallback: true,
    fallbackReason: "daemon_unavailable",
    message: "常驻 PowerShell 通道当前不可用。请改用内置 Bash 工具执行这条命令。",
  };
}

async function executePwsh(args) {
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
    name: "pwsh_run",
    description:
      "Run a PowerShell command in a resident daemon instead of spawning pwsh each time. " +
      "This is the fast lane for PowerShell: it costs about 60ms instead of the ~440ms a fresh " +
      "`pwsh -NoProfile -NonInteractive -Command` start takes, so it is roughly 7-10x faster for short commands. " +
      "It is a drop-in replacement for the Bash tool on this Windows host: same PowerShell syntax, same " +
      "exit-code semantics ($? based, matching `pwsh -Command`), same working directory (the workspace root). " +
      "Each command runs in a fresh Runspace, so variables/functions do NOT leak between calls — behaviour " +
      "matches a new pwsh process. The daemon runs a pool of workers, so concurrent calls execute in parallel. " +
      "To batch several quick commands in ONE call, pass `commands` (array of strings, up to 20): they run " +
      "sequentially in order and each result comes back in `results[]` with its own stdout/exitCode — use this " +
      "for multiple independent inspections to save round-trips. Batched commands do NOT short-circuit on " +
      "failure: if one fails the rest still run (see okCount), so send commands one at a time when a later " +
      "command depends on an earlier one's success. " +
      "Use it for: Get-ChildItem, Select-Object, Where-Object, ForEach-Object, Get-Content, Test-Path, " +
      "Get-Item, $env: reads, and ordinary native commands (git/node/cmd). " +
      "Use the Bash tool instead for: commands whose exit code must be exactly propagated (this tool maps " +
      "`exit N` to 1), long builds and test suites (npm/go/cargo/msbuild), and anything interactive. " +
      "If the result has fallback=true, do NOT retry here: call the Bash tool instead.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "A single PowerShell command, e.g. 'Get-ChildItem -File | Select-Object -First 5'. Same syntax as the Bash tool. Provide either command or commands.",
        },
        commands: {
          type: "array",
          items: { type: "string" },
          description:
            "Batch of PowerShell commands (max 20) run sequentially in one call; results return in results[] in order. Use instead of command for multiple quick inspections. Each command still runs in a fresh isolated Runspace. Batched commands do NOT short-circuit on failure: if one fails the rest still run (see okCount); send them one at a time when a later command depends on an earlier one's success.",
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
    execute: executePwsh,
  });

  // 预热：插件加载时就拉起 daemon，避免第一次工具调用付启动成本
  startDaemon().catch(() => {});
}

async function onUnload() {
  try {
    await pi.agent.unregisterTool("pwsh_run");
  } catch {
    /* 宿主可能已经卸载 */
  }

  const child = proc;
  proc = null;
  starting = null;
  failAll(new Error("插件已卸载"));

  if (child && !child.killed) {
    try {
      child.stdin.write(encodeRequest({ id: ++reqId, shutdown: true }));
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
    SERVER_PATH,
    PWSH_ARGS,
    daemonPid: () => (proc && proc.pid ? proc.pid : null),
  },
};
