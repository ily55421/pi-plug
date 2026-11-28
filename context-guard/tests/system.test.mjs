import test from "node:test";
import assert from "node:assert/strict";
import config from "../config.cjs";
import backend from "../system-engine.cjs";
import { registerGuard } from "../extension/core.mjs";
import { limitError } from "../extension/system.mjs";
const { createSystemEngine, countOf } = backend;
function fixture(patch = {}) {
  let settings = { ...config.DEFAULTS, enabled: true, threshold: 2, ...patch };
  let telemetry = {}; let control = {}; let clock = 1000;
  const calls = []; const queued = []; const hud = []; const reports = [];
  const behavior = { busy: false, fail: null, accepted: true, beforeStore: null, gate: null };
  const model = { provider: "source", id: "exact", api: "openai-responses" };
  const ctx = { model, sessionManager: { getSessionId: () => "s", getBranch: () => [], getLeafId: () => null }, modelRegistry: { find() {} },
    compact: (...args) => { queued.push(args); }, ui: { setStatus: (...args) => hud.push(args) }, isIdle: () => false, hasPendingMessages: () => false };
  const handlers = registerGuard({ on() {} }, { readSettings: () => settings, readState: () => telemetry, readControl: () => control,
    publish: async value => { telemetry = value; reports.push(value); }, now: () => ++clock });
  const engine = createSystemEngine({ getSettings: async () => settings, readTelemetry: async () => telemetry, readControl: async () => control,
    writeControl: async (_id, value) => { control = value; behavior.beforeStore?.(value); },
    getCapabilities: async () => ({ available: true }), delay: async () => {}, now: () => ++clock,
    invoke: async (operation, args) => {
      calls.push({ operation, args });
      if (operation === "agent/getStatus") return { status: { isRunning: behavior.busy } };
      assert.equal(operation, "agent/compact"); assert.deepEqual(args, [{ sessionId: "s" }]);
      if (behavior.fail) throw behavior.fail;
      if (behavior.gate) return behavior.gate();
      return { accepted: behavior.accepted };
    },
  });
  return { handlers, engine, ctx, calls, queued, hud, reports, behavior,
    settings: () => settings, change: patch => { settings = { ...settings, ...patch }; },
    telemetry: () => telemetry, setTelemetry: value => { telemetry = value; }, control: () => control,
    turn: async index => handlers.turn_start({ turnIndex: index, timestamp: index }, ctx),
    ended: (id, reason = "completed") => engine.onTurnEnded({ sessionId: "s", turnId: id, reason }),
  };
}
const compacts = f => f.calls.filter(call => call.operation === "agent/compact");

