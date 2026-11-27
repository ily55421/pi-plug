/* 只读快照桥接；任务文本仅通过 textContent 写入。 */
(function () {
  "use strict";

  const bridge = window.pluginBridge;
  const $ = (id) => document.getElementById(id);
  // 轮询只做兜底：宿主会在回合结束时向面板推送 session:turnEnded，命中后立即刷新。
  const POLL_ACTIVE_MS = 3000;      // 清单还有未完成项时
  const POLL_IDLE_MS = 20000;       // 清单已结束或为空时降低频率
  const BACKOFF_MS = [3000, 6000, 15000, 30000];
  const APPEARANCE_POLL_MS = 30000;
  const MAX_TODOS = 200;
  const order = { in_progress: 0, pending: 1, completed: 2, cancelled: 3 };
  const words = {
    zh: {
      title: "任务中心", pending: "待办", active: "进行中", done: "已完成",
      ended: "已结束", completed: "完成", cancelled: "取消", updated: "更新于",
      empty: "还没有任务清单", hint: "让 Agent 开始一个多步任务，它会用 todo_write 建清单",
      legacy: "有旧版任务记录；当前会话还没有任务清单", loading: "正在加载…",
      stale: "数据已过期，显示上次成功读取的内容", failed: "刷新失败，将自动重试",
      bridge: "无法连接宿主：pluginBridge 不可用", high: "高", medium: "中", low: "低",
      capacityWarn: "会话数据已占用 {p}%，用 todo_history 查看归档；需要时手动运行 taskCenter.purgeArchived 永久清理",
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
      capacityWarn: "Session data uses {p}%; inspect archives with todo_history; run taskCenter.purgeArchived manually to delete them",
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
  let failures = 0;
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
    } else if (snapshot.capacity?.warning) {
      message = t.capacityWarn.replace("{p}", String(snapshot.capacity.percent));
    }
    notice.textContent = message;
    notice.hidden = !message;
    notice.dataset.kind = error ? "error" : "warn";
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
    failures += 1;
    if (result.code === "NO_ACTIVE_SESSION" || result.code === "SESSION_CHANGED") {
      snapshot = null;
      render();
    } else {
      renderNotice();
    }
  }

  // 宿主是边界：即使后端已经生成可信快照，也要拒绝自相矛盾或越界的数据。
  function validSnapshot(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if (typeof value.sessionId !== "string" || !value.sessionId) return false;
    if (!(value.runId === null || typeof value.runId === "string")) return false;
    if (!Number.isInteger(value.revision) || value.revision < 0) return false;
    const counts = value.counts;
    if (!counts || typeof counts !== "object") return false;
    if (!Object.keys(order).every((key) => Number.isInteger(counts[key]) && counts[key] >= 0)) return false;
    if (![value.total, value.finished, value.percent].every((n) => Number.isFinite(n) && n >= 0)) return false;
    if (value.percent > 100) return false;
    if (!Array.isArray(value.todos) || value.todos.length > MAX_TODOS) return false;
    if (!value.todos.every((todo) => todo && typeof todo.content === "string" &&
      Object.prototype.hasOwnProperty.call(order, todo.status) &&
      ["high", "medium", "low"].includes(todo.priority))) return false;
    if (value.total !== value.todos.length) return false;
    if (value.finished !== counts.completed + counts.cancelled) return false;
    if (counts.pending + counts.in_progress + counts.completed + counts.cancelled !== value.total) return false;
    const percent = value.total ? Math.round(value.finished / value.total * 100) : 0;
    if (Math.abs(percent - value.percent) > 1) return false;
    if (value.current !== null) {
      if (typeof value.current !== "object" || typeof value.current.content !== "string") return false;
      if (!["in_progress", "pending"].includes(value.current.status)) return false;
    }
    if (value.capacity !== undefined && value.capacity !== null) {
      const capacity = value.capacity;
      if (typeof capacity !== "object" || Array.isArray(capacity)) return false;
      if (![capacity.usedBytes, capacity.limitBytes, capacity.percent].every((n) => Number.isFinite(n) && n >= 0)) return false;
    }
    return true;
  }

  // 有未完成项时保持较高频率；已结束或读取失败时退避，避免异常状态下持续读盘。
  function delayMs() {
    if (error) return BACKOFF_MS[Math.min(Math.max(failures, 1), BACKOFF_MS.length) - 1];
    if (!snapshot || (snapshot.remainingCount ?? 1) > 0) return POLL_ACTIVE_MS;
    return POLL_IDLE_MS;
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (visible() && available()) timer = setTimeout(refresh, delayMs());
  }

  // 插件进程拿不到宿主的 session.getActive，面板用 bridge 的同名频道提供可见会话身份。
  async function detectSession() {
    if (typeof bridge?.invoke !== "function") return undefined;
    try {
      const active = await bridge.invoke("session.getActive");
      const id = active?.sessionId ?? active?.id;
      return typeof id === "string" && id ? id : null;
    } catch { return undefined; }
  }

  async function refresh() {
    if (!visible() || !available()) return;
    if (running) {
      // Focus and visibility refreshes wait for the current flight instead of overlapping it.
      if (flightEpoch !== epoch) pending = true;
      return;
    }
    clearTimeout(timer);
    timer = null;
    running = true;
    flightEpoch = epoch;
    const requestEpoch = epoch;
    const sessionId = await detectSession();
    if (disposed || (!visible() && requestEpoch === epoch)) {
      // 初始隐藏时不启动快照；已启动的请求若遇到可见性变化则继续发出，并在响应阶段丢弃旧结果。
      running = false;
      pending = false;
      schedule();
      return;
    }
    if (sessionId === null || (typeof sessionId === "string" && snapshot && snapshot.sessionId !== sessionId)) {
      snapshot = null;
      error = null;
      failures = 0;
      render();
    }
    const known = snapshot ? {
      knownSessionId: snapshot.sessionId, knownRunId: snapshot.runId, knownRevision: snapshot.revision,
    } : {};
    const payload = sessionId === null ? { noActiveSession: true }
      : typeof sessionId === "string" ? { ...known, sessionId } : known;
    try {
      const result = await bridge.invoke("taskCenter.snapshot", payload);
      if (!visible() || requestEpoch !== epoch) return;
      const activeAfterRequest = await detectSession();
      if (!visible() || requestEpoch !== epoch) return;
      if (sessionId !== undefined && activeAfterRequest !== undefined && sessionId !== activeAfterRequest) {
        snapshot = null;
        error = null;
        failures = 0;
        render();
        pending = true;
        return;
      }
      if (!result || result.ok !== true) {
        fail(result || { code: "STATE_CORRUPT" });
      } else if (result.unchanged) {
        if (snapshot && result.sessionId === snapshot.sessionId && result.runId === snapshot.runId && result.revision === snapshot.revision) {
          error = null;
          failures = 0;
          renderNotice();
        } else {
          // 无法将未变化响应绑定到本地快照时，清空身份提示并重新取完整结果。
          snapshot = null;
          error = { code: "STATE_CORRUPT" };
          failures += 1;
          render();
        }
      } else if (validSnapshot(result)) {
        snapshot = result;
        error = null;
        failures = 0;
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
  // 宿主的回合结束事件会推给面板：批次结束立即刷新，不必等下一次轮询。
  subscribe("session:turnEnded", () => {
    if (disposed || !visible()) return;
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