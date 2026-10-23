/*
 * REA 工具箱 —— 面板渲染层。
 *
 * 数据来源只有一个：随包发布的离线目录 catalog.js（window.REA_CATALOG）。
 * 它是插件构建时从 REA 6.4.0 的 MCP 服务器导出的真实工具表，因此面板在
 * 断网、MCP 未连上时同样可用。
 *
 * 本页对宿主只读：不写设置、不读文件、不发网络请求。唯一的外部动作是
 * 「复制清单」，走浏览器剪贴板 API（点击手势触发），失败则退回 execCommand。
 *
 * 关于「连接状态」：MCP 服务器由宿主按 manifest 的 contributes.mcpServers
 * 启动，其连接状态**不通过面板桥暴露**，因此本页不伪造一个灯。状态条展示的
 * 是插件能确证的事实：声明了哪个服务器、目录里有多少工具、目录何时生成。
 */

(function () {
  "use strict";

  var CATALOG = window.REA_CATALOG || null;

  /** 与 manifest.json 的 contributes.mcpServers 保持一致，用于状态条如实展示。 */
  var MCP_COMMAND = "node launcher.cjs";

  /** 调用工具时的客户端名前缀：plugin_<插件id安全化>_<serverId>_ */
  var CLIENT_PREFIX = "plugin_local_rea_rea_";

  var el = {
    version: document.getElementById("versionBadge"),
    statusDot: document.getElementById("statusDot"),
    statusText: document.getElementById("statusText"),
    search: document.getElementById("search"),
    groups: document.getElementById("groups"),
    meta: document.getElementById("meta"),
    list: document.getElementById("list"),
    foot: document.getElementById("foot"),
    copyBtn: document.getElementById("copyBtn"),
    expandBtn: document.getElementById("expandBtn"),
  };

  /** 当前筛选状态。 */
  var state = {
    group: "",
    query: "",
    expanded: {},
    allExpanded: false,
  };

  /** 转义，避免把目录文本当 HTML 解析。 */
  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** 按名字/标题/描述/参数名做不区分大小写的包含匹配。 */
  function match(tool, needle) {
    if (!needle) return true;
    if (tool.name.toLowerCase().indexOf(needle) >= 0) return true;
    if ((tool.title || "").toLowerCase().indexOf(needle) >= 0) return true;
    if ((tool.description || "").toLowerCase().indexOf(needle) >= 0) return true;
    if ((tool.group || "").toLowerCase().indexOf(needle) >= 0) return true;
    for (var i = 0; i < (tool.params || []).length; i++) {
      if (tool.params[i].name.toLowerCase().indexOf(needle) >= 0) return true;
    }
    return false;
  }

  /** 当前筛选下的工具。 */
  function visibleTools() {
    var needle = state.query.trim().toLowerCase();
    return CATALOG.tools.filter(function (tool) {
      if (state.group && tool.group !== state.group) return false;
      return match(tool, needle);
    });
  }

  /* ------------------------------------------------------------ 状态与摘要 */

  function renderStatus() {
    el.version.textContent = CATALOG.packageName + " " + CATALOG.packageVersion;
    // 视图能渲染出来，说明插件已加载 —— 这是本页唯一能确证的状态。
    el.statusDot.className = "dot ok";
    el.statusText.textContent =
      "插件已加载 · MCP 服务器 " +
      MCP_COMMAND +
      "（由宿主启动）· 目录 " +
      CATALOG.toolCount +
      " 个工具";
    el.statusText.title =
      "MCP 连接状态不由面板桥暴露，因此这里不显示实时连接灯。\n" +
      "确认方式：在 Agent 的工具表里搜索 “rea”，出现 plugin_local_rea_rea_* 即为已连接。\n" +
      "工具缺失时先跑命令「REA：检查运行时状态」定位，再按提示「准备运行时」并重载插件。";
  }

  function renderMeta() {
    var shown = visibleTools().length;
    var generated = String(CATALOG.generatedAt || "").replace("T", " ").replace(/\..*$/, "");
    el.meta.textContent =
      "显示 " +
      shown +
      " / " +
      CATALOG.toolCount +
      " 个工具 · 目录导出自 REA " +
      CATALOG.packageVersion +
      "（" +
      generated +
      " UTC）";
  }

  function renderFoot() {
    el.foot.innerHTML =
      "<span>调用名形如 <code>" +
      esc(CLIENT_PREFIX) +
      "binary_overview</code></span>" +
      "<span>协议 " +
      esc(CATALOG.protocolVersion) +
      "</span>";
  }

  /* ------------------------------------------------------------------ 分组 */

  function renderGroups() {
    var html = "";
    var total = CATALOG.toolCount;
    html +=
      '<button type="button" class="chip' +
      (state.group === "" ? " active" : "") +
      '" data-group="">全部<span class="chip-count">' +
      total +
      "</span></button>";
    for (var i = 0; i < CATALOG.groups.length; i++) {
      var g = CATALOG.groups[i];
      html +=
        '<button type="button" class="chip' +
        (state.group === g.id ? " active" : "") +
        '" data-group="' +
        esc(g.id) +
        '">' +
        esc(g.label) +
        '<span class="chip-count">' +
        g.count +
        "</span></button>";
    }
    el.groups.innerHTML = html;
  }

  /* ------------------------------------------------------------------ 卡片 */

  /** 参数一行。带 `*` 的是必填。 */
  function paramRow(p) {
    var html = '<li class="param">';
    html += '<span class="param-name' + (p.required ? " required" : "") + '">' + esc(p.name) + "</span>";
    html += '<span class="param-type">' + esc(p.type) + "</span>";
    var tail = "";
    if (p.enum && p.enum.length) {
      tail += '<span class="param-enum">' + esc(p.enum.join(" | ")) + "</span>";
    }
    if (p.desc) {
      tail += '<span class="param-desc">' + esc(p.desc) + "</span>";
    }
    if (tail) html += tail;
    return html + "</li>";
  }

  /** 生成一段可直接抄的调用示例 JSON。 */
  function callExample(tool) {
    var args = {};
    for (var i = 0; i < (tool.params || []).length; i++) {
      var p = tool.params[i];
      if (!p.required) continue;
      if (p.type === "string") args[p.name] = "<" + p.name + ">";
      else if (p.type === "number" || p.type === "integer") args[p.name] = 0;
      else if (p.type === "boolean") args[p.name] = false;
      else if (p.type === "array") args[p.name] = [];
      else if (p.type === "enum" && p.enum && p.enum.length) args[p.name] = p.enum[0];
      else args[p.name] = "<" + p.name + ">";
    }
    return (
      CLIENT_PREFIX + tool.name + "\n" + JSON.stringify(args, null, 2)
    );
  }

  function cardHtml(tool) {
    var expanded = state.allExpanded || state.expanded[tool.name] === true;
    var html = '<article class="card" data-tool="' + esc(tool.name) + '" role="listitem">';

    html += '<div class="card-head" data-toggle="' + esc(tool.name) + '">';
    html += '<span class="caret">' + (expanded ? "▾" : "▸") + "</span>";
    html += '<div class="card-main">';
    html += '<div class="card-name">' + esc(tool.name) + "</div>";
    if (tool.title) html += '<div class="card-title">' + esc(tool.title) + "</div>";
    html += "</div>";
    html += '<div class="card-flags">';
    if (tool.readOnly) html += '<span class="flag ro">只读</span>';
    if (tool.destructive) html += '<span class="flag destructive">破坏性</span>';
    if (tool.required && tool.required.length) {
      html += '<span class="flag req">' + tool.required.length + " 必填</span>";
    }
    html += "</div>";
    html += "</div>";

    if (expanded) {
      html += '<div class="card-body">';
      if (tool.description) html += '<p class="desc">' + esc(tool.description) + "</p>";

      if (tool.params && tool.params.length) {
        html += '<div class="sec-label">参数</div><ul class="params">';
        for (var i = 0; i < tool.params.length; i++) html += paramRow(tool.params[i]);
        html += "</ul>";
      } else {
        html += '<div class="sec-label">参数</div><p class="desc">无参数。</p>';
      }

      html += '<div class="call-label">调用示例</div>';
      html += '<div class="call">' + esc(callExample(tool)) + "</div>";
      html += "</div>";
    }

    return html + "</article>";
  }

  function renderList() {
    var tools = visibleTools();
    if (!tools.length) {
      el.list.innerHTML =
        '<div class="empty">没有匹配的工具。<br />试试清空搜索词，或换一个能力域。</div>';
      return;
    }
    var html = "";
    for (var i = 0; i < tools.length; i++) html += cardHtml(tools[i]);
    el.list.innerHTML = html;
  }

  function renderAll() {
    renderGroups();
    renderMeta();
    renderList();
  }

  /* ------------------------------------------------------------------ 交互 */

  el.groups.addEventListener("click", function (event) {
    var chip = event.target.closest(".chip");
    if (!chip) return;
    state.group = chip.getAttribute("data-group") || "";
    renderAll();
  });

  var searchTimer = null;
  el.search.addEventListener("input", function () {
    var value = el.search.value || "";
    if (searchTimer) clearTimeout(searchTimer);
    // 170 条卡片重建很快，但仍给一点防抖，避免长输入时每键都重排
    searchTimer = setTimeout(function () {
      state.query = value;
      renderAll();
    }, 120);
  });

  el.list.addEventListener("click", function (event) {
    var head = event.target.closest("[data-toggle]");
    if (!head) return;
    var name = head.getAttribute("data-toggle");
    state.expanded[name] = !(state.expanded[name] === true || state.allExpanded);
    if (state.allExpanded) state.allExpanded = false;
    renderList();
  });

  el.expandBtn.addEventListener("click", function () {
    state.allExpanded = !state.allExpanded;
    state.expanded = {};
    el.expandBtn.textContent = state.allExpanded ? "折叠" : "展开";
    renderList();
  });

  /** 复制文本：优先异步剪贴板，失败退回 execCommand（都在点击手势里）。 */
  function copyText(text, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () {
          done(true);
        },
        function () {
          done(legacyCopy(text));
        },
      );
      return;
    }
    done(legacyCopy(text));
  }

  function legacyCopy(text) {
    try {
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch (e) {
      return false;
    }
  }

  el.copyBtn.addEventListener("click", function () {
    var names = CATALOG.tools.map(function (tool) {
      return CLIENT_PREFIX + tool.name;
    });
    copyText(names.join("\n"), function (ok) {
      var original = "复制清单";
      el.copyBtn.textContent = ok ? "已复制 " + names.length + " 条" : "复制失败";
      setTimeout(function () {
        el.copyBtn.textContent = original;
      }, 1600);
    });
  });

  /* ------------------------------------------------------------------ 启动 */

  if (!CATALOG || !CATALOG.tools || !CATALOG.tools.length) {
    el.statusDot.className = "dot err";
    el.statusText.textContent = "目录数据缺失：catalog.js 未能加载。";
    el.list.innerHTML = '<div class="empty">离线目录未加载，无法显示工具列表。</div>';
    return;
  }

  renderStatus();
  renderFoot();
  renderAll();
})();
