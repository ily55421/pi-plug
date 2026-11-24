"use strict";

// 插件层端到端测试：模拟 PI-Desktop 宿主，走 main.js 的真实工具路径。
// 运行：node tests/plugin.test.cjs

const assert = require("assert");
const path = require("path");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const { setTimeout: sleep } = require("node:timers/promises");
const { execFileSync } = require("node:child_process");

const WORKSPACE_ROOT = path.join(__dirname, "..");
const literal = (value) => `'${value.replace(/'/g, "''")}'`;
const outputBytes = (r) => Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr);
const scratch = process.env.PI_SCRATCH_DIR || process.env.TEMP;
const temp = fs.mkdtempSync(path.join(scratch, "pwshd-test-"));
async function waitForFile(file) {
  for (let i = 0; i < 200; i++) {
    if (fs.existsSync(file) && fs.statSync(file).size) return true;
    await sleep(10);
  }
  return false;
}

let registered = null;

// 模拟宿主：workspace.get 故意写成 async，验证 main.js 的 await 处理
globalThis.pi = {
  agent: {
    registerTool: async (tool) => {
      registered = tool;
    },
    unregisterTool: async () => {
      registered = null;
    },
  },
  workspace: {
    get: async () => ({ root: WORKSPACE_ROOT }),
  },
};

const plugin = require("../main.js");

function norm(s) {
  return (s || "").replace(/\r\n/g, "\n").replace(/\n+$/, "").trim();
}

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
}

