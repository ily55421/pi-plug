---
name: browser-dom-annotate
description: 用户要求可视化标注网页问题时使用：圈出页面上哪里不对、给元素编号、批注页面、把页面问题整理成带编号与截图的报告。通过 Browser 工具注入 Shadow DOM 序号徽章与高亮框并截图回传。纯浏览/操作/采集类请求不触发。
---

# 浏览器页面标注（DOM Annotate）

把「页面上哪里不对」变成可回传的视觉证据：序号徽章 + 高亮框 + 截图 + 编号报告。
本技能只指导使用宿主内置的 Browser 工具（`plugin_pi_browser_Browser`；未激活时先
ToolSearch 按名字加载），不依赖任何自建工具。

## 前提

- 目标页面已在 Browser 中打开；没有就先 `navigate`。
- 用户说得清「标什么」；说不清时先 `snapshot` 列出候选元素让用户挑，标注点靠猜会浪费时间。

## 流程

1. **定位**：Browser `snapshot` 拿可访问性树，把用户描述的问题映射到具体元素
   （uid 对应的语义描述）。快照只给 role/name 语义，不给选择器，也不保证
   等于 DOM 文本；需要确认时可做一次探测 evaluate（例：
   `document.querySelector('h1') && document.querySelector('h1').textContent`），
   用探测结果组装标注，不要凭快照猜。
2. **组装**标注数组，一次 ≤8 条（再多截图上看不清，分批做）：
   `{"q": "CSS 选择器"}` 或 `{"text": "元素直接可见文本"}` 二选一；
   可选 `"label"`（缺省自动编号 1..n）、`"comment"`（一句话说明）、
   `"tone"`（`"error" | "warn" | "info"`，缺省 info）。
   稳定 id/class 优先用 `q`。文本匹配规则：先取文本完全相等的可见元素，
   找不到回退到第一个「包含」该文本的可见元素——所以 `text` 要足够长，
   只传「登陆」两个字容易误中其他元素。
3. **注入**：Browser `evaluate`，expression 用下面的脚本原文，只替换末尾
   `})([…])` 处的 `ANNOTATIONS` 数组，其余一个字都不要改（改过容易在
   CSP 严格页面上崩）。
4. **截图**：返回 `placed === 标注条数` 时立即 Browser `screenshot`；
   内容超一屏再用 `fullPage`。
5. **报告**：按输出契约用注入返回的 `results` 逐条填表，报告头取返回值的
   `title` 与 `url`，不要凭记忆转述。
6. **清理**：用户确认后、或继续其他浏览器操作前，`evaluate` 执行
   `window.__PI_ANNOTATE__.remove()`。导航会自然清除 overlay；
   忘了清也不影响页面交互（overlay 不接收指针事件）。

## 注入脚本（原样作为 evaluate 的 expression）

