import test from "node:test";
import assert from "node:assert/strict";
import config from "../config.cjs";
import { registerGuard, nativeCapabilities, branchState, summaryPrompt, PLUGIN_ID } from "../extension/core.mjs";
const source = { provider: "main", id: "gpt/exact", api: "openai-responses" };
const target = { provider: "summary", id: "long", api: "anthropic-messages", contextWindow: 200000, maxTokens: 8192 };
const assistant = id => ({ id, type: "message", message: { role: "assistant", content: "完成", stopReason: "stop" } });
function fixture(patch = {}) {
  let settings = { ...config.DEFAULTS, compressionMode: "dedicated", enabled: true, sourceProvider: source.provider, sourceModelId: source.id,
    sourceApi: source.api, compressionProvider: target.provider, compressionModelId: target.id, threshold: 2, ...patch };
  const branch = [assistant("1"), assistant("2")];
  const reports = []; const calls = []; const compacts = [];
  const ctx = { model: { ...source }, sessionManager: { getSessionId: () => "test-session", getBranch: () => branch },
    modelRegistry: { find: (provider, id) => provider === target.provider && id === target.id ? target : undefined,
      complete: async (...args) => { calls.push(args); return { content: [{ type: "text", text: "# 目标\n实现插件\n# 进度\n已完成配置界面" }], stopReason: "stop" }; } },
    compact: options => { compacts.push(options); }, ui: { setStatus() {} },
    isIdle: () => true, hasPendingMessages: () => false,
  };
  const handlers = registerGuard({ on() {}, setModel() { assert.fail("绝不能切换会话主模型"); } }, {
    readSettings: () => settings, publish: async status => reports.push(status), now: () => 12345,
  });
  const controller = new AbortController();
  const event = { branchEntries: branch, signal: controller.signal, preparation: {
    firstKeptEntryId: "2", tokensBefore: 10000, messagesToSummarize: [{ role: "user", content: "实现插件" }],
    turnPrefixMessages: [{ role: "assistant", content: "已完成配置界面" }], previousSummary: "此前确定默认关闭",
  } };
  return { ctx, event, controller, branch, reports, calls, compacts, handlers,
    change: patch => { settings = { ...settings, ...patch }; } };
}

