/*
 * 任务中心 —— 插件进程入口。
 *
 * 职责：给 Agent 两个结构化任务清单工具（todo_write / todo_read），把清单
 * 存进插件自己的设置里，供右侧工作面板视图轮询渲染。
 *
 * 为什么走「设置」这条通道：视图页只拿到 window.pluginBridge，而面板桥没有
 * 任何「读任务清单」的固定通道，plugin.getSettings 是固定通道之一。
 *
 * 本机 local.token-meter 插件用的就是这个范式（视图侧 bridge.invoke("plugin.getSettings")）。
 *
 * 边界：只写自己的插件设置；不读工作区文件、不联网、不执行命令。
 */

"use strict";

/** 插件设置里保存任务清单的键，与 renderer/index.html 保持一致。 */
const KEY_STATE = "todoState";

/** 合法的状态与优先级；与 manifest.json 里工具 schema 的 enum 一一对应。 */
const STATUSES = ["pending", "in_progress", "completed", "cancelled"];
const PRIORITIES = ["high", "medium", "low"];

/** 单条任务文本上限，防止模型把整篇文档塞进一条。 */
const MAX_CONTENT = 500;
/** 清单条数上限：超过这个数量说明任务粒度太粗，应当拆分。 */
const MAX_TODOS = 200;

/* ------------------------------------------------------------ 规范化与统计 */

/** 把任意输入压成一行紧凑文本。 */
function oneLine(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 校验并规范化模型送来的清单。
 *
 * 策略：能修就修（缺 priority 补 medium、状态非法降级为 pending），
 * 只有 content 全空或条数超限才报错——工具报错会打断模型的执行流，
 * 不值得为可推断的字段这么做。
 */
function normalizeTodos(input) {
  if (!Array.isArray(input)) {
    throw new Error("todos must be an array of { content, status, priority } objects");
  }
  if (input.length > MAX_TODOS) {
    throw new Error(`too many tasks (${input.length}); keep the list under ${MAX_TODOS} items`);
  }

  const todos = [];
  let dropped = 0;

  for (const raw of input) {
    if (!raw || typeof raw !== "object") {
      dropped += 1;
      continue;
    }
    const content = oneLine(raw.content).slice(0, MAX_CONTENT);
    if (!content) {
      dropped += 1;
      continue;
    }
    const status = STATUSES.includes(raw.status) ? raw.status : "pending";
    const priority = PRIORITIES.includes(raw.priority) ? raw.priority : "medium";
    todos.push({ content, status, priority });
  }

  if (todos.length === 0 && input.length > 0) {
    throw new Error("every task needs a non-empty content string");
  }
  return { todos, dropped };
}

/** 把状态分布、当前进行项与剩余项算成模型和视图都能直接用的形状。 */
function summarize(todos) {
  const counts = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 };
  for (const todo of todos) counts[todo.status] += 1;

  const active = todos.filter((todo) => todo.status === "in_progress");
  const remaining = todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress");
  const total = todos.length;
  const finished = counts.completed + counts.cancelled;

  return {
    counts,
    active,
    remaining,
    total,
    finished,
    /** 0-100 的完成度；空清单按 0 处理，避免除零。 */
    percent: total === 0 ? 0 : Math.round((finished / total) * 100),
    /** 模型最该先看的那一条：优先取 in_progress，否则取第一个 pending。 */
    current: active[0] ?? todos.find((todo) => todo.status === "pending") ?? null,
  };
}

/* ------------------------------------------------------------------ 存储 */

/** 读回清单；读失败当成空清单，绝不让读异常挡住工具调用。 */
async function readState() {
  let settings = null;
  try {
    settings = await pi.plugin.getSettings();
  } catch {
    settings = null;
  }
  const stored = settings && settings[KEY_STATE];
  const raw = stored && Array.isArray(stored.todos) ? stored.todos : [];
  const todos = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const content = oneLine(item.content);
    if (!content) continue;
    todos.push({
      content: content.slice(0, MAX_CONTENT),
      status: STATUSES.includes(item.status) ? item.status : "pending",
      priority: PRIORITIES.includes(item.priority) ? item.priority : "medium",
    });
  }
  return { todos, updatedAt: stored && stored.updatedAt ? stored.updatedAt : null };
}

/** 写回清单。写失败要抛出，让模型知道状态没保存。 */
async function writeState(todos, source) {
  const updatedAt = Date.now();
  await pi.plugin.setSettings({
    [KEY_STATE]: { todos, updatedAt, source, version: 1 },
  });
  return updatedAt;
}

/* ------------------------------------------------------------------ 工具 */

