/**
 * Learn 接线测试：真实临时目录 + 真实文件读写。
 *
 * 跑法：node --test tests/extension.test.mjs
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import learn from "../extension/index.mjs";

const PLUGIN_DATA_DIR = "local.learn";

/**
 * 在临时数据目录里跑一段测试。
 * values 为 undefined 表示不写 settings.json（插件走 manifest 默认值）。
 */
async function runWithSettings(values, fn) {
  const dir = mkdtempSync(join(tmpdir(), "plg-data-"));
  const previous = process.env.PI_DESKTOP_DATA_DIR;
  process.env.PI_DESKTOP_DATA_DIR = dir;
  if (values !== undefined) {
    const pluginDir = join(dir, "plugins", "data", PLUGIN_DATA_DIR);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, "settings.json"), JSON.stringify(values), "utf8");
  }
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_DESKTOP_DATA_DIR;
    else process.env.PI_DESKTOP_DATA_DIR = previous;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响结论。
    }
  }
}

function runWithDefaults(fn) {
  return runWithSettings(undefined, fn);
}


/**
 * 设置现在走宿主的 plugins/data/<id>/settings.json。
 * 测试用 PI_DESKTOP_DATA_DIR 指向临时目录，隔离且不污染真实配置。
 */
const PLUGIN_DATA_KEY = "local.learn";

function withSettingsDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "plg-data-"));
  const previous = process.env.PI_DESKTOP_DATA_DIR;
  process.env.PI_DESKTOP_DATA_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_DESKTOP_DATA_DIR;
    else process.env.PI_DESKTOP_DATA_DIR = previous;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响结论。
    }
  }
}

/** 写该插件的 settings.json；不写则插件用 manifest 默认值。 */
function writeSettings(dir, values) {
  const pluginDir = join(dir, "plugins", "data", PLUGIN_DATA_KEY);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "settings.json"), JSON.stringify(values), "utf8");
}


function fakePi() {
  const tools = new Map();
  const handlers = new Map();
  const pi = {
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    on(event, handler) {
      handlers.set(event, (handlers.get(event) ?? []).concat(handler));
    },
    tools,
    handlers,
  };
  return pi;
}

function makeCtx({ cwd, sessionId = "s1" } = {}) {
  const ctx = { cwd, sessionManager: { getSessionId: () => sessionId } };
  return ctx;
}

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "learn-"));
  try {
    return await fn(dir);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响结论。
    }
  }
}

/** 调用某个工具。 */
function callTool(pi, name, params, ctx) {
  const tool = pi.tools.get(name);
  assert.ok(tool, `工具 ${name} 应已注册`);
  return tool.execute("call-1", params, undefined, undefined, ctx);
}

const GOOD = "Run bun run generate after changing the public protocol; the client is generated and will drift otherwise.";

/* ------------------------------------------------------------ 注册面 */

test("注册两个工具：learn_scope 与 learn_append", () => {
  const pi = fakePi();
  learn(pi);
  assert.deepEqual([...pi.tools.keys()].sort(), ["learn_append", "learn_scope"]);
  assert.equal(typeof pi.tools.get("learn_scope").parameters, "object");
  assert.equal(typeof pi.tools.get("learn_append").parameters, "object");
});

/* ------------------------------------------------------------ learn_scope（只读） */

test("learn_scope 指向文件所在目录，且不创建任何文件", async () => {
  await withTempDir(async (dir) => {
    const pi = fakePi();
    learn(pi);
    const ctx = makeCtx({ cwd: dir });

    const r = await callTool(pi, "learn_scope", { file: join(dir, "src", "auth", "login.ts") }, ctx);
    assert.equal(r.details.ok, true);
    assert.equal(r.details.target, "src/auth/AGENTS.md");
    assert.ok(!existsSync(join(dir, "src", "auth", "AGENTS.md")), "只读工具绝不能建文件");
  });
});

test("learn_scope 反映已有文件的预算占用", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "AGENTS.md"), ["# P", "", "## Learned", "", "- a", "- b"].join("\n"), "utf8");
    const pi = fakePi();
    learn(pi);
    const r = await callTool(pi, "learn_scope", {}, makeCtx({ cwd: dir }));
    assert.equal(r.details.target, "AGENTS.md");
    assert.equal(r.details.summary.learnedItems, 2);
    assert.ok(r.details.summary.bytes > 0);
  });
});

