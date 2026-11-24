"use strict";

const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const { contributes } = require("./manifest.json");

const DAEMON_PATH = path.join(__dirname, "bin", "fastsh.exe");
const DEFAULT_TIMEOUT_MS = 60000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 600000;
const MAX_BATCH_TIMEOUT_MS = 90000;
const BATCH_DISPATCH_MARGIN_MS = 15;
const MAX_BATCH = 20;
const MAX_BATCH_OUTPUT = 8 * 1024 * 1024;
let daemon;
let reqId = 0;
let loaded = false;

function stopDaemon(state, error, kill = true) {
  if (daemon === state) daemon = undefined;
  state.finishStart(error);
  for (const complete of state.pending.values()) complete(error);
  if (kill && !state.child.killed && state.child.exitCode === null) {
    try { state.child.kill(); } catch { /* 进程已退出 */ }
  }
}

function startDaemon() {
  if (!loaded) throw new Error("插件未加载");
  if (daemon && !daemon.child.killed && daemon.child.exitCode === null && daemon.child.signalCode === null) return daemon.ready;
  const child = spawn(DAEMON_PATH, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const state = { child, pending: new Map() };
  daemon = state;
  state.ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => stopDaemon(state, new Error("fastsh 守护进程启动超时")), 10000);
    state.finishStart = (error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(state);
    };
  });
  child.once("spawn", () => state.finishStart());
  child.on("error", (error) => stopDaemon(state, error));
  child.once("close", (code) => stopDaemon(state, new Error(`fastsh 守护进程退出 (${code})`), false));
  child.stdin.on("error", (error) => stopDaemon(state, error));
  child.stderr.resume();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let result;
    try { result = JSON.parse(line); } catch { return; }
    if (result && Number.isSafeInteger(result.id)) state.pending.get(result.id)?.(null, result);
  });
  return state.ready;
}

function send(state, request, waitMs, signal, limitedByBatch) {
  return new Promise((resolve, reject) => {
    const id = ++reqId;
    let batchTimer;
    const stopWaiting = (error) => {
      // 保留看门狗，避免被取消的命令永久占住串行 daemon。
      clearTimeout(batchTimer);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    const onAbort = () => stopWaiting(new Error("工具调用已取消"));
    const timer = setTimeout(() => stopDaemon(state, new Error("等待 fastsh 响应超时")), request.timeoutMs + 5000);
    const complete = (error, result) => {
      state.pending.delete(id);
      clearTimeout(timer);
      clearTimeout(batchTimer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result);
    };
    if (limitedByBatch) batchTimer = setTimeout(() => stopWaiting(new Error("已到批量总截止时间")), waitMs);
    state.pending.set(id, complete);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      state.child.stdin.write(JSON.stringify({ id, ...request }) + "\n", (error) => {
        if (error) stopDaemon(state, error);
      });
    } catch (error) {
      stopDaemon(state, error);
    }
  });
}

function isAbsolute(p) {
  return path.isAbsolute(p) && (process.platform !== "win32" || /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(p));
}

async function resolveCwd(requested) {
  const target = typeof requested === "string" ? requested.trim() : "";
  if (isAbsolute(target)) return path.normalize(target);
  if (process.platform === "win32" && /^(?:[a-z]:|[\\/])/i.test(target)) return null;
  const ws = globalThis.pi?.workspace;
  const pick = (v) => {
    const roots = typeof v === "string" ? [v] : [v?.root, v?.path, v?.directory, v?.cwd, v?.workspaceRoot, v?.rootPath];
    const root = roots.find((p) => typeof p === "string" && isAbsolute(p.trim()));
    return root ? path.resolve(root.trim(), target) : null;
  };
  for (const name of ["get", "getActive", "current", "resolve"]) {
    if (typeof ws?.[name] !== "function") continue;
    try {
      const cwd = pick(await ws[name]());
      if (cwd) return cwd;
    } catch { /* 尝试其他宿主 API */ }
  }
  return pick(ws);
}

function normalizeTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(n), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}
const round2 = (n) => Math.round(n * 100) / 100;

function notStarted(command, reason, message, fallback = true) {
  return { command, ok: false, executionState: "not_started", fallback, reason, ...(fallback ? { fallbackReason: reason } : {}), message };
}

function formatResult(r, command, timings) {
  const state = r.executionState || (r.fallback ? "not_started" : "finished");
  const fallback = state === "not_started" && r.fallback === true;
  const reason = r.reason || undefined;
  return {
    command,
    ok: r.ok === true,
    exitCode: state === "unknown" ? null : r.exitCode ?? null,
    executionState: state,
    fallback,
    ...(reason ? { reason } : {}),
    ...(fallback ? { fallbackReason: reason } : {}),
    timings,
    durationMs: r.durationMs ?? null,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    ...(r.stdoutTruncated ? { stdoutTruncated: true } : {}),
    ...(r.stderrTruncated ? { stderrTruncated: true } : {}),
    message: state === "unknown" ? "执行结果未知，请先核对副作用，不要自动重跑。"
      : fallback ? `命令未执行（${reason}）。请根据原因选择执行通道或修正工作目录。`
      : state === "not_started" ? `命令未开始（${reason}）。`
      : r.ok ? "执行成功。" : `执行失败，退出码 ${r.exitCode}。`,
  };
}