(async () => {
  if (process.platform === "win32") {
    const git = execFileSync("where.exe", ["git.exe"], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
    process.env.PATHEXT = ".CPL";
    delete process.env.ComSpec;
    console.log("== Windows 环境回归（只修改测试 Node 进程） ==");
    const env = Object.freeze({ PathExt: ".CPL;.eXe", systemroot: "D:\\Win", Path: "keep", EXTRA: "unchanged" });
    const repaired = plugin.__test.buildSpawnEnv(env, "win32");
    check("只补必要扩展，保留键名、顺序及其他变量", repaired.PathExt === ".CPL;.eXe;.COM;.BAT;.CMD" && repaired.Path === env.Path && repaired.EXTRA === env.EXTRA && env.PathExt === ".CPL;.eXe");
    check("仅使用本机 SystemRoot 补 ComSpec", repaired.ComSpec === "D:\\Win\\System32\\cmd.exe" && !plugin.__test.buildSpawnEnv({ SystemRoot: "\\\\host\\share" }, "win32").ComSpec);
    const complete = { PATHEXT: ".com;.exe;.cmd;.bat;.cpl", COMSPEC: "preserve" };
    check("不重写已齐备的 Windows env 或非 Windows env", JSON.stringify(complete) === JSON.stringify(plugin.__test.buildSpawnEnv(complete, "win32")) && plugin.__test.buildSpawnEnv(env, "linux") === env);
    await plugin.onLoad();
    const environment = await registered.execute({ commands: ["$env:PATHEXT", "$env:ComSpec", "git rev-parse --short HEAD", `& ${literal(git)} --version`] });
    check("残缺环境下仍能跑 git 及绝对 exe", environment.ok && /^git version /.test(environment.results[3].stdout) && /^[0-9a-f]{7,}$/.test(environment.results[2].stdout));
    check("仅 daemon 子进程获得修复", process.env.PATHEXT === ".CPL" && !process.env.ComSpec && environment.results[0].stdout.startsWith(".CPL;.EXE;") && /System32\\cmd\.exe$/i.test(environment.results[1].stdout));
  } else {
    await plugin.onLoad();
  }
  assert.ok(registered, "工具未被注册");

  console.log("== 0. 工具注册 ==");
  check("name", registered.name === "pwsh_run", registered.name);
  check("risk", registered.risk === "medium", registered.risk);
  const descriptor = require("../manifest.json").contributes.agentTools[0];
  check("注册数据与 manifest 一致", registered.description === descriptor.description && JSON.stringify(registered.schema) === JSON.stringify(descriptor.schema));
  check("server.ps1 存在", require("fs").existsSync(plugin.__test.SERVER_PATH), plugin.__test.SERVER_PATH);

  console.log("\n== 1. 功能（PowerShell 语法） ==");
  const CASES = [
    ["'hello'", (r) => r.ok && norm(r.stdout) === "hello"],
    ["$env:USERPROFILE", (r) => r.ok && norm(r.stdout).length > 0],
    ["Get-ChildItem -File | Select-Object -First 1 | ForEach-Object { $_.Name }", (r) => r.ok && norm(r.stdout).length > 0],
    ["(Get-ChildItem -File).Count", (r) => r.ok && /^\d+$/.test(norm(r.stdout))],
    ["1..3 | ForEach-Object { $_ * 2 }", (r) => r.ok && norm(r.stdout).split(/\s+/).join(",") === "2,4,6"],
    ["Test-Path .\\main.js", (r) => r.ok && norm(r.stdout) === "True"],
    ["'中文测试'", (r) => r.ok && norm(r.stdout) === "中文测试"],
    ["git rev-parse --short HEAD", (r) => r.ok && norm(r.stdout).length >= 7],
  ];
  for (const [cmd, verify] of CASES) {
    const r = await registered.execute({ command: cmd });
    let ok = false;
    try {
      ok = !r.fallback && verify(r);
    } catch {
      ok = false;
    }
    check(cmd.slice(0, 52), ok, `exit=${r.exitCode} out=${JSON.stringify(norm(r.stdout).slice(0, 40))}`);
  }

  console.log("\n== 2. 退出码语义（对齐宿主） ==");
  // 基线：pwsh -NoProfile -NonInteractive -Command
  const EXITS = [
    ["'ok'", 0, false],
    ["Write-Error 'boom'; 'after'", 0, false],
    ["Write-Error 'boom'", 1, false],
    ["cmd /c exit 7", 1, false],
    ["Get-ChildItem -Path no-such-dir-xyz", 1, false],
    ["Get-ChildItem -Path no-such-dir-xyz -ErrorAction SilentlyContinue; 'ok'", 0, false],
    ["throw 'fatal'", 1, false],
    ["exit 3", 1, true],
  ];
  for (const [cmd, expectExit, expectExplicit] of EXITS) {
    const r = await registered.execute({ command: cmd });
    const ok = !r.fallback && r.exitCode === expectExit && (r.note !== undefined) === expectExplicit;
    check(
      cmd.slice(0, 52),
      ok,
      `exit=${r.exitCode}（期望 ${expectExit}）` + (expectExplicit ? ` note=${r.note ? "有" : "无"}` : "")
    );
  }

  console.log("\n== 3. 状态隔离 ==");
  await registered.execute({ command: "$leak = 'LEAKED'; $leak" });
  const iso = await registered.execute({ command: "if ($null -eq $leak) { 'isolated' } else { 'LEAKED' }" });
  check("变量不跨命令残留", norm(iso.stdout) === "isolated", JSON.stringify(norm(iso.stdout)));

  console.log("\n== 4. 工作目录 ==");
  const pwd = await registered.execute({ command: "(Get-Location).Path" });
  check(
    "默认 cwd = 工作区根",
    norm(pwd.stdout).replace(/\\/g, "/").toLowerCase() === WORKSPACE_ROOT.replace(/\\/g, "/").toLowerCase(),
    JSON.stringify(norm(pwd.stdout))
  );
  const sub = await registered.execute({ command: "(Get-Location).Path", cwd: path.join(WORKSPACE_ROOT, "tests") });
  check(
    "显式 cwd 生效",
    norm(sub.stdout).replace(/\\/g, "/").toLowerCase() === path.join(WORKSPACE_ROOT, "tests").replace(/\\/g, "/").toLowerCase(),
    JSON.stringify(norm(sub.stdout))
  );
  const relative = await registered.execute({ command: "(Get-Location).Path", cwd: "tests" });
  check("相对 cwd 从工作区解析", relative.stdout === sub.stdout && relative.status === "finished");
  const bad = await registered.execute({ command: "'must-not-run'", cwd: path.join(WORKSPACE_ROOT, "absent-pwshd-cwd") });
  check("不存在 cwd 不运行用户命令", bad.status === "not_started" && bad.fallback && bad.reason === "cwd_invalid" && !bad.stdout);
  const workspace = pi.workspace;
  pi.workspace = { get: async () => ({ root: "relative-root" }) };
  try {
    const missing = await registered.execute({ command: "'must-not-run'" });
    const missingRelative = await registered.execute({ command: "'must-not-run'", cwd: "tests" });
    const absolute = await registered.execute({ command: "'absolute'", cwd: WORKSPACE_ROOT });
    check("根目录不能解析时不落到 Node cwd", [missing, missingRelative].every((r) => r.status === "not_started" && r.fallback && r.reason === "cwd_unresolved"));
    check("无工作区仍接受绝对 cwd", absolute.ok && absolute.stdout === "absolute");
  } finally { pi.workspace = workspace; }

  console.log("\n== 5. 大输出不卡死 ==");
  for (const [cmd, min] of [
    ["1..3000", 9000],
    ["1..2000 | ForEach-Object { \"line-$_\" }", 20000],
  ]) {
    const t0 = Date.now();
    const r = await registered.execute({ command: cmd, timeoutMs: 30000 });
    const ms = Date.now() - t0;
    check(cmd.slice(0, 44), !r.fallback && r.stdout.length >= min && ms < 30000, `${r.stdout.length}B ${ms}ms`);
  }
  const alive = await registered.execute({ command: "'alive'" });
  check("大输出之后仍响应", !alive.fallback && norm(alive.stdout) === "alive", JSON.stringify(norm(alive.stdout)));

  console.log("\n== 6. 参数校验 ==");
  const empty = await registered.execute({ command: "   " });
  check("空命令回退", empty.fallback === true && empty.fallbackReason === "empty_command", empty.fallbackReason);
  const t = plugin.__test.normalizeTimeout;
  check("timeout 下限夹紧", t(1) === 1000, String(t(1)));
  check("timeout 上限夹紧", t(1e9) === 600000, String(t(1e9)));
  check("timeout 缺省", t(undefined) === 60000, String(t(undefined)));

  console.log("\n== 7. 性能 ==");
  // 预热一次（daemon 已在 onLoad 预热，这里确保 Runspace 路径已热）
  await registered.execute({ command: "'warm'" });
  const N = 20;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) await registered.execute({ command: "'bench'" });
  const dt = Date.now() - t0;
  check(`${N} 次平均 < 150ms`, dt / N < 150, `${(dt / N).toFixed(1)}ms/次（Bash 对照约 440ms）`);

  console.log("\n== 8. 批量 commands[] ==");
  const batch = await registered.execute({ commands: ["'a'", "'b'", "'c'"] });
  check("批量返回 batch 形状", batch.batch === true && batch.count === 3 && Array.isArray(batch.results), `count=${batch.count}`);
  check(
    "批量顺序与内容",
    batch.ok === true && batch.results.map((r) => norm(r.stdout)).join(",") === "a,b,c",
    JSON.stringify(batch.results.map((r) => norm(r.stdout)))
  );
  const ordered = path.join(temp, "ordered.txt");
  const mixed = await registered.execute({ commands: [`[IO.File]::WriteAllText(${literal(ordered)}, 'first'); Write-Error 'x'`, `[IO.File]::ReadAllText(${literal(ordered)})`] });
  check("默认顺序执行且失败不短路", mixed.ok === false && mixed.okCount === 1 && mixed.results[0].exitCode === 1 && mixed.results[1].stdout === "first");
  const tooMany = await registered.execute({ commands: Array.from({ length: 21 }, (_, i) => `'${i}'`) });
  check("批量超限回退", tooMany.fallback === true && tooMany.fallbackReason === "batch_too_large", tooMany.fallbackReason);
  const emptyBatch = await registered.execute({ commands: ["  "] });
  check("批量全空回退", emptyBatch.fallback === true && emptyBatch.fallbackReason === "empty_command", emptyBatch.fallbackReason);
  const both = await registered.execute({ command: "'single'", commands: ["'x'", "'y'"] });
  check("commands 优先于 command", both.batch === true && both.count === 2, `count=${both.count}`);
  const budget = 8 * 1024 * 1024;
  for (const parallel of [false, true]) {
    const limit = await registered.execute({ commands: ["'é' * 2500000", "'🐈' * 1250000", "Write-Error 'x'"], parallel });
    check(`批量总输出预算（parallel=${parallel}）`, limit.results.every((r) => r.status === "finished") && limit.outputTruncated && limit.results.reduce((n, r) => n + outputBytes(r), 0) <= budget);
  }
  const span = ["Start-Sleep -Milliseconds 550; 'a'", "Start-Sleep -Milliseconds 100; 'b'", "Start-Sleep -Milliseconds 550; 'c'"];
  const seqStart = Date.now();
  await registered.execute({ commands: span });
  const seqMs = Date.now() - seqStart;
  const parStart = Date.now();
  const parallel = await registered.execute({ commands: span, parallel: true });
  const parMs = Date.now() - parStart;
  check("并发实际重叠且结果仍按输入顺序", parallel.ok && parallel.results.map((r) => r.stdout).join("") === "abc" && seqMs - parMs > 300, `${seqMs}ms / ${parMs}ms`);

  const forbidden = path.join(temp, "forbidden.txt");
  const forbiddenCommand = `[IO.File]::WriteAllText(${literal(forbidden)}, 'ran')`;
  const limited = await registered.execute({ commands: [...Array(4).fill("Start-Sleep -Seconds 5"), forbiddenCommand], parallel: true, batchTimeoutMs: 600 });
  check("总截止不继续提交（最多四条并发）", limited.results[4].skipped && limited.results[4].reason === "batch_timeout" && !fs.existsSync(forbidden) && limited.results.every((r) => !r.fallback));
  pi.workspace = { get: () => new Promise(() => {}) };
  try {
    const cwdDeadline = await registered.execute({ commands: [forbiddenCommand], batchTimeoutMs: 30 });
    check("总截止覆盖尚未返回的 workspace API", cwdDeadline.results[0].skipped && cwdDeadline.results[0].reason === "batch_timeout");
  } finally { pi.workspace = workspace; }
  const beforeAbort = new AbortController();
  beforeAbort.abort();
  const pre = await registered.execute({ commands: [forbiddenCommand] }, { signal: beforeAbort.signal });
  check("预取消不提交", pre.results[0].skipped && pre.results[0].reason === "cancelled");
  const beforeCancel = path.join(temp, "cancel-active.txt");
  const ctl = new AbortController();
  const cancelling = registered.execute({ commands: [`[IO.File]::WriteAllText(${literal(beforeCancel)}, 'started'); Start-Sleep -Milliseconds 750`, forbiddenCommand] }, { signal: ctl.signal });
  assert.ok(await waitForFile(beforeCancel));
  ctl.abort();
  const cancelled = await cancelling;
  check("执行中取消不重放且跳过后续命令", cancelled.results[0].status === "unknown" && !cancelled.results[0].fallback && cancelled.results[1].skipped && cancelled.results[1].reason === "cancelled" && !fs.existsSync(forbidden));

  console.log("\n== 9. 插件层并发（池化） ==");
  const tp = Date.now();
  const par = await Promise.all(
    Array.from({ length: 6 }, () => registered.execute({ command: "Start-Sleep -Milliseconds 250; 'p'" }))
  );
  const wp = Date.now() - tp;
  check(
    "6 条并发 < 1200ms",
    par.every((r) => !r.fallback && norm(r.stdout) === "p") && wp < 1200,
    `${wp}ms（串行约 1500ms）`
  );

  console.log("\n== 10. 崩溃自恢复 ==");
  const pid = plugin.__test.daemonPid();
  assert.ok(Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  const effect = path.join(temp, "effect.txt");
  const pending = registered.execute({ command: `[IO.File]::AppendAllText(${literal(effect)}, 'x'); Start-Sleep -Seconds 10` });
  assert.ok(await waitForFile(effect), "已发送命令应产生副作用后再模拟崩溃");
  process.kill(pid, "SIGKILL"); // 只终止本测试 Node 启动的子进程
  const crash = await pending;
  check("崩溃后状态未知、不回退、不重放", crash.status === "unknown" && !crash.fallback && crash.reason === "transport_error" && fs.readFileSync(effect, "utf8") === "x");
  const after = await registered.execute({ command: "'recovered'" });
  check("下一条命令启动新 daemon 且无重复副作用", after.status === "finished" && after.stdout === "recovered" && plugin.__test.daemonPid() !== pid && fs.readFileSync(effect, "utf8") === "x");

  console.log("\n== 11. 卸载 ==");
  const pidBefore = plugin.__test.daemonPid();
  await plugin.onUnload();
  check("工具已注销", registered === null);
  check("daemon 已置空", plugin.__test.daemonPid() === null, `卸载前 pid=${pidBefore}`);

  console.log("\n== 12. 确定性传输故障 ==");
  await testTransport();

  console.log("\n" + pass + " 通过 / " + fail + " 失败");
  console.log(fail === 0 ? "全部通过" : "有 " + fail + " 项失败");
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((e) => {
  console.error("测试异常:", e);
  process.exitCode = 1;
}).finally(async () => {
  if (registered) await plugin.onUnload();
  fs.rmSync(temp, { recursive: true, force: true });
});

// 用假子进程精确控制故障和旧进程事件的顺序；不调用或终止任何实际进程。
async function testTransport() {
  const entry = require.resolve("../main.js");
  const realModule = require.cache[entry];
  const childProcess = require("node:child_process");
  const realSpawn = childProcess.spawn;
  const children = [];
  const writes = [];
  const reply = (child, msg) => child.stdout.write(JSON.stringify(msg) + "\n");
  childProcess.spawn = () => {
    const generation = children.length + 1;
    const child = new EventEmitter();
    Object.assign(child, {
      exitCode: null, signalCode: null, killed: false, stdout: new PassThrough(), stderr: new PassThrough(),
      kill() { this.killed = true; },
    });
    children.push(child);
    child.stdin = new Writable({ write(buffer, _, done) {
      const request = JSON.parse(Buffer.from(buffer.toString().trim(), "base64"));
      writes.push([generation, request.command]);
      if (generation === 2) return done(new Error("EPIPE"));
      if (generation === 3) {
        const old = children[1];
        reply(old, { id: request.id, status: "finished", ok: true, stdout: "stale" });
        old.emit("error", new Error("late error from old child"));
        old.emit("close", 1);
      }
      if (generation !== 4) reply(child, { id: request.id, status: "finished", ok: true, stdout: "fresh" });
      done();
    } });
    setImmediate(() => {
      if (generation === 1) child.emit("error", new Error("ENOENT"));
      else reply(child, { ready: true });
    });
    return child;
  };
  delete require.cache[entry];
  let mock;
  try { mock = require(entry); }
  finally {
    childProcess.spawn = realSpawn;
    require.cache[entry] = realModule;
  }
  try {
    await mock.onLoad();
    const before = await registered.execute({ command: "'start failure'" });
    check("启动前失败允许回退且未写入", before.status === "not_started" && before.fallback && writes.length === 0);
    const pipe = await registered.execute({ command: "'pipe failure'" });
    check("写入后 EPIPE 是未知且不重试", pipe.status === "unknown" && !pipe.fallback && writes.length === 1);
    const recovered = await registered.execute({ command: "'recover'" });
    check("旧 child 的响应/close/error 不污染新请求", recovered.ok && recovered.stdout === "fresh" && writes.length === 2);
    children[2].stdout.end();
    await new Promise((resolve) => setImmediate(resolve));
    const timeout = await registered.execute({ command: "'watchdog'", timeoutMs: 1000 });
    check("发送后传输超时不回退或重试", timeout.status === "unknown" && timeout.reason === "transport_timeout" && !timeout.fallback && writes.length === 3);
    const afterTimeout = await registered.execute({ command: "'after timeout'" });
    check("传输超时后的新命令恢复", afterTimeout.ok && writes.length === 4 && children.length === 5);
  } finally { await mock.onUnload(); }
}