```js
((ANNOTATIONS) => {
  const NS = "__PI_ANNOTATE__";
  try { if (window[NS] && window[NS].remove) window[NS].remove(); } catch (e) {}
  const doc = document;
  if (!doc.documentElement || !doc.body) return { ok: false, error: "NO_DOCUMENT" };

  const host = doc.createElement("div");
  host.setAttribute("data-pi-annotate", "");
  host.style.cssText =
    "position:absolute;top:0;left:0;width:0;height:0;z-index:2147483646;pointer-events:none;";
  const root = host.attachShadow({ mode: "open" });

  const style = doc.createElement("style");
  style.textContent = [
    ":host{all:initial}",
    ".layer{position:absolute;top:0;left:0;pointer-events:none;font:12px/1.45 system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif}",
    ".box{position:absolute;border:2px solid;border-radius:4px}",
    ".box.error{border-color:#e5534b}.box.warn{border-color:#d9a343}.box.info{border-color:#3b82f6}",
    ".badge{position:absolute;min-width:18px;height:18px;padding:0 5px;border-radius:9px;color:#fff;font:700 12px/18px system-ui,sans-serif;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.45)}",
    ".badge.error{background:#e5534b}.badge.warn{background:#d9a343}.badge.info{background:#3b82f6}",
    ".note{position:absolute;max-width:280px;background:#111827;color:#f9fafb;padding:6px 8px;border-radius:6px;font:12px/1.4 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.35)}",
    ".tag{position:fixed;top:8px;right:8px;background:#111827;color:#f9fafb;padding:4px 10px;border-radius:999px;font:700 11px/1.6 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.35)}",
  ].join("");
  root.appendChild(style);

  const layer = doc.createElement("div");
  layer.className = "layer";
  root.appendChild(layer);

  const tone = (t) => (t === "error" || t === "warn" || t === "info" ? t : "info");
  const describe = (el) => {
    const parts = [el.tagName.toLowerCase()];
    if (el.id) parts.push("#" + el.id);
    else if (typeof el.className === "string" && el.className.trim())
      parts.push("." + el.className.trim().split(/\s+/).slice(0, 2).join("."));
    return parts.join("");
  };
  const findByText = (text) => {
    const wanted = String(text).trim();
    if (!wanted) return null;
    let fallback = null;
    for (const el of doc.querySelectorAll("*")) {
      if (el === doc.documentElement || el === doc.body) continue;
      if (!el.getClientRects().length) continue;
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent.trim())
        .join(" ");
      if (!own) continue;
      if (own === wanted) return el;
      if (!fallback && own.indexOf(wanted) >= 0) fallback = el;
    }
    return fallback;
  };

  const results = [];
  (ANNOTATIONS || []).forEach((a, i) => {
    const label = a && a.label ? String(a.label) : String(i + 1);
    let el = null;
    try {
      if (a && typeof a.q === "string" && a.q) el = doc.querySelector(a.q);
    } catch (e) {}
    if (!el && a && typeof a.text === "string" && a.text) el = findByText(a.text);
    if (!el) { results.push({ label, ok: false, reason: "NOT_FOUND" }); return; }
    const r = el.getBoundingClientRect();
    const x = r.left + window.scrollX;
    const y = r.top + window.scrollY;
    const t = tone(a && a.tone);
    const box = doc.createElement("div");
    box.className = "box " + t;
    box.style.left = (x - 3) + "px";
    box.style.top = (y - 3) + "px";
    box.style.width = (r.width + 6) + "px";
    box.style.height = (r.height + 6) + "px";
    layer.appendChild(box);
    const badge = doc.createElement("div");
    badge.className = "badge " + t;
    badge.style.left = (x - 9) + "px";
    badge.style.top = (y - 9) + "px";
    badge.textContent = label;
    layer.appendChild(badge);
    if (a && a.comment) {
      const note = doc.createElement("div");
      note.className = "note";
      note.textContent = label + " " + a.comment;
      const maxLeft = doc.documentElement.scrollWidth - 300;
      note.style.left = Math.max(0, Math.min(x + r.width + 10, maxLeft)) + "px";
      note.style.top = y + "px";
      layer.appendChild(note);
    }
    results.push({
      label, ok: true, tone: t,
      element: describe(el),
      text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40),
      rect: { x: Math.round(x), y: Math.round(y), w: Math.round(r.width), h: Math.round(r.height) },
    });
  });

  if (results.length) {
    const tag = doc.createElement("div");
    tag.className = "tag";
    tag.textContent = "PI 标注 · " + results.filter((r) => r.ok).length + " 处";
    layer.appendChild(tag);
  }

  doc.documentElement.appendChild(host);
  window[NS] = {
    remove: () => {
      if (host.parentNode) host.parentNode.removeChild(host);
      try { delete window[NS]; } catch (e) { window[NS] = undefined; }
    },
  };
  return {
    ok: true,
    placed: results.filter((r) => r.ok).length,
    missed: results.filter((r) => !r.ok).length,
    results,
    title: doc.title,
    url: location.href,
    cleanup: "window.__PI_ANNOTATE__.remove()",
  };
})([
  /* 在这里填 ANNOTATIONS，例如：
  { "q": "#login-btn", "comment": "点击无响应", "tone": "error" },
  { "text": "MeNote 登陆", "comment": "「登陆」应为「登录」", "tone": "warn" }
  */
])
```

## 输出契约

报告放在回复正文里（不落盘），固定结构：

```markdown
# 标注报告 · <title>（<url>，取注入返回值）

共 N 处：🔴 x · 🟡 y · 🔵 z（截图见上方 Browser 截图）

| # | 级别 | 元素 | 说明 |
|---|------|------|------|
| 1 | 🔴 error | `button#login` · "登录" | 点击无响应 |

### 下一步建议
- （每条标注一行可执行的建议，或指出需要用户补充的信息）
```

元素列用 `results[i].element` 加 `text` 摘要；说明列用 `comment`。
`missed > 0` 时在表格下方如实列出没标上的条目和原因（NOT_FOUND）。

## 失败处理

- `placed < 标注条数`：选择器或文本没匹配上。换更稳的选择器或页面上的真实 DOM
  文本重试一次；仍失败就去掉该条并报告，不要硬编。
- 极少数 CSP 严格/敌意页面拒绝 evaluate：放弃注入，改产纯文字编号报告
  （元素描述 + 问题 + 无法画图的原因）。
- 跨 iframe 内容标注不了（脚本只处理主文档）：如实说明，改用文字描述。
- 页面无 body（about:blank 等）：先 `navigate` 到真实页面再注入。

## 示例

输入：「帮我标注这个页面的问题：1. 登录按钮点了没反应；2. 标题里「登陆」写错了。」

执行：`snapshot` 定位两元素 → ANNOTATIONS =
`[{"q":"#login-btn","comment":"点击无响应","tone":"error"},{"text":"MeNote 登陆","comment":"「登陆」应为「登录」","tone":"warn"}]`
→ `evaluate` 注入（返回 placed=2）→ `screenshot` → 输出报告表 → 用户确认后
`evaluate` 执行 `window.__PI_ANNOTATE__.remove()`。

## 差距（用户问起时如实说明）

- 一次性注入，无持久工具条；刷新/导航后消失。
- 标注点来自对话（agent 中介），无 live 点选。
- 主世界注入（CDP evaluate）：绝大多数页面稳定；敌意页面可能干扰，
  届时回退纯文字报告。要完全 parity 需要宿主在 pi.browser 里开放
  isolated-world 的 annotation hook（宿主级改动，本插件做不到）。
