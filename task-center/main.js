"use strict";

const { randomUUID } = require("node:crypto");
const state = require("./state.cjs");
const manifest = require("./manifest.json");
const { readSettingsFile, MAX_BYTES } = require("./storage.cjs");
// 不同会话也共享一份设置文件，因此在插件进程内串行进行整个读改写。
let writes = Promise.resolve();

function cancelled(ctx) {
  if (ctx?.signal?.aborted) state.fail("ABORTED", "调用已取消，未保存任务清单。");
}
function errorResult(error) {
  return { ok: false, code: error.code || "TASK_CENTER_ERROR", message: error.message || "任务中心操作失败。" };
}
async function settingsOf() {
  try {
    if (typeof pi.plugin.getDataPath !== "function") state.fail("HOST_UNSUPPORTED", "宿主缺少插件私有数据路径接口。");
    const directory = await pi.plugin.getDataPath();
    if (typeof directory !== "string" || !directory) state.fail("STORAGE_READ_FAILED", "插件私有数据路径不可用。");
    return await readSettingsFile(directory);
  } catch (error) {
    if (["STATE_CORRUPT", "STATE_TOO_LARGE", "HOST_UNSUPPORTED"].includes(error.code)) throw error;
    state.fail("STORAGE_READ_FAILED", "任务清单读取失败，无法确认是否还有剩余任务。请稍后重试。");
  }
}
function enqueue(operation) {
  const result = writes.then(operation);
  writes = result.catch(() => undefined);
  return result;
}
function compact(snapshot) {
  const { ok, sessionId, runId, revision, updatedAt, total, counts, finished, percent, remainingCount, current, legacyAvailable } = snapshot;
  return { ok, sessionId, runId, revision, updatedAt, total, counts, finished, percent, remainingCount, current: current?.content ?? null, legacyAvailable };
}

async function executeTodoWrite(args, ctx) {
  try {
    const sessionId = state.sessionIdOf(ctx);
    cancelled(ctx);
    const { todos, notes } = state.normalizeTodos(args?.todos);
    if (args?.expectedRevision !== undefined && (!Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0)) {
      state.fail("INVALID_REVISION", "expectedRevision 必须是非负安全整数。");
    }
    if (args?.newPlan !== undefined && typeof args.newPlan !== "boolean") state.fail("INVALID_ARGUMENT", "newPlan 必须是布尔值。");
    return await enqueue(async () => {
      cancelled(ctx);
      const settings = await settingsOf();
      cancelled(ctx);
      const previous = state.stateOf(settings, sessionId);
      if (args.expectedRevision !== undefined && args.expectedRevision !== previous.revision) {
        return { ok: false, code: "REVISION_CONFLICT", revision: previous.revision, runId: previous.runId, message: "清单已被更新，请先 todo_read，再合并并使用最新 revision 提交。" };
      }
      const newPlan = args.newPlan === true || !previous.runId ||
        (state.summarize(previous.todos).remainingCount === 0 && state.summarize(todos).remainingCount > 0);
      if (!newPlan && JSON.stringify(previous.todos) === JSON.stringify(todos)) {
        return { ...compact(state.snapshot(settings, sessionId)), unchanged: true, notes };
      }
      if (previous.revision >= Number.MAX_SAFE_INTEGER) state.fail("REVISION_LIMIT", "清单版本已达上限，请导出数据后联系维护者。");
      const next = {
        todos, runId: newPlan ? randomUUID() : previous.runId,
        revision: previous.revision + 1, updatedAt: Date.now(),
      };
      const store = state.storeOf(settings);
      const updated = { version: state.VERSION, sessions: { ...store.sessions, [`session:${sessionId}`]: next } };
      const defaults = Object.fromEntries(manifest.contributes.settings.map((setting) => [setting.key, setting.default]));
      if (Buffer.byteLength(JSON.stringify({ ...defaults, ...settings, [state.KEY]: updated }, null, 2), "utf8") > MAX_BYTES) {
        state.fail("STATE_TOO_LARGE", "全部会话清单超过 8 MiB，未保存。请归档旧会话后重试。");
      }
      cancelled(ctx);
      try { await pi.plugin.setSettings({ [state.KEY]: updated }); }
      catch { state.fail("STORAGE_WRITE_FAILED", "任务清单保存失败，请读取当前版本后重试。"); }
      return { ...compact(state.snapshot({ ...settings, [state.KEY]: updated }, sessionId)), notes };
    });
  } catch (error) { return errorResult(error); }
}

async function executeTodoRead(args, ctx) {
  try {
    const sessionId = state.sessionIdOf(ctx);
    cancelled(ctx);
    if (args?.detail !== undefined && !["summary", "full"].includes(args.detail)) state.fail("INVALID_ARGUMENT", "detail 只能为 summary 或 full。");
    await writes;
    const settings = await settingsOf();
    cancelled(ctx);
    const snapshot = state.snapshot(settings, sessionId);
    if (args?.detail === "summary") return compact(snapshot);
    // 默认返回一次完整清单，不再叠加 remaining 全文和格式化副本。
    return { ...compact(snapshot), todos: snapshot.todos };
  } catch (error) { return errorResult(error); }
}

async function activeId() {
  if (typeof pi.session?.getActive !== "function") state.fail("HOST_UNSUPPORTED", "当前宿主不支持读取当前会话，请升级 PI-Desktop。");
  const active = await pi.session.getActive();
  const id = active?.sessionId ?? active?.id;
  if (typeof id !== "string" || !id) state.fail("NO_ACTIVE_SESSION", "当前没有打开的会话。");
  return state.sessionIdOf({ sessionId: id });
}

async function onPanelInvoke(channel, payload) {
  try {
    if (channel !== "taskCenter.snapshot") state.fail("UNKNOWN_CHANNEL", "不支持的任务中心接口。");
    if (payload !== undefined && !state.record(payload)) state.fail("INVALID_ARGUMENT", "快照参数必须为对象。");
    const sessionId = await activeId();
    await writes;
    const settings = await settingsOf();
    const result = state.snapshot(settings, sessionId);
    if (await activeId() !== sessionId) state.fail("SESSION_CHANGED", "会话已切换，正在刷新任务。");
    if (payload?.knownSessionId === sessionId && payload?.knownRunId === result.runId &&
        payload?.knownRevision === result.revision) {
      return { ok: true, unchanged: true, sessionId, runId: result.runId, revision: result.revision };
    }
    return result;
  } catch (error) { return errorResult(error); }
}

async function onLoad() {
  for (const descriptor of manifest.contributes.agentTools) {
    await pi.agent.registerTool({ ...descriptor, execute: descriptor.name === "todo_write" ? executeTodoWrite : executeTodoRead });
  }
  await pi.commands.register({
    ...manifest.contributes.commands[0],
    run: async () => {
      try {
        const sessionId = await activeId();
        if (typeof pi.ui.revealView === "function") {
          await pi.ui.revealView({ viewId: "tasks", sessionId });
        } else {
          await pi.ui.showToast("打开右侧面板 → 任务，查看当前会话清单。", "info");
        }
      } catch (error) { await pi.ui.showToast(error.message, "error"); }
    },
  });
}
async function onUnload() {
  await writes;
  await Promise.allSettled([
    pi.agent.unregisterTool("todo_write"), pi.agent.unregisterTool("todo_read"), pi.commands.unregister("taskCenter.open"),
  ]);
}
module.exports = { onLoad, onUnload, onPanelInvoke, __test: { ...state, executeTodoRead, executeTodoWrite } };
