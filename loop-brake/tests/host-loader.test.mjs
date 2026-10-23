/**
 * 经宿主同款 loader 的集成测试（可选，需要 jiti）。
 *
 * 与 extension.test.mjs 的区别：
 *   - extension.test.mjs 直接 `import` 入口，验证的是「插件自己的逻辑」；
 *   - 本文件用 PI-Desktop `loader.ts` 完全相同的方式（`await import("jiti/static")`
 *     + `createJiti(..., { moduleCache: false, tryNative: false, virtualModules })`
 *     + `jiti.import(entry, { default: true })`）加载入口，验证的是
 *     「宿主的加载路径能真的取出并执行这个模块」——这是打包后最容易翻车的一环。
 *
 * 为什么默认跳过：pi-plug 工作区本身不带依赖，`jiti` 需要现装。为了不让
 * `npm test` 因为缺一个可选依赖就失败，这里做成「装了就跑，没装就明确跳过并说明」，
 * 而不是静默通过。
 *
 * 跑法（在装了 jiti 的环境里）：
 *   npm i --no-save jiti
 *   node --test tests/host-loader.test.mjs
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "extension", "index.mjs");

/** jiti 是否可用：可用返回 createJiti，不可用返回 null。 */
async function loadJiti() {
  try {
    const mod = await import("jiti/static");
    return typeof mod.createJiti === "function" ? mod.createJiti : null;
  } catch {
    return null;
  }
}

/** 宿主的加载方式（照 loader.ts:158-166）。 */
async function loadLikeHost() {
  const createJiti = await loadJiti();
  if (!createJiti) return null;
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    tryNative: false,
    virtualModules: {},
  });
  const loaded = await jiti.import(entry, { default: true });
  return typeof loaded === "function" ? loaded : null;
}

/** 假 pi：与 extension.test.mjs 同形，足以驱动入口。 */
function fakePi() {
  const handlers = new Map();
  const tools = new Map();
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    registerCommand() {},
    log() {},
  };
  return { pi, handlers, tools };
}

test("经宿主同款 jiti loader 能取出 default 工厂函数", async (t) => {
  const factory = await loadLikeHost();
  if (!factory) {
    t.skip("跳过：本环境未安装 jiti（npm i --no-save jiti 后可跑）");
    return;
  }
  assert.equal(typeof factory, "function");
});

test("加载后按契约订阅事件并注册只读工具", async (t) => {
  const factory = await loadLikeHost();
  if (!factory) {
    t.skip("跳过：本环境未安装 jiti");
    return;
  }

  const { pi, handlers, tools } = fakePi();
  factory(pi);

  assert.deepEqual([...handlers.keys()].sort(), ["context", "session_shutdown", "tool_call"]);
  assert.ok(tools.has("loop_brake_status"));
});

test("真实事件形状下：3 次放行、第 4 次按契约返回 { block, reason }", async (t) => {
  const factory = await loadLikeHost();
  if (!factory) {
    t.skip("跳过：本环境未安装 jiti");
    return;
  }

  const { pi, handlers } = fakePi();
  factory(pi);

  // 事件形状照 runtime.ts:2032；ctx 形状照 runner.ts:713。
  const ctx = { sessionManager: { getSessionId: () => "integration-session" } };
  const event = { type: "tool_call", toolName: "Read", toolCallId: "t1", input: { file_path: "/a" } };
  const fire = () => handlers.get("tool_call")(event, ctx);

  assert.equal(await fire(), undefined);
  assert.equal(await fire(), undefined);
  assert.equal(await fire(), undefined); // warn 阶段不阻断

  const blocked = await fire();
  assert.equal(blocked.block, true);
  assert.ok(typeof blocked.reason === "string" && blocked.reason.length > 0);
});

test("context 事件按契约返回 { messages } 而非就地修改", async (t) => {
  const factory = await loadLikeHost();
  if (!factory) {
    t.skip("跳过：本环境未安装 jiti");
    return;
  }

  const { pi, handlers } = fakePi();
  factory(pi);
  const ctx = { sessionManager: { getSessionId: () => "integration-ctx" } };

  const event = { type: "tool_call", toolName: "Grep", toolCallId: "t", input: { pattern: "x" } };
  await handlers.get("tool_call")(event, ctx);
  await handlers.get("tool_call")(event, ctx);
  await handlers.get("tool_call")(event, ctx); // 攒下警告

  const messages = [{ role: "user", content: "hi" }];
  const result = await handlers.get("context")({ type: "context", messages }, ctx);

  assert.ok(Array.isArray(result?.messages));
  assert.equal(result.messages.length, 2);
  assert.equal(messages.length, 1, "原数组不应被就地修改");
});

/* eslint-disable-next-line no-unused-vars -- 保留给未来需要 require 的场景 */
const _require = createRequire(import.meta.url);