test("learn_scope 优先沿用已存在的 AGENTS.override.md", async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, "AGENTS.override.md"), "# override\n", "utf8");
    const pi = fakePi();
    learn(pi);
    const r = await callTool(pi, "learn_scope", {}, makeCtx({ cwd: dir }));
    assert.equal(r.details.target, "AGENTS.override.md");
  });
});

test("learn_scope 越界时拒绝", async () => {
  await withTempDir(async (dir) => {
    const pi = fakePi();
    learn(pi);
    const r = await callTool(pi, "learn_scope", { directory: join(dir, "..", "outside") }, makeCtx({ cwd: dir }));
    assert.equal(r.details.ok, false);
    assert.match(r.details.reason, /outside/);
  });
});

test("learn_scope 无 workspace 时给明确失败", async () => {
  const pi = fakePi();
  learn(pi);
  const r = await callTool(pi, "learn_scope", {}, { sessionManager: { getSessionId: () => "s" } });
  assert.equal(r.details.ok, false);
  assert.match(r.details.reason, /workspace root/);
});

/* ------------------------------------------------------------ learn_append：默认关闭 */

test("默认关闭：不写文件，并说清为什么", async () => {
  await withTempDir(async (dir) => {
    const pi = fakePi();
    learn(pi);
    const r = await callTool(pi, "learn_append", { insight: GOOD }, makeCtx({ cwd: dir }));

    assert.equal(r.details.ok, false);
    assert.match(r.details.reason, /disabled/);
    assert.ok(!existsSync(join(dir, "AGENTS.md")), "关闭时绝不能写文件");
  });
});

test("设置不为 true 时同样关闭", async () => {
  await withTempDir(async (dir) => {
    for (const values of [{}, { learnAppend: false }, { learnAppend: "yes" }]) {
      // 类型错（"yes"）走 settings.json 的真实读取路径，不塞 ctx（ctx 上没有 settings）。
      await runWithSettings(values, async () => {
        const pi = fakePi();
        learn(pi);
        const r = await callTool(pi, "learn_append", { insight: GOOD }, makeCtx({ cwd: dir }));
        assert.equal(r.details.ok, false);
      });
    }
    assert.ok(!existsSync(join(dir, "AGENTS.md")));
  });
});

