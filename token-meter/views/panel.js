/*
 * Token 计量 —— 停靠视图渲染层。
 *
 * 视图页没有 `pi` 对象，只能通过 window.pluginBridge 读宿主数据。插件进程
 * 把算好的快照写进插件设置，这里轮询 plugin.getSettings 渲染即可。
 *
 * 本文件对宿主只读：从不写设置、从不读数据库、不发网络请求。
 */

(function () {
  "use strict";

  const bridge = window.pluginBridge || null;

  /** 可见时 1.5s，隐藏时 6s；面板常常可见但没有焦点，所以跟随可见性而不是焦点。 */
  const POLL_MS = 1500;
  const POLL_HIDDEN_MS = 6000;

  /** 插件进程写进设置的三个键，与 main.js 保持一致。 */
  const KEY_SNAPSHOT = "meterSnapshot";
  const KEY_APPEARANCE = "hostAppearance";
  const KEY_HISTORY = "meterHistory";

  /** 明细表最多列多少行；超过的行数在表尾注明，而不是静默截断。 */
  const TABLE_LIMIT = 14;
  /** 当前看板周期：day | month | year。 */
  const SCOPES = ["day", "month", "year"];

  /** 周期在界面上的说法：主数字的标题与卡片注释共用。 */
  const SCOPE_NAMES = { day: "今日", month: "本月", year: "今年" };
  /** 柱状图标题：粒度跟着周期走，标题也得跟着改，否则会误读成「每日」。 */
  const CHART_TITLES = { day: "每日消耗趋势", month: "每月消耗趋势", year: "每年消耗趋势" };
  /** 周期单位，用在柱子的悬浮提示里（「点击查看该天 / 该月 / 该年」）。 */
  const PERIOD_UNITS = { day: "天", month: "月", year: "年" };

  /**
   * 本页面的内置版本号，必须与 manifest.json 的 version 一致。
   *
   * 用途是自检：宿主在「安装插件包」时只重载插件进程，不会销毁已有的视图
   * webview（只有停用 / 卸载 / 崩溃 / dev 重载才销毁）。所以覆盖安装后，这个
   * 面板里跑的可能仍是安装前那份旧页面——数据是新的，界面却是旧的。
   * 插件进程把版本号随快照发布，这里发现不一致就自行 reload 一次，
   * 用户不必手动停用再启用。
   */
  const VIEW_VERSION = "0.4.1";

  /**
   * 是否该为版本不一致重新加载。
   *
   * 守卫必须跨 reload 存活，否则「磁盘上的页面比 manifest 旧」会变成无限刷新。
   * 所以用 sessionStorage 记住「已经为哪个版本重载过」；拿不到存储时宁可不自动
   * 重载——显示旧界面总好过刷屏。
   */
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

  const state = {
    snapshot: null,
    /** 跨会话累计统计；插件进程慢节奏发布，可能比 snapshot 晚到。 */
    history: null,
    /** 看板当前周期。 */
    scope: "day",
    scope: "day",
    /**
     * 柱状图里被点选的那个桶（null = 跟随当前周期）。
     *
     * 语义是「在看哪一段时间」：默认看今天 / 本月 / 今年，点柱子后看那个桶。
     * 只存 key 不存整份数据 —— 数据每 60 秒会被插件进程换新，存 key 才能让
     * 新数据里的同一个桶自动接上，而不是拿着旧快照不放。
     */
    selectedKey: null,
    status: "loading", // loading | ok | empty | error
    message: "",
    pollTimer: null,
    appearanceKey: null,
    /** 上一次渲染的数据指纹，避免无谓的 DOM 重建。 */
    renderKey: null,
    historyKey: null,
    refreshing: false,
  };
  /* ------------------------------------------------------------ 格式化工具 */

  /** 1234567 → 1.23M；1234 → 1.23K。用于大数字。 */
  function compact(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return "0";
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(Math.round(n));
  }

  /** 精确到千分位的整数，用于单条回复的分项。 */
  function thousands(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return Math.round(n).toLocaleString("en-US");
  }

  /** 797 → 797ms；1848 → 1.8s；204000 → 3分24秒。 */
  function formatDuration(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return "—";
    if (n < 1000) return Math.round(n) + "ms";
    if (n < 60000) return (n / 1000).toFixed(1) + "s";
    const totalSeconds = Math.round(n / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 60) return minutes + "分" + seconds + "秒";
    const hours = Math.floor(minutes / 60);
    return hours + "小时" + (minutes % 60) + "分";
  }

  /** 与宿主消息页脚同风格的「9月10日 21:47」。 */
  function formatStamp(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return "—";
    const d = new Date(n);
    if (Number.isNaN(d.getTime())) return "—";
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return d.getMonth() + 1 + "月" + d.getDate() + "日 " + hh + ":" + mm;
  }

  function formatClock(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return "—";
    const d = new Date(n);
    if (Number.isNaN(d.getTime())) return "—";
    return (
      String(d.getHours()).padStart(2, "0") +
      ":" +
      String(d.getMinutes()).padStart(2, "0") +
      ":" +
      String(d.getSeconds()).padStart(2, "0")
    );
  }

  function speedText(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return String(Math.round(n));
  }

  function setText(id, text) {
    const el = $(id);
    if (el && el.textContent !== text) el.textContent = text;
  }

  /* --------------------------------------------------------------- 主题 */

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

  /* --------------------------------------------------------------- 渲染 */

  function renderState() {
    const box = $("stateBox");
    const scroll = $("scroll");
    if (state.status === "ok") {
      box.hidden = true;
      scroll.hidden = false;
      return;
    }
    box.hidden = false;
    scroll.hidden = true;
    if (state.status === "loading") {
      setText("stateTitle", "正在读取本地记录…");
      setText("stateBody", "扫描当前会话的转录本与宿主数据库。");
    } else if (state.status === "empty") {
      setText("stateTitle", "还没有可统计的回复");
      setText("stateBody", state.message || "在当前会话里完成一次模型回复后，这里会显示用量与生成速度。");
    } else {
      setText("stateTitle", "无法读取用量数据");
      setText("stateBody", state.message || "插件未能读到宿主记录。");
    }
  }

  function renderHero(snapshot) {
    const latest = snapshot.latest;
    const speed = latest ? speedText(latest.tokensPerSecond) : null;
    setText("heroLabel", "生成速度");
    $("heroApprox").hidden = !(latest && latest.tokensPerSecondEstimated);
    setText("heroValue", speed === null ? "—" : speed);

    const sub = $("heroSub");
    const parts = [];
    if (latest) {
      if (latest.outputEstimated) {
        parts.push("输出 token 由可见文本估算");
      }
      parts.push(latest.durationSource === "reported" ? "用时来自宿主记录" : "用时为估算值");
      if (latest.isSubagent) parts.push("子智能体回复");
    } else {
      parts.push("等待首次回复");
    }
    const wanted = parts.join("\u0000");
    if (sub.dataset.parts !== wanted) {
      sub.dataset.parts = wanted;
      sub.textContent = "";
      parts.forEach((text, index) => {
        if (index > 0) {
          const sep = document.createElement("span");
          sep.className = "sep";
          sep.textContent = "·";
          sub.appendChild(sep);
        }
        const span = document.createElement("span");
        span.textContent = text;
        sub.appendChild(span);
      });
    }
  }

  function renderLatest(snapshot) {
    const latest = snapshot.latest;
    if (!latest) {
      setText("valOut", "—");
      setText("valIn", "—");
      setText("valReasoning", "—");
      setText("valCacheRead", "—");
      setText("valDuration", "—");
      setText("valTotal", "—");
      setText("latestNote", "");
      return;
    }
    setText("valOut", (latest.outputEstimated ? "≈" : "") + thousands(latest.outputTokens));
    setText("valIn", thousands(latest.inputTokens));
    setText("valReasoning", thousands(latest.reasoningTokens));
    setText("valCacheRead", thousands(latest.cacheReadTokens));
    setText("valDuration", formatDuration(latest.durationMs));
    setText("valTotal", thousands(latest.totalTokens));
    setText("latestNote", formatStamp(latest.createdMs));
  }

  function renderSession(snapshot) {
    const session = snapshot.session;
    if (!session) return;
    setText("valSessionTotal", compact(session.totals.total) + " tok");
    setText("sessionNote", session.shortId ? "会话 " + session.shortId : "");
    setText(
      "valReplies",
      String(session.replies) + (session.subagentReplies ? "（含子智能体 " + session.subagentReplies + "）" : ""),
    );
    const avg = speedText(session.avgTokensPerSecond);
    const peak = speedText(session.peakTokensPerSecond);
    setText("valAvg", avg === null ? "—" : avg + " tokens/s");
    setText("valPeak", peak === null ? "—" : peak + " tokens/s");
    setText("valSessionDuration", formatDuration(session.durationMs));
    setText("valCacheRate", Number.isFinite(session.cacheHitRate) ? session.cacheHitRate + "%" : "—");
  }

  function buildItem(entry, isLatest) {
    const item = document.createElement("div");
    item.className = "item" + (isLatest ? " is-latest" : "");

    const time = document.createElement("span");
    time.className = "item-time";
    time.textContent = formatStamp(entry.createdMs);
    item.appendChild(time);

    const out = document.createElement("span");
    out.className = "item-out";
    if (entry.isSubagent && entry.agentName) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = entry.agentName;
      out.appendChild(badge);
    }
    out.appendChild(
      document.createTextNode(
        "输出 " + (entry.outputEstimated ? "≈" : "") + thousands(entry.outputTokens) + " tok",
      ),
    );
    item.appendChild(out);

    const speed = document.createElement("span");
    speed.className = "item-speed";
    const value = speedText(entry.tokensPerSecond);
    if (value === null) {
      speed.textContent = "—";
    } else {
      if (entry.tokensPerSecondEstimated) speed.appendChild(document.createTextNode("≈"));
      speed.appendChild(document.createTextNode(value));
      const unit = document.createElement("span");
      unit.className = "u";
      unit.textContent = "tokens/s";
      speed.appendChild(unit);
    }
    item.appendChild(speed);

    const meta = document.createElement("span");
    meta.className = "item-meta";
    const bits = [
      "用时 " + formatDuration(entry.durationMs),
      "输入 " + thousands(entry.inputTokens),
      "推理 " + thousands(entry.reasoningTokens),
    ];
    if (entry.cacheReadTokens > 0) bits.push("缓存读取 " + thousands(entry.cacheReadTokens));
    meta.textContent = bits.join("  ·  ");
    item.appendChild(meta);

    return item;
  }

  function renderRecent(snapshot) {
    const list = $("recentList");
    const recent = Array.isArray(snapshot.recent) ? snapshot.recent : [];
    setText("recentTitle", "最近回复");
    setText("recentNote", recent.length ? "共 " + recent.length + " 条" : "");
    list.textContent = "";
    if (!recent.length) {
      const empty = document.createElement("div");
      empty.className = "item";
      empty.style.color = "var(--fg-muted)";
      empty.textContent = "暂无记录";
      list.appendChild(empty);
      return;
    }
    const latestId = snapshot.latest ? snapshot.latest.id : null;
    recent.forEach((entry, index) => {
      list.appendChild(buildItem(entry, index === 0 && entry.id === latestId));
    });
  }

  function renderHead(snapshot) {
    const session = snapshot.session || {};
    const model = session.modelId || "未知模型";
    const bits = [model];
    if (session.shortId) bits.push(session.shortId);
    setText("headStatus", bits.join(" · "));
  }

  function renderFoot(snapshot) {
    const foot = $("foot");
    const diag = snapshot.diagnostics || {};
    const sqlite = snapshot.sqlite || {};
    const bits = [
      "来源 " + (snapshot.source || "transcript"),
      "刷新 " + formatClock(snapshot.generatedAt),
    ];
    if (sqlite.remainder && sqlite.remainder.turns > 0) {
      bits.push("数据库补入 " + sqlite.remainder.turns + " 轮");
    }
    if (Number.isFinite(diag.records) && diag.records > 0) bits.push("解析 " + diag.records + " 条");
    foot.textContent = bits.join("  ·  ");
  }

  /* ------------------------------------------------------- 累计看板渲染 */

  /** 周期标签：日 → `09-21`，月 → `2026-09`，年 → `2026`。 */
  function periodLabel(key, scope) {
    if (!key) return "—";
    if (scope === "year" || scope === "month") return key;
    // 日：只显示月-日，年份在标题里已经给了。
    return key.slice(5);
  }

  /** 当前本地日期，形如 2026-09-21，用来给「今天」这一根柱子加高亮。 */
  function localToday() {
    const d = new Date();
    return (
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0")
    );
  }

  function renderSeg() {
    const host = $("boardSeg");
    if (!host) return;
    host.textContent = "";
    const labels = { day: "日", month: "月", year: "年" };
    for (const scope of SCOPES) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "seg-btn" + (state.scope === scope ? " is-active" : "");
      button.dataset.scope = scope;
      button.setAttribute("role", "tab");
      button.textContent = labels[scope];
      button.addEventListener("click", () => {
        if (state.scope === scope) return;
        state.scope = scope;
        // 换周期就丢掉跨周期的选中态：上一个周期里选中的那天在月 / 年视角下没有意义。
        state.selectedKey = null;
        state.historyKey = null; // 强制重画
        renderBoard(true);
      });
      host.appendChild(button);
    }
  }

  /** 当前周期对应的桶列表（日 / 月 / 年）。 */
  function bucketsForScope(history) {
    if (!history) return [];
    if (state.scope === "year") return history.years || [];
    if (state.scope === "month") return history.months || [];
    return history.days || [];
  }

  /** 当前周期内「最近一个」桶 —— 也就是今天 / 本月 / 今年。 */
  function currentBucket(history) {
    const buckets = bucketsForScope(history);
    if (!buckets.length) return null;
    const today = localToday();
    if (state.scope === "day") return buckets.find((b) => b.key === today) || buckets[0];
    if (state.scope === "month") return buckets.find((b) => b.key === today.slice(0, 7)) || buckets[0];
    return buckets.find((b) => b.key === today.slice(0, 4)) || buckets[0];
  }
  /**
   * 当前周期在聚合层备好的那一包数据：{ key, empty, summary, chart, models }。
   *
   * 0.4.0 起插件进程会为日 / 月 / 年各发布一份，视图只负责挑当前这份渲染，
   * 所以切换周期时柱状图与模型列表会跟着换，而不是永远显示同一份累计值。
   * 旧插件进程没有这个字段，返回 null，调用方各自退回 0.3.x 的旧行为。
   */
  function periodData(history) {
    if (!history || !history.periods) return null;
    return history.periods[state.scope] || null;
  }

  function renderScopeTiles(history) {
    const scopeName = SCOPE_NAMES[state.scope];
    const pack = periodData(history);
    if (!pack) {
      // 兜底：旧插件进程只发布了 years / months / days，按桶找当前周期，行为与 0.3.x 一致。
      const bucket = currentBucket(history);
      if (!bucket) {
        setText("scopeTotal", "—");
        setText("scopeReplies", "—");
        setText("scopeAvg", "—");
        setText("scopeDuration", "—");
        setText("boardNote", "");
        return;
      }
      setText("scopeTotal", compact(bucket.tokens.total));
      setText("scopeReplies", thousands(bucket.replies));
      setText("scopeAvg", bucket.avgSpeed === null ? "—" : bucket.avgSpeed + " tok/s");
      setText("scopeDuration", formatDuration(bucket.durationMs));
      setText("boardNote", scopeName + " · " + periodLabel(bucket.key, state.scope));
      return;
    }
    // 点了柱子就看那个桶，没点就看当前周期 —— activeBucket 已经把两者统一成同一形状。
    const bucket = activeBucket(history);
    const summary = bucket.summary;
    setText("scopeTotal", compact(summary.tokens.total));
    setText("scopeReplies", thousands(summary.replies));
    setText("scopeAvg", summary.avgSpeed === null ? "—" : summary.avgSpeed + " tok/s");
    setText("scopeDuration", formatDuration(summary.durationMs));
    // 注释栏要能区分「正在看今天」和「正在看你点出来的 09-19」。
    const picked = state.selectedKey ? state.selectedKey : null;
    const note = picked
      ? scopeName + " · 已选 " + periodLabel(bucket.key, state.scope)
      : scopeName + " · " + periodLabel(bucket.key, state.scope) + (bucket.empty ? " · 无记录" : "");
    setText("boardNote", note);
  }

  /**
   * 柱状图。粒度跟着所选周期走：日→最近 30 天、月→最近 30 个月、年→最近 30 年。
   *
   * 为什么不再固定画「日」：固定日柱时点「月 / 年」，柱状图纹丝不动，用户看到的
   * 就是「切换没生效」。切到月 / 年视角后，人想看的本来就是那个粒度的对比。
   * 柱高按当期最大值归一化，所以安静的日子不会被压成看不见的细线。
   */
  function renderChart(history) {
    const host = $("chart");
    if (!host) return;
    host.textContent = "";
    const pack = periodData(history);
    // 兜底：拿不到 periods 就退回旧字段（日粒度），总比空白强。
    const chart = pack ? pack.chart : (history && history.chart) || [];
    setText("chartTitle", CHART_TITLES[state.scope]);
    if (!chart.length) {
      const empty = document.createElement("div");
      empty.className = "model-empty";
      empty.textContent = "暂无数据";
      host.appendChild(empty);
      setText("chartNote", "");
      return;
    }
    const max = chart.reduce((best, entry) => Math.max(best, entry.total || 0), 0);
    const span = chart.length > 1 ? chart[0].key + " → " + chart[chart.length - 1].key : chart[0].key;
    setText("chartNote", span);
    for (const entry of chart) {
      const bar = document.createElement("button");
      bar.type = "button";
      bar.className =
        "chart-bar" +
        (entry.total > 0 ? "" : " is-empty") +
        (entry.key === state.selectedKey ? " is-current" : "");
      bar.dataset.key = entry.key;
      const ratio = max > 0 ? Math.max(0, Math.min(1, entry.total / max)) : 0;
      bar.title =
        entry.key +
        " · " +
        compact(entry.total) +
        " tok · " +
        thousands(entry.replies) +
        " 条" +
        "（点击查看该" +
        PERIOD_UNITS[state.scope] +
        "）";
      const fill = document.createElement("div");
      fill.className = "chart-fill";
      fill.style.height = Math.round(ratio * 100) + "%";
      bar.appendChild(fill);
      // 点柱子 = 选中那个桶：上面四个数字、明细表与模型用量一起换成它的。
      bar.addEventListener("click", () => selectBucket(entry.key));
      host.appendChild(bar);
    }
  }

  /**
   * 选中柱状图里的某个桶。
   *
   * 选中态的语义是「看哪一段时间」：默认是当前周期（今天 / 本月 / 今年），
   * 点某根柱子后就换成那个桶，四个主数字、明细表与模型用量一起跟着换。
   * 选中的 key 不存在或点的是已经选中的那根时，回到当前周期。
   */
  function selectBucket(key) {
    const pack = periodData(state.history);
    if (!pack) return;
    const exists = pack.buckets.some((bucket) => bucket.key === key);
    const next = exists && key !== state.selectedKey ? key : null;
    if (next === state.selectedKey) return;
    state.selectedKey = next;
    state.historyKey = null; // 强制重画
    renderBoard(true);
  }

  /**
   * 当前展示的那个桶：选中了就给它，否则是当前周期。
   *
   * 返回值形状与 period 包一致（{ key, summary, models }），所以上层渲染
   * 不需要知道「这是当前周期还是用户点出来的某一天」。
   */
  function activeBucket(history) {
    const pack = periodData(history);
    if (!pack) return null;
    if (state.selectedKey) {
      const picked = pack.buckets.find((bucket) => bucket.key === state.selectedKey);
      if (picked) return picked;
    }
    return pack;
  }

  function renderBoardTable(history) {
    const body = $("boardBody");
    const more = $("boardMore");
    if (!body) return;
    body.textContent = "";
    const buckets = bucketsForScope(history);
    setText("thPeriod", state.scope === "day" ? "日期" : state.scope === "month" ? "月份" : "年份");
    if (!buckets.length) {
      if (more) more.hidden = true;
      return;
    }
    // 高亮的是「正在看的那一段」：点了柱子就是它，否则是当前周期。
    const pack = periodData(history);
    const active = pack ? activeBucket(history) : currentBucket(history);
    for (const bucket of buckets.slice(0, TABLE_LIMIT)) {
      const row = document.createElement("tr");
      if (active && bucket.key === active.key) row.className = "is-current";
      // 选了某个桶之后，表格行也可以点，方便在相邻周期之间来回看。
      if (pack) {
        row.classList.add("is-clickable");
        row.addEventListener("click", () => selectBucket(bucket.key));
      }

      const period = document.createElement("td");
      period.className = "table-period";
      period.textContent = periodLabel(bucket.key, state.scope);
      row.appendChild(period);

      const cells = [
        [compact(bucket.tokens.total), "num"],
        [thousands(bucket.replies), "num"],
        [bucket.avgSpeed === null ? "—" : String(bucket.avgSpeed), "num"],
        [formatDuration(bucket.durationMs), "num"],
      ];
      for (const [text, className] of cells) {
        const cell = document.createElement("td");
        cell.className = className;
        cell.textContent = text;
        row.appendChild(cell);
      }
      body.appendChild(row);
    }
    if (more) {
      const hidden = buckets.length - TABLE_LIMIT;
      more.hidden = hidden <= 0;
      if (hidden > 0) more.textContent = "另有 " + hidden + " 个周期未列出（表内只显示最近 " + TABLE_LIMIT + " 个）";
    }
  }

  /**
   * 模型用量。跟着所选周期走：日→今天、月→本月、年→今年。
   *
   * 0.4.0 前这里固定读 history.models（全历史累计），所以点「日 / 月 / 年」
   * 模型列表纹丝不动——那正是「切了没反应」的一半。现在读当前周期那一份，
   * 占比也按该周期总量重算，因此「本月 deepseek 48.9%」只在本月范围内成立。
   */
  function renderModels(history) {
    const host = $("modelList");
    if (!host) return;
    host.textContent = "";
    const pack = periodData(history);
    const bucket = pack ? activeBucket(history) : null;
    const models = bucket ? bucket.models : (history && history.models) || [];
    const scopeName = SCOPE_NAMES[state.scope];
    setText("modelsTitle", "模型用量 · " + scopeName + (state.selectedKey ? "（已选 " + periodLabel(bucket.key, state.scope) + "）" : ""));
    setText("modelsNote", models.length ? models.length + " 个模型" : "");
    if (!models.length) {
      const empty = document.createElement("div");
      empty.className = "model-empty";
      empty.textContent = "暂无数据";
      host.appendChild(empty);
      return;
    }
    for (const model of models) {
      const row = document.createElement("div");
      row.className = "model-row";

      const top = document.createElement("div");
      top.className = "model-top";
      const name = document.createElement("span");
      name.className = "model-name";
      name.textContent = model.modelId;
      top.appendChild(name);
      const share = document.createElement("span");
      share.className = "model-share";
      share.textContent = compact(model.tokens.total) + " · " + model.share + "%";
      top.appendChild(share);
      row.appendChild(top);

      const bar = document.createElement("div");
      bar.className = "model-bar";
      const fill = document.createElement("div");
      fill.className = "model-bar-fill";
      fill.style.width = Math.max(0, Math.min(100, model.share)) + "%";
      bar.appendChild(fill);
      row.appendChild(bar);

      const bits = [
        thousands(model.replies) + " 条",
        model.avgSpeed === null ? "速度 —" : "平均 " + model.avgSpeed + " tok/s",
      ];
      if (Number.isFinite(model.peakSpeed)) bits.push("峰值 " + model.peakSpeed);
      if (Number.isFinite(model.cacheHitRate)) bits.push("缓存 " + model.cacheHitRate + "%");
      if (Number.isFinite(model.days)) bits.push(model.days + " 天");
      const meta = document.createElement("div");
      meta.className = "model-meta";
      meta.textContent = bits.join("  ·  ");
      row.appendChild(meta);

      host.appendChild(row);
    }
  }

  /** 累计看板的整体渲染。history 为空时也要给一句说明，而不是空白卡片。 */
  function renderBoard(force) {
    const history = state.history;
    if (!history) {
      setText("boardNote", "统计中…");
      renderSeg();
      renderScopeTiles(null);
      renderChart(null);
      renderBoardTable(null);
      renderModels(null);
      return;
    }
    if (!history.ok) {
      setText("boardNote", "读取失败：" + String(history.error || "未知原因"));
      renderSeg();
      renderScopeTiles(null);
      renderChart(null);
      renderBoardTable(null);
      renderModels(null);
      return;
    }
    const key = JSON.stringify([
      history.generatedAt,
      state.scope,
      history.totals ? history.totals.replies : 0,
      history.totals ? history.totals.tokens.total : 0,
      history.files ? history.files.rescanned : 0,
    ]);
    if (!force && key === state.historyKey) return;
    state.historyKey = key;
    renderSeg();
    renderScopeTiles(history);
    renderChart(history);
    renderBoardTable(history);
    renderModels(history);
    setText("boardTitle", "累计看板 · " + SCOPE_NAMES[state.scope]);
  }

  function render(force) {
    renderState();
    renderBoard(force);
    const snapshot = state.snapshot;
    if (state.status !== "ok" || !snapshot) return;
    const key = JSON.stringify([
      snapshot.generatedAt,
      snapshot.latest ? snapshot.latest.id : null,
      snapshot.session ? snapshot.session.replies : 0,
      snapshot.session ? snapshot.session.totals.total : 0,
    ]);
    if (!force && key === state.renderKey) return;
    state.renderKey = key;
    renderHead(snapshot);
    renderHero(snapshot);
    renderLatest(snapshot);
    renderSession(snapshot);
    renderRecent(snapshot);
    renderFoot(snapshot);
  }

  /* --------------------------------------------------------------- 轮询 */

  async function poll() {
    if (!bridge || typeof bridge.invoke !== "function") {
      state.status = "error";
      state.message = "pluginBridge 不可用：本页面只能在 PI-Desktop 的插件视图里运行。";
      render(true);
      return;
    }
    let settings;
    try {
      settings = await bridge.invoke("plugin.getSettings");
    } catch (error) {
      state.status = "error";
      state.message = "读取插件设置失败：" + (error && error.message ? error.message : String(error));
      render(true);
      return;
    }

    // 主题跟随：宿主只给 base（light/dark）。
    const appearance = (settings && settings[KEY_APPEARANCE]) || null;
    const appearanceKey = appearance ? String(appearance.base || "") + "|" + String(appearance.locale || "") : "none";
    if (appearanceKey !== state.appearanceKey) {
      state.appearanceKey = appearanceKey;
      applyAppearance(appearance);
    }

    // 累计看板读的是插件进程算好的聚合结果。读不到时保留上一份，避免面板闪成空白。
    const history = settings && settings[KEY_HISTORY];
    if (history) state.history = history;

    const snapshot = settings && settings[KEY_SNAPSHOT];

    // 版本自检：宿主覆盖安装时不会重建视图，这里发现插件进程比自己新就重新加载，
    // 否则用户会一直看着旧界面（数据是新的，卡片却是旧的）。
    if (shouldReloadForVersion(snapshot && snapshot.pluginVersion)) {
      window.location.reload();
      return;
    }

    if (!snapshot) {
      state.snapshot = null;
      state.status = "loading";
      render(true);
      return;
    }
    if (!snapshot.ok) {
      state.snapshot = snapshot;
      state.status = "empty";
      state.message = snapshot.reason === "NO_ACTIVE_SESSION" ? "" : "读取失败：" + String(snapshot.reason || "未知原因");
      render(true);
      return;
    }
    state.snapshot = snapshot;
    state.status = "ok";
    state.message = "";
    render(false);
  }

  function startPolling() {
    stopPolling();
    const cadence = document.hidden ? POLL_HIDDEN_MS : POLL_MS;
    state.pollTimer = window.setInterval(() => void poll(), cadence);
  }

  function stopPolling() {
    if (state.pollTimer) window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  /* --------------------------------------------------------------- 启动 */

  function bindEvents() {
    const btn = $("refreshBtn");
    btn.addEventListener("click", () => {
      if (state.refreshing) return;
      state.refreshing = true;
      btn.classList.add("spin");
      void poll().finally(() => {
        state.refreshing = false;
        btn.classList.remove("spin");
      });
    });

    // 面板切换显隐会改变轮询节奏，同时立刻补一次，避免回到面板看到旧数据。
    document.addEventListener("visibilitychange", () => {
      startPolling();
      if (!document.hidden) void poll();
    });
  }

  function boot() {
    // 先把主题定下来，避免首帧闪错配色。
    applyAppearance(null);
    if (bridge && typeof bridge.on === "function") {
      bridge.on("appearance:changed", applyAppearance);
    }
    bindEvents();
    void poll();
    startPolling();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
