"use strict";

// daemon 层回归测试：直接驱动 bin/fastsh.exe，断言 stdout/exitCode，不靠肉眼。
// 运行：node tests/daemon.test.cjs
//
// 覆盖四类曾经出过问题的场景：
//   1. 大输出死锁（P0）——超过 Windows 管道缓冲就卡死，且 daemon 变砖；
//   2. shim 静默错误——退出码 0 但答案是错的；
//   3. 工作目录校验——无效 cwd 必须回退，不能沿用上一个请求的目录；
//   4. 超大输出与无限输出——必须截断/超时返回，不能挂住。

const assert = require("assert");
const path = require("path");
const { spawn } = require("child_process");
const readline = require("readline");

const DAEMON = path.join(__dirname, "..", "bin", "fastsh.exe");
const SRC_DIR = path.join(__dirname, "..", "src");
const WAIT_MS = 30000;

/* ------------------------------------------------------------ daemon 客户端 */

function startDaemon() {
  const proc = spawn(DAEMON, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  proc.stderr.on("data", () => {});
  const pending = new Map();
  readline.createInterface({ input: proc.stdout }).on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const cb = pending.get(msg.id);
    if (cb) {
      pending.delete(msg.id);
      cb(msg);
    }
  });

  let seq = 0;
  function run(command, opts = {}) {
    const cwd = opts.cwd === undefined ? SRC_DIR : opts.cwd;
    const timeoutMs = opts.timeoutMs || 10000;
    return new Promise((resolve) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ hung: true });
      }, WAIT_MS);
      pending.set(id, (m) => {
        clearTimeout(timer);
        resolve({
          hung: false,
          ok: m.ok,
          exitCode: m.exitCode,
          stdout: m.stdout || "",
          stderr: m.stderr || "",
          fallback: m.fallback,
          reason: m.reason,
          durationMs: m.durationMs,
        });
      });
      proc.stdin.write(JSON.stringify({ id, command, cwd, timeoutMs }) + "\n");
    });
  }
  return { proc, run };
}

/** 统一把 \r\n 折成 \n 并去掉结尾换行，便于精确比较 */
function norm(s) {
  return s.replace(/\r\n/g, "\n").replace(/\n+$/, "").trim();
}

/* ---------------------------------------------------------------- 用例表 */

// [命令, 期望 stdout（norm 后精确匹配）, 期望 exitCode]
const SEMANTIC_CASES = [
  // wc：-m 是字符数（rune），-c 是字节数
  ["printf '中文abc' | wc -m", "5", 0],
  ["printf '中文abc' | wc -c", "9", 0],
  ["printf '中文abc' | wc -l", "0", 0],
  ["echo abc | wc -w", "1", 0],

  // head/tail：老式 -N 写法、-n N、-nN 三种都要认
  ["seq 1 20 | head -3", "1\n2\n3", 0],
  ["seq 1 20 | head -n 3", "1\n2\n3", 0],
  ["seq 1 20 | head -n3", "1\n2\n3", 0],
  ["seq 1 20 | tail -3", "18\n19\n20", 0],
  ["seq 1 5 | tail -n 2", "4\n5", 0],
  // tail -n +N：从第 N 行到尾（不是"最后 N 行"）
  ["seq 1 5 | tail -n +3", "3\n4\n5", 0],

  // grep：-- 终止符之后的位置参数才是模式
  ["echo '-x' | grep -- -x", "-x", 0],
  ["echo abc | grep -c b", "1", 0],
  ["echo abc | grep -n b", "1:abc", 0],
  ["printf 'A\\nb\\n' | grep -i B", "b", 0],
  ["printf 'a\\nb\\n' | grep -v a", "b", 0],

  // sed：转义分隔符、非 / 分隔符、g 标志、替换串里的 $ 当字面量
  ["echo 'a/b' | sed 's/a\\/b/X/'", "X", 0],
  ["echo 'hello' | sed s/l/L/", "heLlo", 0],
  ["echo 'hello' | sed 's/l/L/g'", "heLLo", 0],
  ["echo 'path/to/x' | sed 's#path#P#'", "P/to/x", 0],
  ["echo ab | sed 's/a/$/'", "$b", 0],

  // find：glob 的 * ? 与字符类都要正确翻译
  ["find . -name 'main.go' -type f", "main.go", 0],
  ["find . -name 'mai?.go' -type f", "main.go", 0],
  ["find . -name '*.go' -type f | wc -l", "4", 0],
  ["find . -maxdepth 1 -name 'm*' -type f", "main.go", 0],
  // 以前：c++* 让正则直接编译失败；a[!b]* 的排除语义失效
  ["find . -name 'c++*'", "", 0],
  ["find . -name 'a[!b]*'", "", 0],
  ["find . -name 'a[b-m]*'", "", 0],

  // 基础命令仍要正常
  ["echo hi", "hi", 0],
  ["seq 1 3 | sort -r", "3\n2\n1", 0],
  ["dirname /a/b/c.txt", "/a/b", 0],
  ["basename /a/b/c.txt", "c.txt", 0],
  ["echo abc | tr a-z A-Z", "ABC", 0],
  ["printf 'a\\nb\\na\\n' | sort | uniq", "a\nb", 0],
];

// PowerShell 专有语法必须拒绝执行（fallback=true）
const FALLBACK_CASES = [
  ["$env:USERPROFILE", "pwsh_env_var"],
  ["Get-ChildItem | Select-Object -First 1", "pwsh_cmdlet"],
  ["ls C:\\Users", "win_backslash_path"],
  [".\\setup.ps1", "pwsh_script"],
  ["definitelynotacommand123", "command_not_found"],
];