test("普通桌面系统模式可运行，不再显示宿主不支持", async () => {
  const f = fixture(); await f.handlers.session_start({}, f.ctx);
  assert.equal(f.reports.at(-1).capability, "system"); assert.equal(f.reports.at(-1).phase, "ready");
  assert.equal(f.hud.some(args => args[1]?.includes("宿主不支持")), false);
  assert.equal((await f.engine.snapshot("s")).systemAvailable, true);
});
test("工具循环按模型轮次记录，达到阈值同步置 pending，不重复排队", async () => {
  const f = fixture(); await f.turn(1); assert.equal(f.queued.length, 0);
  const pending = f.handlers.turn_start({ turnIndex: 2 }, f.ctx);
  assert.equal(f.queued.length, 1, "不能等文件写入后才设置原生 pending"); await pending;
  await f.turn(2); await f.handlers.turn_end({ turnIndex: 2 }, f.ctx);
  assert.equal(f.telemetry().requestSerial, 2); assert.equal(f.queued.length, 1);
  assert.equal(await f.handlers.session_before_compact({ reason: "manual" }, f.ctx), undefined);
  await f.handlers.session_compact({}, f.ctx);
  assert.equal(f.telemetry().count, 0); assert.equal(f.telemetry().countExact, true);
  await f.turn(3); assert.equal(f.telemetry().count, 1);
});
test("单轮任务无下一模型轮次时，由官方 agent/compact 补执行并重建基线", async () => {
  const f = fixture(); await f.turn(1); await f.turn(2);
  const result = await f.ended("t1"); assert.equal(result.ok, true);
  assert.equal(compacts(f).length, 1); assert.equal(countOf(f.telemetry(), f.control()), 0);
  await f.ended("t1"); await f.ended("t2"); assert.equal(compacts(f).length, 1);
  assert.ok(!f.calls.some(call => /abort|prompt|configure/.test(call.operation)));
  assert.equal(f.ctx.model.id, "exact");
});
test("先在工具循环完成了系统压缩时，不再于宿主结束事件重复执行", async () => {
  const f = fixture(); await f.turn(1); await f.turn(2); await f.handlers.session_compact({}, f.ctx);
  await f.ended("done"); assert.equal(compacts(f).length, 0);
});
test("100轮上限明确识别，任意服务错误或普通文本不会误触发", async () => {
  const f = fixture(); await f.turn(1);
  const error = { stopReason: "error", errorMessage: 'custom API error (400): {"code":"session_turn_limit_exceeded","message":"This conversation has reached 100 model turns."}' };
  assert.equal(limitError(error), true); assert.equal(limitError({ stopReason: "stop", content: [{ type: "text", text: error.errorMessage }] }), false);
  assert.equal(limitError({ stopReason: "error", errorMessage: "HTTP 503" }), false);
  await f.handlers.message_end({ message: error }, f.ctx);
  assert.equal(f.telemetry().limitExceeded, true); assert.equal("errorMessage" in f.telemetry(), false);
  const result = await f.ended("limit", "error"); assert.equal(result.ok, true); assert.equal(compacts(f).length, 1);
  const unrelated = fixture(); await unrelated.turn(1); await unrelated.turn(2);
  await unrelated.ended("503", "error"); assert.equal(compacts(unrelated).length, 0);
});
test("上限恢复开关关闭或用户取消时不自动压缩", async () => {
  for (const patch of [{ rescueOnLimit: false }, { enabled: false }]) {
    const f = fixture(patch); await f.turn(1);
    await f.handlers.message_end({ message: { stopReason: "error", errorMessage: "session_turn_limit_exceeded" } }, f.ctx);
    await f.ended("error", "error"); assert.equal(compacts(f).length, 0);
  }
  const f = fixture(); await f.turn(1); await f.turn(2); await f.ended("cancel", "aborted"); assert.equal(compacts(f).length, 0);
});
test("自动排队后关闭规则或切模式，压缩前取消自身请求而非回落主模型", async () => {
  for (const patch of [{ enabled: false }, { compressionMode: "dedicated" }]) {
    const f = fixture(); await f.turn(1); await f.turn(2); f.change(patch);
    assert.deepEqual(await f.handlers.session_before_compact({}, f.ctx), { cancel: true });
    await f.ended("off"); assert.equal(compacts(f).length, 0);
  }
});
test("自动调度落盘期间关闭开关，官方命令不被调用", async () => {
  const f = fixture(); await f.turn(1); await f.turn(2);
  f.behavior.beforeStore = state => { if (state.phase === "compacting") f.change({ enabled: false }); };
  const result = await f.ended("race"); assert.equal(result.code, "CANCELLED"); assert.equal(compacts(f).length, 0);
});
test("忙碌时不终止任务，下一次空闲结束可重试", async () => {
  const f = fixture(); await f.turn(1); await f.turn(2); f.behavior.busy = true;
  assert.equal((await f.ended("busy")).code, "AGENT_BUSY"); assert.equal(compacts(f).length, 0);
  f.behavior.busy = false; assert.equal((await f.ended("idle")).ok, true); assert.equal(compacts(f).length, 1);
});
test("系统失败不清零、不循环重试；用户显式手动重试可恢复", async () => {
  const f = fixture(); await f.turn(1); await f.turn(2);
  f.behavior.fail = new Error("包含私密信息的供应商错误");
  assert.equal((await f.ended("fail")).ok, false); assert.equal(countOf(f.telemetry(), f.control()), 2);
  await f.ended("again"); assert.equal(compacts(f).length, 1);
  assert.equal(JSON.stringify(f.control()).includes("私密信息"), false);
  f.behavior.fail = null; assert.equal((await f.engine.compact("s", { manual: true })).ok, true);
  assert.equal(countOf(f.telemetry(), f.control()), 0);
});
test("关闭自动规则仍可手动压缩，结果未确认不能宣称成功", async () => {
  const f = fixture({ enabled: false });
  assert.equal((await f.engine.compact("s", { manual: true })).ok, true);
  const unconfirmed = fixture(); await unconfirmed.turn(1); unconfirmed.behavior.accepted = false;
  const result = await unconfirmed.engine.compact("s", { manual: true });
  assert.equal(result.ok, false); assert.equal(unconfirmed.control().lastCompactAt, undefined);
});
test("同一会话并发点击只发送一次系统命令", async () => {
  const f = fixture(); let release;
  f.behavior.gate = () => new Promise(resolve => { release = resolve; });
  const first = f.engine.compact("s", { manual: true });
  for (let i = 0; i < 10 && !release; i++) await new Promise(setImmediate);
  assert.equal(typeof release, "function");
  assert.equal((await f.engine.compact("s", { manual: true })).code, "AGENT_BUSY");
  release({ accepted: true }); assert.equal((await first).ok, true); assert.equal(compacts(f).length, 1);
});
test("旧版或过时遥测不再被当作当前 ready/success", async () => {
  const f = fixture({ enabled: false });
  f.setTelemetry({ sessionId: "s", phase: "ready", updatedAt: 1, count: 80 });
  const status = await f.engine.snapshot("s"); assert.equal(status.phase, "disabled"); assert.equal(status.count, null);
});
test("从磁盘恢复观察序号时不宣称覆盖了离线期间的请求", async () => {
  const reports = [];
  const handlers = registerGuard({ on() {} }, { readSettings: () => ({ ...config.DEFAULTS }),
    readState: () => ({ schemaVersion: 2, sessionId: "reload", requestSerial: 20, checkpointSerial: 10, countExact: true }),
    publish: async value => reports.push(value) });
  await handlers.session_start({}, { model: {}, sessionManager: { getSessionId: () => "reload" }, ui: {} });
  assert.equal(reports.at(-1).count, 10); assert.equal(reports.at(-1).countExact, false);
});
