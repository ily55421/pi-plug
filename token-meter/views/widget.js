/*
 * Token 计量 —— 速度浮窗渲染层。
 *
 * 与 views/panel.js 同源：读 pluginBridge 的设置快照，渲染成一行大号速度。
 * 区别是这里只展示「最近一次回复」，不做列表，也不做任何交互（见 widget.css
 * 里关于拖动区域与 pointer-events 的说明）。
 */

(function () {
  "use strict";

  const bridge = window.pluginBridge || null;

  /** 浮窗常驻可见，节奏比面板快一点，跟手即可。 */
  const POLL_MS = 1000;
  const POLL_HIDDEN_MS = 5000;
  const KEY_SNAPSHOT = "meterSnapshot";
  const KEY_APPEARANCE = "hostAppearance";

  /**
   * 本页面的内置版本号，必须与 manifest.json 的 version 一致。
   *
   * 与 panel.js 同一个理由：宿主覆盖安装时只重载插件进程，不销毁已有视图的
   * webview，所以浮窗里也可能跑着安装前的旧页面。发现版本落后就 reload 一次；
   * 守卫放在 sessionStorage，避免「磁盘页面比 manifest 旧」时无限刷新。
   */
  const VIEW_VERSION = "0.4.1";

  function shouldReloadForVersion(snapshotVersion) {
    if (!snapshotVersion || snapshotVersion === VIEW_VERSION) return false;
    try {
      const key = "tokenMeter.versionReload";
      if (window.sessionStorage.getItem(key) === snapshotVersion) return false;
      window.sessionStorage.setItem(key, snapshotVersion);
      return true;
    } catch {
      return false;
    }
  }

  const $ = (id) => document.getElementById(id);

  let appearanceKey = null;
  let renderKey = null;
  let timer = null;

  function speedText(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return String(Math.round(n));
  }

  function thousands(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return Math.round(n).toLocaleString("en-US");
  }

  function formatDuration(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n < 1000) return Math.round(n) + "ms";
    if (n < 60000) return (n / 1000).toFixed(1) + "s";
    const totalSeconds = Math.round(n / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 60) return minutes + "分" + seconds + "秒";
    return Math.floor(minutes / 60) + "小时" + (minutes % 60) + "分";
  }

  function setText(id, text) {
    const el = $(id);
    if (el && el.textContent !== text) el.textContent = text;
  }

  function applyAppearance(appearance) {
    const base = appearance && appearance.base;
    const resolved =
      base === "light" || base === "dark"
        ? base
        : window.matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark";
    if (document.documentElement.dataset.base !== resolved) {
      document.documentElement.dataset.base = resolved;
    }
  }

  function render(snapshot) {
    const latest = snapshot && snapshot.latest;
    const session = (snapshot && snapshot.session) || null;

    if (!snapshot || !snapshot.ok || !latest) {
      setText("value", "—");
      $("approx").hidden = true;
      setText("detail", "等待首次回复");
      setText("total", "");
      return;
    }

    const speed = speedText(latest.tokensPerSecond);
    setText("value", speed === null ? "—" : speed);
    $("approx").hidden = !latest.tokensPerSecondEstimated;

    // 第二行：这次回复的输出与用时。
    const bits = ["输出 " + (latest.outputEstimated ? "≈" : "") + thousands(latest.outputTokens) + " tok"];
    const duration = formatDuration(latest.durationMs);
    if (duration) bits.push("用时 " + duration);
    setText("detail", bits.join(" · "));

    // 第三行：本会话累计（面板里的完整数字在这里只留一行摘要）。
    if (session) {
      setText(
        "total",
        "会话 " + session.replies + " 条 · 累计 " + compact(session.totals.total) + " tok",
      );
    } else {
      setText("total", "");
    }
  }

  function compact(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return "0";
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(Math.round(n));
  }

  async function poll() {
    if (!bridge || typeof bridge.invoke !== "function") {
      setText("value", "—");
      setText("detail", "pluginBridge 不可用");
      return;
    }
    let settings;
    try {
      settings = await bridge.invoke("plugin.getSettings");
    } catch {
      setText("detail", "读取失败");
      return;
    }

    const appearance = (settings && settings[KEY_APPEARANCE]) || null;
    const key = appearance ? String(appearance.base || "") : "none";
    if (key !== appearanceKey) {
      appearanceKey = key;
      applyAppearance(appearance);
    }

    // 版本自检：覆盖安装后浮窗可能还在跑旧页面，发现插件进程更新就 reload 一次。
    if (shouldReloadForVersion(settings && settings[KEY_SNAPSHOT] && settings[KEY_SNAPSHOT].pluginVersion)) {
      window.location.reload();
      return;
    }

    const snapshot = settings && settings[KEY_SNAPSHOT];
    const renderKeyNext = JSON.stringify([
      snapshot ? snapshot.ok : null,
      snapshot && snapshot.latest ? snapshot.latest.id : null,
      snapshot && snapshot.latest ? snapshot.latest.tokensPerSecond : null,
      snapshot && snapshot.latest ? snapshot.latest.tokensPerSecondEstimated : null,
      snapshot && snapshot.session ? snapshot.session.replies : null,
      snapshot && snapshot.session ? snapshot.session.totals.total : null,
    ]);
    if (renderKeyNext === renderKey) return;
    renderKey = renderKeyNext;
    render(snapshot);
  }

  function start() {
    if (timer) window.clearInterval(timer);
    timer = window.setInterval(() => void poll(), document.hidden ? POLL_HIDDEN_MS : POLL_MS);
  }

  function boot() {
    applyAppearance(null);
    if (bridge && typeof bridge.on === "function") {
      bridge.on("appearance:changed", applyAppearance);
    }
    document.addEventListener("visibilitychange", () => {
      start();
      if (!document.hidden) void poll();
    });
    void poll();
    start();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
