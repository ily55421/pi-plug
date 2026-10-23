# opencode → PI-Desktop：可插件化增强的深度分析

> **调查对象**：`E:\data\1021\opencode`（SST/anomalyco 的 opencode，v2.1.2，commit `b42c31613f`，2026-10-22；`git describe` = `github-v1.2.27-57-gb42c31613f`；Bun + Effect monorepo，34 个包）
> **对比基准**：`E:\code\ai-platform-amd64\PI-Desktop` v0.15.1-beta.7（宿主源码 + 308 篇 ADR + `docs/spec/07-plugins/` 17 篇规范）
> **落点工作区**：`E:\code\ai-platform-amd64\pi-plug`（12 个自建插件）+ `pi-desktop-plugins`（官方目录 31 个插件）
> **前序分析**：`ZCode-...md`、`Kimi-Code-...md`、`DSH-SEP-...md`、`pi-agent-desktop-...md`。**本文只写这四份没覆盖的增量**，并在 §2.1 更正前序的一处事实错误。
> **证据原则**：所有结论带文件路径与行号；grep 零匹配的写「零匹配」，不臆测。

---

## 0. 结论速览

opencode 与前四份研究对象都不同：它是**唯一一个在「代码智能」和「运行时闸门」两侧同时超出 PI-Desktop 的成熟竞品**，而且它的桌面扩展体系（`packages/gui-extensions`，846 文件 / 55,135 行）本身就是 PI-Desktop 插件体系的**平行实现**——两套系统解决同一批问题，因此它的工程纪律可以直接对照吸收。

### 三个最大发现

**① 代码智能面是彻底空白。** opencode 内建 **34 个 LSP server**（`packages/web/src/content/docs/lsp.mdx` 的 Built-in 表，多数标注 "Auto-installs"）与 **26 个 formatter**（`formatters.mdx` Built-in 表）。PI-Desktop 侧：

| 检查 | 命令范围 | 结果 |
|---|---|---|
| LSP | `apps`/`crates`/`packages` 全部 `.ts`/`.rs`，模式 `languageServer\|\blsp\b\|LspServer` | **仅 1 处命中**，且是第三方 MCP 的目录描述文案：`packages/shared/src/mcp-catalog-builtin.ts:138`「语义检索 + LSP 的代码理解工具集」 |
| formatter | 同上范围，模式 `formatter\|formatDocument\|prettier\|biome` | **仅 2 处命中**，都是注释：`apps/desktop/electron/main/plugin-watcher.ts:5`、`apps/desktop/src/features/plugins/install-progress.ts:160` |

也就是说宿主既不会给模型提供「跳转到定义/查引用」，也不会在模型改完文件后自动格式化。官方 31 个插件里最接近的是 `pi.ts-toolkit`（正则/符号级依赖查询），与真实 LSP 不是一个量级。

**② 运行时闸门是彻底空白。** opencode 的权限键里有 `doom_loop`——「同一工具调用以完全相同入参重复 3 次即触发」（`permissions.mdx` Available Permissions 段），默认 `ask`。PI-Desktop 侧全库 grep `doom_loop|doomLoop|repeatedToolCall|identicalToolCall|loopDetect` → **零匹配**；grep `external_directory|externalDirectory|outsideWorkspace|escapeWorkspace` → **零匹配**。

这一条对本工作区尤其刺眼：本会话的系统提示里就挂着 `loop-guard` 技能（诊断模型重复输出死循环），但它是**纯提示词纪律 + 事后扫描脚本**，没有任何运行时强制。opencode 把它做成了权限闸。

**③ 宿主早就给了落地所需的 API，只是没人用。** `docs/spec/07-plugins/16-trusted-extensions.md:212` 的 Supported 行里包含 **`registerAgent`、`getAllTools`、`getActiveTools`、`setActiveTools`、`exec`、`getFlag`**。其中 `setActiveTools` 正好能实现 opencode 最漂亮的一个设计：

> When set to `deny`, the subagent is removed from the Task tool description entirely, so the model won't attempt to invoke it. —— `agents.mdx` Task permissions 段

即**「拒绝」不是运行时阻断，而是从提示词里删掉**。省 token，且模型不会反复撞墙。pi-plug 现有 12 个插件中，`contributes` 里出现 `agentExtensions` 的数量为 **0**——这条路完全没被走过。

### 可行性矩阵

| # | 能力 | opencode 出处 | 插件可行 | 价值 | 工作量 | 建议 |
|---|---|---|:---:|:---:|:---:|---|
| 1 | **LSP 代码智能工具** | `lsp.mdx` Built-in（34 项）、`core/src/tool/lsp` | ✅ 完全 | ★★★★★ | 中 | **P0** `local.code-intel` |
| 2 | **重复调用闸（doom_loop）** | `permissions.mdx`、`core/src/permission/` | ✅ 完全 | ★★★★★ | 小 | **P0** `local.loop-brake` |
| 3 | **编辑后自动格式化** | `formatters.mdx`（26 项）、`core/src/formatter/builtins.ts` | ✅ 完全 | ★★★★☆ | 中 | **P0** `local.format-on-edit` |
| 4 | **技能广告预算治理** | `skills.mdx` `opencode/autoinvoke`、`permission.skill` | ✅ 完全 | ★★★★☆ | 小 | **P1** `local.skill-budget` |
| 5 | **引用源（外部目录 + Git 物化）** | `references.mdx`、`core/src/reference/instructions.ts`、`scout` agent | ⚠️ 部分 | ★★★☆☆ | 中 | P1 `local.ref-source`（宿主已有项目组多根 `workspaceRootsFor`，但「登记外部只读知识源 + 版本可追溯」仍空白） |
| 6 | **分层 AGENTS.md 就近注入** | `.opencode/command/learn.md` | ✅ 完全 | ★★★★★ | 小 | **P1** `local.nested-memory` |
| 7 | **agent 预设 + 默认全拒工具白名单** | `agents.mdx`、`.opencode/agent/triage.md` | ⚠️ 部分 | ★★☆☆☆ | 小 | **降级**：宿主已有 `loadSubagentDefinitions`（读 `~/.agents/subagents/*.md`）与内置预设；插件只多「随包分发预设」这一层，价值有限 |
| 8 | **浏览器性能/内存审计** | `packages/plugin-browser/README.md` | ❌ 不可做 | ★★☆☆☆ | — | **证伪**：`browser.cdp` 走 `BROWSER_CDP_ALLOWLIST`（`browser-cdp.ts:10-36`），**不含** `HeapProfiler.*`/`Performance.*`/`Network.*`；只剩可访问性（`Accessibility.getFullAXTree`）可做 |
| 9 | **tree-sitter 命令级 shell 权限** | `permission.shell`、`cli` deps `tree-sitter-powershell` | ⚠️ 部分 | ★★★☆☆ | 中 | P2 `local.shell-guard` |
| 10 | **IAM 风格资源策略** | `policies.mdx` | ⚠️ 部分 | ★★★☆☆ | 中 | P2 `local.policy-gate` |
| 11 | **工程纪律四件套** | `gui-extensions/README.md`、`client/README.md` | ✅ 完全 | ★★★★☆ | 小 | **P2**（改 pi-plug 自身，非插件） |
| 12 | **录制/回放确定性测试台** | `packages/http-recorder`、`packages/simulation` | ⚠️ 部分 | ★★☆☆☆ | 大 | P2 `local.cassette` |
| 13 | 提示词资产包（rmslop/learn/translate+glossary） | `.opencode/command/*.md`、`.opencode/glossary/` | ✅ 完全 | ★★★★☆ | 极小 | **P0 顺手做** |
| 14 | 编辑后诊断自动回流 | `lsp.client.diagnostics` 事件 | ❌ 宿主无一等公民 | ★★★★☆ | 大 | 向宿主提（C 级） |
| 15 | 资源级审批持久化（ask→always） | `core/src/permission/saved.ts` | ❌ 宿主审批模型不同 | ★★★☆☆ | 大 | 向宿主提（C 级） |
| 16 | ACP server（接入 Zed/JetBrains/nvim） | `acp.mdx`、`cli` deps `@agentclientprotocol/sdk` | ❌ 须宿主暴露会话 | ★★★☆☆ | 大 | 向宿主提（C 级） |
| 17 | shadow-git 快照 / 按路径选择性恢复 | `core/src/snapshot.ts`（216 行）、`session/revert.ts` | ❌ 宿主已有近似 | ★★☆☆☆ | — | 已有（`review.rs` 672 行） |
| 18 | 代码模式（codemode）本体 | `packages/codemode`（85 文件 / 29,834 行） | ⚠️ 官方已有 | ★★★☆☆ | — | 已有 `pi.workflow`，只借两点 |

---

## 1. 研究对象解剖

### 1.1 规模与形态

各包源码规模（排除 `node_modules`/`dist`/`.turbo`，统计 `.ts/.tsx/.go/.rs/.js`）：

| 包 | 文件 | 行数 | 定位 |
|---|---:|---:|---|
| `core` | 758 | 164,682 | 引擎主体 |
| `app` | 766 | 162,666 | SolidStart 桌面/Web 前端 |
| `tui` | 492 | 104,396 | 终端 UI（OpenTUI） |
| `ai` | 408 | 74,328 | Schema-first 多模态 LLM 层 |
| **`gui-extensions`** | **846** | **55,135** | **桌面扩展体系（对标 PI-Desktop 插件）** |
| `ui` | 221 | 33,426 | UI 组件库 |
| **`codemode`** | **85** | **29,834** | **工具调用的纯解释器** |
| `session-ui` | 155 | 25,448 | 会话渲染（deps 含 `mermaid`、`@pierre/diffs`） |
| `cli` | 197 | 23,669 | CLI 入口 |
| `client` | 61 | 21,318 | 从 HttpApi 生成的客户端 |
| `stats` | 96 | 19,825 | 公开统计站点（app/core/function 三层） |
| `merman` | 89 | 19,698 | **终端里渲染 mermaid** |
| `desktop` | 172 | 12,124 | Electron 壳 |
| `plugins` | 11 | 11,019 | 官方插件集（**实质只有 figma**） |
| `server` | 91 | 9,003 | HTTP API |
| `protocol` | 46 | 4,435 | 端点构造与中间件位置 |
| **`simulation`** | **25** | **3,974** | **模拟 provider + 录制回放** |
| `plugin` | 66 | 3,293 | 插件 SDK（4 个入口） |
| **`http-recorder`** | **23** | **3,067** | **HTTP/WS 磁带录制回放** |
| `sdk` | 30 | 2,700 | **进程内宿主**（不开监听） |
| `latex` | 14 | 2,436 | **终端里渲染 LaTeX** |
| `plugin-browser` | 11 | 1,835 | **浏览器能力经 Code Mode 暴露** |
| `theme` | 14 | 1,545 | 终端主题 |
| `containers` | 1 | 67 | CI 预构建镜像 |

`packages/core/src` 一级目录（37 个）中最值得注意的：`formatter`、`instructions`、`reference`、`skill`、`permission`、`worktree`、`vcs`、`persistent-pty`、`codemode`、`models-dev`、`wellknown`、`kv`、`modal`。

### 1.2 三套扩展面（这是与 PI-Desktop 最大的结构差异）

opencode 不是一个扩展面，是**三个**，各自解决不同层次：

| 扩展面 | 位置 | 形态 | 能力 | 对标 PI-Desktop |
|---|---|---|---|---|
| **plugin** | `.opencode/plugins/*.ts`、`~/.config/opencode/plugins/`、npm 包 | 一个导出函数，收 ctx 返回 hooks 对象 | 事件订阅、`tool.execute.before/after` 改参数或抛错阻断、`shell.env` 注入环境变量、`experimental.session.compacting` 改压缩提示词、注册自定义工具（可覆盖内建） | `agent.extension`（B 级） |
| **custom tool** | `.opencode/tools/*.ts`、`~/.config/opencode/tools/` | 文件名即工具名；多导出 → `<filename>_<exportname>` | `tool.schema` 就是 Zod；`execute(args, context)` 拿 `{agent, sessionID, messageID, directory, worktree}` | `contributes.agentTools`（A 级） |
| **gui-extension** | `packages/gui-extensions/src/*` | `Extension.define` 清单 + window/main 双入口 | 10 个注册表 + 22 个宿主 API 属性（window 16 / main 9，表列 25 行）+ 类型化 IPC + 声明式存储 | `contributes.views` / `ui.panel` |

证据：`plugins.mdx`（Create a plugin / Events / Examples 全节）、`custom-tools.mdx`（Location / Structure / Context 全节）、`gui-extensions/README.md:22-49`（Anatomy + 清单字段表）。

三个值得单独记的设计：

1. **插件进程共享宿主运行时实例。** `packages/plugin/README.md` 明确：CLI 加载插件时把 `effect`、`effect/*` 子路径、`@opencode/plugin` 入口的 import **解析到宿主的运行时模块实例**，「so fibers, loggers, and `Schema` parsers share one copy」；并要求把 `effect` 声明为 `peerDependency`、打包时 external，因为「Two copies of `effect` do not share fiber, logger, or `Schema` internals」。导入 Effect 私有 `internal` 模块会**加载失败并在错误里点名路径**。
   → PI-Desktop 的插件是独立进程 + 自带 `node_modules`，没有这个约束也没有这个保护。这是**宿主级依赖解析策略**的差异，插件层无法复现，但值得在 pi-plug 的打包脚本里注意「不要把宿主也提供的运行时打进 bundle」。

2. **自定义工具可以覆盖内建工具。** `custom-tools.mdx` Name collisions 段：同名时自定义工具优先，文档给的例子就是用一个「什么都 blocked」的 `shell.ts` 替换内建 `shell`。`plugins.mdx` 也重申「If a plugin tool uses the same name as a built-in tool, the plugin tool takes precedence」。
   → 这是**很强的能力，也是很强的风险**。PI-Desktop 的 `registerTool` 是否允许覆盖宿主内建工具，规范未见明示；若允许，应在 pi-plug 侧自我约束为「只覆盖自己注册过的」。

3. **进程内宿主。** `packages/sdk/README.md`：`@opencode/sdk` 在**内存里执行 Server 的 HTTP 路由，不开监听、不加网络跳**，`await using opencode = await OpenCode.create()`，`close()`/`Symbol.asyncDispose` 释放 router 资源、Location 服务、fiber 与 scoped 插件注册。
   → 与 `pi.session-orchestrator`（spawn 真实持久 Worker Session）是两种编排哲学：一个进程内嵌入，一个进程外派生。前者启动快、无端口冲突，后者隔离好、可跨会话存活。

