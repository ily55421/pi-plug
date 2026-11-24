"use strict";

// 插件层端到端测试：模拟 PI-Desktop 宿主，走 main.js 的真实工具路径。
// 运行：node tests/plugin.test.cjs
//
// 与 daemon.test.cjs 的分工：
//   - daemon.test.cjs 直接驱动 bin/fastsh.exe，细粒度断言 shim 语义与死锁；
//   - 本文件验证宿主契约：工具注册、cwd 解析、fallback 格式、性能、崩溃自恢复。
//
// 历史盲区：原用例输出全都极小（ls | head -3 之类），所以 ≥4KB 输出死锁的 P0
// 一直没被测出来。下面"大输出"一节就是补这个洞。

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

// [命令, 是否应回退, 期望 stdout（norm 后精确匹配，可选）]
const CASES = [
  // 基础功能
  ["pwd", false, null],
  ["echo abc | wc -c", false, "4"],
  ["seq 1 3 | sort -r", false, "3\n2\n1"],
  ["dirname /a/b/c.txt", false, "/a/b"],

  // 曾静默出错的 shim（退出码 0 但答案错）
  ["seq 1 20 | head -3", false, "1\n2\n3"],
  ["printf '中文abc' | wc -m", false, "5"],
  ["find . -name 'mai?.go' -type f", false, "src/main.go"],
  ["echo 'a/b' | sed 's/a\\/b/X/'", false, "X"],
  ["echo '-x' | grep -- -x", false, "-x"],

  // PowerShell 语义必须回退
  ["$env:USERPROFILE", true, null],
  ["Get-ChildItem | Select-Object -First 1", true, null],
  ["ls C:\\Users", true, null],
  [".\\setup.ps1", true, null],
  ["definitelynotacommand123", true, null],
];

function norm(s) {
  return (s || "").replace(/\r\n/g, "\n").replace(/\n+$/, "").trim();
}

