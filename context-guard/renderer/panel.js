(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const bridge = window.pluginBridge;
  let locale = "zh-CN";
  let catalog = [];
  let saved = null;
  let initialized = false;
  let saving = false;
  let dirty = false;
  let snapshotPending = false;
  let manualRefreshing = false;
  let compactPending = false;
  let statusPending = 0;
  let runtimeSequence = 0;
  let currentRuntime = {};
  let saveStateKey = "localOnly";
  let noticeState = { text: "", error: false, key: false };
  const en = {
    brand: "Context Guard", title: "Keep the conversation going.", intro: "Use the built-in /compact to make room in long conversations, then continue your work.",
    disabled: "Disabled", enabled: "Enabled", rules: "Continuation rules", precision: "Off by default. System mode can cover all main models. A selected model must match the provider, full model ID and API protocol exactly.",
    mode: "Compression mode", systemMode: "Built-in system compaction", dedicatedMode: "Dedicated summary model (advanced)",
    mainModel: "Main model", allModels: "All main models (system mode)", choose: "Select a configured model", allModelsHint: "Use system compaction with any current main model.", protocol: "Main model API protocol",
    protocolHint: "Required only for a selected main model. Enter its runtime API identifier; a mismatch skips the rule.", compressionModel: "Compression model",
    compressionHint: "Advanced mode requires the full native SDK and a main model, API protocol and summary model. Use system mode in regular PI-Desktop. Summaries incur normal model usage.",
    threshold: "Compress at request", thresholdHint: "Leave headroom. The default attempts compaction at request 90.", rounds: "requests",
    countHint: "Counts are recorded by this plugin and may be incomplete for old sessions or after reloads. Internal HTTP retries are excluded. Manual system compaction can rebuild a baseline for an old session.",
    rescue: "Rescue automatically at the session turn limit", rescueHint: "Requires the rule to be enabled. Calls system compaction after session_turn_limit_exceeded; never resends the task automatically.",
    localOnly: "Settings stay on this device", save: "Save settings ↗", saved: "Saved · runtime status follows session events", changed: "Unsaved changes", saving: "Saving…",
    session: "Current session", waiting: "Waiting for session state", waitingHint: "Connect a session to see plugin-recorded counts.", currentSession: "Session ID", currentModel: "Main model", lastCompact: "Last compaction", updated: "Status updated",
    compact: "Compact with system now", compactPending: "Requesting compaction…", manualHint: "Compacts only; sends no message. Click Continue in the session when complete. Tasks are never resent automatically. Manual compaction also works with the rule disabled.",
    refresh: "Refresh status (keep unsaved settings)", retry: "Retry loading settings and session", refreshHint: "Refresh updates session status only and keeps unsaved settings. After an initialization failure, use it to retry the full load.",
    flow: "Summarize. Then carry on.", step1: "Approach the threshold", step1Hint: "Leave headroom using plugin-recorded counts, which may be incomplete.", step2: "Call built-in system compaction", step2Hint: "Regular PI-Desktop can use /compact. Advanced summary mode requires the native SDK.", step3: "Review, then continue", step3Hint: "Check the result and click Continue in the session. The plugin never resends your task automatically.",
    inspired: "Inspired by Save Xingchi 100 · Built for PI-Desktop", manual: "System compaction: button above or /compact in the session",
    preview: "UI preview only. Open this plugin in PI-Desktop for settings and session actions.", error: "Operation failed", unavailable: "Unavailable", notMatched: "Rule does not match", ready: "Ready", queued: "Compaction queued", busy: "Session busy", compacting: "Compacting", success: "Compaction complete", cooldown: "Automatic retry paused", stopped: "Stopped", unsupported: "Current mode unavailable",
    permissionHint: "Grant desktop.control permission to call system /compact. Saving settings does not grant permission.",
    dedicatedLimit: "This session does not provide the full native SDK required by advanced summary mode. Use built-in system compaction in regular PI-Desktop.",
    systemUnavailable: "System /compact is currently unavailable for this session. Check the host connection and desktop.control permission; follow the runtime message.",
    loadFirst: "Load the session state before using manual compaction.", connectSession: "Connect a session to use system /compact.", busyHint: "Wait until the session is idle before compacting.", compactingHint: "A compaction request is in progress. Please wait.", manualReady: "Calls system /compact for the session ID displayed above.",
    sessionChanged: "The session changed. Refresh the session state before trying again.", invalidResponse: "The extension returned incomplete data. Refresh to retry.", approximate: "Plugin-recorded count; the session baseline may be incomplete.", progress: "Plugin-recorded requests toward the compaction threshold", enableLabel: "Enable context guard",
  };
  const zh = {
    enabled: "已启用", disabled: "未启用", allModelsHint: "不限定主模型，使用当前会话的系统压缩。", preview: "当前为界面预览。请在 PI-Desktop 中打开本插件以配置规则和操作当前会话。",
    changed: "有未保存的更改", saved: "已保存 · 运行状态以会话事件为准", saving: "保存中…", localOnly: "配置仅保存在本机", refresh: "刷新状态（保留未保存配置）", retry: "重试加载配置与会话",
    unavailable: "当前不可用", waiting: "等待会话状态", waitingHint: "连接当前会话后显示插件计数。", notMatched: "未匹配规则", ready: "就绪", queued: "压缩已排队", busy: "会话忙碌", compacting: "正在压缩", success: "压缩已完成", cooldown: "自动重试已暂停", error: "操作失败", stopped: "已停止", unsupported: "当前模式不可用",
    compact: "立即系统压缩", compactPending: "正在请求压缩…", permissionHint: "请授予 desktop.control 权限，以便调用系统 /compact；保存配置不会授予权限。",
    dedicatedLimit: "当前会话未提供高级摘要模式所需的完整原生 SDK；普通 PI-Desktop 请使用系统原生压缩。",
    systemUnavailable: "当前会话暂不可调用系统 /compact。请检查宿主连接与 desktop.control 授权，以运行状态提示为准。",
    loadFirst: "加载会话状态后可手动压缩。", connectSession: "连接会话后可手动调用系统 /compact。", busyHint: "会话忙碌，请等待空闲后再压缩。", compactingHint: "正在处理压缩请求，请稍候。", manualReady: "对上方显示的会话 ID 调用系统 /compact。",
    sessionChanged: "会话已切换，请刷新会话状态后重试。", invalidResponse: "扩展返回的数据不完整，请点击刷新重试。", approximate: "插件记录计数，会话基线可能不完整。", progress: "距压缩阈值的插件记录轮次", enableLabel: "启用续航压缩",
  };
  const originalText = new Map([...document.querySelectorAll("[data-i18n]")].map(node => [node.dataset.i18n, node.textContent]));
  const t = key => (locale.startsWith("zh") ? zh[key] || originalText.get(key) : en[key]) || key;

  function renderNotice() {
    $("notice").textContent = noticeState.key ? t(noticeState.text) : noticeState.text;
    $("notice").hidden = !noticeState.text;
    $("notice").classList.toggle("error", noticeState.error);
  }
  function notice(text = "", error = false, key = false) {
    noticeState = { text, error, key };
    renderNotice();
  }
  async function invoke(channel, payload) {
    const result = await bridge.invoke(channel, payload);
    if (!result?.ok) {
      const error = new Error(result?.message || t("error"));
      error.code = result?.code;
      throw error;
    }
    return result;
  }
  function identity(provider, id) { return provider && id ? JSON.stringify([provider, id]) : ""; }
  function modelParts(value) {
    try { return JSON.parse(value || "[]"); } catch { return []; }
  }
  function fillSelect(id, selected) {
    const select = $(id);
    const placeholder = id === "sourceModel" && $("compressionMode").value === "system" ? "allModels" : "choose";
    select.replaceChildren(new Option(t(placeholder), ""));
    for (const row of catalog) select.add(new Option(`${row.providerName || row.providerId} / ${row.label || row.modelId}`, identity(row.providerId, row.modelId)));
    if (selected && ![...select.options].some(option => option.value === selected)) select.add(new Option(`${modelParts(selected).join(" / ")} · ${t("unavailable")}`, selected));
    select.value = selected;
  }
  function refreshOptions() {
    fillSelect("sourceModel", $("sourceModel").value);
    fillSelect("compressionModel", $("compressionModel").value);
  }
  function badge() {
    const enabled = saved?.enabled === true;
    $("savedBadge").textContent = t(enabled ? "enabled" : "disabled");
    $("savedBadge").classList.toggle("active", enabled);
  }
  function renderSaveState() {
    $("saveState").textContent = t(saving ? "saving" : dirty ? "changed" : saveStateKey);
  }
  function compatibility() {
    let key = "";
    if (initialized) {
      if ($("compressionMode").value === "dedicated" && currentRuntime.capability !== "native") key = "dedicatedLimit";
      else if (currentRuntime.capability === "permissionRequired") key = "permissionHint";
      else if ($("compressionMode").value === "system" && currentRuntime.sessionId && !currentRuntime.systemAvailable) key = "systemUnavailable";
    }
    $("compatibility").textContent = key ? t(key) : "";
    $("compatibility").hidden = !key;
  }
  function updateControls() {
    const locked = !bridge?.invoke || !initialized || saving;
    const dedicated = $("compressionMode").value === "dedicated";
    const selected = Boolean($("sourceModel").value);
    for (const field of $("settingsForm").elements) field.disabled = locked;
    $("compressionFields").hidden = !dedicated;
    $("compressionModel").disabled = locked || !dedicated;
    $("sourceApi").disabled = locked || (!dedicated && !selected);
    $("sourceModel").required = $("enabled").checked && dedicated;
    $("sourceApi").required = $("enabled").checked && (dedicated || selected);
    $("compressionModel").required = $("enabled").checked && dedicated;
    $("sourceDetail").textContent = selected ? modelParts($("sourceModel").value).join(" / ") : t(dedicated ? "choose" : "allModelsHint");
    $("refresh").disabled = !bridge?.invoke || snapshotPending || manualRefreshing || compactPending;
    $("refresh").title = $("refresh").ariaLabel = t(initialized ? "refresh" : "retry");
    const phase = currentRuntime.phase;
    $("compact").disabled = !initialized || !currentRuntime.systemAvailable || !currentRuntime.sessionId || compactPending || ["busy", "compacting"].includes(phase);
    $("compact").textContent = t(compactPending ? "compactPending" : "compact");
    let hint = "manualReady";
    if (!bridge?.invoke) hint = "preview";
    else if (!initialized) hint = "loadFirst";
    else if (!currentRuntime.sessionId) hint = "connectSession";
    else if (compactPending || phase === "compacting") hint = "compactingHint";
    else if (phase === "busy") hint = "busyHint";
    else if (!currentRuntime.systemAvailable) hint = currentRuntime.capability === "permissionRequired" ? "permissionHint" : "systemUnavailable";
    $("compactHint").textContent = t(hint);
    compatibility();
  }
  function applySettings(settings) {
    saved = { ...settings, compressionMode: settings.compressionMode === "dedicated" ? "dedicated" : "system", rescueOnLimit: settings.rescueOnLimit !== false };
    $("enabled").checked = saved.enabled === true;
    $("compressionMode").value = saved.compressionMode;
    $("rescueOnLimit").checked = saved.rescueOnLimit;
    $("sourceApi").value = typeof saved.sourceApi === "string" ? saved.sourceApi : "";
    $("threshold").value = saved.threshold ?? 90;
    fillSelect("sourceModel", identity(saved.sourceProvider, saved.sourceModelId));
    fillSelect("compressionModel", identity(saved.compressionProvider, saved.compressionModelId));
    dirty = false;
    badge();
    updateControls();
  }
  function when(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "—";
    return date.toLocaleString(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }
  function renderRuntime() {
    const status = currentRuntime;
    const phase = status.phase || "waiting";
    $("phase").textContent = t(phase);
    $("statusDot").className = `dot ${["error", "cooldown", "unsupported"].includes(phase) ? "error" : ["ready", "queued", "success", "compacting"].includes(phase) ? "active" : ""}`;
    $("count").textContent = Number.isInteger(status.count) ? `${status.countExact === false ? "≈" : ""}${status.count}` : "—";
    $("count").title = t("approximate");
    const max = Number.isInteger(status.threshold) ? status.threshold : saved?.threshold || 90;
    $("limit").textContent = max;
    $("progress").max = max;
    $("progress").value = Math.max(0, Math.min(status.count || 0, max));
    $("runtimeMessage").textContent = status.message || t("waitingHint");
    $("runtimeSession").textContent = status.sessionId || "—";
    $("runtimeModel").textContent = status.model ? `${status.model.provider} / ${status.model.id}${status.model.api ? ` · ${status.model.api}` : ""}` : "—";
    $("lastCompact").textContent = when(status.lastCompactAt);
    $("updated").textContent = when(status.updatedAt);
    updateControls();
  }
  function setRuntime(status) {
    currentRuntime = status && typeof status === "object" ? status : {};
    renderRuntime();
  }
  function appearance(value) {
    if (typeof value?.locale === "string") locale = value.locale;
    document.documentElement.lang = locale;
    document.documentElement.dataset.base = value?.base === "light" ? "light" : "dark";
    for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
    $("enabled").ariaLabel = t("enableLabel");
    $("progress").ariaLabel = t("progress");
    refreshOptions();
    badge();
    renderSaveState();
    renderRuntime();
    renderNotice();
  }
  function formChanged(event) {
    if (saving || !initialized) return;
    dirty = true;
    if (event.target.id === "compressionMode") refreshOptions();
    updateControls();
    renderSaveState();
  }
  $("settingsForm").addEventListener("input", formChanged);
  $("settingsForm").addEventListener("change", formChanged);
  $("settingsForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (!bridge?.invoke || !initialized || saving || !$("settingsForm").reportValidity()) return;
    const [sourceProvider = "", sourceModelId = ""] = modelParts($("sourceModel").value);
    const [compressionProvider = "", compressionModelId = ""] = modelParts($("compressionModel").value);
    const payload = { enabled: $("enabled").checked, sourceProvider, sourceModelId, sourceApi: $("sourceApi").value.trim(), compressionProvider, compressionModelId,
      threshold: Number($("threshold").value), compressionMode: $("compressionMode").value, rescueOnLimit: $("rescueOnLimit").checked };
    saving = true;
    updateControls();
    renderSaveState();
    try {
      const result = await invoke("guard.save", payload);
      if (!result.settings || typeof result.settings !== "object") throw new Error(t("invalidResponse"));
      applySettings(result.settings);
      saveStateKey = "saved";
      notice();
    } catch (error) {
      dirty = true;
      notice(error.message, true);
    } finally {
      saving = false;
      updateControls();
      renderSaveState();
    }
  });

  async function loadSnapshot() {
    if (!bridge?.invoke || initialized || snapshotPending) return;
    snapshotPending = true;
    const sequence = ++runtimeSequence;
    updateControls();
    try {
      const result = await invoke("guard.snapshot");
      if (!result.settings || typeof result.settings !== "object" || !result.runtime) throw new Error(t("invalidResponse"));
      catalog = Array.isArray(result.models) ? result.models.filter(row => row && typeof row.providerId === "string" && typeof row.modelId === "string") : [];
      $("catalogWarnings").textContent = Array.isArray(result.warnings) ? result.warnings.filter(message => typeof message === "string").join("\n") : "";
      $("catalogWarnings").hidden = !$("catalogWarnings").textContent;
      applySettings(result.settings);
      initialized = true;
      if (sequence === runtimeSequence) setRuntime(result.runtime);
      notice();
    } catch (error) {
      notice(error.message, true);
    } finally {
      snapshotPending = false;
      updateControls();
      renderSaveState();
    }
  }
  async function refresh(manual = false) {
    if (!bridge?.invoke || snapshotPending || compactPending) return;
    if (!initialized) {
      if (manual) await loadSnapshot();
      return;
    }
    if (manual ? manualRefreshing : statusPending > 0 || manualRefreshing) return;
    const sequence = ++runtimeSequence;
    const sessionId = currentRuntime.sessionId ?? null;
    statusPending += 1;
    if (manual) manualRefreshing = true;
    updateControls();
    try {
      const result = await invoke("guard.status");
      if (sequence !== runtimeSequence || sessionId !== (currentRuntime.sessionId ?? null)) return;
      if (!result.runtime) throw new Error(t("invalidResponse"));
      setRuntime(result.runtime);
      if (manual) notice();
    } catch (error) {
      if (sequence === runtimeSequence && sessionId === (currentRuntime.sessionId ?? null)) notice(error.message, true);
    } finally {
      statusPending -= 1;
      if (manual) manualRefreshing = false;
      updateControls();
    }
  }
  $("refresh").addEventListener("click", () => { void refresh(true); });
  $("compact").addEventListener("click", async () => {
    if (!bridge?.invoke || $("compact").disabled) return;
    const sessionId = currentRuntime.sessionId;
    const sequence = ++runtimeSequence;
    compactPending = true;
    updateControls();
    let refreshAfter = false;
    try {
      const result = await invoke("guard.compact", { sessionId });
      if (sequence !== runtimeSequence || sessionId !== currentRuntime.sessionId || result.runtime?.sessionId !== sessionId) throw new Error(t("sessionChanged"));
      setRuntime(result.runtime);
      notice();
    } catch (error) {
      notice(error.message, true);
      refreshAfter = true;
    } finally {
      compactPending = false;
      updateControls();
    }
    if (refreshAfter) await refresh();
  });
  async function start() {
    appearance(null);
    if (!bridge?.invoke) {
      notice("preview", false, true);
      return;
    }
    let appearanceChanged = false;
    bridge.on?.("appearance:changed", value => { appearanceChanged = true; appearance(value); });
    try {
      const value = await bridge.invoke("app.getAppearance");
      if (!appearanceChanged) appearance(value);
    } catch { /* 保留已收到的主题与语言。 */ }
    await loadSnapshot();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    window.addEventListener("pagehide", () => { clearInterval(timer); runtimeSequence += 1; }, { once: true });
  }
  void start();
})();