### 1.3 gui-extensions：与 PI-Desktop 插件体系的平行对照

`gui-extensions/README.md:3` 第一句就定了调：「Every feature of the desktop and web app that is not the core shell is an extension: the terminal, review, files, the browser, SSH, WSL, the updater and more.」内建 13 个（`src/main.ts#builtins`：context、btw、debug、terminal、file、review、details、browser、pairing、updater、ssh、wsl、microsoftOffice）。

| 维度 | opencode gui-extensions | PI-Desktop 插件 |
|---|---|---|
| 清单 | `Extension.define({id, legacy, os, provides, uses, requires, stores, i18n})` | `manifest.json`（`contributes` + `permissions`） |
| 依赖表达 | `provides`/`uses`（可选）/`requires`（硬），**编译期检查** | 无插件间依赖声明；只有 `bus.publish/subscribe` 松耦合 |
| 依赖不可用时 | `Live<T>` 六态：`pending`、`active`、`inactive{restarting, disabled, failed, blocked}` | 未定义 |
| UI 面 | 10 个注册表（Command/MenuItem/Panel/SettingsPage/Server/LinkHandler/TitlebarItem/Slot/Style/MenubarItem） | `views`（右侧工作面板）、`ui.panel`（独立窗口）、`commands`、`themes` |
| 存储 | `Store.global`/`Store.session`/`Store.main`，**声明式 + 迁移 `from` homes** | `pi.plugin.setSettings` + 插件自己的存储隔离（spec 11） |
| 进程模型 | window（同步 setup）+ main（可异步），类型化 `Ipc` 契约 | 插件进程 + panel/view 沙盒页面 |
| 权限 | 无能力权限模型，靠「受信内建」 | **39 项能力权限 + 安装期授予**（这是 PI-Desktop 的优势） |
| 分发 | 只能内建（`src/renderer.ts`/`src/main.ts` 是唯一列出扩展名的两个文件） | `.piplug` 打包 + 市场（spec 06/07） |

**结论**：PI-Desktop 在**治理与分发**上更强（权限矩阵、签名、市场、审计），opencode 在**组合性与降级契约**上更强（编译期依赖图、`Live<T>`、存储迁移）。后者是可以直接吸收的工程纪律，见 §3.10。

---

## 2. PI-Desktop 能力基线（本次重新核实）

### 2.1 权限枚举实为 **39 项**（更正前序文档）

`DSH-SEP-...md` §2.1 写「权限枚举：44 项」。**本次逐行核实为 39 项**：`packages/plugin-sdk/src/index.ts:1247-1291` 的 `PLUGIN_PERMISSIONS` 数组，从 `"ui.panel"`（:1248）到 `"net.websocket"`（:1290），`as const` 收尾于 :1291，`PluginPermission` 类型定义在 :1293。完整清单：

```
ui.panel, ui.view, ui.microphone, ui.theme, ui.settings, ui.window.appearance,
clipboard.read, clipboard.write, notify,
fs.read, fs.write, fs.delete,
agent.tool.register, agent.prompt.inject, agent.complete, agent.extension,
provider.register, desktop.control, models.list, project.create,
session.read, session.import, session.read.own, session.update.own, session.delete.own,
usage.read, net.fetch, net.websocket, shell.openExternal,
mcp.server.local, mcp.server.remote, background.service,
bus.publish, bus.subscribe, browser.cdp,
audio.capture.background, audio.playback.background, speech.adapter.register,
keyboard.globalShortcut
```

与本分析相关的关键项：

| 权限 | 对本分析的意义 |
|---|---|
| `agent.extension` | **本文 7 个方案的地基**（#2/#3/#4/#6/#7/#9/#10） |
| `mcp.server.local` | **宿主替插件拉起本地进程**的唯一合规通道（#1 LSP 桥） |
| `browser.cdp` | #8 浏览器性能/内存审计的入场券 |
| `agent.tool.register` | A 级方案基础 |
| `agent.prompt.inject` | #5/#6/#13 的提示词注入 |
| `fs.read`/`fs.write` | 引用源缓存、就近 AGENTS.md 写回 |

注意 `:1276` 的 `net.fetch` 与 `:1290` 的 `net.websocket` 是分开的两项；`:1283` 的 `browser.cdp` 独立存在（意味着插件可直接驱动 CDP，不必绕 BrowserPreview）。

同一文件还有两条硬上限：`MAX_AGENT_EXTENSIONS_PER_PLUGIN = 8`（`:1243`）、`MAX_GLOBAL_SHORTCUTS_PER_PLUGIN = 8`（`:1245`）。**8 个 extension 模块的上限对本文方案是真实约束**，见 §7。

### 2.2 `agent.extension` 支持矩阵（比前序文档记录的更宽）

`docs/spec/07-plugins/16-trusted-extensions.md:212` 的 Supported 行，本次完整摘出（前序分析漏记了 `registerAgent`/`getAllTools`/`getActiveTools`/`setActiveTools`/`getFlag`）：

> `registerTool`、`registerCommand`、**`registerAgent`**、`registerProvider`（plugin-owned 兼容别名，与 `registerAgent` 同形）、`unregisterAgent`、`unregisterProvider`、`on(...)`（§6 全部事件）、**`exec`**、**`getActiveTools`**、**`getAllTools`**、**`setActiveTools`**、`getCommands`、`setModel`（已配置模型与插件 agent；仅 idle；持久化当前会话绑定）、`getThinkingLevel`、`setThinkingLevel`、`setSessionName`、`getSessionName`、`sendUserMessage`（Host-owned queue，D386）、**`getFlag`**

`:213` Supported on context：`ui.notify/confirm/select/input/setStatus/setWorkingMessage`、`cwd`、`modelRegistry`、`isIdle`、`abort`、`hasPendingMessages`、`getContextUsage`、**`compact`**、**`getSystemPrompt`**、`waitForIdle`、`newSession`、`fork`。

事件采纳表（`:251-261`）：

| 事件 | 钩子点 | 结果是否被采纳 |
|---|---|---|
| `before_agent_start`（:251） | 本轮首次 provider 请求前 | **是，系统提示与消息可改** |
| `context`（:252） | `prepareNextTurn` | **是，可替换消息列表** |
| `tool_call`（:257） | `beforeToolCall` | **是，可带原因阻断** |
| `tool_result`（:259） | `afterToolCall` | **是，可替换结果** |
| `session_before_compact`（:261） | 压缩管线 | **是** |
| `tool_execution_start/update/end`（:258） | 工具执行流 | 否 |

另：`:283`「`exec` runs in the sidecar with the session's working directory」；`:281`「Every execution writes an audit line with extension id, tool name」；`:36`「An agent extension is trusted code. It executes inside the Agent sidecar」。

**这四条合起来决定了本文大部分方案的可行性**：能改系统提示、能替换工具结果、能带原因阻断工具调用、能在会话 cwd 里执行命令、且每次执行都留审计行。

### 2.3 插件进程可达 Node 内建

`docs/spec/07-plugins/04-plugin-security.md:509`：

> Capability sandboxing inside the plugin process (Node built-ins are reachable ...)

同文件 `:306`：「`sandbox: true` removes Node, not the network」——但那是**panel 会话**的约束，不是插件进程。

**这条是 #1（LSP）、#3（formatter）、#5（git clone 引用源）能落地的前提**：插件进程可以用 `child_process`。这也解释了为什么 `local.rea`（v1.1.0，权限含 `mcp.server.local`）能驱动 Hopper/Ghidra 这类外部原生二进制（其目录里有 `launcher.cjs`、`runtime.js`）。

### 2.4 `mcpServers`：宿主替插件拉进程的合规通道

`packages/plugin-sdk/src/index.ts:516-528`：

