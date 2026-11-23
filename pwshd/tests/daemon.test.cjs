"use strict";

// pwshd daemon 层测试：直接驱动 server.ps1，断言与宿主 `pwsh -NoProfile -Command` 一致的语义。
// 运行：node tests/daemon.test.cjs
//
// 重点覆盖原型阶段踩到的坑：
//   1. 协议污染 —— 任何非 JSON 行都算失败（cwd 泄漏、格式化表格泄漏）
//   2. 状态隔离 —— 每条命令新建 Runspace，变量不得跨命令泄漏
//   3. 退出码语义 —— 对齐宿主（用 $? 而非 $LASTEXITCODE）
//   4. 显式 exit —— 管道提前终止时给出显式标记而不是静默错值

const assert = require("assert");
const path = require("path");
const { spawn } = require("child_process");
const readline = require("readline");

const SERVER = path.join(__dirname, "..", "server.ps1");
const CWD = path.join(__dirname, "..");
const TIMEOUT = 30000;

const proc = spawn(
  "pwsh",
  ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SERVER],
  { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
);

let protocolNoise = [];
const pending = new Map();
proc.stderr.on("data", (d) => protocolNoise.push("STDERR:" + d.toString().slice(0, 160)));
readline.createInterface({ input: proc.stdout }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    protocolNoise.push("NONJSON:" + line.slice(0, 160));
    return;
  }
  const cb = pending.get(m.id);
  if (cb) {
    pending.delete(m.id);
    cb(m);
  }
});