test("当前桌面兼容契约被正确拒绝，不伪造计数或触发压缩", async () => {
  const f = fixture(); delete f.ctx.modelRegistry.complete; f.ctx.sessionManager.getBranch = () => [];
  assert.equal(nativeCapabilities(f.ctx), false);
  await f.handlers.session_start({}, f.ctx); await f.handlers.agent_end({}, f.ctx);
  assert.equal(await f.handlers.session_before_compact({}, f.ctx), undefined);
  assert.equal(f.reports.at(-1).phase, "unsupported"); assert.equal(f.reports.at(-1).count, null);
  assert.equal(f.compacts.length, 0); assert.equal(f.calls.length, 0);
});
test("默认关闭与精确匹配失败时不改宿主行为", async () => {
  for (const patch of [{ enabled: false }, { sourceApi: "other" }, { sourceProvider: "other" }, { sourceModelId: "gpt" }]) {
    const f = fixture(patch);
    await f.handlers.agent_settled({}, f.ctx);
    assert.equal(await f.handlers.session_before_compact(f.event, f.ctx), undefined);
    assert.equal(f.calls.length + f.compacts.length, 0);
  }
});
test("恢复计数按检查点归零、去重，排除失败/取消及工具结果", () => {
  const f = fixture();
  f.branch.push({ id: "cp", type: "compaction" }, assistant("3"), assistant("3"),
    { id: "4", type: "message", message: { role: "toolResult" } },
    { id: "5", type: "message", message: { role: "assistant", stopReason: "error" } });
  assert.deepEqual(branchState(f.ctx), { checkpoint: "cp", count: 1 });
});
test("启动只读取，任务结束到达阈值仅申请一次原生压缩", async () => {
  const f = fixture();
  await f.handlers.session_start({}, f.ctx); assert.equal(f.compacts.length, 0);
  await f.handlers.agent_settled({}, f.ctx); await f.handlers.agent_settled({}, f.ctx);
  assert.equal(f.compacts.length, 1); assert.equal(f.reports.at(-1).phase, "compacting");
  assert.deepEqual(f.ctx.model, source);
});
test("专用模型摘要保留原生边界，成功必须收到匹配的检查点确认", async () => {
  const f = fixture();
  const result = await f.handlers.session_before_compact(f.event, f.ctx);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], target);
  assert.equal(f.calls[0][2].signal, f.event.signal);
  assert.equal(result.compaction.firstKeptEntryId, "2"); assert.equal(result.compaction.tokensBefore, 10000);
  assert.equal(f.reports.at(-1).phase, "compacting");
  f.branch.push({ type: "compaction", id: "cp", ...result.compaction });
  await f.handlers.session_compact({ fromExtension: true, compactionEntry: f.branch.at(-1) }, f.ctx);
  assert.equal(f.reports.at(-1).phase, "success"); assert.equal(f.reports.at(-1).count, 0);
  assert.equal(f.reports.at(-1).lastCompactAt, 12345); assert.deepEqual(f.ctx.model, source);
});
test("其他插件或宿主默认压缩不会被计为本插件成功", async () => {
  const f = fixture();
  await f.handlers.session_compact({ fromExtension: false, compactionEntry: { details: { plugin: PLUGIN_ID } } }, f.ctx);
  assert.notEqual(f.reports.at(-1).phase, "success"); assert.equal(f.reports.at(-1).lastCompactAt, null);
});
test("压缩失败后取消，不回退使用主模型，不循环自动重试", async () => {
  const f = fixture();
  f.ctx.modelRegistry.complete = async () => { throw new Error("不要把供应商原始错误或凭据写入状态"); };
  assert.deepEqual(await f.handlers.session_before_compact(f.event, f.ctx), { cancel: true });
  await f.handlers.agent_settled({}, f.ctx); assert.equal(f.compacts.length, 0);
  assert.equal(f.reports.at(-1).phase, "cooldown");
  assert.equal(JSON.stringify(f.reports).includes("供应商原始错误或凭据"), false);
  f.change({ threshold: 3 }); await f.handlers.agent_settled({}, f.ctx); assert.equal(f.reports.at(-1).phase, "ready");
});
test("取消和生成期间修改配置均阻止检查点提交", async () => {
  const aborted = fixture(); aborted.controller.abort();
  assert.deepEqual(await aborted.handlers.session_before_compact(aborted.event, aborted.ctx), { cancel: true });
  assert.equal(aborted.calls.length, 0);
  const changed = fixture(); changed.ctx.modelRegistry.complete = async () => {
    changed.change({ enabled: false }); return { content: [{ type: "text", text: "旧配置结果" }] };
  };
  assert.deepEqual(await changed.handlers.session_before_compact(changed.event, changed.ctx), { cancel: true });
});
test("缺少原生边界、目标模型缺失或窗口不足时取消", async () => {
  const malformed = fixture(); delete malformed.event.preparation.firstKeptEntryId;
  assert.deepEqual(await malformed.handlers.session_before_compact(malformed.event, malformed.ctx), { cancel: true });
  assert.equal(malformed.calls.length, 0);
  const missing = fixture({ compressionModelId: "removed" });
  assert.deepEqual(await missing.handlers.session_before_compact(missing.event, missing.ctx), { cancel: true });
  const small = fixture(); small.ctx.modelRegistry.find = () => ({ ...target, contextWindow: 2048 });
  assert.deepEqual(await small.handlers.session_before_compact(small.event, small.ctx), { cancel: true });
  assert.equal(small.calls.length, 0);
});
test("空摘要、截断摘要与 provider 失败不能写入检查点", async () => {
  for (const result of [{ content: [] }, { content: [{ type: "text", text: "截断" }], stopReason: "length" },
    { content: [{ type: "text", text: "错误" }], stopReason: "error" }]) {
    const f = fixture(); f.ctx.modelRegistry.complete = async () => result;
    assert.deepEqual(await f.handlers.session_before_compact(f.event, f.ctx), { cancel: true });
  }
});
test("摘要包含此前摘要、待压缩历史与分割轮次，不携带思考签名和图片编码", () => {
  const f = fixture(); f.event.preparation.messagesToSummarize.push({ role: "assistant", content: [
    { type: "thinking", thinking: "秘密思考", signature: "签名" }, { type: "image", data: "BASE64_IMAGE" },
    { type: "toolCall", name: "Read", arguments: { path: "main.cjs" } },
  ] });
  const prompt = summaryPrompt(f.event.preparation, "保留测试结果");
  for (const text of ["此前确定默认关闭", "实现插件", "已完成配置界面", "main.cjs", "保留测试结果"]) assert.ok(prompt.includes(text));
  assert.equal(prompt.includes("BASE64_IMAGE"), false); assert.equal(prompt.includes("秘密思考"), false);
});
test("不同会话的暂停状态互不污染", async () => {
  const f = fixture();
  await f.handlers.session_compact_failed({}, f.ctx);
  f.ctx.sessionManager.getSessionId = () => "another-session";
  await f.handlers.agent_settled({}, f.ctx); assert.equal(f.compacts.length, 1);
  assert.equal(f.reports.at(-1).sessionId, "another-session");
});
test("运行中或存在排队消息时不自动压缩", async () => {
  for (const patch of [{ isIdle: () => false }, { hasPendingMessages: () => true }]) {
    const f = fixture(); Object.assign(f.ctx, patch);
    await f.handlers.agent_settled({}, f.ctx); assert.equal(f.compacts.length, 0);
    assert.equal(f.reports.at(-1).phase, "ready");
  }
});
test("分支或模型查询异常时取消定向压缩，不意外回落到主模型", async () => {
  const branch = fixture(); branch.ctx.sessionManager.getBranch = () => { throw new Error("读取失败"); };
  assert.deepEqual(await branch.handlers.session_before_compact(branch.event, branch.ctx), { cancel: true });
  const model = fixture(); model.ctx.modelRegistry.find = () => { throw new Error("查询失败"); };
  assert.deepEqual(await model.handlers.session_before_compact(model.event, model.ctx), { cancel: true });
});
test("真实生命周期：agent_end 仍忙，agent_settled 空闲后才触发", async () => {
  const f = fixture(); let idle = false; f.ctx.isIdle = () => idle;
  await f.handlers.agent_end({}, f.ctx); assert.equal(f.compacts.length, 0);
  idle = true; await f.handlers.agent_settled({}, f.ctx); assert.equal(f.compacts.length, 1);
});