(async () => {
  let pass = 0;
  let fail = 0;
  const check = (name, ok, detail) => {
    if (ok) pass++;
    else fail++;
    console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  };

  /* ---------------------------------------------------------------- 注册 */
  await plugin.onLoad();
  assert.ok(registered, "工具未被注册");
  console.log("== 0. 工具注册 ==");
  check("name", registered.name === "fastsh_run", registered.name);
  check("risk", registered.risk === "medium", registered.risk);
  check("schema 含 command 与 commands", !!registered.schema.properties.command && !!registered.schema.properties.commands);
  console.log("  daemon: " + plugin.__test.DAEMON_PATH);
  console.log("");

  /* ------------------------------------------------------ 功能与回退判定 */
  console.log("== 1. 功能与回退判定 ==");
  for (const [cmd, expectFallback, expectOut] of CASES) {
    const r = await registered.execute({ command: cmd });
    const fbOk = r.fallback === expectFallback;
    const outOk = expectOut === null || norm(r.stdout) === expectOut;
    const ok = fbOk && outOk;
    check(
      cmd,
      ok,
      ok
        ? fbOk && expectFallback
          ? "[" + r.fallbackReason + "]"
          : JSON.stringify(norm(r.stdout).slice(0, 40))
        : `fallback=${r.fallback}${fbOk ? "" : "（期望 " + expectFallback + "）"} out=${JSON.stringify(norm(r.stdout).slice(0, 40))}` +
          (expectOut !== null && !outOk ? `（期望 ${JSON.stringify(expectOut)}）` : "")
    );
  }

  /* -------------------------------------------------- 大输出不再死锁（P0） */
  console.log("\n== 2. 大输出不再卡死（P0 回归，原测试的盲区） ==");
  // 旧版：cat 一个 >4KB 的文件就永久挂住，且 daemon 之后完全不响应
  const BIG_CASES = [
    ["seq 1 1500", 6000], // 刚好越过 Windows 管道缓冲
    ["cat src/coreutils.go", 19000], // 一个真实的中等文件
    ["seq 1 20000", 100000],
  ];
  for (const [cmd, minBytes] of BIG_CASES) {
    const t0 = Date.now();
    const r = await registered.execute({ command: cmd, timeoutMs: 15000 });
    const ms = Date.now() - t0;
    const ok = !r.fallback && r.exitCode === 0 && (r.stdout || "").length >= minBytes && ms < 15000;
    check(cmd, ok, ok ? `${r.stdout.length}B ${ms}ms` : `fallback=${r.fallback} exit=${r.exitCode} bytes=${(r.stdout || "").length} ${ms}ms`);
  }
  // 大输出之后必须还能用（旧版这里是"变砖"状态）
  const alive = await registered.execute({ command: "echo alive" });
  check("大输出之后仍响应", !alive.fallback && norm(alive.stdout) === "alive", JSON.stringify(norm(alive.stdout)));

  /* -------------------------------------------------------------- cwd */
  console.log("\n== 3. 默认工作目录 ==");
  const pwd = await registered.execute({ command: "pwd" });
  const pwdOut = norm(pwd.stdout).replace(/\\/g, "/");
  const expectRoot = WORKSPACE_ROOT.replace(/\\/g, "/");
  check(
    "默认 cwd = 工作区根（不是安装目录）",
    pwdOut.toLowerCase() === expectRoot.toLowerCase(),
    `${pwdOut}（期望 ${expectRoot}）`
  );
  // 显式 cwd 生效
  const explicit = await registered.execute({ command: "pwd", cwd: path.join(WORKSPACE_ROOT, "tests") });
  check(
    "显式 cwd 生效",
    norm(explicit.stdout).replace(/\\/g, "/").toLowerCase() === path.join(WORKSPACE_ROOT, "tests").replace(/\\/g, "/").toLowerCase(),
    JSON.stringify(norm(explicit.stdout))
  );
  // 无效 cwd 必须回退，不能静默在旧目录执行
  const badCwd = await registered.execute({ command: "echo nope", cwd: path.join(WORKSPACE_ROOT, "no-such-dir-xyz") });
  check(
    "无效 cwd 明确回退",
    badCwd.fallback === true && badCwd.fallbackReason === "cwd_not_found",
    `fallback=${badCwd.fallback} reason=${badCwd.fallbackReason}`
  );
  const relative = await registered.execute({ command: "pwd", cwd: "tests" });
  check("相对 cwd 以工作区为基准", norm(relative.stdout) === norm(explicit.stdout));
  const savedWorkspace = global.pi.workspace;
  global.pi.workspace = { get: () => null };
  const missing = await registered.execute({ command: "echo must-not-run" });
  global.pi.workspace = savedWorkspace;
  check("工作区不可用不使用安装目录", missing.executionState === "not_started" && missing.fallbackReason === "cwd_not_found");

  /* ---------------------------------------------------------- 空命令防护 */
  console.log("\n== 4. 参数校验 ==");
  const empty = await registered.execute({ command: "   " });
  check("空命令回退", empty.fallback === true && empty.fallbackReason === "empty_command", empty.fallbackReason);
  const t = plugin.__test.normalizeTimeout;
  check("timeout 下限夹紧", t(1) === 1000, String(t(1)));
  check("timeout 上限夹紧", t(1e9) === 600000, String(t(1e9)));
  check("timeout 缺省", t(undefined) === 60000, String(t(undefined)));

  /* ---------------------------------------------------------------- 性能 */
  console.log("\n== 5. 常驻性能 ==");
  const t0 = Date.now();
  const N = 50;
  for (let i = 0; i < N; i++) {
    await registered.execute({ command: "echo bench" });
  }
  const dt = Date.now() - t0;
  check(`${N} 次调用平均 < 10ms`, dt / N < 10, `${dt}ms 总计，平均 ${(dt / N).toFixed(2)}ms/次`);

  /* -------------------------------------------------------------- 批量 */
  console.log("\n== 6. 批量 commands[] ==");
  const batch = await registered.execute({ commands: ["echo a", "echo b", "echo c"] });
  check("批量返回 batch 形状", batch.batch === true && batch.count === 3 && Array.isArray(batch.results), `count=${batch.count}`);
  check(
    "批量顺序与内容",
    batch.ok === true && batch.results.map((r) => norm(r.stdout)).join(",") === "a,b,c",
    JSON.stringify(batch.results.map((r) => norm(r.stdout)))
  );
  const mixed = await registered.execute({ commands: ["echo ok", "definitelynotacommand123"] });
  check("批量含回退项 ok=false", mixed.ok === false && mixed.results[1].fallback === true, `okCount=${mixed.okCount}`);
  const tooMany = await registered.execute({ commands: Array.from({ length: 21 }, (_, i) => `echo ${i}`) });
  check("批量超限回退", tooMany.fallback === true && tooMany.fallbackReason === "batch_too_large", tooMany.fallbackReason);
  const emptyBatch = await registered.execute({ commands: ["  "] });
  check("批量全空回退", emptyBatch.fallback === true && emptyBatch.fallbackReason === "empty_command", emptyBatch.fallbackReason);
  const budget = await registered.execute({ commands: ["seq 1 1300000", "printf overflow"], timeoutMs: 18000 });
  check("批量共享 8 MiB 输出预算", budget.ok && budget.results.every((r) => r.stdoutTruncated) &&
    budget.results.reduce((sum, r) => sum + Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr), 0) <= 8 * 1024 * 1024);
  const expiredBatch = await registered.execute({ commands: ["sleep 2", "echo must-not-run"], batchTimeoutMs: 1000 });
  check("批量过期不提交下一条", expiredBatch.results[1].executionState === "not_started" && expiredBatch.results[1].reason === "batch_deadline");
  const abort = new AbortController();
  abort.abort();
  const cancelled = await registered.execute({ command: "echo must-not-run" }, { signal: abort.signal });
  check("取消后不提交命令", cancelled.executionState === "not_started" && cancelled.reason === "cancelled");

  /* ------------------------------------------------------ 崩溃自恢复 */
  console.log("\n== 7. 崩溃自恢复 ==");
  const pid = plugin.__test.daemonPid();
  check("能拿到 daemon pid", typeof pid === "number" && pid > 0, String(pid));
  const inflight = registered.execute({ command: "sleep 3; echo this-must-not-replay", timeoutMs: 6000 });
  await new Promise((r) => setTimeout(r, 120));
  try {
    execFileSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore" });
  } catch {
    /* 可能已经退出 */
  }
  const lost = await inflight;
  check("响应丢失：未知状态、禁止回退重放", lost.executionState === "unknown" && lost.fallback === false && lost.exitCode === null && plugin.__test.daemonPid() === null);
  const after = await registered.execute({ command: "echo recovered" });
  check(
    "杀掉 daemon 后自动重启",
    !after.fallback && norm(after.stdout) === "recovered",
    `fallback=${after.fallback} out=${JSON.stringify(norm(after.stdout))}`
  );

  /* -------------------------------------------------------------- 卸载 */
  console.log("\n== 8. 卸载 ==");
  const pidBefore = plugin.__test.daemonPid();
  await plugin.onUnload();
  await new Promise((r) => setTimeout(r, 300));
  check("工具已注销", registered === null);
  check("daemon 已置空", plugin.__test.daemonPid() === null, `卸载前 pid=${pidBefore}`);

  console.log("\n" + pass + " 通过 / " + fail + " 失败");
  console.log(fail === 0 ? "全部通过" : "有 " + fail + " 项失败");
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((err) => {
  console.error("测试异常:", err);
  process.exitCode = 1;
});