let seq = 0;
function run(command, opts = {}) {
  const cwd = opts.cwd === undefined ? CWD : opts.cwd;
  return new Promise((resolve) => {
    const id = ++seq;
    const start = Date.now();
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ hung: true, wallMs: Date.now() - start });
    }, opts.timeout || TIMEOUT);
    pending.set(id, (m) => {
      clearTimeout(timer);
      resolve({
        hung: false,
        wallMs: Date.now() - start,
        ok: m.ok,
        exitCode: m.exitCode,
        stdout: m.stdout || "",
        stderr: m.stderr || "",
        explicitExit: m.explicitExit === true,
        durationMs: m.durationMs,
      });
    });
    const payload = { id, command, cwd };
    if (opts.shutdown) payload.shutdown = true;
    if (opts.timeoutMs) payload.timeoutMs = opts.timeoutMs;
    proc.stdin.write(Buffer.from(JSON.stringify(payload), "utf8").toString("base64") + "\n");
  });
}

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  PASS ${name}${detail ? "  " + detail : ""}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? "  " + detail : ""}`);
  }
}

(async () => {
  console.log("== 1. 与宿主一致的退出码语义 ==");
  // 基线取自 pwsh -NoProfile -NonInteractive -Command 实测
  const EXIT_CASES = [
    ["'ok'", 0],
    ["Write-Error 'boom'; 'after'", 0], // 最后一条成功 => 0
    ["Write-Error 'boom'", 1],
    ["cmd /c exit 7", 1], // 宿主给 1，不是 7
    ["Get-ChildItem -Path no-such-dir-xyz", 1],
    ["Get-ChildItem -Path no-such-dir-xyz -ErrorAction SilentlyContinue; 'ok'", 0],
    ["throw 'fatal'", 1],
    ["'done'", 0],
  ];
  for (const [cmd, expect] of EXIT_CASES) {
    const r = await run(cmd);
    check(cmd, !r.hung && r.exitCode === expect, r.hung ? "*** 卡死 ***" : `exit=${r.exitCode}（期望 ${expect}）`);
  }

  console.log("\n== 2. 输出内容 ==");
  const OUT_CASES = [
    ["'hello'", (r) => r.stdout.trim() === "hello"],
    ["1..3 | Format-Table", (r) => /1/.test(r.stdout) && /3/.test(r.stdout) && !/FormatEntryData/.test(r.stdout)],
    ["'中文输出测试'", (r) => r.stdout.trim() === "中文输出测试"],
    ["node -e \"console.log('ns')\"", (r) => r.stdout.trim() === "ns"],
    ["cmd /c echo native", (r) => r.stdout.trim() === "native"],
    ["pwd", (r) => /Path/.test(r.stdout) && r.stdout.includes("----")],
    ["$a=1\n$b=2\n$a+$b", (r) => r.stdout.trim() === "3"],
  ];
  for (const [cmd, verify] of OUT_CASES) {
    const r = await run(cmd);
    let ok = false;
    try {
      ok = !r.hung && verify(r);
    } catch {
      ok = false;
    }
    check(cmd.replace(/\n/g, " "), ok, r.hung ? "*** 卡死 ***" : `out=${JSON.stringify(r.stdout.slice(0, 60))}`);
  }

  console.log("\n== 3. 错误分流 ==");
  const errCase = await run("Write-Error 'boom'; 'after'");
  check(
    "stdout/stderr 分离",
    errCase.stdout.trim() === "after" && /boom/.test(errCase.stderr),
    `stdout=${JSON.stringify(errCase.stdout.trim())} stderr=${JSON.stringify(errCase.stderr.slice(0, 40))}`
  );

  console.log("\n== 4. 状态隔离（每条新 Runspace） ==");
  await run("$leak = 'LEAKED'; $leak");
  const iso = await run("if ($null -eq $leak) { 'isolated' } else { 'LEAKED:' + $leak }");
  check("变量不跨命令泄漏", iso.stdout.trim() === "isolated", JSON.stringify(iso.stdout.trim()));
  const fn = await run("function Global:Helper { 'x' }; Helper");
  const fn2 = await run("if (Get-Command Helper -ErrorAction SilentlyContinue) { 'leaked-fn' } else { 'isolated-fn' }");
  check("函数不跨命令泄漏", fn2.stdout.trim() === "isolated-fn", JSON.stringify(fn2.stdout.trim()));

  console.log("\n== 5. 显式 exit 的处理 ==");
  const ex = await run("exit 3");
  check(
    "exit 被识别并明确告知",
    !ex.hung && ex.explicitExit === true && /exit/.test(ex.stderr),
    ex.hung ? "*** 卡死 ***" : `explicitExit=${ex.explicitExit} exit=${ex.exitCode}`
  );

  console.log("\n== 6. 工作目录 ==");
  const pwd = await run("(Get-Location).Path");
  check(
    "默认 cwd 生效",
    pwd.stdout.trim().replace(/\\/g, "/").toLowerCase() === CWD.replace(/\\/g, "/").toLowerCase(),
    JSON.stringify(pwd.stdout.trim())
  );
  const sub = await run("(Get-Location).Path", { cwd: path.join(CWD, "tests") });
  check(
    "显式 cwd 生效",
    sub.stdout.trim().replace(/\\/g, "/").toLowerCase() === path.join(CWD, "tests").replace(/\\/g, "/").toLowerCase(),
    JSON.stringify(sub.stdout.trim())
  );
  const badCwd = await run("'should-not-run'", { cwd: path.join(CWD, "no-such-dir-xyz") });
  check(
    "无效 cwd 不静默乱跑",
    !badCwd.hung && badCwd.stdout.trim() !== "should-not-run",
    `exit=${badCwd.exitCode} out=${JSON.stringify(badCwd.stdout.trim().slice(0, 40))}`
  );

  console.log("\n== 7. 大输出 ==");
  for (const [cmd, min] of [
    ["1..5000", 15000],
    ["1..2000 | ForEach-Object { \"line-$_\" }", 20000],
  ]) {
    const r = await run(cmd, { timeout: 40000 });
    check(cmd.slice(0, 50), !r.hung && r.stdout.length >= min, r.hung ? "*** 卡死 ***" : `${r.stdout.length}B ${r.wallMs}ms`);
  }

  console.log("\n== 8. 性能 ==");
  const N = 20;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) await run("'bench'");
  const dt = Date.now() - t0;
  check(`${N} 次平均 < 150ms`, dt / N < 150, `${(dt / N).toFixed(1)}ms/次`);

  console.log("\n== 9. 并发池吞吐（消灭排队） ==");
  // server.ps1 默认 Workers=4：8 条各 sleep 300ms 应约 2 波 ≈ 600ms，串行则需 2400ms。
  const M = 8;
  const sleepMs = 300;
  const tc = Date.now();
  const concurrent = await Promise.all(
    Array.from({ length: M }, () => run(`Start-Sleep -Milliseconds ${sleepMs}; 'done'`, { timeout: 15000 }))
  );
  const wall = Date.now() - tc;
  const allOk = concurrent.every((r) => !r.hung && r.stdout.trim() === "done");
  check(`${M} 条并发（各 ${sleepMs}ms）总耗时 < 1500ms`, allOk && wall < 1500, `${wall}ms（串行约 ${M * sleepMs}ms）`);

  console.log("\n== 10. 每命令超时（worker 自收口，daemon 存活） ==");
  const to = await run("Start-Sleep -Seconds 5; 'late'", { timeoutMs: 1000, timeout: 8000 });
  check("超时返回 124", !to.hung && to.exitCode === 124, `exit=${to.exitCode} wall=${to.wallMs}ms`);
  const afterTo = await run("'alive-after-timeout'");
  check(
    "超时后 daemon 仍响应（不再杀进程）",
    !afterTo.hung && afterTo.stdout.trim() === "alive-after-timeout",
    JSON.stringify(afterTo.stdout.trim())
  );

  console.log("\n== 11. 并发下状态隔离 ==");
  await Promise.all([run("$leak='A'"), run("$leak='B'"), run("$leak='C'"), run("$leak='D'")]);
  const isoC = await run("if ($null -eq $leak) { 'isolated' } else { 'LEAKED:'+$leak }");
  check("并发命令变量不泄漏", isoC.stdout.trim() === "isolated", JSON.stringify(isoC.stdout.trim()));

  console.log("\n== 12. 协议完整性（含并发写入） ==");
  check("stdout 无非 JSON 行", protocolNoise.length === 0, `${protocolNoise.length} 行噪声`);
  if (protocolNoise.length) {
    for (const n of protocolNoise.slice(0, 5)) console.log("    " + n);
  }

  // 优雅关闭
  await run("", { shutdown: true });
  await new Promise((r) => setTimeout(r, 300));
  try {
    proc.kill();
  } catch {
    /* 已退出 */
  }

  console.log("\n" + pass + " 通过 / " + fail + " 失败");
  console.log(fail === 0 ? "全部通过" : "有 " + fail + " 项失败");
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((e) => {
  console.error("测试异常:", e);
  process.exitCode = 1;
});
