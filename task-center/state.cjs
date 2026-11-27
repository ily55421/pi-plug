"use strict";

// 普通插件、Agent 扩展共用状态契约；面板只消费后端生成的快照。
const KEY = "todoSessions";
// v3：settings.json 只保存轻量索引，每个会话的清单单独成文件；v2 把全部会话内联在同一份设置里。
const VERSION = 3;
const LEGACY_VERSION = 2;
const MAX_TODOS = 200;
const MAX_CONTENT = 500;
const STATUSES = ["pending", "in_progress", "completed", "cancelled"];
const PRIORITIES = ["high", "medium", "low"];
// 未建立清单的会话统一使用这个只读空状态，调用方不需要构造默认对象。
const EMPTY_SESSION = Object.freeze({ todos: [], runId: null, revision: 0, updatedAt: null, archived: false });
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const oneLine = (value) => value.replace(/\s+/g, " ").trim();

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function sessionIdOf(ctx) {
  const id = ctx?.sessionId;
  if (typeof id !== "string" || !id.trim() || id.length > 512) {
    fail("SESSION_REQUIRED", "缺少有效的调用会话，未读写任何清单。");
  }
  return id;
}

function normalizeTodos(input) {
  if (!Array.isArray(input) || input.length > MAX_TODOS) {
    fail("INVALID_TODOS", `todos 必须是数组，最多 ${MAX_TODOS} 项。`);
  }
  const notes = [];
  const todos = input.map((item, index) => {
    if (!record(item) || typeof item.content !== "string" || !oneLine(item.content)) {
      fail("INVALID_TODOS", `第 ${index + 1} 项需要非空字符串 content。`);
    }
    const text = oneLine(item.content);
    if (text.length > MAX_CONTENT) fail("INVALID_TODOS", `第 ${index + 1} 项超过 ${MAX_CONTENT} 字符，请缩短后重试。`);
    const status = STATUSES.includes(item.status) ? item.status : "pending";
    const priority = PRIORITIES.includes(item.priority) ? item.priority : "medium";
    if (status !== item.status) notes.push(`第 ${index + 1} 项状态已修正为 pending`);
    if (priority !== item.priority && item.priority !== undefined) notes.push(`第 ${index + 1} 项优先级已修正为 medium`);
    return { content: text, status, priority };
  });
  if (todos.filter((item) => item.status === "in_progress").length > 1) {
    fail("MULTIPLE_ACTIVE_TASKS", "同一清单最多保留一项 in_progress。");
  }
  return { todos, notes };
}

function summarize(todos) {
  const counts = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 };
  for (const todo of todos) counts[todo.status] += 1;
  const total = todos.length;
  const finished = counts.completed + counts.cancelled;
  return {
    counts, total, finished,
    percent: total ? Math.round(finished / total * 100) : 0,
    current: todos.find((item) => item.status === "in_progress") ?? todos.find((item) => item.status === "pending") ?? null,
    remainingCount: counts.pending + counts.in_progress,
  };
}

// 严格读取持久化会话：损坏即失败，不静默降级。expected.sessionId 用于核对文件归属。
function validateSession(value, expected = {}) {
  if (!record(value)) fail("STATE_CORRUPT", "当前会话清单存储格式损坏，原数据未覆盖。");
  if (expected.sessionId !== undefined && value.sessionId !== undefined && value.sessionId !== expected.sessionId) {
    fail("STATE_CORRUPT", "会话清单文件与请求的会话不一致，未读取。");
  }
  if (typeof value.runId !== "string" || !value.runId ||
      !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      !Number.isFinite(value.updatedAt) || value.updatedAt <= 0 || !Array.isArray(value.todos)) {
    fail("STATE_CORRUPT", "当前会话清单元数据损坏，原数据未覆盖。");
  }
  let normalized;
  try { normalized = normalizeTodos(value.todos); }
  catch { fail("STATE_CORRUPT", "当前会话任务数据损坏，不能据此判断任务已完成。"); }
  // 存储数据严格读取，不能把损坏状态静默降级为 pending。
  if (normalized.notes.length || value.todos.some((item, index) =>
    item.status !== normalized.todos[index].status || item.priority !== normalized.todos[index].priority ||
    item.content !== normalized.todos[index].content)) {
    fail("STATE_CORRUPT", "当前会话任务数据不符合存储契约。");
  }
  return {
    todos: normalized.todos, runId: value.runId, revision: value.revision,
    updatedAt: value.updatedAt, archived: value.archived === true,
  };
}

// 只校验 v3 索引；内联 v2 数据必须由迁移或只读回退分支处理，不走这里。
function storeOf(settings) {
  if (!record(settings)) fail("STATE_CORRUPT", "插件设置格式损坏，不能据此判断任务已完成。");
  if (!own(settings, KEY)) return { version: VERSION, index: {} };
  const store = settings[KEY];
  if (record(store) && store.version === LEGACY_VERSION) {
    fail("MIGRATION_REQUIRED", "旧版内联会话存储尚未迁移，未读写清单。");
  }
  if (!record(store) || store.version !== VERSION || !record(store.index)) {
    fail("STATE_CORRUPT", "会话清单索引格式损坏或版本不受支持，原数据未覆盖。");
  }
  return store;
}

function legacyAvailable(settings) {
  return record(settings?.todoState) && Array.isArray(settings.todoState.todos) && settings.todoState.todos.length > 0;
}

function snapshotOf(session, sessionId, extra = {}) {
  const base = session ?? EMPTY_SESSION;
  return {
    ok: true, sessionId, runId: base.runId, revision: base.revision, updatedAt: base.updatedAt,
    ...summarize(base.todos), todos: base.todos,
    archived: base.archived === true,
    legacyAvailable: extra.legacyAvailable === true,
    capacity: extra.capacity ?? null,
  };
}

module.exports = {
  KEY, VERSION, LEGACY_VERSION, MAX_TODOS, MAX_CONTENT, STATUSES, PRIORITIES, EMPTY_SESSION,
  record, oneLine, fail, sessionIdOf, normalizeTodos, summarize, validateSession, storeOf,
  legacyAvailable, snapshotOf,
};