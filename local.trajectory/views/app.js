/*
 * 轨迹回放 —— 停靠视图渲染层。
 *
 * 视图页没有 `pi` 对象，只有 window.pluginBridge。宿主把未识别的通道原样
 * 转发给插件进程的 onPanelInvoke，所以这里全部走 trajectory.* 自定义通道：
 *   trajectory.list      → 会话列表（每次最多重建 3 个索引，pendingCount 告知还剩多少）
 *   trajectory.timeline  → 某会话的 turn 序列 + compaction 标记
 *   trajectory.turn      → 一页 turn 内容（消息级，120 条/页）
 *   trajectory.block     → 单个块的完整内容（按字节偏移原位读）
 *   trajectory.appearance→ 宿主明暗/语言
 *   trajectory.rebuild   → 强制重建索引
 *
 * 诚信标注：turn 边界由用户消息推导（derived，虚线徽章）；token 数字来自
 * Pi 实测 meta.usage（measured，实线徽章）；宿主无费用数据，因此不显示费用。
 */

(function () {
  "use strict";

  const bridge = window.pluginBridge || null;

  const POLL_PENDING_MS = 2500;
  const POLL_APPEARANCE_MS = 3000;
  const POLL_FOLLOW_MS = 4000;
  const SCRUB_FETCH_DELAY = 140;
  const PAGE_LIMIT = 120;

  const $ = (id) => document.getElementById(id);

  /* --------------------------------------------------------------- i18n */

  const STR = {
    zh: {
      title: "轨迹回放",
      searchPh: "搜索会话…",
      noUser: "(无用户消息)",
      indexing: "索引中",
      stale: "未刷新",
      imported: "导入",
      turns: "turn",
      msgs: "消息",
      derived: "derived",
      measured: "measured",
      turnDerived: "turn 边界由用户消息推导 · derived",
      user: "用户",
      assistant: "助手",
      tool: "工具",
      thinking: "思考",
      args: "参数",
      result: "结果",
      expand: "展开全文",
      expandFail: "（该块过大，未能加载完整内容）",
      loadMore: "加载更多",
      emptyTurn: "该 turn 没有消息记录。",
      tooLarge: "这条消息过大，未整段加载。",
      broken: "这条消息无法解析（已如实跳过）。",
      loading: "正在读取本地会话…",
      empty: "没有可回放的会话",
      emptyBody: "在 PI-Desktop 里完成一次对话后，这里会出现可回放的会话。",
      indexingTitle: "索引构建中…",
      indexingBody: "正在为这个会话建立回放索引，稍候自动出现。",
      bridgeErr: "pluginBridge 不可用",
      bridgeBody: "本页面只能在 PI-Desktop 的工作面板视图里运行。",
      follow: "跟随当前会话",
      currentBadge: "当前",
      deleted: "已删除",
      refresh: "刷新",
      sessions: "会话列表",
      image: "图片",
      attachment: "附件",
      noUsage: "无 usage 记录",
      compaction: "压缩",
      confirm: "完成",
      aborted: "中止",
      error: "错误",
      prelude: "前奏（首条用户消息之前）",
      spanMs: "跨度",
      modelMs: "模型用时",
      out: "出",
      in: "入",
      cacheRead: "缓存读",
      ctxIn: "上下文规模",
      speed: "速度",
      updated: "刷新于",
    },
    en: {
      title: "Trajectory",
      searchPh: "Search sessions…",
      noUser: "(no user message)",
      indexing: "indexing",
      stale: "stale",
      imported: "imported",
      turns: "turns",
      msgs: "msgs",
      derived: "derived",
      measured: "measured",
      turnDerived: "turns derived from user messages · derived",
      user: "User",
      assistant: "Assistant",
      tool: "Tool",
      thinking: "Thinking",
      args: "args",
      result: "result",
      expand: "Show full",
      expandFail: "(block too large to load in full)",
      loadMore: "Load more",
      emptyTurn: "No messages recorded in this turn.",
      tooLarge: "Message too large; not loaded in full.",
      broken: "This message failed to parse (skipped honestly).",
      loading: "Reading local sessions…",
      empty: "No replayable sessions",
      emptyBody: "Finish a conversation in PI-Desktop and it will appear here.",
      indexingTitle: "Building index…",
      indexingBody: "Replay index for this session is being built; it will appear shortly.",
      bridgeErr: "pluginBridge unavailable",
      bridgeBody: "This page only runs inside a PI-Desktop work-panel view.",
      follow: "Follow current session",
      currentBadge: "current",
      deleted: "deleted",
      refresh: "Refresh",
      sessions: "Sessions",
      image: "image",
      attachment: "attachment",
      noUsage: "no usage recorded",
      compaction: "compaction",
      confirm: "complete",
      aborted: "aborted",
      error: "error",
      prelude: "Prelude (before first user message)",
      spanMs: "span",
      modelMs: "model time",
      out: "out",
      in: "in",
      cacheRead: "cache read",
      ctxIn: "context size",
      speed: "speed",
      updated: "updated",
    },
  };

  const state = {
    lang: "zh",
    sessions: [],
    pendingCount: 0,
    current: null, // 服务端判定的「当前会话」{name,id,title,basis}
    query: "",
    selected: null, // { name, id, mtimeMs, stale, partial }
    timeline: null,
    turnN: null,
    items: [],
    itemCount: 0,
    hasMore: false,
    follow: false,
    builtOut: 0,
    loadingList: false,
    loadingTimeline: false,
    loadingTurn: false,
    pendingPollTimer: null,
    pendingPolls: 0,
    followTimer: null,
    appearanceTimer: null,
    scrubTimer: null,
    dragTurn: null,
    lastTurnN: null,
    renderedListKey: null,
  };

  function T(key) {
    return STR[state.lang][key] || STR.zh[key] || key;
  }

  /* --------------------------------------------------------------- 工具 */

  async function api(channel, payload) {
    const res = await bridge.invoke(channel, payload || {});
    if (!res || res.ok !== true) {
      const err = res && res.error ? res.error : "NO_RESPONSE";
      throw new Error(err);
    }
    return res;
  }

  function compactNum(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return "0";
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return String(Math.round(v));
  }

  function thousands(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    return Math.round(v).toLocaleString("en-US");
  }

  function fmtDur(ms) {
    const v = Number(ms);
    if (!Number.isFinite(v) || v <= 0) return "—";
    if (v < 1000) return Math.round(v) + "ms";
    if (v < 60000) return (v / 1000).toFixed(1) + "s";
    const total = Math.round(v / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    if (m < 60) return m + "m" + s + "s";
    return Math.floor(m / 60) + "h" + (m % 60) + "m";
  }

  function fmtClock(ts) {
    const d = new Date(Number(ts));
    if (Number.isNaN(d.getTime())) return "—";
    const p = (x) => String(x).padStart(2, "0");
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  function fmtDay(ts) {
    const d = new Date(Number(ts));
    if (Number.isNaN(d.getTime())) return "—";
    const p = (x) => String(x).padStart(2, "0");
    return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function badge(text, opts) {
    const cls = ["badge"];
    if (opts && opts.measured) cls.push("measured");
    if (opts && opts.derived) cls.push("derived");
    if (opts && opts.model) cls.push("model");
    if (opts && opts.st) cls.push("st-" + opts.st);
    const node = el("span", cls.join(" "));
    if (opts && (opts.measured || opts.derived)) {
      const mk = el("span", "mk", opts.measured ? "●" : "○");
      node.appendChild(mk);
      mk.title = opts.measured ? "Pi 实测 (measured)" : "推导值 (derived)";
    }
    node.appendChild(el("span", null, text));
    if (opts && opts.title) node.title = opts.title;
    return node;
  }

  /* --------------------------------------------------------------- 状态屏 */

  function showState(title, body) {
    $("stateBox").hidden = false;
    $("timelineBox").hidden = true;
    $("inspector").hidden = true;
    $("stateTitle").textContent = title;
    $("stateBody").textContent = body || "";
  }

  function showContent() {
    $("stateBox").hidden = true;
    $("timelineBox").hidden = false;
    $("inspector").hidden = false;
  }

  /* --------------------------------------------------------------- 主题 */

  function applyAppearance(ap) {
    const base = ap && (ap.base === "light" || ap.base === "dark") ? ap.base : null;
    const resolved =
      base ||
      (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    if (document.documentElement.dataset.base !== resolved) {
      document.documentElement.dataset.base = resolved;
    }
    const locale = ap && typeof ap.locale === "string" ? ap.locale : "";
    const prevLang = state.lang;
    state.lang = /^en/i.test(locale) ? "en" : "zh";
    if (prevLang !== state.lang) {
      applyI18n();
      if (state.sessions.length) renderList(true);
      if (state.timeline) renderTurnHeader();
    }
  }

  function applyI18n() {
    $("headTitle").textContent = T("title");
    $("searchInput").placeholder = T("searchPh");
    $("followBtn").title = T("follow");
    $("refreshBtn").title = T("refresh");
    $("toggleSessions").title = T("sessions");
    $("derivedNote").textContent = T("turnDerived");
    if (state.timeline) renderFooter();
  }

  async function pollAppearance() {
    try {
      const ap = await api("trajectory.appearance");
      applyAppearance(ap);
    } catch {
      /* 主题拿不到就算了 */
    }
  }

  /* --------------------------------------------------------------- 会话列表 */

  function sessionMatches(s, q) {
    if (!q) return true;
    const hay = (s.title || "") + " " + (s.name || "") + " " + (s.models || []).join(" ");
    return hay.toLowerCase().indexOf(q) >= 0;
  }

  function renderList(force) {
    const q = state.query.trim().toLowerCase();
    const rows = state.sessions.filter((s) => sessionMatches(s, q));
    const key = q + "|" + rows.length + "|" + (rows[0] ? rows[0].name : "") + "|" + state.selected;
    if (!force && key === state.renderedListKey) return;
    state.renderedListKey = key;

    const list = $("sessionList");
    list.textContent = "";
    if (!rows.length) {
      list.appendChild(el("div", "note", state.sessions.length ? "（无匹配）" : "…"));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const s of rows) {
      const row = el("button", "session-row" + (state.selected === s.name ? " active" : ""));
      row.type = "button";
      const title = el("div", "s-title", s.title || T("noUser"));
      const meta = el("div", "s-meta");
      const bits = [];
      bits.push(fmtDay(s.lastAt));
      if (s.turns != null) bits.push(s.turns + " " + T("turns"));
      if (s.out != null) bits.push("out " + compactNum(s.out));
      meta.appendChild(el("span", null, bits.join(" · ")));
      meta.appendChild(el("span", "grow"));
      if (s.partial) meta.appendChild(el("span", "mini-badge warn", T("indexing")));
      else if (s.stale) meta.appendChild(el("span", "mini-badge", T("stale")));
      if (state.current && state.current.name === s.name)
        meta.appendChild(el("span", "mini-badge cur", T("currentBadge")));
      if (s.isDeleted) meta.appendChild(el("span", "mini-badge", T("deleted")));
      if (s.imported) meta.appendChild(el("span", "mini-badge", T("imported")));
      row.appendChild(title);
      row.appendChild(meta);
      row.addEventListener("click", () => selectSession(s));
      frag.appendChild(row);
    }
    list.appendChild(frag);
    updateHeadStatus();
  }

  function updateHeadStatus() {
    const parts = [];
    if (state.pendingCount > 0) parts.push(T("indexing") + " " + state.pendingCount);
    if (state.current) {
      const label = state.current.title || state.current.name;
      parts.push(T("currentBadge") + ": " + (label.length > 24 ? label.slice(0, 24) + "…" : label));
    }
    parts.push(state.sessions.length + " " + T("msgs"));
    $("headStatus").textContent = parts.join(" · ");
  }

  async function loadList(opts) {
    const align = !!(opts && opts.align);
    if (state.loadingList) return;
    state.loadingList = true;
    try {
      const res = await api("trajectory.list");
      state.sessions = res.sessions || [];
      state.pendingCount = res.pendingCount || 0;
      state.current = res.current || null;
      renderList(true);
      updateHeadStatus();
      renderFooter();

      // 对齐「当前会话」：面板打开（boot / 变为可见）或开启跟随时切换过去；
      // 普通轮询与手动刷新不打断用户正在翻看的会话。
      const currentRow = state.current
        ? state.sessions.find((s) => s.name === state.current.name)
        : null;
      if (currentRow && (align || state.follow) && currentRow.name !== state.selected) {
        selectSession(currentRow);
      } else if (!state.selected && state.sessions.length) {
        selectSession(currentRow || state.sessions[0]);
      } else {
        // 已选会话刚建好索引 → 重新拉时间线。
        const cur = state.sessions.find((s) => s.name === state.selected);
        if (cur && state.timeline && (cur.partial || cur.stale)) {
          void loadTimeline();
        }
        if (cur && state.selectedRow && cur.mtimeMs !== state.selectedRow.mtimeMs && !cur.partial && !cur.stale) {
          void loadTimeline();
        }
        if (cur) state.selectedRow = cur;
      }

      // 还有索引待建 → 继续轮询（list 每次最多重建 3 个）。
      if (state.pendingCount > 0 && state.pendingPolls < 60) {
        schedulePendingPoll();
      } else {
        stopPendingPoll();
      }
    } catch (err) {
      showState(T("bridgeErr") + "：" + String(err.message || err), T("bridgeBody"));
    } finally {
      state.loadingList = false;
    }
  }

  function schedulePendingPoll() {
    if (state.pendingPollTimer) return;
    state.pendingPolls++;
    state.pendingPollTimer = window.setTimeout(() => {
      state.pendingPollTimer = null;
      if (!document.hidden) void loadList();
    }, POLL_PENDING_MS);
  }

  function stopPendingPoll() {
    if (state.pendingPollTimer) window.clearTimeout(state.pendingPollTimer);
    state.pendingPollTimer = null;
    state.pendingPolls = 0;
  }

  /* --------------------------------------------------------------- 时间线 */

  function selectSession(s) {
    if (!s || state.selected === s.name && state.timeline) return;
    state.selected = s.name;
    state.selectedRow = s;
    state.timeline = null;
    state.turnN = null;
    state.items = [];
    renderList(true);
    if (s.partial) {
      showState(T("indexingTitle"), T("indexingBody"));
      schedulePendingPoll();
      return;
    }
    void loadTimeline();
  }

  async function loadTimeline() {
    if (!state.selected || state.loadingTimeline) return;
    state.loadingTimeline = true;
    try {
      const prevN = state.turnN;
      const prevLast = state.lastTurnN;
      const res = await api("trajectory.timeline", { file: state.selected });
      state.timeline = res;
      showContent();
      renderStrip();
      const turns = res.turns || [];
      if (!turns.length) {
        state.turnN = null;
        state.lastTurnN = null;
        $("inspector").textContent = "";
        return;
      }
      const lastN = turns[turns.length - 1].n;
      state.lastTurnN = lastN;
      let target;
      if (prevN == null) target = lastN;
      // 之前就停在最后一个 turn → 跟随新出现的 turn（live 回放体验）
      else if (prevN === prevLast) target = lastN;
      // 用户手动选过别的 turn → 轮询刷新不打断
      else if (turns.some((t) => t.n === prevN)) target = prevN;
      else target = lastN;
      selectTurn(target, true);
    } catch (err) {
      showState("加载时间线失败", String(err.message || err));
    } finally {
      state.loadingTimeline = false;
    }
  }

  function maxOut(turns) {
    let m = 0;
    for (const t of turns) if (t.out != null && t.out > m) m = t.out;
    return m || 1;
  }

  function renderStrip() {
    const tl = state.timeline;
    if (!tl) return;
    const strip = $("strip");
    strip.textContent = "";

    $("sessionName").textContent =
      (tl.turns || []).length + " " + T("turns") + " · " +
      (tl.session && tl.session.name ? tl.session.name : "");
    const badges = $("sessionBadges");
    badges.textContent = "";
    const totals = tl.session && tl.session.totals;
    if (totals) {
      badges.appendChild(
        badge("out " + compactNum(totals.out) + " tok", { measured: true, title: "Σ outputTokens（Pi 实测）" }),
      );
      if (totals.cr > 0) badges.appendChild(badge("cacheR " + compactNum(totals.cr), { measured: true }));
      badges.appendChild(badge(fmtDur(totals.modelMs) + " " + T("modelMs"), { measured: true }));
      badges.appendChild(badge(totals.msgs + " " + T("msgs"), { measured: true }));
    }
    if (tl.session && tl.session.schema != null && tl.session.schema !== 1) {
      badges.appendChild(badge("schema " + tl.session.schema, { st: "aborted" }));
    }

    const turns = tl.turns || [];
    const markers = tl.markers || [];
    const markerByTurn = new Map();
    for (const m of markers) {
      if (m.turnIdx != null) markerByTurn.set(m.turnIdx, m);
    }
    const mo = maxOut(turns);
    const frag = document.createDocumentFragment();

    for (const t of turns) {
      const m = markerByTurn.get(t.n);
      if (m) {
        const cut = el("div", "cut-marker");
        cut.title = T("compaction") + (m.p ? " · " + m.p : "") + " · " + fmtClock(m.ts);
        frag.appendChild(cut);
      }
      const cell = el("div", "turn-cell" + (t.kind === "prelude" ? " prelude" : ""));
      cell.dataset.n = String(t.n);

      const top = el("div", "cell-top");
      top.appendChild(el("span", "cell-label", t.kind === "prelude" ? "P" : "T" + t.n));
      if (t.st) top.appendChild(el("span", "cell-status " + t.st));
      cell.appendChild(top);

      const bars = el("div", "cell-bars");
      const outH = t.out != null ? 4 + 30 * Math.sqrt(t.out / mo) : 0;
      const bar = el("div", "cell-bar");
      bar.style.height = Math.max(2, Math.round(outH)) + "px";
      if (t.st === "aborted" || t.st === "error") bar.style.background = "var(--tool)";
      bars.appendChild(bar);
      if (t.think > 0) {
        const tb = el("div", "cell-bar tool");
        tb.style.height = Math.max(2, Math.round(4 + 30 * Math.sqrt(t.think / Math.max(t.tools + t.think, 1)))) + "px";
        bars.appendChild(tb);
      }
      cell.appendChild(bars);

      const chips = el("div", "cell-chips");
      if (t.tools > 0) chips.appendChild(el("span", "c-tool", "🛠" + t.tools));
      if (t.think > 0) chips.appendChild(el("span", "c-think", "◔" + t.think));
      if (!chips.childNodes.length) chips.appendChild(el("span", null, "·"));
      cell.appendChild(chips);

      const tokens = el("div", "cell-tokens");
      const bits = [];
      if (t.out != null) bits.push("out " + compactNum(t.out));
      if (t.ctxIn != null) bits.push("ctx≈" + compactNum(t.ctxIn));
      tokens.textContent = bits.join(" ") || "—";
      cell.appendChild(tokens);

      const tip = [];
      tip.push((t.kind === "prelude" ? T("prelude") : "#" + t.n + " " + t.preview));
      tip.push(T("spanMs") + " " + fmtDur(t.spanMs) + " ○derived");
      if (t.out != null) tip.push("out " + thousands(t.out) + " ●measured");
      if (t.models && t.models.length) tip.push(t.models.join(", "));
      cell.title = tip.join("\n");

      cell.addEventListener("click", (e) => {
        if (state.dragTurn != null) return;
        selectTurn(t.n);
      });
      frag.appendChild(cell);
    }
    strip.appendChild(frag);
    renderFooter();
  }

  function cellForTurn(n) {
    return $("strip").querySelector('.turn-cell[data-n="' + n + '"]');
  }

  function movePlayhead(n) {
    const cell = cellForTurn(n);
    const ph = $("playhead");
    if (!cell) {
      ph.hidden = true;
      return;
    }
    ph.hidden = false;
    const strip = $("strip");
    const left = cell.offsetLeft - strip.scrollLeft + cell.offsetWidth / 2;
    ph.style.left = left + "px";
    const target = cell.offsetLeft - (strip.clientWidth - cell.offsetWidth) / 2;
    if (Math.abs(strip.scrollLeft - target) > 8) {
      strip.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
    }
  }

  function selectTurn(n, immediate) {
    state.turnN = n;
    const cells = $("strip").querySelectorAll(".turn-cell");
    cells.forEach((c) => c.classList.toggle("active", c.dataset.n === String(n)));
    movePlayhead(n);
    window.clearTimeout(state.scrubTimer);
    if (immediate) {
      void loadTurn(0, true);
    } else {
      state.scrubTimer = window.setTimeout(() => void loadTurn(0, true), SCRUB_FETCH_DELAY);
    }
  }

  /* --------------------------------------------------------------- 详情 */

  function renderTurnHeader() {
    const insp = $("inspector");
    insp.textContent = "";
    const tl = state.timeline;
    if (!tl) return;
    const turn = (tl.turns || []).find((t) => t.n === state.turnN);
    if (!turn) return;
    const head = el("div", "turn-head");
    head.appendChild(
      el("span", "t-label", (turn.kind === "prelude" ? "P" : "T" + turn.n)),
    );
    if (turn.kind === "prelude") head.appendChild(el("span", "note", T("prelude")));
    head.appendChild(badge(T("spanMs") + " " + fmtDur(turn.spanMs), { derived: true }));
    head.appendChild(badge(T("modelMs") + " " + fmtDur(turn.modelMs), { measured: true }));
    if (turn.out != null) {
      head.appendChild(badge(T("out") + " " + thousands(turn.out), { measured: true }));
    }
    if (turn.ctxIn != null) {
      head.appendChild(badge("ctx≈" + thousands(turn.ctxIn), { derived: true, title: "turn 末尾 inputTokens+cacheRead 的近似" }));
    }
    if (turn.cr != null && turn.cr > 0) head.appendChild(badge(T("cacheRead") + " " + compactNum(turn.cr), { measured: true }));
    if (turn.models && turn.models.length) {
      head.appendChild(badge(turn.models.join(", "), { model: true }));
    }
    if (turn.st && turn.st !== "complete") head.appendChild(badge(T(turn.st), { st: turn.st }));
    head.appendChild(badge("turn " + T("derived"), { derived: true }));
    insp.appendChild(head);
  }

  async function loadTurn(offset, reset) {
    if (!state.selected || state.turnN == null || state.loadingTurn) return;
    state.loadingTurn = true;
    try {
      const res = await api("trajectory.turn", {
        file: state.selected,
        turnN: state.turnN,
        offset,
        limit: PAGE_LIMIT,
      });
      if (state.turnN !== res.turn.n) return; // 期间用户又换了 turn
      if (reset) {
        state.items = [];
        state.itemCount = 0;
        state.hasMore = false;
        renderTurnHeader();
      }
      state.items = state.items.concat(res.items || []);
      state.itemCount = res.total || state.items.length;
      state.hasMore = !!res.hasMore;
      appendItems(res.items || [], offset);
      renderFooter();
    } catch (err) {
      const note = el("div", "note", "加载 turn 失败：" + String(err.message || err));
      $("inspector").appendChild(note);
    } finally {
      state.loadingTurn = false;
    }
  }

  function appendItems(items, startIdx) {
    const insp = $("inspector");
    const oldMore = insp.querySelector(".load-more");
    if (oldMore) oldMore.remove();

    if (!items.length && state.items.length === items.length) {
      insp.appendChild(el("div", "note", T("emptyTurn")));
      return;
    }
    const frag = document.createDocumentFragment();
    items.forEach((item, i) => frag.appendChild(renderItem(item, (startIdx || 0) + i)));
    insp.appendChild(frag);

    if (state.hasMore) {
      const btn = el("button", "load-more", T("loadMore") + "（" + state.items.length + "/" + state.itemCount + "）");
      btn.type = "button";
      btn.addEventListener("click", () => void loadTurn(state.items.length, false));
      insp.appendChild(btn);
    }
  }

  function renderItem(item, seq) {
    const wrap = el("div", "item");
    const head = el("div", "item-head");
    const roleKey = item.kind === "user" ? "user" : item.kind === "assistant" ? "assistant" : "tool";
    const role = el("span", "role" + (item.kind === "tool" ? " tool" : ""), T(roleKey) + " #" + seq);
    head.appendChild(role);
    if (item.ts != null) head.appendChild(el("span", null, fmtClock(item.ts)));
    if (item.kind === "assistant") {
      if (item.model) head.appendChild(el("span", "model", item.model));
      const bits = [];
      if (item.dur != null) bits.push(fmtDur(item.dur));
      if (item.usage) {
        if (item.usage.o != null) bits.push("out " + thousands(item.usage.o));
        if (item.usage.i != null) bits.push("in " + thousands(item.usage.i));
        if (item.usage.cr != null && item.usage.cr > 0) bits.push("cr " + compactNum(item.usage.cr));
        if (item.usage.r != null && item.usage.r > 0) bits.push("rr " + compactNum(item.usage.r));
        if (item.usage.o != null && item.dur > 0) bits.push("≈" + Math.round(item.usage.o / (item.dur / 1000)) + " tok/s");
      }
      const right = el("span", "right", bits.join(" · "));
      head.appendChild(right);
      if (item.st && item.st !== "complete") head.appendChild(el("span", "mini-badge warn", T(item.st)));
    }
    wrap.appendChild(head);

    if (item.tooLarge) {
      wrap.appendChild(el("div", "note", T("tooLarge")));
      return wrap;
    }
    if (item.broken) {
      wrap.appendChild(el("div", "note", T("broken")));
      return wrap;
    }
    if (item.kind === "user") {
      const bubble = el("div", "user-bubble");
      let textBlocks = 0;
      for (const b of item.blocks || []) {
        if (b.t === "text") {
          bubble.appendChild(el("span", null, b.text || ""));
          if (b.trunc) attachExpand(bubble, item, b);
          textBlocks++;
        } else {
          bubble.appendChild(renderChipBlock(b));
        }
      }
      if (!textBlocks) bubble.appendChild(el("span", "note", "（无文本块）"));
      wrap.appendChild(bubble);
      return wrap;
    }
    if (item.kind === "assistant") {
      const holder = el("div", "assistant-block");
      for (const b of item.blocks || []) holder.appendChild(renderRichBlock(item, b));
      if (!(item.blocks || []).length) holder.appendChild(el("div", "note", "（无块）"));
      wrap.appendChild(holder);
      if (item.usage == null) wrap.appendChild(el("div", "note", T("noUsage")));
      return wrap;
    }
    // tool / 其他角色
    for (const b of item.blocks || []) wrap.appendChild(renderRichBlock(item, b));
    return wrap;
  }

  function renderChipBlock(b) {
    if (b.t === "image") {
      return el("span", "chip", "🖼 " + T("image") + " " + (b.m || "") + (b.kb ? " ~" + b.kb + "KB" : ""));
    }
    if (b.t === "attachment") {
      const name = (b.n || "").split(/[\\/]/).pop() || T("attachment");
      return el("span", "chip", "📎 " + name + (b.kb ? " " + b.kb + "KB" : ""));
    }
    return el("span", "chip", b.t);
  }

  function renderRichBlock(item, b) {
    if (b.t === "text") {
      const box = el("div", "text-block");
      box.textContent = b.text || "";
      if (b.trunc) attachExpand(box, item, b);
      return box;
    }
    if (b.t === "thinking") {
      const det = el("details", "block");
      const sum = el("summary", null);
      sum.appendChild(el("span", "think-tag", "◐ " + T("thinking")));
      sum.appendChild(el("span", null, (b.fullLen || (b.text || "").length) + " 字"));
      det.appendChild(sum);
      const body = el("div", "body");
      const pre = el("pre", "pre dim", b.text || "");
      body.appendChild(pre);
      if (b.trunc) attachExpand(body, item, b);
      det.appendChild(body);
      return det;
    }
    if (b.t === "tool_call") {
      const card = el("div", "tool-card");
      const s1 = el("div", "sect");
      const nameRow = el("div", null);
      nameRow.appendChild(el("span", "tool-name tool-tag", b.n || "(tool)"));
      if (b.d != null) nameRow.appendChild(el("span", null, " · " + fmtDur(b.d)));
      s1.appendChild(nameRow);
      const argsPre = el("pre", "pre dim", b.args || "");
      s1.appendChild(argsPre);
      if (b.argsTrunc) attachExpand(s1, item, b, "args");
      card.appendChild(s1);
      const s2 = el("div", "sect");
      s2.appendChild(el("div", "sect-label", T("result")));
      const resPre = el("pre", "pre", b.result || "");
      s2.appendChild(resPre);
      if (b.resultTrunc) attachExpand(s2, item, b, "result");
      card.appendChild(s2);
      return card;
    }
    if (b.t === "image") return renderChipBlock(b);
    if (b.t === "attachment") return renderChipBlock(b);
    const box = el("div", "text-block");
    box.textContent = b.p || b.t || "";
    return box;
  }

  function attachExpand(container, item, b, part) {
    const btn = el("button", "expand-btn", T("expand"));
    btn.type = "button";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "…";
      try {
        const res = await api("trajectory.block", {
          file: state.selected,
          off: item.off,
          len: item.len,
          bi: b.bi,
        });
        const blk = res.block || {};
        let text = "";
        if (part === "args") text = blk.args || "";
        else if (part === "result") text = blk.result || "";
        else text = blk.text || "";
        const pre = el("pre", "pre" + (part ? " dim" : ""), text);
        if (part === "args") {
          const old = container.querySelector("pre");
          if (old) old.remove();
          container.insertBefore(pre, btn);
        } else if (part === "result") {
          const old = container.querySelector("pre");
          if (old) old.remove();
          container.insertBefore(pre, btn);
        } else {
          const host = container.classList.contains("body") ? container : container;
          const old = host.querySelector("pre");
          if (old) old.remove();
          host.insertBefore(pre, btn);
        }
        if (blk.trunc || blk.argsTrunc || blk.resultTrunc) {
          const note = el("div", "note", T("expandFail"));
          container.insertBefore(note, btn);
        }
        btn.remove();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "⚠ " + String(err.message || err);
      }
    });
    container.appendChild(btn);
  }

  /* --------------------------------------------------------------- 底部 */

  function renderFooter() {
    const tl = state.timeline;
    const bits = [];
    bits.push(T("turnDerived"));
    bits.push("usage ●" + T("measured"));
    bits.push("cost —（宿主无费用数据）");
    if (tl && tl.session) {
      const lines = tl.session.lines;
      if (lines && lines.skipped > 0) bits.push("跳过 " + lines.skipped + " 行");
    }
    bits.push(T("updated") + " " + fmtClock(Date.now()));
    $("foot").textContent = bits.join(" · ");
  }

  /* --------------------------------------------------------------- 交互 */

  function bindStripDrag() {
    const wrap = $("stripWrap");
    const strip = $("strip");
    let dragging = false;

    const turnAt = (clientX) => {
      const rect = strip.getBoundingClientRect();
      const x = clientX - rect.left + strip.scrollLeft;
      const cells = strip.querySelectorAll(".turn-cell");
      for (const c of cells) {
        const l = c.offsetLeft;
        if (x >= l && x <= l + c.offsetWidth) return Number(c.dataset.n);
        if (x < l) return Number(c.dataset.n); // 点在第一个单元格左侧
      }
      const last = cells[cells.length - 1];
      return last ? Number(last.dataset.n) : null;
    };

    wrap.addEventListener("pointerdown", (e) => {
      if (!state.timeline || !(state.timeline.turns || []).length) return;
      dragging = true;
      wrap.setPointerCapture(e.pointerId);
      const n = turnAt(e.clientX);
      if (n != null) {
        state.dragTurn = n;
        selectTurn(n);
      }
    });
    wrap.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const n = turnAt(e.clientX);
      if (n != null && n !== state.dragTurn) {
        state.dragTurn = n;
        selectTurn(n);
      }
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      state.dragTurn = null;
      try {
        wrap.releasePointerCapture(e.pointerId);
      } catch {
        /* 没捕获就算了 */
      }
    };
    wrap.addEventListener("pointerup", end);
    wrap.addEventListener("pointercancel", end);

    strip.addEventListener("scroll", () => {
      if (state.turnN != null) {
        const cell = cellForTurn(state.turnN);
        const ph = $("playhead");
        if (cell) ph.style.left = cell.offsetLeft - strip.scrollLeft + cell.offsetWidth / 2 + "px";
      }
    });

    document.addEventListener("keydown", (e) => {
      if (document.hidden || !state.timeline) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const turns = state.timeline.turns || [];
      if (!turns.length) return;
      e.preventDefault();
      const idx = turns.findIndex((t) => t.n === state.turnN);
      const next = e.key === "ArrowLeft" ? Math.max(0, idx - 1) : Math.min(turns.length - 1, idx + 1);
      selectTurn(turns[next].n);
    });
  }

  function bindChrome() {
    $("refreshBtn").addEventListener("click", async () => {
      const btn = $("refreshBtn");
      btn.classList.add("spin");
      try {
        await loadList();
        if (state.selected && state.timeline) await loadTimeline();
      } finally {
        btn.classList.remove("spin");
      }
    });

    $("followBtn").addEventListener("click", () => {
      state.follow = !state.follow;
      $("followBtn").classList.toggle("on", state.follow);
      try {
        localStorage.setItem("trajectory.follow", state.follow ? "1" : "");
      } catch {
        /* 隐私模式下 localStorage 可能不可用 */
      }
      if (state.follow) void loadList();
    });

    $("toggleSessions").addEventListener("click", () => {
      const pane = $("sessionsPane");
      const collapsed = pane.classList.toggle("collapsed");
      try {
        localStorage.setItem("trajectory.sessionsCollapsed", collapsed ? "1" : "");
      } catch {
        /* 忽略 */
      }
    });

    let searchTimer = null;
    $("searchInput").addEventListener("input", (e) => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        state.query = e.target.value || "";
        renderList(true);
      }, 120);
    });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        void pollAppearance();
        void loadList({ align: true }); // 面板变为可见 = 用户打开轨迹回放：对齐当前会话
      }
    });
  }

  function startFollowTimer() {
    if (state.followTimer) window.clearInterval(state.followTimer);
    state.followTimer = window.setInterval(() => {
      if (document.hidden) return;
      if (state.follow || state.pendingCount > 0) void loadList();
    }, POLL_FOLLOW_MS);
  }

  function startAppearanceTimer() {
    if (state.appearanceTimer) window.clearInterval(state.appearanceTimer);
    state.appearanceTimer = window.setInterval(() => {
      if (!document.hidden) void pollAppearance();
    }, POLL_APPEARANCE_MS);
  }

  /* --------------------------------------------------------------- 启动 */

  function boot() {
    applyAppearance(null);
    try {
      state.follow = localStorage.getItem("trajectory.follow") === "1";
    } catch {
      /* 忽略 */
    }
    $("followBtn").classList.toggle("on", state.follow);
    try {
      if (localStorage.getItem("trajectory.sessionsCollapsed") === "1") {
        $("sessionsPane").classList.add("collapsed");
      }
    } catch {
      /* 忽略 */
    }

    if (!bridge || typeof bridge.invoke !== "function") {
      showState(T("bridgeErr"), T("bridgeBody"));
      return;
    }

    if (typeof bridge.on === "function") {
      try {
        bridge.on("appearance:changed", applyAppearance);
      } catch {
        /* 停靠视图收不到该事件是已知限制 */
      }
    }

    bindChrome();
    bindStripDrag();
    applyI18n();
    showState(T("loading"), "");
    void pollAppearance();
    void loadList({ align: true });
    startFollowTimer();
    startAppearanceTimer();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