/** 模型读清单时看到的文本：一行一条，带序号与优先级，便于它精确回填。 */
function formatForAgent(state) {
  const { todos, updatedAt } = state;
  if (todos.length === 0) {
    return "任务清单为空。开始多步任务前，用 todo_write 先建一份清单。";
  }
  const summary = summarize(todos);
  const lines = todos.map(
    (todo, index) => `${index + 1}. [${todo.status}] (${todo.priority}) ${todo.content}`,
  );
  const header = [
    `任务清单（共 ${summary.total} 项：待办 ${summary.counts.pending} · 进行中 ${summary.counts.in_progress} · 已完成 ${summary.counts.completed} · 已取消 ${summary.counts.cancelled}）`,
    `完成度 ${summary.percent}%${summary.current ? `，当前：${summary.current.content}` : ""}`,
  ];
  if (updatedAt) header.push(`更新时间：${new Date(updatedAt).toLocaleString()}`);
  return header.concat(["", ...lines]).join("\n");
}

async function executeTodoWrite(args) {
  const { todos, dropped } = normalizeTodos(args && args.todos);

  const inProgress = todos.filter((todo) => todo.status === "in_progress").length;
  const notes = [];
  if (dropped > 0) notes.push(`${dropped} 条空任务被忽略`);
  // 不硬性报错：模型可能正在一次批量推进多条，强行打断反而更糟。
  if (inProgress > 1) notes.push(`有 ${inProgress} 条任务同时处于 in_progress，建议只保留一条`);

  await writeState(todos, "agent");
  const summary = summarize(todos);

  return {
    ok: true,
    total: summary.total,
    counts: summary.counts,
    percent: summary.percent,
    current: summary.current ? summary.current.content : null,
    remaining: summary.remaining.map((todo) => todo.content),
    notes,
    message:
      summary.total === 0
        ? "任务清单已清空。"
        : `任务清单已更新：共 ${summary.total} 项，完成度 ${summary.percent}%。` +
          (summary.current ? `当前：${summary.current.content}` : ""),
  };
}

async function executeTodoRead() {
  const state = await readState();
  const summary = summarize(state.todos);
  return {
    ok: true,
    total: summary.total,
    counts: summary.counts,
    percent: summary.percent,
    todos: state.todos,
    remaining: summary.remaining.map((todo) => todo.content),
    current: summary.current ? summary.current.content : null,
    updatedAt: state.updatedAt,
    message: formatForAgent(state),
  };
}

/* ---------------------------------------------------------------- 生命周期 */

async function onLoad() {
  await pi.agent.registerTool({
    name: "todo_write",
    description:
      "Create or update the structured task list for a complex coding session. Use it for multi-step work or an explicit user task list; skip it for single, trivial or purely conversational requests. Send the complete list every time: it replaces the previous one. Keep exactly one task in_progress, mark a task completed the moment it is done, and never mark work completed that you did not verify.",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The updated todo list, in execution order.",
          items: {
            type: "object",
            properties: {
              content: {
                type: "string",
                description: "Brief description of the task, imperative mood.",
              },
              status: {
                type: "string",
                enum: STATUSES,
                description: "Current status of the task.",
              },
              priority: {
                type: "string",
                enum: PRIORITIES,
                description: "Priority level of the task.",
              },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
    execute: executeTodoWrite,
  });

  await pi.agent.registerTool({
    name: "todo_read",
    description:
      "Read the current task list snapshot: every task with its status, priority and position, plus counts and the active task. Call it before reporting a long task as finished to confirm nothing is still pending.",
    risk: "low",
    schema: { type: "object", properties: {}, required: [] },
    execute: executeTodoRead,
  });

  await pi.commands.register({
    id: "taskCenter.open",
    title: "任务中心：查看任务进度",
    keywords: ["todo", "task", "任务", "清单", "进度", "task center"],
    category: "Productivity",
    run: async () => {
      const state = await readState();
      const summary = summarize(state.todos);
      if (summary.total === 0) {
        await pi.ui.showToast("任务清单为空", "info");
        return;
      }
      // 视图插件没有"打开某个视图"的宿主 API，所以这里给出路径指引，
      // 与官方 pi.terminal 的同类命令做法一致。
      await pi.ui.showToast(
        `任务：${summary.counts.completed}/${summary.total} 已完成（${summary.percent}%）` +
          (summary.current ? ` · 当前：${summary.current.content}` : "") +
          " · 打开：右侧面板 → 任务",
        "info",
      );
    },
  });
}

async function onUnload() {
  await Promise.allSettled([
    pi.agent.unregisterTool("todo_write"),
    pi.agent.unregisterTool("todo_read"),
    pi.commands.unregister("taskCenter.open"),
  ]);
}

module.exports = {
  onLoad,
  onUnload,
  // 导出纯函数供测试直接断言，不依赖宿主环境。
  __test: { normalizeTodos, summarize, formatForAgent, oneLine, STATUSES, PRIORITIES },
};
