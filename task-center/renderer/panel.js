/* 只读快照桥接；任务文本仅通过 textContent 写入。 */
(function () {
  "use strict";

  const bridge = window.pluginBridge;
  const $ = (id) => document.getElementById(id);
  const POLL_MS = 3000;
  const APPEARANCE_POLL_MS = 30000;
  const order = { in_progress: 0, pending: 1, completed: 2, cancelled: 3 };
  const words = {
    zh: {
      title: "任务中心", pending: "待办", active: "进行中", done: "已完成",
      ended: "已结束", completed: "完成", cancelled: "取消", updated: "更新于",
      empty: "还没有任务清单", hint: "让 Agent 开始一个多步任务，它会用 todo_write 建清单",
      legacy: "有旧版任务记录；当前会话还没有任务清单", loading: "正在加载…",
      stale: "数据已过期，显示上次成功读取的内容", failed: "刷新失败，将自动重试",
      bridge: "无法连接宿主：pluginBridge 不可用", high: "高", medium: "中", low: "低",
      errors: {
        NO_ACTIVE_SESSION: "当前没有活动会话", SESSION_CHANGED: "会话已切换，正在重新读取",
        STORAGE_READ_FAILED: "任务记录读取失败", STATE_CORRUPT: "任务记录格式异常",
      },
    },
    en: {
      title: "Task Center", pending: "Pending", active: "In progress", done: "Completed",
      ended: "Finished", completed: "Completed", cancelled: "Cancelled", updated: "Updated",
      empty: "No task list yet", hint: "Ask the Agent to start a multi-step task with todo_write",
      legacy: "Legacy tasks exist; this session has no task list yet", loading: "Loading…",
      stale: "Data is stale; showing the last successful snapshot", failed: "Refresh failed; retrying automatically",
      bridge: "Cannot connect to the host: pluginBridge is unavailable", high: "High", medium: "Medium", low: "Low",
      errors: {
        NO_ACTIVE_SESSION: "No active session", SESSION_CHANGED: "Session changed; refreshing",
        STORAGE_READ_FAILED: "Could not read task data", STATE_CORRUPT: "Invalid task data",
      },
    },
  };
  let language = "zh";
  let snapshot = null;
  let error = null;
  let disposed = false;
  let epoch = 0;
  let running = false;
  let flightEpoch = 0;
  let pending = false;
  let timer = null;
  let appearanceTimer = null;
  let appearanceVersion = 0;
  let appearanceRunning = false;
  let appearancePending = false;
  let hasAppearanceEvents = false;
  const cleanup = [];
  const text = () => words[language];
  const available = () => bridge && typeof bridge.invoke === "function";
  const visible = () => !disposed && !document.hidden;

  function renderNotice() {
    const t = text();
    const notice = $("notice");
    let message = "";
    if (error) {
      message = error.code === "BRIDGE_UNAVAILABLE" ? t.bridge
        : (language === "zh" && error.message) || t.errors[error.code] || t.failed;
      if (snapshot) message = t.stale + " · " + message;
    } else if (!snapshot) {
      message = t.loading;
    }
    notice.textContent = message;
    notice.hidden = !message;
    document.body.dataset.stale = String(Boolean(error && snapshot));
  }

  function stamp(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return "—";
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleString(language === "zh" ? "zh-CN" : "en-US", {
      month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  }

  function render() {
    const t = text();
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    document.title = t.title;
    $("title").textContent = t.title;
    $("legendPending").textContent = t.pending;
    $("legendActive").textContent = t.active;
    $("legendDone").textContent = t.done;
    $("emptyTitle").textContent = t.empty;
    $("emptyHint").textContent = snapshot?.legacyAvailable ? t.legacy : t.hint;
    $("empty").hidden = !snapshot || snapshot.todos.length > 0;
    $("count").textContent = snapshot
      ? t.ended + " " + snapshot.finished + "/" + snapshot.total + " · " + snapshot.percent + "%" : "—";
    $("breakdown").hidden = !snapshot;
    $("breakdown").textContent = snapshot
      ? t.completed + " " + snapshot.counts.completed + " · " + t.cancelled + " " + snapshot.counts.cancelled : "";
    const percent = snapshot ? snapshot.percent : 0;
    $("progress").style.width = percent + "%";
    $("progressBar").setAttribute("aria-label", t.ended);
    $("progressBar").setAttribute("aria-valuenow", String(percent));
    $("progressBar").setAttribute("aria-valuetext", snapshot ? $("count").textContent : "—");
    $("updated").textContent = snapshot?.updatedAt ? t.updated + " " + stamp(snapshot.updatedAt) : "—";
    $("currentRow").hidden = !snapshot?.current;
    $("currentText").textContent = snapshot?.current?.content || "";
    const list = $("list");
    list.textContent = "";
    // 同状态保留服务端给出的顺序；统计和当前任务始终使用服务端结果。
    const todos = snapshot ? snapshot.todos.map((todo, index) => ({ todo, index })) : [];
    todos.sort((a, b) => (order[a.todo.status] ?? 9) - (order[b.todo.status] ?? 9) || a.index - b.index);
    for (const { todo } of todos) {
      const item = document.createElement("li");
      item.className = "item" + (todo.status === "in_progress" ? " active" : "");
      item.dataset.status = todo.status;
      const glyph = document.createElement("span");
      glyph.className = "glyph";
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = todo.status === "completed" ? "✓" : todo.status === "cancelled" ? "×" : "";
      item.setAttribute("aria-label", (t[todo.status === "in_progress" ? "active" : todo.status === "completed" ? "done" : todo.status] || t.pending) + ": " + todo.content);
      const content = document.createElement("span");
      content.className = "content";
      content.textContent = todo.content;
      const priority = document.createElement("span");
      priority.className = "prio";
      priority.dataset.p = todo.priority;
      priority.textContent = todo.priority === "high" ? t.high : todo.priority === "low" ? t.low : t.medium;
      item.append(glyph, content, priority);
      list.append(item);
    }
    renderNotice();
  }

  function applyAppearance(appearance) {
    if (disposed) return;
    const base = appearance?.base;
    document.documentElement.dataset.base = base === "light" || base === "dark" ? base
      : window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
    const next = typeof appearance?.locale === "string" && /^en\b/i.test(appearance.locale) ? "en" : "zh";
    if (next !== language) {
      language = next;
      render();
    }
  }

  function fail(result) {
    error = result;
    if (result.code === "NO_ACTIVE_SESSION" || result.code === "SESSION_CHANGED") {
      snapshot = null;
      render();
    } else {
      renderNotice();
    }
  }

  function validSnapshot(value) {
    return typeof value.sessionId === "string" && (value.runId === null || typeof value.runId === "string")
      && Number.isInteger(value.revision) && value.revision >= 0
      && [value.total, value.finished, value.percent, ...Object.keys(order).map((key) => value.counts?.[key])]
        .every((n) => Number.isFinite(n) && n >= 0)
      && value.percent <= 100 && Array.isArray(value.todos)
      && value.todos.every((todo) => todo && typeof todo.content === "string")
      && (value.current === null || (value.current && typeof value.current.content === "string"));
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (visible() && available()) timer = setTimeout(refresh, POLL_MS);
  }

  async function refresh() {
    if (!visible() || !available()) return;
    if (running) {
      // 聚焦复用当前请求；切换/恢复后的请求等待失效请求结束再执行。
      if (flightEpoch !== epoch) pending = true;
      return;
    }
    clearTimeout(timer);
    timer = null;
    running = true;
    flightEpoch = epoch;
    const requestEpoch = epoch;
    const known = snapshot ? {
      knownSessionId: snapshot.sessionId, knownRunId: snapshot.runId, knownRevision: snapshot.revision,
    } : {};
    try {
      const result = await bridge.invoke("taskCenter.snapshot", known);
      if (!visible() || requestEpoch !== epoch) return;
      if (!result || result.ok !== true) {
        fail(result || { code: "STATE_CORRUPT" });
      } else if (result.unchanged) {
        if (snapshot && result.sessionId === snapshot.sessionId && result.runId === snapshot.runId && result.revision === snapshot.revision) {
          error = null;
          renderNotice();
        } else {
          // 无法将未变化响应绑定到本地快照时，清空身份提示并重新取完整结果。
          snapshot = null;
          error = { code: "STATE_CORRUPT" };
          render();
        }
      } else if (validSnapshot(result)) {
        snapshot = result;
        error = null;
        render();
      } else {
        fail({ code: "STATE_CORRUPT" });
      }
    } catch {
      if (visible() && requestEpoch === epoch) fail({ code: "STORAGE_READ_FAILED" });
    } finally {
      running = false;
      if (pending && visible()) {
        pending = false;
        void refresh();
      } else {
        pending = false;
        schedule();
      }
    }
  }

  function scheduleAppearance() {
    clearTimeout(appearanceTimer);
    appearanceTimer = null;
    if (!hasAppearanceEvents && visible() && available()) {
      appearanceTimer = setTimeout(refreshAppearance, APPEARANCE_POLL_MS);
    }
  }

  async function refreshAppearance() {
    if (!visible() || !available()) return;
    if (appearanceRunning) {
      appearancePending = true;
      return;
    }
    clearTimeout(appearanceTimer);
    appearanceTimer = null;
    appearanceRunning = true;
    const version = appearanceVersion;
    try {
      const appearance = await bridge.invoke("app.getAppearance");
      if (visible() && version === appearanceVersion) applyAppearance(appearance);
    } catch {
      // 保留已有主题；初始化已应用系统回退主题。
    } finally {
      appearanceRunning = false;
      if (appearancePending && visible()) {
        appearancePending = false;
        void refreshAppearance();
      } else {
        appearancePending = false;
        scheduleAppearance();
      }
    }
  }

  function listen(target, event, handler) {
    target.addEventListener(event, handler);
    cleanup.push(() => target.removeEventListener(event, handler));
  }

  function subscribe(event, handler) {
    if (typeof bridge?.on !== "function") return false;
    try {
      const unsubscribe = bridge.on(event, handler);
      if (typeof unsubscribe === "function") cleanup.push(unsubscribe);
      return true;
    } catch {
      return false;
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    epoch++;
    appearanceVersion++;
    pending = false;
    appearancePending = false;
    clearTimeout(timer);
    clearTimeout(appearanceTimer);
    for (const unsubscribe of cleanup.splice(0)) {
      try { unsubscribe(); } catch { /* 宿主已关闭时继续清理其余订阅。 */ }
    }
  }

  applyAppearance(null);
  if (!available()) error = { code: "BRIDGE_UNAVAILABLE" };
  render();
  if (!available()) return;

  hasAppearanceEvents = subscribe("appearance:changed", (appearance) => {
    if (disposed) return;
    appearanceVersion++;
    if (visible()) applyAppearance(appearance);
  });
  subscribe("session:activated", () => {
    if (disposed) return;
    epoch++;
    snapshot = null;
    error = null;
    render();
    void refresh();
  });
  listen(document, "visibilitychange", () => {
    epoch++;
    appearanceVersion++;
    clearTimeout(timer);
    clearTimeout(appearanceTimer);
    if (visible()) {
      void refresh();
      void refreshAppearance();
    }
  });
  listen(window, "focus", () => { void refresh(); });
  listen(window, "pagehide", dispose);
  listen(window, "beforeunload", dispose);
  void refreshAppearance();
  void refresh();
})();