test("符号链接目录指向工作区外时拒绝写入", async () => {
  await withTempDir(async (dir) => {
    await runWithSettings({ learnAppend: true }, async () => {
      const outside = mkdtempSync(join(tmpdir(), "learn-out-"));
      try {
        const link = join(dir, "linked");
        try {
          symlinkSync(outside, link, "dir");
        } catch {
          // Windows 无开发者模式/管理员权限时建不了目录符号链接；环境不支持就跳过。
          return;
        }
        const pi = fakePi();
        learn(pi);
        const r = await callTool(pi, "learn_append", { insight: GOOD, directory: link }, makeCtx({ cwd: dir }));
        assert.equal(r.details.ok, false, "realpath 防线必须拒绝链出 workspace 的目录");
        assert.ok(!existsSync(join(outside, "AGENTS.md")), "内容绝不能落到链接目标里");
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });
});

/* ------------------------------------------------------------ learn_append：开启 */

test("开启后真实写入，并建出 Learned 段", async () => {
  await withTempDir(async (dir) => {
    await runWithSettings({ learnAppend: true }, async () => {
      const pi = fakePi();
      learn(pi);
      const ctx = makeCtx({ cwd: dir });

      const r = await callTool(pi, "learn_append", { insight: GOOD, file: join(dir, "src", "api.ts") }, ctx);
      assert.equal(r.details.ok, true);
      assert.equal(r.details.added, true);
      assert.equal(r.details.target, "src/AGENTS.md");

      const written = readFileSync(join(dir, "src", "AGENTS.md"), "utf8");
      assert.ok(written.includes("## Learned"));
      assert.ok(written.includes("bun run generate"));
    });
  });
});

test("第二次写入追加在同一个 Learned 段内，不重复建标题", async () => {
  await withTempDir(async (dir) => {
    await runWithSettings({ learnAppend: true }, async () => {
      const pi = fakePi();
      learn(pi);
      const ctx = makeCtx({ cwd: dir });
      const file = join(dir, "src", "a.ts");

      await callTool(pi, "learn_append", { insight: GOOD, file }, ctx);
      await callTool(pi, "learn_append", { insight: "The lock file must be regenerated together with the client build.", file }, ctx);

      const written = readFileSync(join(dir, "src", "AGENTS.md"), "utf8");
      assert.equal(written.split("## Learned").length - 1, 1, "只应有一个 Learned 标题");
      assert.ok(written.includes("bun run generate"));
      assert.ok(written.includes("lock file must be regenerated"));
    });
  });
});

test("重复洞见不写第二次", async () => {
  await withTempDir(async (dir) => {
    await runWithSettings({ learnAppend: true }, async () => {
      const pi = fakePi();
      learn(pi);
      const ctx = makeCtx({ cwd: dir });

      const first = await callTool(pi, "learn_append", { insight: GOOD }, ctx);
      assert.equal(first.details.added, true);
      const before = readFileSync(join(dir, "AGENTS.md"), "utf8");

      const second = await callTool(pi, "learn_append", { insight: GOOD }, ctx);
      assert.equal(second.details.duplicate, true);
      assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), before, "内容不应变化");
    });
  });
});
test("校验不通过时不落盘", async () => {
  await withTempDir(async (dir) => {
    const pi = fakePi();
    learn(pi);
    const ctx = makeCtx({ cwd: dir });

    for (const insight of ["TODO", "TypeScript is a programming language.", "The user asked me to do this on 2026-10-22T21:06."]) {
      const r = await callTool(pi, "learn_append", { insight }, ctx);
      assert.equal(r.details.ok, false, insight);
    }
    assert.ok(!existsSync(join(dir, "AGENTS.md")), "被拒的洞见不应建文件");
  });
});

test("越界作用域被拒且不写工作区外", async () => {
  await withTempDir(async (dir) => {
    const outside = join(dir, "..", `outside-${Date.now()}`);
    const pi = fakePi();
    learn(pi);
    const r = await callTool(
      pi,
      "learn_append",
      { insight: GOOD, directory: outside },
      makeCtx({ cwd: dir }),
    );
    assert.equal(r.details.ok, false);
    assert.ok(!existsSync(join(outside, "AGENTS.md")), "绝不能写到工作区外");
  });
});

test("写入后不破坏既有内容", async () => {
  await withTempDir(async (dir) => {
    const original = ["# Project rules", "", "Always use pnpm.", "", "## Conventions", "", "- two spaces"].join("\n");
    writeFileSync(join(dir, "AGENTS.md"), original, "utf8");

    const pi = fakePi();
    learn(pi);
    await runWithSettings({ learnAppend: true }, () => callTool(pi, "learn_append", { insight: GOOD }, makeCtx({ cwd: dir })));

    const written = readFileSync(join(dir, "AGENTS.md"), "utf8");
    assert.ok(written.includes("# Project rules"));
    assert.ok(written.includes("Always use pnpm."));
    assert.ok(written.includes("## Conventions"));
    assert.ok(written.includes("- two spaces"));
    assert.ok(written.includes("bun run generate"));
  });
});

test("会话隔离：A 会话的写入计数不串到 B", async () => {
  await withTempDir(async (dir) => {
    await runWithSettings({ learnAppend: true }, async () => {
      const pi = fakePi();
      learn(pi);
      await callTool(pi, "learn_append", { insight: GOOD }, makeCtx({ cwd: dir, sessionId: "a" }));

      const b = await callTool(
        pi,
        "learn_append",
        { insight: "A completely different durable insight about caching layers." },
        makeCtx({ cwd: dir, sessionId: "b" }),
      );
      assert.equal(b.details.ok, true);
      assert.equal(b.details.log.appended, 1, "B 会话自己的计数应为 1");
    });
  });
});

test("session_shutdown 清理计数不抛", () => {
  const pi = fakePi();
  learn(pi);
  const ctx = makeCtx({ cwd: tmpdir(), sessionId: "x" });
  assert.doesNotThrow(() => pi.handlers.get("session_shutdown")[0]({ type: "session_shutdown" }, ctx));
});

test("目录不存在时会递归建目录再写", async () => {
  await withTempDir(async (dir) => {
    await runWithSettings({ learnAppend: true }, async () => {
      const deep = join(dir, "packages", "api", "src");
      mkdirSync(deep, { recursive: true });
      const pi = fakePi();
      learn(pi);
      const r = await callTool(
        pi,
        "learn_append",
        { insight: GOOD, directory: deep },
        makeCtx({ cwd: dir }),
      );
      assert.equal(r.details.ok, true);
      assert.ok(existsSync(join(deep, "AGENTS.md")));
    });
  });
});
