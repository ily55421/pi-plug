# A11y Audit —— 可访问性审计

> `local.a11y-audit` v0.1.0 · 权限：`browser.cdp` + `agent.tool.register`

---

## 为什么是这个能力

原路线图里 #8 是「浏览器性能/内存审计」，对标 opencode 的 `plugin-browser`
（`trace.start/stop/analyze`、`cpu.*`、`heap.snapshot/summary/query`、`lighthouse`）。

**动手前核实 `browser-cdp.ts:10-36` 的 `BROWSER_CDP_ALLOWLIST`，这项做不成**：

```js
Page.enable / reload / captureScreenshot / getLayoutMetrics / bringToFront
DOM.enable / getDocument / querySelector(All) / getBoxModel / describeNode
DOM.scrollIntoViewIfNeeded / getOuterHTML / getAttributes
Runtime.enable / evaluate / callFunctionOn / getProperties / awaitPromise
Input.dispatchMouseEvent / dispatchKeyEvent / insertText
Accessibility.enable / getFullAXTree / getPartialAXTree
Console.enable
```

`HeapProfiler.*`、`Performance.*`、`Network.*` **一个都不在名单里**，宿主还明确写着
「Cookie, storage, target, and network-interception methods stay off this list」。
所以性能与内存审计在这个宿主上根本发不出去。

但 `Accessibility.getFullAXTree` **在名单里**，而宿主与现有插件都没把这套能力交给模型。
这就是被证实的落点。

---

## 它做什么

审计工作区浏览器面板里当前页面，检查**扁平可访问性树能揭示的问题**：

| 检查 | 严重度 |
|---|---|
| 可交互元素缺无障碍名称（button/link/textbox/combobox/tab…） | high |
| 整页节点不少但**没有任何交互角色** | medium |
| 图像缺 alt 文本 | medium |
| 名称只是占位词（`click here`、`点击`、`→`、`123`） | medium |
| 节点不少但**没有任何标题** | medium |

## 它**不**做什么（能力边界，报告里逐条列出）

扁平树没有 ARIA properties、没有 DOM 顺序、没有计算样式，因此：

- 对比度
- 焦点顺序与键盘可达性
- `aria-expanded` / `aria-invalid` 等状态
- 图片到底是装饰性还是漏了 alt
- live region 与表单错误关联

**一条都不冒充检测**，`notCovered` 会随每次结果返回。

---

## 形态：纯插件，不是 agent extension

核实 `packages/agent-runtime/src/extensions/runner.ts` 的 `createContext` 后确认：
**agent extension 的 ctx 里没有 `browser` 成员**，拿不到 `pi.browser.snapshot()`。

而 `browser.cdp` 是**插件进程**的能力，所以本插件以普通插件形态运行，用
`pi.agent.registerTool` 把能力交给模型。

| 交付 | 说明 |
|---|---|
| 工具 `a11y_audit` | 模型可调用，返回统计 + findings + 未检查项 |
| 命令 `a11yAudit.open` | 用户主动跑一次，摘要走 `ui.notify` |

---

## 输出长什么样

```
Accessibility tree: 6 node(s), 3 interactive, 1 heading(s).
Findings: 1 high, 2 medium, 0 low.

- [high] e3 (button): button has no accessible name; a screen reader announces only the role.
- [medium] e5 (image): image has no accessible name; if it is decorative this is fine, otherwise add alt text.
- [medium] e6 (button) "click here": name "click here" carries no information out of context.

Not checked (the flattened tree cannot show these): color contrast ...; focus order ...; ARIA state ...; ...
```

刻意只回「统计 + 前 N 条 + 未检查项」：审计工具本身不该吃掉上下文。
`maxFindings` 默认 20、硬上限 60；报告超过 8000 字符会被截断并注明。

---

## 只读性

`tests/main.test.mjs` 里有一条用例把 `pi.browser` 包起来记录调用：
审计过程**只调用 `snapshot()`**，`navigate` / `evaluate` / `screenshot` / `cdp`
一旦被调用就抛错。实测 `calls === ["snapshot"]`。

---

## 已知边界

1. **依赖模块抓不到**：树只看主文档，iframe 内部元素不在其中。
2. **宿主已过滤 `ignored` 节点**（`flattenAxTree` 里 `if (!node.ignored)`），
   所以「本来该被辅助技术读到的元素被 aria-hidden 掉了」这类问题看不到。
3. **占位词表是启发式的**，覆盖中英文常见词；长文本里含 `click here` 不会误报
   （按整名精确匹配，不做子串匹配）。
4. **命令可达性未做端到端验证**：`pi.commands.register` 已按现有插件（`task-center`）
   的真实用法书写，但未在真实应用里手点。
5. **需要一个打开的浏览器面板**；没有时给出「先打开浏览器面板」的明确提示，而不是报栈。

---

## 测试

```powershell
node --test tests/core.test.mjs tests/main.test.mjs
```

- `tests/core.test.mjs`（27 项）：树解析（含转义、`(empty)`、非法行）、占位名称判定、
  各类角色检出、页面级检查、排序与截断、`notCovered` 存在性、报告渲染。
- `tests/main.test.mjs`（14 项）：注册与回收、有树/空树/抛错三条分支、错误翻译、
  `maxFindings`、报告截断、命令行为、**只读性验证**。

`PluginCheck` 通过（唯一提示是 `browser.cdp` + `agent.tool.register` 需显式授权）。
