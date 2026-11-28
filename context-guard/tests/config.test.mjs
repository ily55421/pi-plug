import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { DEFAULTS, normalize, validate, matches } = require("../config.cjs");
const configured = { ...DEFAULTS, compressionMode: "dedicated", enabled: true, sourceProvider: "source", sourceModelId: "GPT/exact", sourceApi: "openai-responses", compressionProvider: "summary", compressionModelId: "small" };

test("默认关闭，空配置和畸形设置不触发", () => {
  assert.equal(DEFAULTS.enabled, false);
  for (const input of [undefined, null, [], "enabled", { enabled: "true" }]) assert.equal(matches({ provider: "source", id: "GPT/exact", api: "openai-responses" }, normalize(input)), false);
});
test("供应商、完整模型 ID、协议区分大小写且精确匹配", () => {
  const model = { provider: "source", id: "GPT/exact", api: "openai-responses" };
  assert.equal(matches(model, configured), true);
  for (const patch of [{ provider: "other" }, { id: "GPT" }, { id: "gpt/exact" }, { api: "openai-completions" }]) assert.equal(matches({ ...model, ...patch }, configured), false);
  assert.equal(matches(model, { ...configured, enabled: false }), false);
});
test("启用前必须填满匹配条件与压缩目标", () => {
  assert.deepEqual(validate(configured), configured);
  for (const key of ["sourceProvider", "sourceModelId", "sourceApi", "compressionProvider", "compressionModelId"]) assert.throws(() => validate({ ...configured, [key]: "  " }));
  assert.doesNotThrow(() => validate({ ...DEFAULTS }));
});
test("拒绝隐式类型、超限轮次和额外设置", () => {
  for (const threshold of [0, 1, 99, 100, 5.5, "90", NaN]) assert.throws(() => validate({ ...configured, threshold }));
  for (const threshold of [2, 90, 98]) assert.equal(validate({ ...configured, threshold }).threshold, threshold);
  assert.throws(() => validate({ ...configured, injected: true }));
  assert.throws(() => validate({ ...configured, sourceProvider: "a".repeat(257) }));
});
test("系统模式无需摘要模型，可对所有主模型启用", () => {
  assert.equal(DEFAULTS.compressionMode, "system");
  assert.equal(validate({ ...DEFAULTS, enabled: true }).enabled, true);
  assert.throws(() => validate({ ...DEFAULTS, enabled: true, sourceProvider: "half" }));
  assert.throws(() => validate({ ...DEFAULTS, compressionMode: "unknown" }));
  assert.throws(() => validate({ ...DEFAULTS, rescueOnLimit: "true" }));
});