```ts
export type PluginMcpServerContrib = {
  id: string; label?: string;
  transport: "stdio" | "http";
  /** stdio only: bare PATH name or plugin-relative executable. */
  command?: string; args?: string[];
  /** stdio only: literal values, or `{ "setting": "<key>" }` to read plugin settings. */
  env?: Record<string, string | { setting: string }>;
  /** http only: an absolute `http://` or `https://` endpoint. */
  url?: string; headers?: Record<string, string | { setting: string }>;
};
```

配套 `PluginServiceContrib`（`:530-535`，`autoRestart` 默认 true）、`PluginBusContrib`（`:537-542`）、`PluginGlobalShortcutContrib`（`:544-558`）。

**意义**：`command` 可以是「plugin-relative executable」——插件可以**自带一个可执行文件让宿主拉起**。这给 LSP 桥提供了两条路：
- 路 A：`agent.extension` 的 `exec` 在 sidecar 里直接跑 LSP server（生命周期自己管）
- 路 B：把 LSP 桥做成插件自带的 stdio MCP server，宿主负责拉起与重启（`autoRestart`），agent 通过 MCP 工具面拿到 `goToDefinition` 等能力

路 B 更符合宿主的治理模型（进程由宿主托管、有审计、可开关），且 `local.rea` 已验证此路可行。**建议 #1 走路 B。**

### 2.5 宿主的四处零匹配（已验证）

| 能力 | grep 模式 | 范围 | 结果 |
|---|---|---|---|
| LSP | `languageServer\|\blsp\b\|LspServer` | `apps`/`crates`/`packages` 全部 `.ts`/`.rs` | 1 处，且为第三方 MCP 描述文案 |
| Formatter | `formatter\|formatDocument\|prettier\|biome` | 同上 | 2 处，均为注释 |
| 循环闸 | `doom_loop\|doomLoop\|repeatedToolCall\|identicalToolCall\|loopDetect` | 同上 | **零匹配** |
| 越界目录权限 | `external_directory\|externalDirectory\|outsideWorkspace\|escapeWorkspace` | 同上 | **零匹配** |

宿主广播给插件的事件仍是 6 个（全库 `broadcastEvent(` 共 7 处，其中 1 处是定义）：

| 事件 | 证据 |
|---|---|
| `appearance:changed` | `apps/desktop/electron/main/bootstrap/app-lifecycle.ts:616` |
| `session:modelChanged` | `apps/desktop/electron/main/ipc/session-ipc.ts:557`、`runtime/sidecar.ts:372` |
| `session:turnEnded` | `apps/desktop/electron/main/services/plugin-services.ts:523` |
| `workspace:changed` | `apps/desktop/electron/main/index.ts:782,792` |
| `plugin:settingsChanged` / `bus.message` | 见前序分析（规范 + `plugin-host-process.mjs`） |
| （定义处） | `apps/desktop/electron/main/plugin-runtime.ts:1633` |

**对照 opencode 的 27 个插件事件**（`plugins.mdx` Events 节：`command.executed`、`file.edited`、`file.watcher.updated`、`installation.updated`、`lsp.client.diagnostics`、`lsp.updated`、`message.part.removed/updated`、`message.removed/updated`、`permission.asked/replied`、`server.connected`、`session.created/compacted/deleted/diff/error/idle/status/updated`、`shell.env`、`tool.execute.before/after`、`tui.prompt.append`、`tui.command.execute`、`tui.toast.show`），PI-Desktop 的事件面窄得多——尤其缺 `file.edited`（#3 需要的「文件被改了」信号）与 `permission.asked/replied`（#15 需要的审批流）。这是**必须走 `agent.extension` 而非纯插件事件**的根本原因。

### 2.6 现有覆盖盘点（本次实测）

**pi-plug 自建 12 个插件**：

| 目录 | id | 版本 | 权限 | contributes |
|---|---|---|---|---|
| doc-index | `local.doc-index` | 0.2.2 | agent.tool.register, agent.prompt.inject, fs.read | agentTools, skills |
| local.annotate | `local.annotate` | 0.1.0 | agent.prompt.inject | skills |
| local.trajectory | `local.trajectory` | 0.1.0 | ui.view | commands, views |
| memory-governed | `local.memory-governed` | 0.2.1 | agent.tool.register, agent.prompt.inject, session.read | agentTools, skills |
| obsidian-theme | `local.obsidian-theme` | 3.0.0 | ui.panel, ui.theme | commands, themes |
| provider-balance | `local.provider-balance` | 0.1.0 | ui.view, net.fetch | commands, views |
| rea | `local.rea` | 1.1.0 | ui.view, agent.tool.register, agent.prompt.inject, mcp.server.local, clipboard.write | agentTools, commands, mcpServers, skills, views |
| session-import | `io.github.muzimu217.session-import` | 0.5.0 | ui.panel, ui.view, session.read, session.read.own, session.import, project.create, agent.complete, models.list, fs.read, fs.write | commands, sessionSources, settings, views |
| session-orchestrator | `pi.session-orchestrator` | 0.5.1 | ui.panel, agent.tool.register, desktop.control, models.list | agentTools, commands |
| skill-pack | `local.mcode-skill-pack` | 0.2.1 | agent.prompt.inject | skills |
| task-center | `local.task-center` | 0.1.1 | ui.view, agent.tool.register, agent.prompt.inject | agentTools, commands, skills, views |
| token-meter | `local.token-meter` | 0.4.1 | ui.view, ui.panel | commands, views |

**官方目录 31 个插件**（`pi-desktop-plugins/catalog.json`）：demo.hello、demo.workspace-notes、demo.workspace-summary、io.github.liushunqiu.pi-idea-git、io.github.muzimu217.deps-audit、io.github.muzimu217.session-import、io.github.muzimu217.usage-dashboard、local.pi-desktop-install-guard、local.pi-matt-workflow、pi.artifact-board、pi.bianqian、pi.clipboard-history、pi.file-manager、pi.gitlens、pi.goal-x、pi.log-viewer、pi.markdown、pi.obsidian-theme、pi.parchment、pi.scratch-calc、pi.session-orchestrator、pi.skill-lock、pi.ssh-manager、pi.state-forge、pi.super-domain-man、pi.terminal、pi.todo、pi.token-insights、pi.ts-toolkit、pi.workflow、pi.workspace-file-guard。

**关键观察**：两侧 43 个插件条目（pi-plug 12 + 官方 31，其中 `io.github.muzimu217.session-import` 与 `pi.session-orchestrator` 两个 id 在两侧重复出现）中，`contributes.agentExtensions` 的出现次数为 **0**；`permissions` 里出现 `agent.extension` 的次数为 **0**。整个 pi-plug 生态**从未使用过宿主最强的扩展点**。本文的 P0 三项全部落在这个未开发区域。

**已饱和、不要碰的方向**：会话导入（session-import v0.5.0）、token 用量（token-meter + pi.token-insights + usage-dashboard）、todo（task-center + pi.todo）、主题（obsidian-theme v3.0.0 + pi.parchment）、工作流编排（pi.workflow）、产物看板（pi.artifact-board）、架构治理与符号依赖（pi.ts-toolkit）、技能来源锁定（pi.skill-lock）、越界写入分类（pi.workspace-file-guard）、目标管理（pi.goal-x）、状态空间枚举（pi.state-forge）、SSH（pi.ssh-manager）、文件管理（pi.file-manager）、Git 视图（pi.gitlens + pi-idea-git）、终端（pi.terminal）、依赖审计（deps-audit）。

---

## 3. 深度分析：opencode 的差异化能力

### 3.1 代码智能面：34 LSP + 26 formatter（★★★★★）

**LSP**（`lsp.mdx` Built-in 表）覆盖 astro、bash、clangd、csharp、clojure-lsp、dart、deno、elixir-ls、eslint、fsharp、gleam、gopls、hls、jdtls、julials、kotlin-ls、lua-ls、nixd、ocaml-lsp、oxlint、php intelephense、prisma、pyright、razor、ruby-lsp(rubocop)、rust、sourcekit-lsp、svelte、terraform、tinymist、typescript、vue、yaml-ls、zls。其中 **11 个标注 "Auto-installs"**（astro、bash、clangd、kotlin-ls、lua-ls、php intelephense、svelte、terraform、tinymist、vue、yaml-ls）。配置项：`disabled`/`command`/`extensions`/`env`/`initialization`。

`lsp` **工具**是实验性的，需 `OPENCODE_EXPERIMENTAL_LSP_TOOL=true`（或 `OPENCODE_EXPERIMENTAL=true`）才出现，支持 9 个操作：`goToDefinition`、`findReferences`、`hover`、`documentSymbol`、`workspaceSymbol`、`goToImplementation`、`prepareCallHierarchy`、`incomingCalls`、`outgoingCalls`（`tools.mdx` lsp 节）。权限键 `lsp`，文档明确注明「currently non-granular」（`permissions.mdx`）。

**Formatter**（`formatters.mdx` Built-in 表）26 个：air、biome、cargofmt、clang-format、cljfmt、dart、dfmt、gleam、gofmt、htmlbeautifier、ktlint、mix、nixfmt、ocamlformat、ormolu、oxfmt(实验)、pint、prettier、rubocop、ruff、rustfmt、shfmt、standardrb、terraform、uv、zig。每项都写了「Requirements」——**绝大多数是「命令可用」或「项目里有对应配置文件/依赖」，不是硬装**。配置项：`disabled`/`command`/`environment`/`extensions`。

**PI-Desktop 的空白已验证**（§2.5）。

**移植方案 #1 `local.code-intel`**：
- 形态：插件自带一个 stdio MCP server（`mcpServers`，`command` 指向 plugin-relative 可执行文件），内部按扩展名路由到用户已装的 LSP server，暴露上述 9 个操作为 MCP 工具
- 权限：`mcp.server.local` + `fs.read`（+ `ui.view` 做一个「LSP 状态」面板，显示哪些 server 起来了）
- **首版不做自动安装**：opencode 的 11 个 Auto-installs 需要网络下载 + 进程管理 + 失败降级，成本高且容易在 Windows 上出问题。首版走「探测 → 未装则明确报未装 + 给安装命令」
- **对 Windows 的特别处理**：本工作区的 shell 是 PowerShell 7，LSP server 的可执行名解析、路径分隔符、`~` 展开都要按 Windows 规则来；opencode 的 `lsp.mdx` 还专门有一节 `windows-wsl.mdx` 说明 WSL 场景
- 与 `pi.ts-toolkit` 的关系：后者的 `dep_refs` 是「注释与字符串字面量被 mask 后做符号级匹配」，属静态文本分析；LSP 是编译器级语义。**不冲突，但 LSP 会显著超越它**，文档里要说清定位差异

**移植方案 #3 `local.format-on-edit`**：
- 形态：`agent.extension` 的 `tool_result` 钩子（`:259` 可替换结果）——在 `Edit`/`Write` 成功后，按扩展名查 formatter 表，用 `exec`（`:283`，带 session cwd）跑格式化，再把「已格式化 + 变更摘要」**并入工具结果**
- **最大的坑（必须处理）**：格式化改写了文件内容，宿主的 Edit 锚点（4-hex `tag`）与行号会失效。若不在替换后的结果里回传新锚点信息，模型下一次 `Edit` 必然 `EDIT_PARSE_FAILED` 或改错行。**这是 opencode 不会遇到的问题**（它的 `edit` 工具用精确字符串替换，且 formatter 在工具内部同步跑完才返回），PI-Desktop 的 tag 机制让这条必须显式处理
- **第二个坑**：`tool_result` 属结果型事件，超 **30 秒**放弃并继续（前序分析引 `16-trusted-extensions.md:266-268`）。大文件跑 clang-format/rustfmt 可能超时 → 必须自带更短的超时（如 8 秒）并降级为「跳过格式化 + 在结果里提示」
- 首版只带「命令可用即用」的少数几个：prettier、biome、ruff、gofmt、rustfmt、shfmt。**不碰需要项目配置文件的**（clang-format、ocamlformat、pint）

### 3.2 权限面：资源级模式匹配 + 两道安全闸（★★★★★）

opencode 的权限模型（`permissions.mdx` 全文）有几个 PI-Desktop 完全没有的维度：

1. **按工具入参做模式匹配。** 不只是「这个工具能不能用」，而是「这个工具**用这些参数**能不能跑」：
   ```json
   "shell": { "*": "ask", "git *": "allow", "rm *": "deny" },
   "edit":  { "*": "deny", "packages/web/src/content/docs/*.mdx": "allow" },
   "webfetch": { "*": "ask", "https://en.wikipedia.org/*": "allow" }
   ```
   规则**按顺序求值，最后匹配者胜**；通配符 `*`（零或多字符）/`?`（恰一字符）；支持 `~` 与 `$HOME` 展开。权限键共 13 个：`read`、`edit`（覆盖 edit/write/apply_patch）、`glob`（匹配 glob 模式本身）、`grep`（匹配正则本身）、`shell`（匹配**解析后的命令**，如 `git status --porcelain`）、`task`（匹配子代理类型）、`skill`（匹配技能名）、`lsp`、`question`、`webfetch`（匹配 URL）、`websearch`、`external_directory`、`doom_loop`。

2. **`doom_loop`**：「triggered when the same tool call repeats 3 times with identical input」，默认 `ask`。

3. **`external_directory`**：任何以路径为入参的工具触碰工作目录之外的路径时触发，默认 `ask`。文档还特别说明：`~` 展开**只影响模式怎么写**，不会让外部路径变成工作区的一部分，所以仍必须经 `external_directory` 放行。放行后「inherits the same defaults as the current workspace」，因此要额外加 `edit` 的 deny 才能做到「可读不可写」。

4. **`.env` 默认拒读**，但 `*.env.example` 重新放行：
   ```json
   "read": { "*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow" }
   ```

5. **审批的 `always` 由工具提议模式**。「The set of patterns that `always` would approve is provided by the tool (for example, shell approvals typically whitelist a safe command prefix like `git status*`)」——泛化规则由工具给出，不让用户自己猜。三档结果：`once`/`always`/`reject`，`always` 的有效期是「the rest of the current OpenCode session」。

6. **审批决定被持久化到数据库**：`core/src/permission/saved.ts` 定义 `AddInput { projectID, action, resources[] }`、`UpdateInput`、`NotFoundError`、`ConflictError`，落到 `PermissionTable`（`permission/sql.ts`）。即**按项目记住资源级授权**。

7. **`--auto` 模式**：自动批准所有未被显式 deny 的请求，「Explicit `deny` rules are still enforced」。TUI 里可开关，开启时提示条会显示一个 muted `auto` 标记。

8. **按 agent 覆盖**，且 agent 规则优先于全局；Markdown agent 的 frontmatter 里可直接写 `permission:`。

**移植方案 #2 `local.loop-brake`（P0，工作量最小，价值最高）**：
- `agent.extension` 的 `tool_call` 钩子（`:257` 可带原因阻断）
- 对 `(toolName, 规范化后的参数 JSON)` 取指纹，滑动窗口计连续重复次数；达阈值（默认 3，可配）→ **直接 block，并把原因写成模型能自我纠正的话**，例如：「你已用完全相同的参数调用 `Grep` 3 次，结果不会改变。请改变检索模式、换用其他工具，或直接向用户报告阻塞。」
- 比 opencode 更进一步：opencode 是 `ask`（打断用户），插件可以**默认 block + 只在用户显式配置时才 ask**——因为 PI-Desktop 的阻断会把 reason 回给模型，模型有机会自己换路，不必惊动用户
- 权限：**仅 `agent.extension`**，无 fs、无 net、无进程
- 与现有 `loop-guard` 技能的分工要在文档里写死：技能负责**事后诊断**（扫历史会话找 token 异常烧毁、thinking 尾部空转），插件负责**实时拦截**。两者互补，且插件落地后技能的「预防纪律」部分可以瘦身
- 建议同时覆盖 opencode 未覆盖的一类循环：**近似重复**（参数只有微小差异，如在同一个目录反复 Glob 递进模式）。可加一个「同工具 + 同路径前缀 + N 次」的次级规则，默认只记审计不阻断

**移植方案 #9 `local.shell-guard`（P2）**：
- `permission.shell` 匹配的是**解析后的命令**，这靠 `packages/cli` 的依赖 `tree-sitter-bash` + `tree-sitter-powershell` + `web-tree-sitter` 实现
- PI-Desktop 的 `Bash` 工具没有命令级闸（`agent.extension` 的 `tool_call` 能拿到原始命令字符串，但宿主不做解析）
- 落地：`tool_call` 钩子 + `web-tree-sitter`（wasm，可在插件进程加载）解析命令 → 应用「最后匹配者胜」的模式规则
- **Windows 要点（照搬必踩）**：本会话 shell 是 PowerShell 7，`Bash` 工具只是协议名。必须用 **tree-sitter-powershell** 语法，用 bash 语法解析 PowerShell 会全线失败
- **必须 fail-closed**：解析失败 → 当作不可信 → 走 ask/deny，绝不能 fail-open 放行

**关于 `external_directory`**：官方已有 `pi.workspace-file-guard`（技能描述里明确「把测试文件、临时文件、草稿脚本、日志、转储、缓存和垃圾文件关在当前工作区或 PI scratch」，并提供 `check_path`/`temp_env`/`tmp_layout`/`project_root` 四个工具）。**不要新造插件**。可借鉴的是 opencode 的两点升级方向：
- 把「分类建议」升级为「运行时强制」——即从工具形态改为 `tool_call` 阻断形态
- 借用 opencode 的分层写法：放行某目录后**默认继承工作区的所有默认权限**，因此要显式补 `edit: deny` 才能做到「可读不可写」

### 3.3 上下文预算面：三个省 token 的机制（★★★★☆）

这是 opencode 最容易被忽略、但对 PI-Desktop 最直接有用的一组设计。

**(a) 工具目录的渐进披露 —— `core/src/codemode/catalog.ts`**

```ts
export type Tool = { type: "tool"; name; description; signature; pinned?: boolean }
export type Namespace = { type: "namespace"; name; description?; tools: ReadonlyArray<Tool|Namespace> }
export const Summary = Schema.Struct({ total, shown, namespaces: Array(NamespaceSummary) })
// NamespaceSummary = { name, description?, count, entries: Array({ path, line }) }
```

配合 `packages/plugin-browser/README.md` 的用法「Discover current signatures with `search({ namespace: "browser" })`」：**系统提示里只放目录摘要（total/shown/每命名空间的 count 与条目路径），具体签名靠模型主动 search 拉取**；`pinned` 标记少量必须常驻的工具。

→ **PI-Desktop 已经对工具这么做了**：本会话系统提示里的 On-demand tools 段落列出一部分，末尾写「... 153 more; search by exact name or capability description」，并要求先 `ToolSearch` 再用。**这是趋同设计，不需要移植。**

**(b) 技能广告的开关 —— 但 PI-Desktop 缺这一半**

opencode 的技能有三个层次的曝光控制（`skills.mdx`）：

| 机制 | 效果 |
|---|---|
| `metadata["opencode/autoinvoke"] = "false"` | **不进 `<available_skills>`**（模型面自动选择指引），但仍可按精确名手动加载 |
| `permission.skill` 的 `deny` | 「Skill hidden from agent, access rejected」，支持 `internal-*` 通配 |
| `tools.skill: false` | 「the `<available_skills>` section is omitted entirely」 |

对照 PI-Desktop 本会话的真实状态：系统提示的 Skills 段落列了 **29 条**技能，每条都带完整 description（`huashu-design` 那条长达 400+ 字，`i-have-adhd`、`pdf-to-dwg-cad`、`workspace-file-guard` 也都是百字级），而 On-demand tools 段却做了「153 more」的渐进披露。

**即：PI-Desktop 对工具做了按需披露，对技能是全量广告。** 而且这 29 条里有**两组重复**：`completion-discipline` 与 `local.adm-discipline/completion-discipline`（description 逐字相同）、`context-discipline` 与 `local.adm-discipline/context-discipline`（同上）。重复条目纯粹是 token 浪费。

→ **移植方案 #4 `local.skill-budget`（P1，工作量小，收益立刻可见）**：
- 用 `agent.extension` 的 `getSystemPrompt`（`:213`）+ `before_agent_start`（`:251` 系统提示可改）重写 Skills 段
- 三个功能：① **审计报告**——扫描已装技能，逐条算 description 的 token 占比、标出重复/近重复、标出「本会话从未被 `Skill` 调用过」的；② **autoinvoke 名单**——用户配置的「不进广告、只按需精确加载」技能集，把它们的 description 从系统提示里摘掉，只留名字进一个紧凑清单；③ **去重**——同名或 description 相同的技能只广告一次
- 与 `pi.skill-lock` 完全不重叠（那个管来源与哈希校验）
- 风险：改系统提示是侵入性操作，必须提供「一键还原」与「只报告不改写」的干跑模式

**(c) 动态提示段的增量渲染 —— `core/src/reference/instructions.ts`**

```ts
const diff = Instructions.diffByKey(previous, current,
  (reference) => reference.name,
  (before, after) => before.path !== after.path || before.description !== after.description)
// Added, changed, and removed references render as deltas;
// the full list is restated only when no entry differs.
```

即：当可用引用源变化时，**只重述 added/changed/removed 三类增量**；只有在没有任何条目差异时才重述全表并声明「This list supersedes the previous reference list」。

→ **这不是一个插件，是一条应当被 pi-plug 全线采纳的技术**。工作区里凡是往上下文注入动态清单的插件都该用：`local.memory-governed`（召回的候选记忆）、`local.doc-index`（检索命中）、`local.task-center`（任务清单快照）、以及 #5/#6 两个新方案。当前这些插件每轮重述全量清单的话，长会话里会持续烧 token。**建议提炼成 pi-plug 内的一个共享小工具（如 `pi-plug/shared/instructions-diff.cjs`），四处复用。**

### 3.4 引用源面：`references` + `scout`（★★★★☆）

opencode 允许把**项目外的目录与 Git 仓库**登记为「引用源」（`references.mdx` 全文 + `core/src/reference/`）：

```jsonc
"references": {
  "docs":  { "path": "../product-docs", "description": "Use for product behavior and documentation conventions" },
  "sdk":   { "repository": "anomalyco/opencode-sdk-js", "branch": "main", "description": "Use for JavaScript SDK implementation details" },
  "effect": "Effect-TS/effect"
}
```

字段：`path`（本地，可相对配置文件/绝对/`~`）、`repository`（Git URL、host/path、或 GitHub `owner/repo` 简写）、`branch`、`description`、`hidden`。五条关键行为：

1. **Git 引用会被物化**：「OpenCode materializes the repository in its local repository cache and makes the checked-out source available as a reference directory」，且**异步刷新**（新配的仓库可能要等一会儿）
2. **有 description 才进 agent 上下文**：「OpenCode includes references with descriptions in agent context」；无 description 的仍可通过 `@` 补全与直接使用，但**不向 agent 广告**
3. `@alias` 附加引用源根，`@alias/` 在其中搜文件
4. **自动穿过外部目录权限边界**：「OpenCode automatically allows reference directories through its external-directory permission boundary」——但「Normal tool permissions still apply」，即无编辑权的 agent 不会因为某目录被登记为引用源就获得编辑权
5. alias 不能为空、不能含 `/`、空白、反引号、逗号

配套还有 **`scout` 子代理**（`agents.mdx`）：「A read-only agent for external docs and dependency research. Use this when you need to **clone a dependency repository into OpenCode's managed cache**, inspect library source, or cross-reference local code against upstream implementations **without modifying your workspace**.」

**PI-Desktop 现状**：插件的 `fs.read`/`fs.write` 限定在 workspace 或用户选定目录；官方 `pi.workspace-file-guard` 的方向恰好相反——**阻止**读写跑到工作区外。宿主没有「显式登记外部只读知识源」的概念。

而这是个真实需求：**本次分析任务本身就是**——要读 `E:\data\1021\opencode`（在工作区外）与 `E:\code\ai-platform-amd64\PI-Desktop`（也在工作区外）。Read 工具的说明里写着「An explicit path outside the workspace and session scratch roots requires permission unless the effective mode is Auto」。即当前是靠「模式放开」解决的，没有「按目录显式授权 + 带用途说明地广告给模型」这一层。

→ **移植方案 #5 `local.ref-source`（P1）**：
- 插件维护 `references.json`（alias → path/repository/branch/description/hidden），存插件自己的隔离存储
- Git 引用 clone 进插件缓存目录（Node 内建可达，§2.3），带**仓库大小与缓存总量上限**，超限拒绝并报告
- 用 `agent.prompt.inject` / `before_agent_start` 注入 `<available_references>`，**必须用 §3.3(c) 的增量渲染**
- 注册一个只读检索工具（`ref_search`/`ref_read`），把路径限定在已登记的引用源内
- 可配一个 `scout` 式只读子代理预设（见 #7），专门做「查上游实现」
- **与 `pi.workspace-file-guard` 的边界必须写清**：那个管「别把垃圾写到外面」，这个管「显式允许从外面读知识」；两者互补。且 #5 必须**严格只读**——绝不给引用源写权限，这与 opencode「Normal tool permissions still apply」一致
- 安全：引用源是**不可信外部内容**（可能是任意公开仓库）。注入上下文时必须标注来源，且要防提示注入——建议参考 `local.doc-index/doc-index-policy` 技能里已有的「不可信数据处理」约定，保持一致

### 3.5 策略面：`experimental.policies`（★★★☆☆）

`policies.mdx` 定义了一套 AWS IAM 风格的资源准入策略，与 permission **正交**：「Permissions control what tools can do during a session, while policies control whether OpenCode may use a resource such as an LLM provider.」

```json
"experimental": { "policies": [
  { "effect": "deny",  "action": "provider.use", "resource": "*" },
  { "effect": "allow", "action": "provider.use", "resource": "anthropic" }
]}
```

四条规则：`effect` ∈ {allow, deny}；`resource` 支持 `*`/`?`；**最后匹配者胜**（所以宽规则写前面，例外写后面）；无匹配则默认允许。当前只有一个 action：`provider.use`。被 deny 的 provider「is not available for model selection or model use, **even if it has credentials**」。

最值得抄的一条：**全局策略优先于项目策略**——「This prevents a repository from re-enabling a provider that you deny globally.」即**克隆一个仓库不能放宽你在用户级设的禁令**。

**PI-Desktop 现状**：有 `models.list`、`provider.register`，但没有「按资源 ID 拒绝某个 provider/模型」的策略层。

→ **移植方案 #10 `local.policy-gate`（P2）**：`agent.extension` 的 `before_provider_request` 或 `setModel`（`:212`，仅 idle 时生效）实现；策略文件分用户级与项目级，**项目级不得放宽用户级**。价值在于「组织/个人禁令不可被仓库配置绕过」这条性质，比功能本身更值得吸收。局限：`setModel` 只在 idle 时可用，无法在请求中途改；真正干净的实现需要宿主支持。

### 3.6 记忆面：`learn` → 分层 AGENTS.md（★★★★★）

`.opencode/command/learn.md`（1,670 B）是一份完整的「会话知识回写」工作流，核心是**路径作用域的分层记忆**：

> AGENTS.md files can exist at any directory level, not just the project root. **When an agent reads a file, any AGENTS.md in parent directories are automatically loaded into the context of the tool read.** Place learnings as close to the relevant code as possible:
> - Project-wide learnings → root AGENTS.md
> - Package/module-specific → packages/foo/AGENTS.md
> - Feature-specific → src/auth/AGENTS.md

什么算 learning（只收非显然的发现）：文件/模块间的隐藏关系、与代码表面不同的执行路径、非显然的配置/环境变量/flag、错误信息误导下的调试突破、API/工具的怪癖与绕过法、README 里没有的构建/测试命令、架构决策与约束、必须一起改的文件。

什么不算：文档里的显然事实、语言/框架的标准行为、已在某个 AGENTS.md 里的、冗长解释、会话特定细节。

流程 5 步：回顾会话找发现 → 判定每条 learning 的作用域目录 → 读该层已有的 AGENTS.md → 建或改 → **每条洞见控制在 1-3 行**。

**PI-Desktop 现状**：ADR 0234 的 projectMemory 是**扁平的**（`kv` 表 `projectMemory` 命名空间，32 KiB 纯文本注入，按 canonical project path 隔离——见前序分析 §2.5）。本会话的 Project instructions 段只加载了 `~/.pi/agent/AGENTS.md` 一个文件，**未见「读文件时自动带出该子树 AGENTS.md」的证据**（宿主全库亦无对应机制的命中）。

pi-plug 的 `local.memory-governed`（v0.2.1）是**证据绑定的结构化记忆库**：候选/确认状态机、revision 乐观锁、撤回墓碑、项目隔离、必须附用户原话证据。它与分层 AGENTS.md **不是同一类东西**：前者是可查询的 KV 记忆，后者是**路径作用域的纯文本工程约定**，随代码走、进 Git、人类可直接读改。

→ **移植方案 #6 `local.nested-memory`（P1，价值 ★★★★★，工作量小）**：
- 注入半场：`agent.extension` 的 `tool_result` 钩子（`:259`）——拦 `Read`/`Grep` 的结果，取被读文件路径，向上逐级找最近的 `AGENTS.md`（到 workspace 根为止），把**尚未在本会话注入过的**那些追加到工具结果尾部，并记账避免重复注入（每层每会话只注入一次）
- 回写半场：一个 `/learn` 式技能（纯提示词），照搬 opencode 的「什么算 / 什么不算 learning」清单与「1-3 行」约束，把发现写回**就近的那一层**
- 与 `local.memory-governed` 的分工写进两者的 SKILL.md：结构化、需证据、需召回 → 记忆库；工程约定、随代码走、按路径触发 → 分层 AGENTS.md
- 与 `local.mcode-skill-pack/project-init`（生成 AGENTS.md）的关系：那个是**初始化根级**，这个是**运行期分层维护**，可衔接
- **成本警示**：注入必须做去重记账，否则每次 Read 都追加一遍会迅速吃掉上下文；且注入内容也应走 §3.3(c) 的增量原则

### 3.7 安全/回滚面：shadow-git 快照（★★☆☆☆，不建议移植）

`core/src/snapshot.ts`（216 行）：`operation: Schema.Literals(["capture", "files", "diff", "restore"])`（`:19`），把 Location 作用域的文件系统状态**捕获为内容寻址的树**（`:45-49`，且是 best-effort，失败不阻断），支持「列出两棵树之间变更的项目相对路径」（`:52`）、「生成结构化的按文件 diff」（`:58`）、「**按选定路径从各自的树恢复**」（`:64-67`，`RestoreInput` 在 `:34`），底层用 `git.repo.discover`（`:92`）——即**内部影子 git 仓库**。

`core/src/session/revert.ts`：`stage()` 取 `input.session.revert?.snapshot ?? snapshot.capture()`，构造 `Map<RelativePath, Snapshot.ID>` 后 `snapshot.restore({ files })`。

`config.mdx` Snapshot 节坦承代价：「For large repositories or projects with many submodules, the snapshot system can cause slow indexing and significant disk usage」，因此提供 `"snapshot": false` 关闭，并注明关掉后 agent 的改动无法从 UI 回滚。

**PI-Desktop 已有近似能力**：`crates/host-core/src/review.rs`（**672 行**，已核实存在）+ `docs/adr/0043-message-owned-review-snapshots-and-rollback.md`——消息级审阅快照与守卫回滚。

**结论：不建议插件重造。** 可向宿主提的唯一增强是 opencode 的**「按路径选择性恢复」+「内容寻址树之间生成结构化 diff」**这两个粒度（宿主 ADR 0043 是消息级）。

### 3.8 浏览器面：把性能/内存/审计开放给 agent（★★★☆☆）

`packages/plugin-browser/README.md` 的职责切分很干净：「The server owns tools, invocation scope, and permissions; the desktop owns tabs, CDP, captured traffic, evaluations, and capture files. Core only registers the plugin. **Neither endpoint imports the other's implementation.**」

工具面（全部经 Code Mode 调用，形如 `await tools.browser.tabs.open({url})`）：

| 类别 | 工具 |
|---|---|
| Tabs | `tabs.list`/`open`/`focus`/`close` |
| 导航 | `navigate`/`back`/`forward`/`reload`/`stop`/`frames` |
| 观察 | `snapshot`/`find`/`evaluate`/`wait`/`screenshot` |
| 输入 | `click`/`hover`/`drag`/`fill`/`fill_form`/`select`/`check`/`press`/`scroll`/`dialog` |
| 文件 | `files.upload`/`drop`/`list`/`get` |
| 诊断 | `console`/`network.list`/`network.get` |
| **性能** | **`trace.start`/`stop`/`analyze`、`cpu.start`/`stop`/`analyze`** |
| **内存** | **`heap.snapshot`/`summary`/`query`/`object`/`compare`** |
| **审计** | **`lighthouse`（accessibility、SEO、best practices）** |

三条使用约束写得很实在：所有页面操作都要 `tabs.open/list` 返回的 `tabID`；`focus` 选的是可见的 Review tab 而非隐式命令目标；**截图要求 tab 已聚焦可见，须先调 `tabs.focus`**。

**PI-Desktop 现状**：有 `browser.cdp` 权限（`index.ts:1283`）、`BrowserPreview` 工具、`dsh-browser-automation` 与 `autoglm-browser-agent` 两个浏览器技能、`local.annotate` 插件（Shadow DOM 序号徽章 + 高亮框 + 截图）。**但全是「操作页面 / 标注页面」，没有「量页面」**——无 heap snapshot、无 CPU trace、无 lighthouse、无 network 记录回流给模型。

→ **移植方案 #8 `local.browser-audit`（P1）**：用 `browser.cdp` 直连，暴露 `Performance.startTrace`、`HeapProfiler.takeHeapSnapshot`、`Audits`/Lighthouse、`Network` 事件采集为 agent 工具。
- **必须做的限制**：heap snapshot 动辄数十 MB，绝不能整块塞进工具结果。要照 opencode 的思路——`packages/codemode/README.md` 明说宿主「can also limit execution time, tool calls, **output size, and data**」——只回 `summary`（分代大小、Top 保留者、疑似泄漏点），全量落盘到 scratch 供 `heap.query`/`heap.object` 二次下钻
- 与 `local.annotate` 不重叠（那个是视觉标注给人看，这个是指标给模型判断）

### 3.9 测试面：确定性回放（★★☆☆☆）

`packages/http-recorder/README.md`：「Record real Effect HTTP and WebSocket traffic once, then replay it from deterministic JSON cassettes. Use it for provider integrations, retries, polling, multi-step flows, and any test where **hand-written HTTP mocks hide too much of the real request shape**.」支持 Node 22+ 与 Bun，不支持浏览器/worker/Deno。

`packages/simulation/src/`（25 文件 / 3,974 行）：`control-server.ts`、`manifest.ts`、`recording.ts`、`backend/{index,network,openai,simulated-provider}.ts`、`frontend/{actions,renderer,semantics,server,simulation}.ts`、`protocol/index.ts`。`packages/server` 直接依赖 `@opencode/simulation`。即**内置了一个模拟 provider**，前后端都能被仿真驱动。

**价值**：改技能/提示词/agent 预设之后，用录好的真实 provider 流量跑确定性回归，而不是每次重跑烧 token 且结果不可比。

**PI-Desktop 现状**：`local.trajectory`（v0.1.0）做的是 jsonl → 时间线回放，**给人看**；`pi-desktop-plugins/tests/` 与 pi-plug 的 `tests/` 是常规测试。没有 provider 层的录制回放。

→ **移植方案 #12 `local.cassette`（P2，成本高）**：需要在 `net.fetch` 或 provider 层插入录制点。`agent.extension` 有 `before_provider_request`/`before_provider_headers`（前序分析记录，结果被采纳），理论上可录；但**回放需要让宿主的请求走假端点**，这在插件层很难干净实现（`provider.register` 可以注册 provider，但要让既有会话改用它需要 `setModel`，而 `setModel` 仅 idle 可用）。**建议先只做「录制 + 差异报告」**（记录每次 provider 请求的形状与响应统计，用于对比改动前后），不做完整回放。

### 3.10 工程纪律面：gui-extensions 的四道治理机制（★★★★☆，改 pi-plug 自身）

这不是插件，是**pi-plug 这个工作区自己该采纳的四条纪律**。每条都有 opencode 的具体实现可参照。

**(a) 文档-代码漂移 lint**

`gui-extensions/README.md:3`：「`bun run lint` checks every code block marked with its source against that source.」标记形如 `<!-- source: src/updater/renderer.tsx#createKeyed -->`（README 里共 **15 处**，已用 grep 核实），由 `script/sdk-docs.ts` 校验（`:436` Lint gate 行）。效果：**README 里的示例代码不可能与出货源码不一致**。
`packages/client/README.md` 有同源思路：「a generation-equivalence test preventing transport drift. Run `bun run generate` after changing the contract and `bun run check:generated` to detect committed-output drift」，外加「Bundle-boundary tests enforce both import graphs」。

→ pi-plug 12 个插件的 README（含 `交付说明.md`、`插件验证指南.md`）里的代码片段与命令**全部没有这层保护**。前序分析文档里引用的行号同样会随宿主升级而失效（本文 §2.1 就抓到一处：「44 项」实为 39 项）。
**建议**：加一个 `pi-plug/tests/check-docs.cjs`，扫描 `*.md` 里的 `<!-- source: path#anchor -->` 标记，比对真实文件内容；并给分析文档里引用的宿主行号做同样的锚定校验。**成本极小，收益是分析文档不会烂掉。**

**(b) `Live<T>`：显式的「不可用」契约**

`gui-extensions/README.md:299-314` 定义六态并规定**每一态用户必须看到什么**：

| 状态 | 何时 | 用户必须看到 |
|---|---|---|
| `pending` | 提供方未启动 | 加载态，或干脆不给可点的东西 |
| `active` | `value` 可用，`generation` 计重启次数 | 功能本身 |
| `inactive` + `restarting` | 曾活跃、正在回来 | **保住用户已有的东西**，回来后继续 |
| `inactive` + `disabled` | 被关、未被组合、平台不支持 | 不可用态，**绝不是一个点了没反应的按钮** |
| `inactive` + `failed` | setup 抛错 | 不可用态 |
| `inactive` + `blocked` | 硬依赖被禁用/失败/自身被阻塞 | 不可用态；依赖回来后自动恢复 |

铁律（`:310`）：「Offer an action only while it can answer, or let it answer with an unavailable state. **Never a silent `return`, never an endless spinner.**」另有 `:312`「An Ipc that goes away is a suspension, not a failure: keep what the user had and resume when it returns. **No retry timer.**」与 `:314`「A contribution that throws renders nothing and records the error. **The rest of the window keeps working.**」

→ pi-plug 的 views（`provider-balance`、`token-meter`、`local.trajectory`、`rea`）目前多是「有数据就渲染」。`provider-balance` 已经做对了一部分（前序分析记载它「归一化不抛错，返回 `{ok:false, reason}`」，且新增「本机另有 N 个供应商不在此看板内」的盘点）。**建议把 `Live<T>` 这套六态提炼成 pi-plug 的共享 view 约定**，特别是「依赖不在时显示什么」与「不给死按钮」两条。

**(c) 改名不丢用户数据**

`gui-extensions/README.md:404`：「Renaming an extension moves **four** things: enable state (`Definition.legacy`), stored keys (`from`), command ids (the keybind rename map in `packages/app/src/settings/keybinds/migration.ts`), and panel keys (`Panel.legacy`). **Never drop user data.**」

存储迁移机制（`:344-403`）：`Store.global/session/main` 三种；`from` 参数**列出旧家（最新在前）**，只在当前 store 为空时导入一次；配 `pick` 可以从「一个装着多个所有者的旧 key」里只挑自己的字段（`:383-387` 的 review 例子），且「a pick returns undefined when that key holds none of its fields, **never an object of undefined fields**, so the next home is read」；`Storage.remove(key, {from})` 之后**不再重复导入**（`:403`）。

→ pi-plug 有真实的改名史（`local.task-center` vs 官方 `pi.todo`；`skill-pack` 的 id 是 `local.mcode-skill-pack`）。**建议**：任何 pi-plug 插件改 id 或改设置结构时，必须写迁移，并在 README 里列出旧家。

**(d) 依赖图矩阵测试**

`gui-extensions/README.md:433`：`packages/app/component-tests/extension-graph.spec.ts` 抓两类问题——「A `requires` cycle; **a consumer that fails when one optional provider is disabled**」。`:722` 说明新增扩展时「The graph matrix then boots each new optional edge with its provider disabled」。另有编译期检查：`sdk/compose.typecheck.ts`、`builtins.typecheck.ts`（`IpcsProvided<typeof builtins, typeof mainBuiltins>`，`:711`）、`sdk/registries.typecheck.ts`。

→ **这是 pi-plug 最缺的一类测试**。工作区里 12 个插件有隐性依赖（例如 `local.mcode-skill-pack` 的 `todo-recheck` 技能指向 `local.task-center` 注册的工具——`交付说明.md` 自己就写了「todo 工具必须自带注册它的插件，否则技能会指向不存在的工具」）。**建议**：加一个矩阵测试，逐个禁用某插件后启动其余插件，断言「不崩、且给出明确的不可用态而非死按钮」。

### 3.11 提示词资产面：`.opencode/` 自举目录（★★★★☆，成本极小）

opencode 用自己的产品开发自己，`.opencode/` 目录就是可移植的资产库：

| 资产 | 内容 | 可移植性 |
|---|---|---|
| `command/rmslop.md`（600 B） | 对照 `origin/dev` 的 diff 清除 AI 味：人类不会加的或与文件其余部分不一致的多余注释、对该代码区域而言异常的防御性检查/try-catch（尤其调用方是可信/已校验路径时）、绕过类型问题的 `any` 转换、与文件不一致的其他风格、不必要的 emoji。**结尾只给 1-3 句变更摘要** | ★★★★★ 直接可用 |
| `command/learn.md`（1,670 B） | 见 §3.6 | ★★★★★ |
| `command/commit.md`（661 B） | `model: opencode/kimi-k2.5` + `subtask: true`（不污染主上下文）；要求 `type(scope): summary`；「prefer to explain **WHY** something was done from an end user perspective instead of **WHAT** was done」；禁止「improved agent experience」这类空话；**有冲突不要修，通知我**；用 `` !`git diff` ``/`` !`git diff --cached` ``/`` !`git status --short` `` 注入上下文 | ★★★★☆ |
| `command/translate.md`（814 B） | `model: opencode/gpt-5.6-sol`；跑 git diff 把变更的英文文档与 UI 文案**并行**翻译成所有语言；保留含义/意图/语气/格式（含 Markdown/MDX 结构）；**逐字保留**产品名、API 名、标识符、代码、命令与 flag、文件路径、URL、版本、错误信息、配置键值、行内代码与代码块内的一切；额外遵守 `.opencode/glossary/<locale>.md` | ★★★★☆ |
| `command/issues.md`（543 B） | `model: opencode/claude-haiku-4-5`（**便宜模型干检索活**）；用 gh CLI 找相似 issue：标题/描述相似、错误信息或症状相同、相关功能或组件、类似特性请求；输出 issue 号+标题+为何匹配+链接 | ★★★★☆ |
| `command/ai-deps.md`（1,053 B） | 只升 minor/patch，**忽略 major**；要求每个依赖给出可升版本 + 变更摘要 + changelog 链接；「Consider using **subagents for each dep** to save your context window」；**只出报告不动手**，写到 `ai-sdk-updates.md` | ★★★★☆ |
| `command/spellcheck.md`（209 B） | 只看 markdown（.md/.mdx）的未暂存变更行，查拼写与语法 | ★★★☆☆ |
| `command/changelog.md`（3,218 B） | 最大的一个，changelog 生成 | ★★★☆☆ |
| `agent/triage.md`（1,456 B） | `mode: primary`、`hidden: true`、`model: opencode/gpt-5.4-mini`、`color: "#44BA81"`、**`tools: {"*": false, "github-triage": true}`**（默认全拒 + 单点放行）；正文是 issue 分派规则，声明「This file is the source of truth for ownership/routing rules」；按重叠度最强的团队分派；**不加标签只指派 owner**；团队划分 TUI / Desktop-Web / Core / Inference / Windows | ★★★★☆ |
| `glossary/README.md` + 17 个 locale 文件 | 术语表体系：`Sources`（**每条规则必须挂 PR/issue/讨论出处**）、`Do Not Translate (Locale Additions)`、`Preferred Terms`（English→Preferred→Notes 三列表）、`Guidance`、`Avoid`。收录标准三条：跨多个文档/界面重复出现、容易一致执行、**有社区贡献或评审讨论背书**。「Prefer PR-backed guidance over invented term mappings」 | ★★★★☆ |
| `tool/github-triage.ts`、`tool/github-pr-search.ts` | 项目级自定义工具（`tool({description, args, execute})`），从 env 读 `ISSUE_NUMBER`/`GITHUB_TOKEN` | ★★☆☆☆（与 opencode 仓库强绑定） |
| `skills/`（8 个） | `app-e2e-tests`(19 KB)、`component-tests`(19 KB)、`unit-tests`(22.7 KB)、`tui-tests`(14.9 KB)、`opencode-dev`(15 KB)、`effect`(2.8 KB)、`rtl-aware-development`(4.2 KB)、`sample-skill`(1.3 KB) | ★☆☆☆☆（与 opencode 技术栈强绑定，但 `sample-skill` 是极好的 SKILL.md 范本） |

命令文件的 frontmatter 能力（`commands.mdx`）：`template`（必填）、`description`、`agent`、`subtask`、`model`；提示词内支持 `$ARGUMENTS`、位置参数 `$1`/`$2`/`$3`、`` !`command` ``（**在项目根跑命令并把输出注入提示词**）、`@path`（**把文件内容注入提示词**）。自定义命令**可覆盖内建命令**（内建有 `/init`、`/undo`、`/redo`、`/help`）。

→ **移植方案 #13（P0 顺手做）**：把 `rmslop`、`learn`、`commit`、`translate`+glossary 机制、`issues`、`ai-deps`、`spellcheck` 收进 `local.mcode-skill-pack`（v0.2.1 → 0.3.0）作为新技能，或另起一个 `local.opencode-skill-pack`。
- 纯提示词资产，**权限只需 `agent.prompt.inject`**，不注册工具、不读文件、不联网——与 `local.mcode-skill-pack` 现有的权限面完全一致，零新增风险
- **必须做的适配**：① 把 `!`git diff`` 与 `@file` 语法改成 PI-Desktop 的等价做法（PI-Desktop 的技能是纯提示词，没有命令注入语法 → 改为在技能里明确指示 agent 自己去跑 `git diff` 并读结果）；② `model:` 与 `subtask:` frontmatter 在 PI-Desktop 技能里没有对应物 → 改为在技能正文里建议「用 Task 委派给子代理，避免污染主上下文」；③ `rmslop` 里的 `origin/dev` 改为主干分支的通用说法；④ 术语表的 `Sources` 纪律（**每条规则挂出处**）与 `local.memory-governed` 的**证据绑定**思想同源，应在文档里互相指引
- **术语表本身值得单独做一个技能**：`glossary/README.md` 的模板（Sources / Do Not Translate / Preferred Terms / Guidance / Avoid）+ 收录三标准 + 「PR 背书优先于臆造术语映射」，对任何做多语言文档的项目都通用。`glossary/zh-cn.md` 是个完整实例（含「prompt→提示词、session→会话、provider→提供商、headless→无界面、keybind→快捷键」等，并注明「Keep `--prompt` unchanged in flags/code」「Keep enum-like values in English when they are literals」）

### 3.12 代码模式（codemode）：只借两点

`packages/codemode/README.md` 的定位：「a lightweight, **pure interpreter** for a JavaScript-like language built around calling tools」。安全模型是**靠只实现部分语言特性**，而不是靠沙箱任意 JS：

- 「Rather than trying to sandbox arbitrary JavaScript, CodeMode **only runs the language features we implement**. Programs **cannot directly access the network, filesystem, processes, or application APIs**. They can interact with the outside world **only through tools provided by the host**, which can also **limit execution time, tool calls, output size, and data**.」
- 「**Unfinished work is interrupted.** Tool calls and async functions start when called. When the program finishes, anything still running is interrupted. Unhandled rejections from un-awaited promises are returned as warnings.」
- 「**REPL-style results.** Without an explicit `return`, the final top-level expression becomes the result. `undefined` becomes `null`.」
- 不支持的语法返回 `UnsupportedSyntax` 诊断**并带源码位置**；缺口记录在 `interpreter-support.md`
- 思路源自 Cloudflare 的 Code Mode（其原文是 isolate 方案，opencode 选了纯解释器方案）
- 包内文件：`codemode.ts`、`data.ts`、`extension.ts`、`namespace.ts`、`tool.ts`、`tools.ts`、`tool-runtime.ts`、`tool-schema.ts`、`tool-error.ts`、`index.ts`

**PI-Desktop 已有 `pi.workflow`**（官方目录，前序 ZCode 分析 §3.1 记为「脚本化工作流编排器」，且该分析 §8.1 专门讨论了它的安全风险）。**不建议重造。** 值得吸收的只有两点：

1. **工具目录的渐进披露**（§3.3(a)）：`catalog.ts` 的 `{name, description, signature, pinned}` + `Summary{total, shown, namespaces[{count, entries[{path,line}]}]` + `search({namespace})`。PI-Desktop 的 `ToolSearch` 已覆盖工具面，但**插件自己注册的 agentTools 若变多，应当套用同一模式**（尤其 `local.rea` v1.1.0 已经注册了大量工具——本会话系统提示里逐一可数的 `plugin_local_rea_*` 就有 19 个，其后还跟着「153 more」未展开；这正是需要「目录摘要 + 按需 search」而非全量铺开的场景）。
2. **显式的执行配额**：「limit execution time, tool calls, **output size, and data**」四项。`pi.workflow` 若尚未对「输出体积」设限，这是最该补的一项——它直接决定一次批量操作会不会把上下文炸掉。

### 3.13 其他值得记录但不建议投入的

| 能力 | 出处 | 为什么不建议 |
|---|---|---|
| `merman`（89 文件 / 19,698 行） | deps `@opencode/plugin`、`@opentui/core`、`entities`、`string-width` | 是**终端里渲染 mermaid**。PI-Desktop 是 Electron GUI，`packages/session-ui` 的依赖里已有 `mermaid` |
| `latex`（14 文件 / 2,436 行） | deps `@opencode/plugin`、`@opentui/core`、`string-width` | 同上，终端 LaTeX 渲染，GUI 侧不需要 |
| `stats`（96 文件 / 19,825 行） | `packages/stats/README.md`：app(SolidStart)/core(Effect+Drizzle)/function(Lambda) 三层，是**公开统计站点**，还带一套 Cloudflare 缓存 TTL 策略 | 形态完全不同。本地用量统计已由 `local.token-meter` v0.4.1 + `pi.token-insights` + `usage-dashboard` 覆盖；`opencode stats` CLI（token 用量与成本）对应的能力，PI-Desktop 侧缺的是**价格表**，前序分析已判定「自带价格表维护成本高」 |
| `containers`（1 文件 / 67 行） | CI 预构建镜像（base/bun-node/rust/tauri-linux/publish） | 与 opencode 自己的 GitHub Actions 强绑定 |
| `theme`（14 文件 / 1,545 行） | 终端主题（`themes.mdx`：终端能力要求、层级、JSON 格式、颜色定义、terminal defaults） | `local.obsidian-theme` v3.0.0 + `pi.parchment` 已覆盖，且终端主题与 GUI 主题不同域 |
| ACP | `acp.mdx`：`opencode acp` 作为子进程走 JSON-RPC over stdio，已适配 Zed（含 Zed ACP Registry）、JetBrains、Avante.nvim、CodeCompanion.nvim；文档注明「Some built-in slash commands like `/undo` and `/redo` are currently unsupported」 | 需要宿主把会话暴露为 ACP server，插件做不到 → C 级 |
| GitHub/GitLab 集成 | `github.mdx`（Features/Installation/Configuration/Supported Events/Schedule-PR-Issues Triage 三类示例/Custom prompts）、`gitlab.mdx`（GitLab CI + GitLab Duo 两条路） | 是 **CI workflow**（在 GitHub Action 里跑 opencode），不是本地能力。与 PI-Desktop 的桌面形态不同域 |
| `@opencode/ai` | 408 文件 / 74,328 行；schema-first 的文本/图像/视频/语音/转写；**provider-neutral 的 `LLMEvent` 流**，同一形状覆盖 OpenAI Chat、OpenAI Responses、Anthropic Messages、Gemini、Bedrock Converse 及任意 OpenAI 兼容部署 | PI-Desktop 有 `pi-ai` 层。可借鉴的是「事件流形状跨 provider 统一」这一设计目标，不是移植代码 |
| 会话导入导出 | `opencode export [sessionID]` / `opencode import <file>`（JSON） | `io.github.muzimu217.session-import` v0.5.0（8 源）已覆盖且更强 |
| `opencode pr <number>` | 拉取并 checkout GitHub PR 分支后启动 | 需要宿主的 worktree/checkout 能力，前序分析已判定「宿主未暴露 worktree 操作」 |
| `packages/plugins`（官方插件集） | 11 文件 / 11,019 行，**实质只有 figma**（~1.2 MB 技能：`figma-use`、`figma-generate-design`(37 KB)、`figma-code-connect`、`figma-generate-library`、`figma-implement-motion`、`figma-use-figjam`、`figma-use-slides`、`figma-shaders`、`figma-swiftui`、`figma-generate-diagram`、`figma-create-new-file`、`figma-generative-plugins`、`figma-use-motion`，各带 `references/` 与 `scripts/`） | 内容不可移植（Figma 专用）。**但它的分发机制值得抄**：`skills-source.json`（529 B）+ `script/sync-skills.ts`（2,373 B）+ `skills/NOTICE.md`（998 B）= **外部技能包的来源登记、同步脚本与出处声明**。建议用它补强 `pi.skill-lock`（那个管哈希与来源锁定，但没有「从上游同步」与「NOTICE 声明」这两步） |
| Watcher 配置 | `config.mdx` Watcher 节：`watcher.ignore` glob，「Common dependency, VCS, build, and cache directories are ignored automatically **at any depth**」 | 依赖 `@parcel/watcher`（在 `cli` deps 里）。PI-Desktop 有 `plugin-watcher.ts`（那是插件文件热重载，不是工作区文件监听）。价值中等，且缺 `file.edited` 事件（§2.5）支撑 |
| `.ignore` 文件 | `tools.mdx` Internals 节：grep/glob 底层用 ripgrep 且默认遵守 `.gitignore`；在项目根放 `.ignore` 写 `!node_modules/` 可把被忽略的路径重新纳入 | PI-Desktop 的 `Grep` 工具有 `include` 参数，属同类能力。可作为一条**技能提示**（「搜不到 node_modules 里的东西时怎么办」）而非插件 |
| `websearch` 免密钥 | `tools.mdx`：仅在使用 OpenCode/OpenCode Go provider 时可用，或设 `OPENCODE_ENABLE_EXA`/`OPENCODE_ENABLE_PARALLEL`；「connects directly to the backend's **hosted MCP service without authentication**」 | 依赖 opencode 自家后端，不可移植。文档里区分 discovery（websearch）与 retrieval（webfetch）的提示语值得抄进技能 |
| Session Core 的持久化设计 | `AGENTS.md:176-187`：durable events 最小化（「record irreducible new facts and do not repeat state derivable by folding the ordered aggregate history」）；`session.inbox.enqueued` → 投影插一行 `session_inbox` → advisory wake；**重用 Session ID 即领养既有 Session**，重用 inbox item ID 在 Session 与 type 匹配时幂等（首次admission 胜出，重试的 payload/metadata/delivery mode 被忽略）；`SessionExecution` 进程全局且基于 Session ID；**write-ahead execution claim** 作为重启恢复标记（终态/失败/用户中断释放它，shutdown 中断与进程死亡保留它），并明确声明「The claim is a recovery marker, **not** clustered ownership, fencing, or an exactly-once guarantee」；「One step is one logical LLM call」，**禁止在内存里写工具循环**；术语纪律：不许写 "provider turn"，"turn" 保留给未来的 assistant-turn 单位 | 这是**引擎内部设计**，插件层无法移植。但三条思想对 pi-plug 有直接价值：① 事件只记不可约的新事实，可推导的一律折叠得出（`local.trajectory`、`local.memory-governed` 都该守）；② **诚实标注保证边界**（「这不是 exactly-once」）——正是本工作区分析文档该有的写法；③ 术语一旦定义就不许混用 |
| 依赖方向纪律 | `AGENTS.md:1-2`：「Keep runtime dependencies directed from Schema to Core and Protocol, then from Core and Protocol to Server. Client runtime code may depend on Schema and Protocol but **never** Core or Server」 | 与 `pi.ts-toolkit` 的 `arch_check`（`architecture-policy.yaml`）同类。可作为该插件的一条示例策略 |

---

## 4. 建议落地清单（按优先级）

### P0（三项 + 一个顺手包）

| # | 交付物 | 形态 | 权限 | 关键风险 |
|---|---|---|---|---|
| 2 | `local.loop-brake` | `agent.extension`（`tool_call` 阻断） | `agent.extension` | 指纹规范化要稳（参数顺序、绝对路径、时间戳需归一），否则漏判 |
| 1 | `local.code-intel` | 插件自带 stdio MCP server（`mcpServers`） | `mcp.server.local`, `fs.read` | LSP 进程生命周期；首版**不做**自动安装 |
| 3 | `local.format-on-edit` | `agent.extension`（`tool_result` 替换） | `agent.extension` | **必须回传新 Edit 锚点**；30 秒事件超时 → 自带 8 秒超时并降级 |
| 13 | `local.opencode-skill-pack`（或并入 `local.mcode-skill-pack` 0.3.0） | `contributes.skills` | `agent.prompt.inject` | 需把 `` !`cmd` `` / `@file` / `model:` / `subtask:` 改写为 PI-Desktop 等价做法 |

**为什么 #2（`local.loop-brake`）排在路线图第一**：工作量最小（一个钩子 + 一个指纹函数 + 一个计数窗口）、权限最窄（只要 `agent.extension`，不碰 fs/net/进程）、痛点最真实（本会话就挂着 `loop-guard` 技能，说明这个问题在本工作区反复出现），且**它是整个 pi-plug 生态第一个用 `agent.extension` 的插件**——跑通它就验证了 §2.2/§2.3 的全部前提，为 #3/#4/#6/#7 铺路。（表内编号沿用 §0 可行性矩阵，故 #2 在前、#1 在后：矩阵按「价值 × 工作量」排序，路线图按「先验证通路」排序。）

### P1（五项）

| # | 交付物 | 形态 | 权限 |
|---|---|---|---|
| 6 | `local.nested-memory` | `agent.extension`（`tool_result` 注入）+ 一个 `/learn` 技能 | `agent.extension`, `fs.read`, `fs.write`, `agent.prompt.inject` |
| 4 | `local.skill-budget` | `agent.extension`（`getSystemPrompt` + `before_agent_start`）+ 审计视图 | `agent.extension`, `ui.view` |
| 5 | `local.ref-source` | 提示词注入 + 只读检索工具 + git 缓存 | `agent.prompt.inject`, `agent.tool.register`, `fs.read`, `net.fetch`(clone 可改用 `exec`) |
| 7 | `local.agent-presets` | `registerAgent` + `setActiveTools` | `agent.extension` |
| 8 | `local.browser-audit` | `browser.cdp` + agent 工具 | `browser.cdp`, `agent.tool.register`, `fs.write`(落盘全量) |

### P2（三项 + 一套纪律）

| # | 交付物 | 说明 |
|---|---|---|
| 9 | `local.shell-guard` | `tool_call` + `web-tree-sitter`（**必须用 powershell 语法**）；解析失败 fail-closed |
| 10 | `local.policy-gate` | IAM 风格策略；**项目级不得放宽用户级** |
| 12 | `local.cassette` | 首版只做「录制 + 差异报告」，不做完整回放 |
| 11 | **pi-plug 工程纪律四件套** | (a) `tests/check-docs.cjs` 文档-代码漂移 lint；(b) `shared/live-state` 六态降级约定；(c) 改名迁移规范（四个位置）；(d) `tests/extension-graph.cjs` 依赖禁用矩阵测试 |

### §3.3(c) 的横切建议

**`Instructions.diffByKey` 的增量渲染应当立刻被采纳**，不必等新插件：`local.memory-governed`、`local.doc-index`、`local.task-center` 三个现有插件凡有「每轮重述动态清单」的地方，都应改为「只重述 added/changed/removed，无差异时才重述全表并声明取代前表」。建议提炼为 `pi-plug/shared/instructions-diff.cjs` 供全线复用。这是本次分析里**成本最低、收益最快**的一条。

---

## 5. 不建议移植的（避免重复劳动）

| 能力 | 为什么不建议 |
|---|---|
| 代码模式本体 | 官方已有 `pi.workflow`；只借 §3.12 的两点（渐进披露 + 输出体积配额） |
| shadow-git 快照与回滚 | 宿主 `crates/host-core/src/review.rs`（672 行）+ ADR 0043 已覆盖消息级审阅快照与回滚。opencode 的增量只是「按路径选择性恢复」与「树间结构化 diff」两个粒度，应向宿主提，不该插件重造 |
| 越界写入守卫（新插件） | 官方已有 `pi.workspace-file-guard`（四个工具：`project_root`/`check_path`/`temp_env`/`tmp_layout`）。opencode 的 `external_directory` 值得吸收的是**从「分类建议」升级为「运行时阻断」**，以及「放行的外部目录继承工作区默认权限，因此要显式补 deny 才能只读」这条细节——建议作为该插件的升级方向 |
| 会话导入导出 | `io.github.muzimu217.session-import` v0.5.0（8 源，权限含 `session.import`/`project.create`/`agent.complete`）已覆盖且强于 `opencode export/import` |
| token / 成本统计 | `local.token-meter` v0.4.1 + `pi.token-insights` + `usage-dashboard` 已饱和；`opencode stats` 的增量是价格表，前序分析已判定维护成本过高 |
| 主题 | `local.obsidian-theme` v3.0.0 + `pi.parchment`；且 opencode 的是终端主题，不同域 |
| mermaid / LaTeX 渲染 | `merman`/`latex` 都是终端渲染（deps `@opentui/core` + `string-width`）；PI-Desktop 是 GUI，`session-ui` 已依赖 `mermaid` |
| 符号级依赖查询 | `pi.ts-toolkit` 已有（`arch_check` + `dep_refs`）。#1 的 LSP 会超越它，但应共存而非替换（LSP 需要用户装 server，`dep_refs` 零依赖） |
| 技能来源锁定 | `pi.skill-lock` 已有。可借 `packages/plugins/figma` 的 `skills-source.json` + `sync-skills.ts` + `NOTICE.md` 补上「上游同步」与「出处声明」两步 |
| 架构治理 | `pi.ts-toolkit` 的 `architecture-policy.yaml`；opencode 的 `AGENTS.md:1-2` 依赖方向纪律可作为一条示例策略 |
| 定时任务 / 项目信任 / 会话搜索 / fork / 技能市场 | 宿主已有（见前序四份分析，本次未复核，因版本仍为 0.15.1-beta.7） |
| CI 容器 / GitHub-GitLab CI 集成 / 公开 stats 站点 | 与 opencode 自己的基础设施强绑定，形态不同域 |
| Figma 技能包内容 | Figma 专用；只借分发机制 |
| `@opencode/ai` 多模态层 | 宿主有 `pi-ai`；只借「事件流形状跨 provider 统一」的设计目标 |

---

## 6. 插件做不了、必须向宿主提的（C 级）

| # | 需求 | 为什么插件做不到 | 参照 |
|---|---|---|---|
| 1 | **LSP 作为宿主一等公民**：编辑后自动请求 diagnostics 并回流给模型 | 插件只能做「工具形态」的 LSP（模型主动查）。「改完就自动告诉模型有哪些新诊断」需要宿主在 Edit 管线里主动触发并注入 | opencode 有 `lsp.client.diagnostics` 与 `lsp.updated` 两个插件事件（`plugins.mdx`）；PI-Desktop 广播的 6 个事件里没有 `file.edited`（§2.5） |
| 2 | **资源级审批持久化**：`ask` 的 `always` 由工具提议模式，按项目记住 | PI-Desktop 的授权是**安装期按能力权限**授予，没有「按资源模式记住」这一层；插件无权修改宿主的审批 UI 与决定存储 | `core/src/permission/saved.ts`（`AddInput{projectID, action, resources[]}` + `ConflictError`）；`permissions.mdx`「The set of patterns that `always` would approve is **provided by the tool**」 |
| 3 | **ACP server**：把 PI-Desktop 会话暴露给 Zed / JetBrains / nvim | 需要宿主把会话生命周期与消息流映射到 ACP 的 JSON-RPC 接口 | `acp.mdx`；`packages/cli` deps `@agentclientprotocol/sdk` |
| 4 | **「deny 即不广告」原生化** | 目前只能靠 `agent.extension` 的 `setActiveTools` 在运行期改工具集，属绕行；应在宿主配置层支持按 agent 的工具白名单 | `agents.mdx` Task permissions；`.opencode/agent/triage.md` 的 `tools: {"*": false, "github-triage": true}` |
| 5 | **provider 策略层** | `setModel` 仅 idle 可用，无法在请求中途改；干净的实现需宿主在 provider 解析处支持策略 | `policies.mdx`；`specs/v2/provider-policy.md`（16,510 B，本文未展开） |
| 6 | **`file.edited` 事件** | #3（格式化）目前只能在 `tool_result` 里做，覆盖不到「用户自己改了文件」与「子代理改了文件」两种情况 | opencode 的 `file.edited` + `file.watcher.updated`（deps `@parcel/watcher`） |
| 7 | **技能曝光的宿主级开关** | #4 靠改系统提示实现，属侵入式；应由宿主在技能清单渲染处支持 `autoinvoke: false` 语义 | `skills.mdx` 的 `metadata["opencode/autoinvoke"]` 与 `permission.skill` |

---

## 7. 实施路线图

**第一期（验证 `agent.extension` 这条路）**
1. `local.loop-brake`（#2）——最小可行，跑通 `tool_call` 阻断与 reason 回传
2. 提炼 `pi-plug/shared/instructions-diff.cjs`（§3.3(c)），先在 `local.task-center` 上验证
3. `pi-plug/tests/check-docs.cjs`（#11a）——顺手把本文与前四份分析文档的行号引用锚定住

**第二期（代码智能与上下文预算）**
4. `local.format-on-edit`（#3）——**先解决锚点回传，再谈格式化**
5. `local.code-intel`（#1）——走路 B（stdio MCP server），首版只探测不安装
6. `local.nested-memory`（#6）+ `local.skill-budget`（#4）

**第三期（外部知识与治理）**
7. `local.ref-source`（#5）+ `local.agent-presets`（#7，含 `scout` 式只读预设）
8. `local.opencode-skill-pack`（#13）——可与第一期并行，因为零新增权限
9. `local.browser-audit`（#8）、`local.shell-guard`（#9）、`local.policy-gate`（#10）
10. #11 的 (b)(c)(d) 三条纪律固化进 pi-plug 的开发流程

**⚠️ 8 个 extension 模块的硬上限**（`packages/plugin-sdk/src/index.ts:1243`）：本文 13 个建议项里，#1 走 MCP（不用 extension），#5/#8/#13 走 A 级权限（`agent.prompt.inject`/`agent.tool.register`/`browser.cdp`），其余 **#2、#3、#4、#6、#7、#9、#10 共 7 项都需要 `agent.extension`**。若各自独立成插件则不撞顶（上限是**每插件** 8 个）；但若为了减少权限授予而合并成一个「治理扩展」插件，7 个模块就只剩 1 个余量。**合并 vs 拆分的取舍**：合并省用户的权限确认次数、共享 extension 生命周期管理；拆分的隔离性好（一个崩了不影响其他）、可独立上架、且不撞模块上限。倾向**拆分**——`16-trusted-extensions.md:36` 已明确 extension 是受信代码，隔离边界比便利性更重要，7/8 的占用率也没给未来留余地。

---

## 8. 风险与边界

### 8.1 `agent.extension` 是受信代码

`docs/spec/07-plugins/16-trusted-extensions.md:36`：「An agent extension is trusted code. It executes inside the Agent sidecar」——**插件沙箱不覆盖它**，授予 `agent.extension` 等于授予 agent 自身的能力。另两条约束：每插件最多 8 个模块（`index.ts:1243`）；manifest 声明了但无权限则**跳过并审计**（`plugin.agentExtensions.skipped`）；**市场分发在 v1.1 未开放**，只接受本地导入与开发插件。

→ 本文 6 个 `agent.extension` 方案**全部只能本地/开发安装，无法上架市场**。这是必须向用户说清的前提，不能包装成「装个插件就好」。

### 8.2 结果型事件的 30 秒超时

`tool_call`/`tool_result`/`context`/`before_agent_start`/`session_before_compact` 都是结果型事件，超时即放弃并继续（前序分析引 `16-trusted-extensions.md:266-268`）。#3（格式化）与 #6（就近 AGENTS.md 查找，可能要向上走很多级 + 读多个文件）都必须自带更短超时并**优雅降级**：格式化超时就跳过并在结果里说明；AGENTS.md 查找超时就本轮不注入。

### 8.3 格式化会破坏 Edit 锚点（#3 的头号风险）

PI-Desktop 的 `Edit` 工具要求「4 uppercase hex from the latest Read, Grep, Write, or Edit for this path」，且「Re-ground on the tag returned by every successful write」。格式化改写了文件 → 旧 tag 失效 → 模型下一次 Edit 会 `EDIT_PARSE_FAILED` 或改错行。

**必须在 `tool_result` 替换的内容里显式回传**：新 tag、新的总行数、以及「文件已被格式化，行号可能整体位移」的警告。opencode 不存在这个问题（它的 `edit` 用精确字符串替换，formatter 在工具内部同步跑完才返回结果）——**这是移植时必须自己补的一环，照搬会出事故**。

### 8.4 不可信外部内容（#5）

`local.ref-source` 会把**任意公开 Git 仓库**的内容注入上下文，这是提示注入的直接入口。必须：① 注入时标注来源与「不可信」性质；② 沿用 `local.doc-index/doc-index-policy` 已有的不可信数据处理约定；③ **严格只读**（与 opencode「Normal tool permissions still apply」一致）；④ clone 有仓库大小与缓存总量上限；⑤ 记录每个引用源的 commit SHA，让「当时读的是哪个版本」可追溯（可复用 `pi.skill-lock` 的哈希思路）。

### 8.5 循环闸的误判（#2）

指纹规范化不当会两类误判：**漏判**（参数里含时间戳/绝对路径/随机顺序的键，每次指纹都不同）与**误杀**（合法的重复调用，例如轮询等待某个进程结束、分页读取、重试一个刚被限流的请求）。缓解：① 规范化要排序键、剥离已知易变字段；② 维护一个「允许重复」的工具/参数模式白名单；③ 首次触发时**只警告不阻断**，第二次才阻断（可配）；④ 每次阻断写审计行（宿主 `:281` 已保证 extension 执行留审计）。

### 8.6 Windows / PowerShell 特异性（#1、#3、#9）

本工作区 shell 是 PowerShell 7（`Bash` 只是协议名）。
- #9 必须用 `tree-sitter-powershell`，用 bash 语法解析 PowerShell 会全线失败；且解析失败必须 **fail-closed**
- #1 的 LSP server 可执行名解析、路径分隔符、`~` 展开都要按 Windows 规则；opencode 专门有 `windows-wsl.mdx` 说明 WSL 场景，若用户项目在 WSL 里，LSP server 必须在 WSL 侧启动——首版建议**明确不支持 WSL 路径**并给出清晰错误，而不是静默失败
- #3 的 formatter 命令在 Windows 上多为 `.cmd`/`.ps1` 包装，`exec` 时需注意（opencode 的 `cli` deps 里有 `cross-spawn`，`util` 包也依赖它，正是为解决这类问题）

### 8.7 与现有插件的重叠检查（已在 §2.6 / §5 完成）

两侧 43 个插件条目（pi-plug 12 + 官方 31，含 2 个重复 id）已盘点。本文 13 个建议项与现有插件的重叠只有四处，且都是「互补/升级」而非「重复」：
- #1 vs `pi.ts-toolkit`：LSP 是编译器级语义，`dep_refs` 是文本级符号匹配，共存
- #5 vs `pi.workspace-file-guard`：一个「显式允许读进来」，一个「阻止写出去」，互补
- #6 vs `local.memory-governed` / `project-init`：路径作用域纯文本约定 vs 证据绑定 KV 记忆 vs 根级初始化，三者分工明确
- #2 vs `loop-guard` 技能：实时拦截 vs 事后诊断，互补

### 8.8 本文的证据边界（诚实说明）

- **未展开的 opencode 部分**：`specs/v2/` 六篇设计文档（`catalog-config-plugin-lifecycle.md` 11,111 B、`event-stream-architecture.md` 10,233 B、`provider-policy.md` 16,510 B、`session.md` 15,305 B、`tools.md` 10,423 B、`README.md` 3,398 B）**只列了清单未读内容**；`V2_HTTP_API_AUDIT.md`（25,013 B）、`STATS.md`（18,510 B）、`CHANGELOG.md`（46,095 B）未读；`packages/app`（162,666 行）、`packages/tui`（104,396 行）、`packages/console`、`packages/desktop` 的内部实现未深入；`.opencode/skills/` 八个技能（合计 ~110 KB）只看了 `sample-skill`；`.opencode/command/changelog.md`（3,218 B）未读全文
- **未复核的部分**：宿主 ADR 只核实了 0043 与总数（308），其余沿用前序四份分析的记录（版本同为 0.15.1-beta.7，故判断为仍有效）；`16-trusted-extensions.md` 的 §6 事件全表未逐条重读，本文只引用了 `:212`/`:213`/`:251`/`:252`/`:257`/`:259`/`:261`/`:281`/`:283`/`:36` 十处已直接读到的行
- **一处更正**：前序 `DSH-SEP-...md` §2.1 记「权限枚举：44 项」，本次逐行核实为 **39 项**（`index.ts:1247-1291`）。前序文档引用的 `13-plugin-permissions-matrix.md:66` 与 ADR 0174 的 `session.read` 契约本次未复核
- **`pi.workflow` 的实际能力未读源码**：本文对它的判断（「已覆盖代码模式」）来自前序 ZCode 分析 §3.1 与官方 catalog 的存在性，未核对其当前实现是否已有输出体积配额。#12/§3.12 的建议以「若尚未有」为前提

---

## 附录 A：证据索引

### opencode 侧（相对 `E:\data\1021\opencode`）

| 主题 | 证据 |
|---|---|
| 版本与提交 | `package.json` version `2.1.2`；`git log -1` = `b42c31613f` (2026-10-22)；`git describe` = `github-v1.2.27-57-gb42c31613f` |
| 包规模 | 各 `packages/*/src` 源文件行数统计（见 §1.1 表） |
| 内建工具 | `packages/core/src/tool/`：`edit.ts`、`write.ts`、`read.ts`、`glob.ts`、`grep.ts`、`shell.ts`、`patch.ts`(+`patch.txt`)、`question.ts`、`skill.ts`、`subagent.ts`、`todo.ts`(+`todowrite.txt`)、`webfetch.ts`、`websearch.ts`、`mcp.ts`、`mcp-resource.ts`、`opencode.ts`、`file-diff.ts`、`html-markdown.ts`、`http-body.ts`、`read-filesystem.ts`、`runtime.ts`、`AGENTS.md` |
| 工具文档 | `packages/web/src/content/docs/tools.mdx`（lsp 实验开关与 9 操作、apply_patch 标记行、websearch 免密钥、question、`.ignore`） |
| 权限模型 | `docs/permissions.mdx`（13 权限键、allow/ask/deny、最后匹配者胜、`*`/`?`、`~`/`$HOME`、`external_directory`、`doom_loop`、`.env` 默认拒读、once/always/reject 且模式由工具提议、`--auto`、按 agent 覆盖） |
| 审批持久化 | `packages/core/src/permission/saved.ts`（`AddInput{projectID, action, resources[]}`、`UpdateInput`、`NotFoundError`、`ConflictError`）、`permission/sql.ts` |
| agent 体系 | `docs/agents.mdx`（primary: build/plan + hidden compaction/title/summary；subagent: general/explore/scout；plan 的 `~/.opencode/plan/` 可写例外；Task permissions 的「deny 即从工具描述移除」；用户仍可经 `@` 补全直接调用） |
| 技能体系 | `docs/skills.mdx`（6 条发现路径含 `.claude/skills` 与 `.agents/skills`；向上走到 git worktree；frontmatter `name`/`description`/`license`/`compatibility`/`metadata`；`opencode/slash`、`opencode/autoinvoke`；名称正则 `^[a-z0-9]+(-[a-z0-9]+)*$` 1–64；description 1–1024；`<available_skills>` XML；`permission.skill` allow/deny/ask；`tools.skill:false` 整段省略）、`packages/core/src/skill/{discovery,instructions}.ts` |
| 命令体系 | `docs/commands.mdx`（`$ARGUMENTS`、`$1..$n`、`` !`cmd` ``、`@file`；`template`/`description`/`agent`/`subtask`/`model`；可覆盖内建；内建 `/init` `/undo` `/redo` `/help`）、`packages/core/src/session/command.ts` |
| 自定义工具 | `docs/custom-tools.mdx`（`.opencode/tools/`、`~/.config/opencode/tools/`；文件名即工具名；多导出 → `<filename>_<exportname>`；同名覆盖内建；`tool.schema` = Zod；context `{agent, sessionID, messageID, directory, worktree}`） |
| 插件 API | `docs/plugins.mdx`（本地与 npm 两种加载、`bun install` at startup、缓存 `~/.cache/opencode/node_modules`、加载顺序、ctx `{project, client, $, directory, worktree}`、27 个事件、`tool.execute.before/after`、`shell.env`、`experimental.session.compacting` 的 push context / replace prompt、`client.app.log`）、`packages/plugin/README.md`（4 入口 + 宿主运行时实例共享 + peerDependency 约束）、`packages/plugin/src/`（`effect/` 22 文件、`promise/` 22 文件、`tui/` 4 文件） |
| 引用源 | `docs/references.mdx`（字段表、git 物化与异步刷新、有 description 才广告、`@alias`、自动穿过 external-directory 边界但常规权限仍适用、alias 字符限制）、`packages/core/src/reference/instructions.ts`（`Instructions.diffByKey` 增量渲染）、`packages/core/src/reference.ts` |
| 策略 | `docs/policies.mdx`（effect/action/resource、`provider.use`、`*`/`?`、最后匹配者胜、**全局优先于项目**、取代 `disabled_providers`/`enabled_providers`）、`specs/v2/provider-policy.md`（未读） |
| LSP | `docs/lsp.mdx`（34 server 表 + 11 项 Auto-installs + 配置项 + PHP Intelephense 专节）、`docs/formatters.mdx`（26 formatter 表 + 配置项）、`packages/core/src/formatter/builtins.ts` |
| ACP | `docs/acp.mdx`（`opencode acp` 子进程 JSON-RPC over stdio；Zed/JetBrains/Avante.nvim/CodeCompanion.nvim；`/undo` `/redo` 不支持）、`packages/cli` deps `@agentclientprotocol/sdk` |
| 快照与回滚 | `packages/core/src/snapshot.ts:19,34,45-49,52,58,64-67,76,92`（216 行，capture/files/diff/restore，内容寻址，best-effort，`git.repo.discover`）、`packages/core/src/session/revert.ts`、`docs/config.mdx` Snapshot 节（内部 git 仓库、大仓可关） |
| 代码模式 | `packages/codemode/README.md`（纯解释器、只实现的语言特性、无网络/文件/进程、只经宿主工具、宿主限制执行时间/工具调用/输出体积/数据量、未完成工作被中断、REPL 式结果、`UnsupportedSyntax` 带源码位置、源自 Cloudflare Code Mode）、`interpreter-support.md`、`packages/codemode/src/{codemode,data,extension,namespace,tool,tools,tool-runtime,tool-schema,tool-error,index}.ts`、`packages/core/src/codemode/{catalog,instructions,tool,web}.ts` |
| 浏览器 | `packages/plugin-browser/README.md`（server/desktop 职责切分、8 类工具含 trace/cpu/heap/lighthouse、tabID 与 focus 约束） |
| 测试台 | `packages/http-recorder/README.md`（JSON cassettes、适用场景、Node 22+/Bun、不支持浏览器/worker/Deno）、`packages/simulation/src/`（13 文件清单）、`packages/server` deps `@opencode/simulation` |
| 桌面扩展体系 | `packages/gui-extensions/README.md`（`:3` doc lint、`:22-49` Anatomy 与清单字段、`:214-227` 10 个注册表、`:229-257` 宿主 API、`:299-314` `Live<T>` 六态与铁律、`:344-403` Store 与 `from` 迁移、`:404` 改名迁移四处、`:416-425` 运行时规则、`:429-436` 测试门与 `extension-graph.spec.ts`、`:442-723` pairing 完整示例、`:663-703` 内建 13 个、`:711` `IpcsProvided`）、`packages/gui-extensions/AGENTS.md`、`src/{browser,btw,context,debug,details,file,microsoft-office,pairing,review,sdk,ssh,terminal,updater,wsl}/` |
| 客户端生成纪律 | `packages/client/README.md`（从 Effect HttpApi 生成、generation-equivalence test 防传输漂移、`bun run generate` / `check:generated`、bundle-boundary tests） |
| 进程内宿主 | `packages/sdk/README.md`（内存执行 HTTP 路由、不开监听、`await using`、`Symbol.asyncDispose`） |
| 多模态层 | `packages/ai/README.md`（schema-first，provider-neutral `LLMEvent` 覆盖 OpenAI Chat/Responses、Anthropic Messages、Gemini、Bedrock Converse） |
| CLI | `docs/cli.mdx`（tui/attach/auth/github/mcp/models/run/serve/session/stats/export/import/web/acp/plugin/pr/db/debug/uninstall/upgrade）、`packages/cli` deps（`@agentclientprotocol/sdk`、`@opentunnel/client`、`@parcel/watcher`、`tree-sitter-bash`、`tree-sitter-powershell`、`web-tree-sitter`、`uqr`、`@silvia-odwyer/photon-node`、`@opencode-ai/pty`） |
| 自举资产 | `.opencode/agent/triage.md`、`.opencode/command/{rmslop,learn,commit,translate,issues,ai-deps,spellcheck,changelog}.md`、`.opencode/glossary/README.md` + 17 locale、`.opencode/skills/`(8 个)、`.opencode/tool/{github-triage,github-pr-search}.ts`、`.opencode/themes/mytheme.json`、`.opencode/opencode.jsonc` |
| 外部技能包分发 | `packages/plugins/figma/{skills-source.json, script/sync-skills.ts, skills/NOTICE.md}` |
| 引擎设计纪律 | `AGENTS.md:1-4`（依赖方向）、`:176-187`（Session Core：durable events 最小化、inbox 幂等领养、write-ahead execution claim 及其「非 exactly-once」声明、one step = one `llm.stream`、术语纪律） |
| 其他包 | `packages/{merman,latex}`（deps `@opentui/core` + `string-width` → 终端渲染）、`packages/stats/README.md`、`packages/containers/README.md`、`packages/theme`、`packages/session-ui`（deps `mermaid`、`@pierre/diffs`、`@pierre/highlights`）、`packages/protocol`、`packages/httpapi-codegen`、`packages/util`（deps `@opentelemetry/*`、`pacote`、`@npmcli/arborist`） |

### PI-Desktop 侧（相对 `E:\code\ai-platform-amd64\PI-Desktop`）

| 主题 | 证据 |
|---|---|
| 版本 | 根 `package.json` 与 `apps/desktop/package.json` 均为 `0.15.1-beta.7` |
| 权限枚举 39 项 | `packages/plugin-sdk/src/index.ts:1247-1291`（`PLUGIN_PERMISSIONS`）、`:1293`（`PluginPermission` 类型） |
| 上限 | `index.ts:1243`（`MAX_AGENT_EXTENSIONS_PER_PLUGIN = 8`）、`:1245`（`MAX_GLOBAL_SHORTCUTS_PER_PLUGIN = 8`） |
| MCP 贡献点 | `index.ts:516-528`（`PluginMcpServerContrib`，stdio 的 `command` 可为 plugin-relative executable、`env` 支持 `{setting}`）、`:530-535`（`PluginServiceContrib.autoRestart` 默认 true）、`:537-542`（`PluginBusContrib`）、`:544-558`（`PluginGlobalShortcutContrib`）、`:133`（`contributes.mcpServers`）、`:1820`（校验处） |
| 插件规范 | `docs/spec/07-plugins/`：`01-plugin-system.md` … `16-trusted-extensions.md` + `README.md`（共 17 篇） |
| 受信扩展支持矩阵 | `docs/spec/07-plugins/16-trusted-extensions.md:212`（Supported 全清单，含 `registerAgent`/`getAllTools`/`getActiveTools`/`setActiveTools`/`exec`/`getFlag`）、`:213`（Supported on context，含 `compact`/`getSystemPrompt`/`fork`/`newSession`/`getContextUsage`）、`:251`/`:252`/`:257`/`:258`/`:259`/`:261`（事件采纳）、`:36`（受信代码，运行于 Agent sidecar）、`:281`（每次执行写审计行）、`:283`（`exec` 带会话 cwd）、`:100`（资源仅复制不提升为可执行扩展）、`:387`（公开文档只承诺 Supported 两类） |
| 插件进程可达 Node 内建 | `docs/spec/07-plugins/04-plugin-security.md:509`；对比 `:306`（panel `sandbox: true` removes Node, not the network）、`:240`、`:336`、`:468` |
| 宿主广播事件 6 个 | `apps/desktop/electron/main/bootstrap/app-lifecycle.ts:616`（`appearance:changed`）、`ipc/session-ipc.ts:557` 与 `runtime/sidecar.ts:372`（`session:modelChanged`）、`services/plugin-services.ts:523`（`session:turnEnded`）、`index.ts:782,792`（`workspace:changed`）、`plugin-runtime.ts:1633`（`broadcastEvent` 定义） |
| LSP 空白 | 全库 `.ts`/`.rs` grep `languageServer\|\blsp\b\|LspServer` → 唯一命中 `packages/shared/src/mcp-catalog-builtin.ts:138`（第三方 MCP 描述文案） |
| formatter 空白 | 同上范围 grep `formatter\|formatDocument\|prettier\|biome` → 仅 `apps/desktop/electron/main/plugin-watcher.ts:5`、`apps/desktop/src/features/plugins/install-progress.ts:160`（均为注释） |
| 循环闸空白 | grep `doom_loop\|doomLoop\|repeatedToolCall\|identicalToolCall\|loopDetect` → **零匹配** |
| 越界目录权限空白 | grep `external_directory\|externalDirectory\|outsideWorkspace\|escapeWorkspace` → **零匹配** |
| 已有回滚能力 | `crates/host-core/src/review.rs`（**672 行**）、`docs/adr/0043-message-owned-review-snapshots-and-rollback.md` |
| ADR 总数 | `docs/adr/*.md` 共 **308** 篇（命名混用数字编号与语义名） |

### pi-plug 侧（相对 `E:\code\ai-platform-amd64\pi-plug`）

| 主题 | 证据 |
|---|---|
| 自建 12 插件 | 各目录 `manifest.json`（id/version/permissions/contributes 见 §2.6 表） |
| `agentExtensions` 使用数 = 0 | 12 个 manifest 的 `contributes` 键集合中无 `agentExtensions`；`permissions` 中无 `agent.extension` |
| 官方目录 31 插件 | `pi-desktop-plugins/catalog.json`、`pi-desktop-plugins/plugins/`（31 目录 + `shared`） |
| 前序分析 | `ZCode-...md`(50,131 B)、`Kimi-Code-...md`(35,186 B)、`DSH-SEP-...md`(41,130 B)、`pi-agent-desktop-...md`(13,843 B) |
| 交付与验证 | `交付说明.md`、`provider-balance-交付说明.md`、`插件验证指南.md`、`PI-Agent-学习与进阶指南.md` |
| 既有调研 | `dsh-plugins-调研/{P1-可借鉴清单.md, README.md, 游标台账-dsh-plugins.json, 原始数据-1000仓库.json}`（P1 清单 40 条，分甲/乙/丙/丁四类） |

---

---

---

## 附录 B：一句话总结

opencode 给 PI-Desktop 的最大增量不在「更多工具」，而在**三层闸门与一层预算**：
- **代码智能层**（34 LSP + 26 formatter）——宿主两侧皆为空白，且 `mcp.server.local` 与 `agent.extension.exec` 已给出落地通道；
- **运行时闸门层**（`doom_loop` 重复闸、资源级模式匹配、`external_directory`、`policies`）——宿主四处零匹配，`tool_call` 阻断已可用；
- **提示词预算层**（`opencode/autoinvoke` 技能曝光开关、`Instructions.diffByKey` 增量渲染、codemode 目录渐进披露）——PI-Desktop 已对**工具**做了渐进披露（`ToolSearch` + 「153 more」），却对**技能**全量广告（本会话 29 条，含 2 组逐字重复），这是最精准的一处空白；
- **工程纪律层**（gui-extensions 的文档-代码漂移 lint、`Live<T>` 六态降级契约、改名四迁移、依赖禁用矩阵测试）——不是插件，是 pi-plug 自己该抄的四条，成本最小、防腐收益最直接。

而这一切的前提是：**pi-plug 生态至今 0 个插件使用 `agent.extension`**，宿主最强的扩展点（可改系统提示、可替换工具结果、可带原因阻断、可注册 agent、可增删活跃工具集、可在会话 cwd 执行命令）完全未被开发。本文 P0 三项的首要价值，就是把这条路走通。

---

## 附录 C：施工期复核（实现阶段的证伪记录）

分析阶段留下的四项，在动手实现前逐条复核了宿主源码。**三项的原始判定需要下调，一项可以换角度做**：

| # | 原判定 | 复核证据 | 最终裁定 |
|---|---|---|---|
| 1 | ✅ 完全可行 | 全库 grep `goToDefinition|findReferences|documentSymbol|semanticSearch` → **零匹配**（宿主确实无 LSP） | **可行**，但需自带 stdio MCP server |
| 5 | ✅ 完全可行 | `workspace-roots.ts:59 workspaceRootsFor` 是「项目组多根（ADR 0249/0263）」，不是「外部只读知识源」 | **降级为 ⚠️ 部分**：多根已覆盖一半，剩下的「登记 + 版本可追溯」仍空白 |
| 7 | ✅ 完全可行 | `subagent-definitions.ts:48` `subagentDefinitionDir` 读 `~/.agents/subagents/*.md`；`:59` 还有 `BUILTIN_SUBAGENT_DOCUMENTS` | **降级为 ⚠️ 部分**：插件只多「随包分发预设」，价值 ★★☆☆☆ |
| 8 | ✅ 完全可行 | `browser-cdp.ts:10-36` 的 `BROWSER_CDP_ALLOWLIST` 只有 Page/DOM/Runtime/Input/Accessibility/Console 四组，**没有** `HeapProfiler.*`、`Performance.*`、`Network.*` | **原方案证伪**；只剩可访问性审计可行 |

### 这三处判定错误暴露的方法问题

分析阶段我对 #5/#7/#8 的判断都基于「插件有什么权限」（`browser.cdp`、`registerAgent`、`agent.tool.register`），却没有核实**权限背后的实际能力边界**：

- `browser.cdp` 名字看着像「直连 CDP」，实际是**白名单代理**（`isAllowedCdpMethod`，`browser-cdp.ts:65`）；
- `registerAgent` 看着像「自定义 agent」，但宿主已有一整套子代理定义加载；
- 「多根 workspace」看着像「外部引用源」，实际是项目组语义。

**教训**：判断可插件化时，「有权限」只是必要条件；必须再读一层**该权限背后的实现**，确认能力边界与语义是否与设想一致。仅凭权限名推断，会系统性地高估。

### 因此换角度实现

`browser.cdp` 白名单里 `Accessibility.getFullAXTree` / `getPartialAXTree` 是**可用的**，而宿主与现有插件都没有把这套能力交给模型。可访问性审计因此成为一个**被证实可行**的落点，已实现为 `local.a11y-audit`（详见该插件 README）。