async function runOne(command, cwd, timeoutMs, cwdMs, signal, deadline = 0, outputLimit) {
  const t0 = performance.now();
  // 给系统时钟取整和定时器调度留少量余量；临近截止不开始新命令。
  const stopped = () => signal?.aborted ? "cancelled"
    : deadline && deadline - Date.now() <= BATCH_DISPATCH_MARGIN_MS ? "batch_deadline" : null;
  const skip = (reason) => notStarted(command, reason, "命令未提交：工具已取消或批量已到截止时间。", false);
  let state;
  let reason = stopped();
  if (reason) return skip(reason);
  try { state = await startDaemon(); }
  catch (error) {
    reason = stopped();
    if (reason) return skip(reason);
    return notStarted(command, "daemon_unavailable", `无法启动 fastsh（${error.message}）。命令未发出。`);
  }
  reason = stopped();
  if (reason) return skip(reason);
  if (daemon !== state || !state.child.stdin.writable || state.child.exitCode !== null || state.child.signalCode !== null) {
    return notStarted(command, "daemon_unavailable", "守护进程不可用，命令未发出。");
  }
  const expiresAt = Math.min(Date.now() + timeoutMs + 1000, deadline || Infinity);
  const remaining = deadline ? deadline - Date.now() : Infinity;
  const limitedByBatch = remaining <= timeoutMs + 5000;
  try {
    const r = await send(state, { command, cwd, timeoutMs, expiresAt, outputLimit }, Math.max(1, remaining), signal, limitedByBatch);
    return formatResult(r, command, { pluginMs: round2(performance.now() - t0), cwdMs, daemonMs: r.durationMs ?? null });
  } catch (error) {
    return formatResult({ executionState: "unknown", reason: stopped() || "response_lost", stderr: error.message }, command,
      { pluginMs: round2(performance.now() - t0), cwdMs, daemonMs: null });
  }
}

// 批量按输入顺序扣减预算，不在 UTF-8 字符中间截断。
function capBatchResult(result, budget) {
  for (const key of ["stdout", "stderr"]) {
    const text = result[key] || "";
    const bytes = Buffer.byteLength(text);
    if (bytes <= budget) { budget -= bytes; continue; }
    const data = Buffer.from(text);
    let end = budget;
    while (end > 0 && (data[end] & 0xc0) === 0x80) end--;
    result[key] = data.subarray(0, end).toString();
    result[`${key}Truncated`] = true;
    budget = 0;
  }
  return budget;
}

async function executeFastsh(args, context) {
  const t0 = performance.now();
  const signal = context?.signal;
  const isBatch = Array.isArray(args?.commands) && args.commands.length > 0;
  const list = isBatch ? args.commands : [args?.command];
  if (list.length > MAX_BATCH) return notStarted(undefined, "batch_too_large", `批量最多 ${MAX_BATCH} 条，请拆分。`);
  if (!list.some((s) => typeof s === "string" && s.trim())) return notStarted(undefined, "empty_command", "缺少有效命令。");
  const deadline = isBatch ? Date.now() + Math.min(normalizeTimeout(args.batchTimeoutMs || MAX_BATCH_TIMEOUT_MS), MAX_BATCH_TIMEOUT_MS) : 0;
  const tCwd = performance.now();
  const cwd = await resolveCwd(args.cwd);
  const cwdMs = round2(performance.now() - tCwd);
  if (!cwd) return notStarted(undefined, "cwd_not_found", "无法确定工作目录，命令未执行；请指定绝对 cwd。");
  const timeoutMs = normalizeTimeout(args.timeoutMs);
  if (!isBatch) return runOne(list[0], cwd, timeoutMs, cwdMs, signal);
  let budget = MAX_BATCH_OUTPUT;
  const results = [];
  for (const cmd of list) {
    const result = typeof cmd === "string" && cmd.trim()
      ? await runOne(cmd, cwd, timeoutMs, cwdMs, signal, deadline, budget)
      : notStarted(cmd, "empty_command", "空命令已跳过。", false);
    budget = capBatchResult(result, budget);
    results.push(result);
  }
  const okCount = results.filter((r) => r.ok).length;
  return { ok: okCount === results.length, batch: true, count: results.length, okCount, results,
    timings: { pluginMs: round2(performance.now() - t0), cwdMs },
    message: `批量执行 ${results.length} 条命令，${okCount} 条成功。结果按输入顺序返回。` };
}

async function onLoad() {
  await pi.agent.registerTool({ ...contributes.agentTools[0], execute: executeFastsh });
  loaded = true;
  Promise.resolve().then(startDaemon).catch(() => {});
}

async function onUnload() {
  loaded = false;
  if (daemon) stopDaemon(daemon, new Error("插件已卸载"));
  try { await pi.agent.unregisterTool("fastsh_run"); } catch { /* 宿主可能已经卸载 */ }
}

module.exports = { onLoad, onUnload, __test: { normalizeTimeout, formatResult, resolveCwd, DAEMON_PATH, daemonPid: () => daemon?.child.pid ?? null } };
