"use strict";

// 普通插件、Agent 扩展共用状态契约；面板只消费后端生成的快照。
const KEY = "todoSessions";
const VERSION = 2;
const MAX_TODOS = 200;
const MAX_CONTENT = 500;
const STATUSES = ["pending", "in_progress", "completed", "cancelled"];
const PRIORITIES = ["high", "medium", "low"];
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

function storeOf(settings) {
  if (!record(settings)) fail("STATE_CORRUPT", "插件设置格式损坏，不能据此判断任务已完成。");
  if (!own(settings, KEY)) return { version: VERSION, sessions: {} };
  const store = settings[KEY];
  if (!record(store) || store.version !== VERSION || !record(store.sessions)) {
    fail("STATE_CORRUPT", "会话清单存储格式损坏或版本不受支持，原数据未覆盖。");
  }
  return store;
}

function stateOf(settings, sessionId) {
  const store = storeOf(settings);
  const key = `session:${sessionId}`;
  if (!own(store.sessions, key)) return { todos: [], runId: null, revision: 0, updatedAt: null };
  const state = store.sessions[key];
  if (!record(state) || typeof state.runId !== "string" || !state.runId ||
      !Number.isSafeInteger(state.revision) || state.revision < 1 ||
      !Number.isFinite(state.updatedAt) || state.updatedAt <= 0 || !Array.isArray(state.todos)) {
    fail("STATE_CORRUPT", "当前会话清单元数据损坏，原数据未覆盖。");
  }
  let normalized;
  try { normalized = normalizeTodos(state.todos); }
  catch { fail("STATE_CORRUPT", "当前会话任务数据损坏，不能据此判断任务已完成。"); }
  // 存储数据严格读取，不能把损坏状态静默降级为 pending。
  if (normalized.notes.length || state.todos.some((item, index) =>
    item.status !== normalized.todos[index].status || item.priority !== normalized.todos[index].priority ||
    item.content !== normalized.todos[index].content)) {
    fail("STATE_CORRUPT", "当前会话任务数据不符合存储契约。");
  }
  return { todos: normalized.todos, runId: state.runId, revision: state.revision, updatedAt: state.updatedAt };
}

function snapshot(settings, sessionId) {
  const state = stateOf(settings, sessionId);
  return {
    ok: true, sessionId, ...state, ...summarize(state.todos),
    legacyAvailable: record(settings.todoState) && Array.isArray(settings.todoState.todos) && settings.todoState.todos.length > 0,
  };
}

module.exports = { KEY, VERSION, MAX_TODOS, MAX_CONTENT, STATUSES, PRIORITIES, record, oneLine, fail, sessionIdOf, normalizeTodos, summarize, storeOf, stateOf, snapshot };
