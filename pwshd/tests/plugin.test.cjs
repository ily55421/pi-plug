"use strict";

// 插件层端到端测试：模拟 PI-Desktop 宿主，走 main.js 的真实工具路径。
// 运行：node tests/plugin.test.cjs

const assert = require("assert");
const path = require("path");
const { execFileSync } = require("child_process");

const WORKSPACE_ROOT = path.join(__dirname, "..");

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
  await plugin.onLoad();
  assert.ok(registered, "工具未被注册");

  console.log("== 0. 工具注册 ==");
  check("name", registered.name === "pwsh_run", registered.name);
  check("risk", registered.risk === "medium", registered.risk);
  check("schema 含 command 与 commands", !!registered.schema.properties.command && !!registered.schema.properties.commands);
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
  const mixed = await registered.execute({ commands: ["'ok'", "Write-Error 'x'"] });
  check("批量混合失败 ok=false", mixed.ok === false && mixed.okCount === 1 && mixed.results[1].exitCode === 1, `okCount=${mixed.okCount}`);
  const tooMany = await registered.execute({ commands: Array.from({ length: 21 }, (_, i) => `'${i}'`) });
  check("批量超限回退", tooMany.fallback === true && tooMany.fallbackReason === "batch_too_large", tooMany.fallbackReason);
  const emptyBatch = await registered.execute({ commands: ["  "] });
  check("批量全空回退", emptyBatch.fallback === true && emptyBatch.fallbackReason === "empty_command", emptyBatch.fallbackReason);
  const both = await registered.execute({ command: "'single'", commands: ["'x'", "'y'"] });
  check("commands 优先于 command", both.batch === true && both.count === 2, `count=${both.count}`);

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
  check("能拿到 daemon pid", typeof pid === "number" && pid > 0, String(pid));
  try {
    execFileSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore" });
  } catch {
    /* 可能已退出 */
  }
  await new Promise((r) => setTimeout(r, 500));
  const after = await registered.execute({ command: "'recovered'" });
  check(
    "杀掉 daemon 后自动重启",
    !after.fallback && norm(after.stdout) === "recovered",
    `fallback=${after.fallback} out=${JSON.stringify(norm(after.stdout))}`
  );

  console.log("\n== 11. 卸载 ==");
  const pidBefore = plugin.__test.daemonPid();
  await plugin.onUnload();
  await new Promise((r) => setTimeout(r, 500));
  check("工具已注销", registered === null);
  check("daemon 已置空", plugin.__test.daemonPid() === null, `卸载前 pid=${pidBefore}`);

  console.log("\n" + pass + " 通过 / " + fail + " 失败");
  console.log(fail === 0 ? "全部通过" : "有 " + fail + " 项失败");
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((e) => {
  console.error("测试异常:", e);
  process.exitCode = 1;
});
