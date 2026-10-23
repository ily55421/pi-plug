import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PLUGIN_DATA_DIR = "local.format-on-edit";

/**
 * 在临时数据目录里跑一段测试。
 * values 为 undefined 表示「不写 settings.json」，插件走 manifest 默认值。
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

/** 不写 settings.json 的简写。 */
function runWithDefaults(fn) {
  return runWithSettings(undefined, fn);
}

import formatOnEdit from "../extension/index.mjs";
import { tagOf } from "../extension/core.mjs";

function fakePi() {
  const handlers = new Map();
  const tools = new Map();
  const logs = [];
  const execCalls = [];
  return {
    on(event, handler) {
      handlers.set(event, (handlers.get(event) ?? []).concat(handler));
    },
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    log(level, message, extra) {
      logs.push({ level, message, extra });
    },
    // 真实形状：exec 是工厂入参 pi 上的成员（runner.ts:923），不在事件 ctx 上。
    // 结果形状 { stdout, stderr, code, killed }（runner.ts:668）。
    // 测试里忽略命令语义，直接对 args 最后一项跑假 formatter。
    async exec(command, args, options) {
      execCalls.push({ command, args, options });
      const { execFile } = await import("node:child_process");
      const filePath = args[args.length - 1];
      return await new Promise((resolve) => {
        execFile(process.execPath, ["-e", FAKE_FORMATTER, "--", filePath], (error, stdout, stderr) => {
          resolve({ stdout: String(stdout), stderr: String(stderr), code: error ? 1 : 0, killed: false });
        });
      });
    },
    async emit(event, payload, ctx) {
      let acc;
      for (const handler of handlers.get(event) ?? []) {
        const next = await handler(payload, ctx);
        if (next !== undefined) acc = next;
      }
      return acc;
    },
    handlers,
    tools,
    logs,
    execCalls,
  };
}

/**
 * 假 formatter：用 node 跑一个小脚本，去掉行尾空白并把 3 个以上连续换行压成 1 个。
 * args 里最后一项是文件路径（前面的 flag 属于真实 formatter，不透传给 node）。
 */
const FAKE_FORMATTER = `
const fs = require("node:fs");
const file = process.argv[1];
const text = fs.readFileSync(file, "utf8");
const formatted = text.replace(/[ \\t]+$/gm, "").replace(/\\n{3,}/g, "\\n");
fs.writeFileSync(file, formatted);
`;

// 真实 tool_result 事件的 ctx（createContext，runner.ts:713-739）没有 exec ——
// exec 在 pi 上。这里只提供 ctx 真实拥有的成员。
function makeCtx({ cwd, sessionId = "s1" } = {}) {
  return {
    cwd,
    sessionManager: { getSessionId: () => sessionId },
  };
}

/* ------------------------------------------------------------ 注册面 */

test("注册一个事件与一个只读工具", () => {
  const pi = fakePi();
  formatOnEdit(pi);
  assert.deepEqual([...pi.handlers.keys()].sort(), ["session_shutdown", "tool_result"]);
  assert.deepEqual([...pi.tools.keys()], ["format_on_edit_status"]);
});

/* ------------------------------------------------------------ 宿主契约形状 */

