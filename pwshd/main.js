"use strict";

const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");
const [tool] = require("./manifest.json").contributes.agentTools;

const SERVER_PATH = path.join(__dirname, "server.ps1");
const PWSH_WORKERS = 4;
const PWSH_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SERVER_PATH, "-Workers", String(PWSH_WORKERS)];
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 600000;
const MAX_BATCH_TIMEOUT_MS = 90000;
const START_TIMEOUT_MS = 15000;
const MAX_BATCH = 20;
const OUTPUT_LIMIT = 8 * 1024 * 1024;
const round2 = (n) => Math.round(n * 100) / 100;

let daemon = null;
let unloaded = true;
let reqId = 0;

function buildSpawnEnv(env, platform = process.platform) {
  if (platform !== "win32") return env;
  const childEnv = { ...env };
  // Node 在 Windows 上对同名大小写键只传递字典序第一个；修补同一个键。
  const key = (name) => Object.keys(childEnv).sort().find((k) => k.toUpperCase() === name.toUpperCase());
  const extKey = key("PATHEXT") || "PATHEXT";
  const old = childEnv[extKey] || "";
  const ext = new Set(old.split(";").map((s) => s.trim().toUpperCase()));
  const missing = [".EXE", ".COM", ".BAT", ".CMD"].filter((s) => !ext.has(s));
  if (missing.length) childEnv[extKey] = [old, ...missing].filter(Boolean).join(";");

  const comKey = key("ComSpec") || "ComSpec";
  const rootPath = childEnv[key("SystemRoot")];
  // 只使用调用方原有的本机 SystemRoot，不猜测 Windows 装在哪，也不从 PATH 查找 cmd。
  const localRoot = /^[a-z]:[\\/]/i.test(rootPath || "") && !/[<>:"|?*\x00-\x1f]|(?:^|[\\/])\.{1,2}(?:[\\/]|$)/.test(rootPath.slice(2));
  if (!childEnv[comKey]?.trim() && localRoot) {
    childEnv[comKey] = path.win32.join(rootPath, "System32", "cmd.exe");
  }
  return childEnv;
}

function retire(state, error, kill = true) {
  if (state.closed) return;
  state.closed = true;
  if (daemon === state) daemon = null;
  clearTimeout(state.timer);
  state.rejectReady(error);
  for (const p of state.pending.values()) p.finish(error);
  if (kill && !state.child.killed) {
    try { state.child.kill(); } catch { /* 进程可能已退出 */ }
  }
}

function startDaemon() {
  if (daemon && (daemon.child.exitCode !== null || daemon.child.signalCode !== null)) {
    retire(daemon, new Error("pwshd 守护进程已经退出"), false);
  }
  if (daemon) return daemon.ready;
  if (unloaded) return Promise.reject(new Error("插件已卸载"));
  let child;
  try {
    child = spawn("pwsh", PWSH_ARGS, {
      env: buildSpawnEnv(process.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (err) {
    return Promise.reject(err);
  }
  const state = { child, pending: new Map(), closed: false };
  state.ready = new Promise((resolve, reject) => {
    state.resolveReady = resolve;
    state.rejectReady = reject;
  });
  daemon = state;
  state.timer = setTimeout(() => retire(state, new Error("pwshd 守护进程启动超时")), START_TIMEOUT_MS);
  const ioError = (err) => retire(state, err);
  child.on("error", ioError);
  child.stdin.on("error", ioError);
  child.stdout.on("error", ioError);
  child.stderr.on("error", ioError);
  child.stderr.resume();
  child.on("close", (code, signal) => retire(state, new Error(`pwshd 守护进程退出 (${signal || code})`), false));
  // stdout 已读取到 EOF 后，不会再有完整协议响应，即使子进程或其他管道尚未关闭。
  const reader = readline.createInterface({ input: child.stdout });
  reader.on("error", ioError);
  reader.on("close", () => retire(state, new Error("pwshd 响应管道已关闭")));
  reader.on("line", (line) => {
    if (state.closed) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg?.ready === true) {
      clearTimeout(state.timer);
      state.resolveReady(state);
      return;
    }
    const pending = state.pending.get(msg?.id);
    if (!pending || !["not_started", "finished"].includes(msg.status)) return;
    msg.ipcMs = round2(performance.now() - pending.writeAt);
    pending.finish(null, msg);
  });
  return state.ready;
}

const encode = (request) => Buffer.from(JSON.stringify(request), "utf8").toString("base64") + "\n";
const stopReason = (ctl) => ctl.signal?.aborted ? "cancelled" : Date.now() >= ctl.deadline ? "batch_timeout" : null;

// 取消/总截止只停止等待及新提交；已写入的请求可能继续执行，绝不能建议重跑。
function watchStop(ctl, callback) {
  const abort = () => callback("cancelled");
  ctl.signal?.addEventListener("abort", abort, { once: true });
  const timer = Number.isFinite(ctl.deadline)
    ? setTimeout(() => callback("batch_timeout"), Math.max(0, ctl.deadline - Date.now())) : null;
  return () => {
    clearTimeout(timer);
    ctl.signal?.removeEventListener("abort", abort);
  };
}

const STOPPED = Symbol("stopped");
async function untilStopped(promise, ctl) {
  // 即使建立 promise 后刚好到达截止，也要消费它随后可能抛出的错误。
  if (stopReason(ctl)) {
    promise.catch(() => {});
    return STOPPED;
  }
  let unwatch;
  const stopped = new Promise((resolve) => { unwatch = watchStop(ctl, () => resolve(STOPPED)); });
  try { return await Promise.race([promise, stopped]); } finally { unwatch(); }
}

function send(state, request, ctl) {
  const reason = stopReason(ctl);
  if (reason) return Promise.resolve({ status: "not_started", reason });
  if (state.closed || state.child.exitCode !== null || state.child.signalCode !== null || !state.child.stdin.writable) {
    const err = new Error("pwshd 守护进程不可用（尚未发送）");
    retire(state, err);
    return Promise.resolve({ status: "not_started", reason: "daemon_unavailable", detail: err.message });
  }
  const id = ++reqId;
  const line = encode({ id, ...request });
  // 编码也可能花时间；在真正写入之前再检查一次。
  if (stopReason(ctl)) return Promise.resolve({ status: "not_started", reason: stopReason(ctl) });
  return new Promise((resolve) => {
    const unknown = (cause, err) => ({ status: "unknown", reason: cause, detail: err?.message });
    const watchdog = new Error("pwshd 传输层未收到命令结果（请求超时）");
    const timer = setTimeout(() => retire(state, watchdog), request.timeoutMs + 5000);
    const unwatch = watchStop(ctl, (cause) => {
      // 调用者已返回，但保留传输看门狗，避免停止不响应的 Runspace 后池永久损失 worker。
      unwatch();
      resolve(unknown(cause));
    });
    function finish(err, result) {
      if (!state.pending.delete(id)) return;
      clearTimeout(timer);
      unwatch();
      resolve(err ? unknown(err === watchdog ? "transport_timeout" : "transport_error", err) : result);
    }
    state.pending.set(id, { finish, writeAt: performance.now() });
    // 从尝试写入起，连 EPIPE 也不能证明命令未被接收。
    try { state.child.stdin.write(line, (err) => { if (err) retire(state, err); }); }
    catch (err) { retire(state, err); }
  });
}

function isFullPath(value) {
  if (process.platform !== "win32") return path.isAbsolute(value);
  return /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(value);
}

async function resolveCwd(requested) {
  const value = typeof requested === "string" ? requested.trim() : "";
  if (value && isFullPath(value)) return path.normalize(value);
  // Windows 的 \foo、C:foo 依赖隐式驱动器状态，不是真正的相对目录。
  if (value && process.platform === "win32" && /^(?:[\\/]|[a-z]:)/i.test(value)) return null;

  const ws = globalThis.pi?.workspace;
  if (!ws) return null;
  const pick = (v) => {
    const candidates = typeof v === "string" ? [v] : ["root", "path", "directory", "cwd", "workspaceRoot", "rootPath"].map((k) => v?.[k]);
    return candidates.find((s) => typeof s === "string" && isFullPath(s.trim()))?.trim();
  };
  for (const method of ["get", "getActive", "current", "resolve"]) {
    try {
      if (typeof ws[method] !== "function") continue;
      const root = pick(await ws[method]());
      if (root) return path.resolve(root, value);
    } catch { /* 尝试下一个工作区 API */ }
  }
  const root = pick(ws);
  return root ? path.resolve(root, value) : null;
}

function normalizeTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(n), 1000), MAX_TIMEOUT_MS);
}

function formatResult(r, command, timings) {
  const status = r.status;
  const skipped = status === "not_started" && ["cancelled", "batch_timeout", "request_timeout"].includes(r.reason);
  const fallback = status === "not_started" && !skipped;
  const ok = status === "finished" && r.ok === true;
  const exitCode = typeof r.exitCode === "number" ? r.exitCode : null;
  const base = {
    command, status, ok, exitCode, fallback,
    durationMs: typeof r.durationMs === "number" ? r.durationMs : null,
    timings: timings || null,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
    stdoutTruncated: r.stdoutTruncated === true,
    stderrTruncated: r.stderrTruncated === true,
  };
  base.outputTruncated = base.stdoutTruncated || base.stderrTruncated;
  if (r.reason) base.reason = r.reason;
  if (r.detail) base.detail = r.detail;
  if (r.explicitExit === true) {
    base.explicitExit = true;
    base.note = "检测到 exit；Runspace 不透传其精确退出码，按 1 上报。需要精确退出码时用内置 Bash。";
  }
  if (fallback) {
    base.fallbackReason = r.reason;
    base.message = ["cwd_unresolved", "cwd_invalid"].includes(r.reason)
      ? "未执行：无法在指定目录运行。请确认目录存在并提供绝对 cwd，或确认目录后改用内置 Bash。"
      : `命令未开始（${r.reason}）；如需执行，可改用内置 Bash。`;
  } else if (skipped) {
    base.skipped = true;
    base.message = {
      cancelled: "已取消，命令未开始。",
      batch_timeout: "已到批量总截止时间，命令未开始。",
      request_timeout: "请求已过执行时限，命令未开始。",
    }[r.reason];
  } else if (status === "unknown") {
    base.message = `命令已提交，但结果未知（${r.reason}）；可能已经执行。不要自动重跑，请先核对状态。`;
  } else {
    base.message = ok ? "执行成功。" : `执行失败，退出码 ${exitCode}。`;
  }
  return base;
}

async function runOne(command, cwd, timeoutMs, cwdMs, ctl, outputLimitBytes) {
  const t0 = performance.now();
  let result;
  try {
    const reason = stopReason(ctl);
    if (reason) return formatResult({ status: "not_started", reason }, command);
    const state = await untilStopped(startDaemon(), ctl);
    if (state === STOPPED) return formatResult({ status: "not_started", reason: stopReason(ctl) }, command);
    const now = Date.now();
    result = await send(state, {
      command, cwd, timeoutMs, outputLimitBytes,
      deadlineMs: Math.min(now + timeoutMs + 5000, ctl.deadline),
      ...(Number.isFinite(ctl.deadline) && { batchDeadlineMs: ctl.deadline }),
    }, ctl);
  } catch (err) {
    result = { status: "not_started", reason: stopReason(ctl) || "daemon_unavailable", detail: err.message };
  }
  return formatResult(result, command, {
    pluginMs: round2(performance.now() - t0), cwdMs,
    daemonMs: result.durationMs ?? null, ipcMs: result.ipcMs ?? null,
  });
}

async function executePwsh(args, ctx) {
  const t0 = performance.now();
  const start = Date.now();
  const isBatch = Array.isArray(args?.commands);
  const single = typeof args?.command === "string" ? args.command.trim() : "";
  const list = isBatch ? Array.from(args.commands) : [single];
  const invalid = isBatch && list.length > MAX_BATCH ? "batch_too_large"
    : !list.length || list.some((cmd) => typeof cmd !== "string" || !cmd.trim()) ? "empty_command" : null;
  if (invalid) return formatResult({ status: "not_started", reason: invalid }, single);

  const batchTimeout = args?.batchTimeoutMs;
  const batchBudget = Number.isFinite(batchTimeout) && batchTimeout > 0
    ? Math.min(Math.max(Math.round(batchTimeout), 1), MAX_BATCH_TIMEOUT_MS) : MAX_BATCH_TIMEOUT_MS;
  const ctl = {
    signal: ctx?.signal ?? ctx?.abortSignal,
    deadline: isBatch ? start + batchBudget : Infinity,
  };
  const tCwd = performance.now();
  let cwd = null;
  if (!stopReason(ctl)) {
    try { cwd = await untilStopped(resolveCwd(args?.cwd), ctl); } catch { /* 无法解析 */ }
  }
  const cwdMs = round2(performance.now() - tCwd);
  const early = stopReason(ctl) || (!cwd ? "cwd_unresolved" : null);
  const timeoutMs = normalizeTimeout(args?.timeoutMs);
  const run = (command, budget) => early
    ? Promise.resolve(formatResult({ status: "not_started", reason: early }, command))
    : runOne(command, cwd, timeoutMs, cwdMs, ctl, budget);
  if (!isBatch) return run(single, OUTPUT_LIMIT);

  const parallel = args?.parallel === true;
  const results = new Array(list.length);
  let next = 0;
  let remaining = OUTPUT_LIMIT;
  // 并发时按输入顺序分配固定份额，以便在 daemon 聚合/序列化之前约束该批总量；
  // 顺序模式可把前一条未使用的预算交给后续命令。
  const share = Math.floor(OUTPUT_LIMIT / list.length);
  async function lane() {
    while (next < list.length && !stopReason(ctl)) {
      const i = next++;
      const budget = parallel ? share + (i < OUTPUT_LIMIT % list.length ? 1 : 0) : remaining;
      const result = await run(list[i].trim(), budget);
      results[i] = result;
      if (!parallel) {
        remaining = Math.max(0, remaining - Buffer.byteLength(result.stdout) - Buffer.byteLength(result.stderr));
      }
    }
  }
  await Promise.all(Array.from({ length: parallel ? Math.min(PWSH_WORKERS, list.length) : 1 }, lane));
  for (; next < list.length; next++) {
    results[next] = formatResult({ status: "not_started", reason: stopReason(ctl) }, list[next].trim());
  }
  const okCount = results.filter((r) => r.ok).length;
  const skippedCount = results.filter((r) => r.skipped).length;
  const unknownCount = results.filter((r) => r.status === "unknown").length;
  return {
    ok: okCount === results.length, batch: true, count: results.length, okCount, skippedCount, unknownCount, results,
    outputTruncated: results.some((r) => r.outputTruncated),
    timings: { pluginMs: round2(performance.now() - t0), cwdMs },
    message: `批量共 ${results.length} 条，成功 ${okCount} 条，跳过 ${skippedCount} 条，结果未知 ${unknownCount} 条；结果按输入顺序排列。`,
  };
}

async function onLoad() {
  await pi.agent.registerTool({ ...tool, execute: executePwsh });
  unloaded = false;
  startDaemon().catch(() => {});
}

async function onUnload() {
  unloaded = true;
  if (daemon) retire(daemon, new Error("插件已卸载"));
  try { await pi.agent.unregisterTool(tool.name); } catch { /* 宿主可能已经卸载 */ }
}

module.exports = {
  onLoad, onUnload,
  __test: { buildSpawnEnv, normalizeTimeout, formatResult, resolveCwd, SERVER_PATH, PWSH_ARGS,
    daemonPid: () => daemon?.child.pid ?? null },
};