/* ------------------------------------------------------------------ 主流程 */

(async () => {
  assert.ok(require("fs").existsSync(DAEMON), "找不到 daemon: " + DAEMON);
  const { proc, run } = startDaemon();
  let pass = 0;
  let fail = 0;

  const check = (name, ok, detail) => {
    if (ok) {
      pass++;
      console.log("  PASS " + name + (detail ? "  " + detail : ""));
    } else {
      fail++;
      console.log("  FAIL " + name + (detail ? "  " + detail : ""));
    }
  };

  console.log("== 1. shim 语义断言 ==");
  for (const [cmd, expectOut, expectExit] of SEMANTIC_CASES) {
    const r = await run(cmd);
    if (r.hung) {
      check(cmd, false, "*** 卡死 ***");
      continue;
    }
    const got = norm(r.stdout);
    check(
      cmd,
      got === expectOut && r.exitCode === expectExit,
      got === expectOut && r.exitCode === expectExit
        ? ""
        : `got=${JSON.stringify(got)} exit=${r.exitCode}（期望 ${JSON.stringify(expectOut)} / ${expectExit}）` +
          (r.stderr ? " stderr=" + JSON.stringify(norm(r.stderr).slice(0, 120)) : "")
    );
  }

  console.log("\n== 2. 回退判定 ==");
  for (const [cmd, expectReason] of FALLBACK_CASES) {
    const r = await run(cmd);
    check(
      cmd,
      !r.hung && r.fallback === true && r.reason === expectReason,
      !r.hung && r.fallback === true && r.reason === expectReason
        ? "[" + r.reason + "]"
        : `fallback=${r.fallback} reason=${r.reason}（期望 ${expectReason}）`
    );
  }

  console.log("\n== 3. 大输出不再死锁（P0 回归） ==");
  // 旧版在 ~4KB 处死锁：seq 1 1050 就挂住，且之后 daemon 永久变砖
  const sizeCases = [
    ["seq 1 1000", 3000, 5000],
    ["seq 1 1500", 6000, 7000],
    ["cat coreutils2.go", 9000, null], // 文件本身 > 4KB
    ["seq 1 20000", 100000, 130000],
    ["seq 1 200000", 1200000, 1400000],
  ];
  for (const [cmd, minBytes, maxBytes] of sizeCases) {
    const r = await run(cmd);
    const len = r.hung ? -1 : r.stdout.length;
    const ok = !r.hung && r.exitCode === 0 && len >= minBytes && (maxBytes === null || len <= maxBytes);
    check(cmd, ok, ok ? `${len}B ${r.durationMs}ms` : `hung=${r.hung} exit=${r.exitCode} bytes=${len}`);
  }

  console.log("\n== 4. 超大/无限输出的上限保护 ==");
  // 超过 8MB 上限：截断并标注，而不是挂死
  const big = await run("seq 1 2000000", { timeoutMs: 20000 });
  check(
    "seq 1 2000000 超过 8MB 上限",
    !big.hung && big.stdout.length > 8 * 1024 * 1024 && /已截断/.test(big.stdout),
    big.hung ? "*** 卡死 ***" : `${big.stdout.length}B，含截断提示`
  );
  // 无限输出：靠超时收口
  const inf = await run("yes hello", { timeoutMs: 2000 });
  check(
    "yes hello 无限输出按超时收口",
    !inf.hung,
    inf.hung ? "*** 卡死 ***" : `exit=${inf.exitCode} ${inf.durationMs}ms`
  );

  console.log("\n== 5. 大输出之后 daemon 仍然可用 ==");
  for (const cmd of ["echo alive", "pwd", "seq 1 3"]) {
    const r = await run(cmd);
    check(cmd, !r.hung && r.exitCode === 0, r.hung ? "*** 卡死 ***" : `exit=${r.exitCode}`);
  }

  console.log("\n== 6. 工作目录校验 ==");
  const goodCwd = await run("pwd");
  check(
    "有效 cwd 正常执行",
    !goodCwd.hung && goodCwd.exitCode === 0 && norm(goodCwd.stdout).length > 0,
    JSON.stringify(norm(goodCwd.stdout))
  );
  // 传入不存在的目录：必须明确回退，绝不能在旧目录里继续跑
  const badCwd = await run("echo should-not-run", { cwd: path.join(SRC_DIR, "no-such-dir-xyz") });
  check(
    "无效 cwd 明确回退",
    !badCwd.hung && badCwd.fallback === true && badCwd.reason === "cwd_not_found",
    badCwd.hung ? "*** 卡死 ***" : `fallback=${badCwd.fallback} reason=${badCwd.reason}`
  );
  // 回退之后 daemon 必须还能用（cwd 没被污染）
  const afterBad = await run("pwd");
  check(
    "无效 cwd 之后仍可用",
    !afterBad.hung && afterBad.exitCode === 0,
    afterBad.hung ? "*** 卡死 ***" : `exit=${afterBad.exitCode}`
  );

  proc.kill();
  console.log("\n" + pass + " 通过 / " + fail + " 失败");
  if (fail > 0) {
    console.log("有失败项");
    process.exitCode = 1;
  } else {
    console.log("全部通过");
  }
})().catch((err) => {
  console.error("测试异常:", err);
  process.exitCode = 1;
});