test("exec 走 pi 而不是 ctx，且把超时交给宿主 SIGTERM", async () => {
  await runWithSettings({ formatOnEdit: true }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "foe-"));
    try {
      const file = join(dir, "a.go");
      writeFileSync(file, "package main\n\n\nfunc main(){}\n", "utf8");
      const pi = fakePi();
      formatOnEdit(pi);
      await pi.emit(
        "tool_result",
        { toolName: "Edit", toolCallId: "t", input: { path: file }, content: [{ type: "text", text: "edited" }], isError: false },
        makeCtx({ cwd: dir }),
      );
      assert.equal(pi.execCalls.length, 1, "formatter 应通过 pi.exec 执行");
      assert.equal(pi.execCalls[0].options?.timeout, 8000, "必须把 timeout 交给宿主，让宿主 SIGTERM 杀进程");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("格式化成功后把结果里残留的旧 tag 替换为新 tag", async () => {
  await runWithSettings({ formatOnEdit: true }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "foe-"));
    try {
      const file = join(dir, "a.go");
      writeFileSync(file, "package main\n\n\nfunc main(){}\n", "utf8");
      const oldTag = tagOf(readFileSync(file));
      const pi = fakePi();
      formatOnEdit(pi);
      const result = await pi.emit(
        "tool_result",
        {
          toolName: "Edit",
          toolCallId: "t",
          input: { path: file },
          // 模拟宿主真实结果：文本里带 [path#oldTag] 头
          content: [{ type: "text", text: `[a.go#${oldTag}]\n1: package main\n\nSuccessfully edited ${file}` }],
          isError: false,
        },
        makeCtx({ cwd: dir }),
      );
      assert.ok(result, "应返回替换后的结果");
      const text = result.content[0].text;
      const newTag = tagOf(readFileSync(file));
      assert.ok(!text.includes(`#${oldTag}]`), `旧 tag ${oldTag} 必须被替换掉`);
      assert.ok(text.includes(`#${newTag}]`), `新 tag ${newTag} 必须出现`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------ 默认关闭 */

test("默认关闭：即使写文件也不动工具结果", async () => {
  await runWithDefaults(async () => {
    const dir = mkdtempSync(join(tmpdir(), "foe-"));
    try {
      const file = join(dir, "a.go");
      writeFileSync(file, "package main\n\n\nfunc main(){}\n", "utf8");
      const pi = fakePi();
      formatOnEdit(pi);
      const result = await pi.emit(
        "tool_result",
        { toolName: "Edit", toolCallId: "t", input: { path: file }, content: [{ type: "text", text: "edited" }], isError: false },
        makeCtx({ cwd: dir }),
      );
      assert.equal(result, undefined, "未开启时不应改写结果");
      assert.ok(readFileSync(file, "utf8").includes("\n\n\n"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("设置为 false 或非布尔值时也不生效", async () => {
  for (const values of [{}, { formatOnEdit: false }, { formatOnEdit: "yes" }]) {
    await runWithSettings(values, async () => {
      const dir = mkdtempSync(join(tmpdir(), "foe-"));
      try {
        const file = join(dir, "a.go");
        writeFileSync(file, "x\n\n\ny\n", "utf8");
        const pi = fakePi();
        formatOnEdit(pi);
        const result = await pi.emit(
          "tool_result",
          { toolName: "Edit", toolCallId: "t", input: { path: file }, content: [], isError: false },
          makeCtx({ cwd: dir }),
        );
        assert.equal(result, undefined, JSON.stringify(values));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

/* ------------------------------------------------------------ 开启后：核心链路 */

test("开启后：真实格式化并把新 tag 回传（tag 必须变）", async () => {
  await runWithSettings({ formatOnEdit: true }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "foe-"));
    try {
      const file = join(dir, "a.go");
      writeFileSync(file, "package main\n\n\nfunc main(){}\n", "utf8");
      const oldTag = tagOf(readFileSync(file));

      const pi = fakePi();
      formatOnEdit(pi);
      const result = await pi.emit(
        "tool_result",
        { toolName: "Edit", toolCallId: "t", input: { path: file }, content: [{ type: "text", text: "edited ok" }], isError: false },
        makeCtx({ cwd: dir }),
      );

      assert.ok(result, "应返回替换后的结果");
      const text = result.content.map((c) => c.text).join("\n");
      assert.ok(text.includes("edited ok"), "原结果必须保留");
      assert.ok(text.includes("[format-on-edit]"));

      const afterContent = readFileSync(file, "utf8");
      assert.ok(!afterContent.includes("\n\n\n"), "连续空行应被压掉");

      const newTag = tagOf(afterContent);
      assert.notEqual(newTag, oldTag, "内容变了，tag 必须变");
      assert.ok(text.includes(newTag), "回传的新 tag 必须出现在结果里");
      assert.ok(text.includes(oldTag), "旧 tag 也应出现");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("内容未变化时仍回传当前 tag", async () => {
  await runWithSettings({ formatOnEdit: true }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "foe-"));
    try {
      const file = join(dir, "a.go");
      writeFileSync(file, "package main\nfunc main(){}\n", "utf8");
      const pi = fakePi();
      formatOnEdit(pi);
      const result = await pi.emit(
        "tool_result",
        { toolName: "Write", toolCallId: "t", input: { path: file }, content: [{ type: "text", text: "written" }], isError: false },
        makeCtx({ cwd: dir }),
      );
      const text = result.content.map((c) => c.text).join("\n");
      assert.ok(text.includes("Current file tag:"));
      assert.ok(!text.includes("changed from"));
      assert.ok(text.includes(tagOf(readFileSync(file))));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("行数变化会被写进结果", async () => {
  await runWithSettings({ formatOnEdit: true }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "foe-"));
    try {
      const file = join(dir, "a.go");
      writeFileSync(file, "a\n\n\n\nb\n", "utf8");
      const pi = fakePi();
      formatOnEdit(pi);
      const result = await pi.emit(
        "tool_result",
        { toolName: "Edit", toolCallId: "t", input: { path: file }, content: [{ type: "text", text: "ok" }], isError: false },
        makeCtx({ cwd: dir }),
      );
      assert.match(result.content.map((c) => c.text).join("\n"), /Line count changed by -\d+/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------ 各种闸门 */

test("工具调用失败 → 不格式化", async () => {
  await runWithSettings({ formatOnEdit: true }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "foe-"));
    try {
      const file = join(dir, "a.go");
      writeFileSync(file, "x\n\n\ny\n", "utf8");
      const pi = fakePi();
      formatOnEdit(pi);
      const result = await pi.emit(
        "tool_result",
        { toolName: "Edit", toolCallId: "t", input: { path: file }, content: [], isError: true },
        makeCtx({ cwd: dir }),
      );
      assert.equal(result, undefined);
      assert.ok(readFileSync(file, "utf8").includes("\n\n"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("非写文件工具 → 完全不动", async () => {
  await runWithSettings({ formatOnEdit: true }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "foe-"));
    try {
      const pi = fakePi();
      formatOnEdit(pi);
      const result = await pi.emit(
        "tool_result",
        { toolName: "Read", toolCallId: "t", input: { path: join(dir, "a.go") }, content: [], isError: false },
        makeCtx({ cwd: dir }),
      );
      assert.equal(result, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("无 formatter 的扩展名 → 不动", async () => {
  await runWithSettings({ formatOnEdit: true }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "foe-"));
    try {
      const file = join(dir, "a.zzz");
      writeFileSync(file, "x\n\n\ny\n", "utf8");
      const pi = fakePi();
      formatOnEdit(pi);
      const result = await pi.emit(
        "tool_result",
        { toolName: "Edit", toolCallId: "t", input: { path: file }, content: [], isError: false },
        makeCtx({ cwd: dir }),
      );
      assert.equal(result, undefined);
      assert.ok(readFileSync(file, "utf8").includes("\n\n"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("生成物目录 → 不动", async () => {
  await runWithSettings({ formatOnEdit: true }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "foe-"));
    try {
      mkdirSync(join(dir, "node_modules"), { recursive: true });
      const file = join(dir, "node_modules", "a.go");
      writeFileSync(file, "x\n\n\ny\n", "utf8");
      const pi = fakePi();
      formatOnEdit(pi);
      const result = await pi.emit(
        "tool_result",
        { toolName: "Edit", toolCallId: "t", input: { path: file }, content: [], isError: false },
        makeCtx({ cwd: dir }),
      );
      assert.equal(result, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("文件不存在 → 不动、不抛", async () => {
  await runWithSettings({ formatOnEdit: true }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "foe-"));
    try {
      const pi = fakePi();
      formatOnEdit(pi);
      const result = await pi.emit(
        "tool_result",
        { toolName: "Edit", toolCallId: "t", input: { path: join(dir, "missing.go") }, content: [], isError: false },
        makeCtx({ cwd: dir }),
      );
      assert.equal(result, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("formatter 失败 → 退回原结果并说明", async () => {
  await runWithSettings({ formatOnEdit: true }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "foe-"));
    try {
      const file = join(dir, "a.go");
      writeFileSync(file, "x\n\n\ny\n", "utf8");
      const pi = fakePi();
      formatOnEdit(pi);
      const ctx = makeCtx({ cwd: dir });
      pi.exec = async () => ({ code: 1, stdout: "", stderr: "boom", killed: false });

      const result = await pi.emit(
        "tool_result",
        { toolName: "Edit", toolCallId: "t", input: { path: file }, content: [{ type: "text", text: "edited" }], isError: false },
        ctx,
      );
      assert.ok(result);
      const text = result.content.map((c) => c.text).join("\n");
      assert.ok(text.includes("edited"));
      assert.ok(text.includes("skipped formatting"));
      assert.ok(text.includes("boom"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("exec 抛异常 → 同样退回并说明", async () => {
  await runWithSettings({ formatOnEdit: true }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "foe-"));
    try {
      const file = join(dir, "a.go");
      writeFileSync(file, "x\n\n\ny\n", "utf8");
      const pi = fakePi();
      formatOnEdit(pi);
      const ctx = makeCtx({ cwd: dir });
      pi.exec = async () => {
        throw new Error("spawn failed");
      };
      const result = await pi.emit(
        "tool_result",
        { toolName: "Edit", toolCallId: "t", input: { path: file }, content: [{ type: "text", text: "edited" }], isError: false },
        ctx,
      );
      assert.ok(result.content.map((c) => c.text).join("\n").includes("skipped formatting"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("content 里没有 text 段时追加一段说明", async () => {
  await runWithSettings({ formatOnEdit: true }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "foe-"));
    try {
      const file = join(dir, "a.go");
      writeFileSync(file, "x\n\n\ny\n", "utf8");
      const pi = fakePi();
      formatOnEdit(pi);
      const result = await pi.emit(
        "tool_result",
        { toolName: "Edit", toolCallId: "t", input: { path: file }, content: [], isError: false },
        makeCtx({ cwd: dir }),
      );
      assert.equal(result.content[0].type, "text");
      assert.ok(result.content[0].text.includes("[format-on-edit]"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("相对路径按会话 cwd 解析", async () => {
  await runWithSettings({ formatOnEdit: true }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "foe-"));
    try {
      writeFileSync(join(dir, "a.go"), "x\n\n\ny\n", "utf8");
      const pi = fakePi();
      formatOnEdit(pi);
      const result = await pi.emit(
        "tool_result",
        { toolName: "Edit", toolCallId: "t", input: { path: "a.go" }, content: [{ type: "text", text: "ok" }], isError: false },
        makeCtx({ cwd: dir }),
      );
      assert.ok(result);
      assert.ok(!readFileSync(join(dir, "a.go"), "utf8").includes("\n\n"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------ 状态工具 */

test("状态工具报告关闭状态", async () => {
  await runWithDefaults(async () => {
    const pi = fakePi();
    formatOnEdit(pi);
    const result = await pi.tools.get("format_on_edit_status").execute("c", {}, undefined, undefined, makeCtx({ cwd: tmpdir() }));
    assert.ok(result.content[0].text.includes("enabled: false"));
    assert.equal(result.details.enabled, false);
  });
});

test("状态工具反映已开启", async () => {
  await runWithSettings({ formatOnEdit: true }, async () => {
    const pi = fakePi();
    formatOnEdit(pi);
    const result = await pi.tools.get("format_on_edit_status").execute("c", {}, undefined, undefined, makeCtx({ cwd: tmpdir() }));
    assert.ok(result.content[0].text.includes("enabled: true"));
  });
});

test("session_shutdown 清理统计不抛", async () => {
  await runWithDefaults(async () => {
    const pi = fakePi();
    formatOnEdit(pi);
    const ctx = makeCtx({ cwd: tmpdir(), sessionId: "del" });
    assert.doesNotThrow(() => pi.handlers.get("session_shutdown")[0]({ type: "session_shutdown" }, ctx));
  });
});

test("payload 缺字段时安静返回", async () => {
  await runWithSettings({ formatOnEdit: true }, async () => {
    const pi = fakePi();
    formatOnEdit(pi);
    const ctx = makeCtx({ cwd: tmpdir() });
    assert.equal(await pi.emit("tool_result", {}, ctx), undefined);
    assert.equal(await pi.emit("tool_result", undefined, ctx), undefined);
  });
});
