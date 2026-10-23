# Kimi-Code → PI-Desktop：可插件化增强的深度分析

> 调查对象：`E:\code\ai-platform-amd64\kimi-code`（MoonshotAI 的终端 AI 编码代理 Kimi Code CLI，pnpm monorepo，4405 文件 / 65 MB）
> 对比基准：`E:\code\ai-platform-amd64\PI-Desktop`（宿主，ADR 308 篇，desktop.control 48+ 受审操作）+ `pi-plug`（落点工作区：8 个本地插件 + 官方仓库克隆 27+ 插件）
> 前序分析：`ZCode-对PI-Desktop的插件化增强分析.md`（六项建议**已全部落地**，本文勿与其重复）、`交付说明.md`（mcode 产物）
> 结论日期：本次会话

---

## 0. 结论速览

kimi-code 与 ZCode 是**两种完全不同的研究对象**：ZCode 是「同物种竞品」（Electron 桌面工作台），其价值在功能移植；kimi-code 是**终端 CLI + 服务化引擎**（单二进制、TUI、headless server、ACP），其价值不在某个功能，而在**四条产品哲学**——

1. **配置即对话**：`/mcp-config`、`/update-config`、`/provider` 等不是表单向导，而是**内置 Skill 提示词**，让 agent 自己读写配置文件，宿主的文件写入权限弹窗就是确认门（`packages/agent-core-v2/src/features/skill/catalog/builtin/mcp-config.md` 全文 130 行，没有一行专用 GUI 代码）。
2. **Skill 即产品**：官方插件 `kimi-webbridge` **零运行时代码**——一份写得极好的 SKILL.md 教模型用 curl 驱动本地浏览器 daemon，就是一个完整插件。
3. **扩展即数据**：官方插件 `kimi-datasource` 把 25 个数据源包装成两个通用工具，API 文档**运行时拉取、不进提示词**，SKILL.md 只写「选源铁律」。
4. **事件即生态**：20 个生命周期 hook + wire.jsonl 事件流存储，配置/审计/通知全部挂在事件面上。

**最大的发现**：PI-Desktop 的插件生态已经把哲学 2（skill-pack、local.annotate 已实践「纯提示词插件」）和哲学 4（`session:turnEnded` + 常驻服务）走通了；哲学 1「配置即对话」是**真正的空白**——宿主的 MCP/技能/子代理/设置管理全在 GUI 里，agent 无法自助盘点与修改，而 `desktop.control` 的受审读操作（`mcp/list`、`skill/list`、`settings/get`、`providers/list`、`subagent/catalog`……）**已经开放了读这一半**，只缺写。这是一个用「技能 + 聚合工具」就能吃到 80% 价值、剩余 20% 向宿主提需求即可的机会。

### 可行性矩阵

| # | 能力 | kimi 出处 | 插件可行 | 价值 | 工作量 | 建议 |
|---|------|-----------|:---:|:---:|:---:|------|
| 1 | AI 原生配置助手（/mcp-config 模式） | 内置 skill + 权限门 | ✅ 完全（读）| ★★★★☆ | 小 | **P0 必做** |
| 2 | 会话导出器（/export-md / export-zip） | TUI 命令 | ✅ 完全 | ★★★☆☆ | 小 | **P1** |
| 3 | 宿主文档检索技能（/check-kimi-code-docs 模式） | 内置 skill | ✅ 完全 | ★★★☆☆ | 小 | **P1** |
| 4 | 数据源网关（kimi-datasource 范式） | official 插件 | ✅ 完全 | ★★★☆☆ | 中 | P2 |
| 5 | 模板化批量派发（AgentSwarm 移植） | 引擎工具 | ✅ 完全 | ★★★☆☆ | 中 | P2（可并入 pi.workflow） |
| 6 | ACP server（Zed/JetBrains 接入） | packages/acp-server | ❌ 宿主 | ★★★★★ | 大 | 向宿主提 |
| 7 | Bash 危险命令参数级解析 | tree-sitter-bash | ❌ 宿主 | ★★★★☆ | 中 | 向宿主提（包可直接复用） |
| 8 | 视频输入管线 | TUI 媒体管线 | ⚠️ 宿主 | ★★★☆☆ | 大 | 向宿主提 |
| 9 | prompt 撤回 /undo | wire journal | ❌ 宿主 | ★★☆☆☆ | 小 | 向宿主提 |
| 10 | deferred 工具按需加载 | mcp.md 实验 | — 已有 | — | — | 宿主已有 ToolSearch |
| 11 | cron 定时任务 | CronCreate 工具 | — 已有 | — | — | 宿主已有 scheduled/* |
| 12 | 多 agent git 分支协作（Tower） | 实验特性 | ⚠️ 近似 | ★★☆☆☆ | 大 | pi.workflow 可近似，不立项 |
| 13 | 外部 hook 脚本生态 | 20 事件 | ⚠️ 低值 | ★☆☆☆☆ | 中 | 不建议（插件已是内联代码） |

---

## 1. kimi-code 的四条产品哲学（证据解剖）

### 1.1 配置即对话：/mcp-config 是一份 skill，不是一个功能（★★★★★，最有价值）

`docs/zh/customization/plugins.md` 和 `mcp.md` 会让你以为 MCP 配置有个向导。实际源码里**没有一行专用配置 GUI**——`/mcp-config` 是 `packages/agent-core-v2/src/features/skill/catalog/builtin/mcp-config.md` 这份 130 行的提示词，它教 agent：

1. 推断目标作用域（用户级 `$KIMI_CODE_HOME/mcp.json` / 仓库根 `.mcp.json`（Claude 兼容）/ 项目本地），**先读目标文件再播报将写入的路径与条目**；
2. 用普通 Read/Edit/Write 工具改 JSON——skill 原文明确写着 *"the Edit/Write permission prompt is the real gate"*（编辑弹窗就是确认门，skill 只负责透明性）；
3. 保留无关条目、告知 `/new` 后生效。

认证同样对话化：server 处于 `needs-auth` 时宿主自动暴露 `mcp__<server>__authenticate` 工具，agent 调它打印授权 URL、阻塞等回调（PKCE），`/mcp-config login <server>` 就是这条链。

**同族命令**（全是 skill 而非代码）：`/update-config`（改 config.toml）、`/custom-theme`（AI 生成主题并过 theme-schema 校验）、`/provider`、`/init`（生成 AGENTS.md）、`/import-from-cc-codex`（从 Claude Code/Codex 迁移 instructions/skills/MCP）。

**对 PI-Desktop 的意义**：PI-Desktop 的配置真值源在 host-core SQLite（`crates/host-core/src/mcp_servers.rs`），**没有用户可编辑的 JSON**，所以 kimi 的「agent 直接改文件」不能照搬；但哲学可以搬——先读后写、播报即确认、配置对话化。可行路径见 §3 P0。

### 1.2 Skill 即产品：webbridge 的零代码插件（★★★★☆）

`plugins/official/kimi-webbridge/kimi.plugin.json` 全部贡献：`{ "skills": "./skills/" }`。没有 mcpServers、没有 hooks、没有可执行文件。`skills/kimi-webbridge/SKILL.md`（180 行）教模型用 Bash+curl 操作本地 daemon（127.0.0.1:10086）的 14 个 action：navigate/click/fill/snapshot（@e 无障碍树引用）/screenshot/evaluate/cdp……正文里全是工程化指令：

- 一个任务 = 一个 tab group（session 概念）；
- Windows PowerShell 中文乱码必须走临时文件 POST；
- daemon 起不来时**让模型自己跑 start 命令**（错误恢复进提示词）；
- 配套 `references/operations.md` 做分层渐进披露。

**对 PI-Desktop 的意义**：`local.annotate`（教 agent 用内置 Browser 工具注入 Shadow DOM 徽章）已经在用这个范式，证明 PI-Desktop 侧成立。kimi 提供的增量经验是**工程细节密度**：平台坑位、错误恢复、分层参考都应该写进 SKILL.md，而不是只写 happy path。

### 1.3 扩展即数据：kimi-datasource 的网关模式（★★★★☆）

`plugins/official/kimi-datasource/`（v3.4.0）：

- **manifest**：只声明 1 个 stdio MCP server（`node ./bin/kimi-datasource.mjs`）+ 根目录 SKILL.md；
- **bin 是零依赖自包含网关**（564 行单文件，"can run from a zipped marketplace install"）：不实现任何数据后端，只把 `get_data_source_desc` / `call_data_source_tool` 两个工具转发到 `${KIMI_CODE_BASE_URL}/tools`，认证直接复用宿主的 OAuth 凭据文件（401 重读重试一次）；返回的 `files[]` 只允许写到调用方指定路径或其同目录同扩展名变体；
- **文档不进 skill**：SKILL.md 明确 *"故意不抄 API 名和参数表"*——每次现场拉最新 API 文档，把易变 schema 推到运行时，提示词只写「选源原则/能力边界/铁律」（股票代码必须核对、企业必须全称、一次只查一个源）；
- **插件目录即用户数据**：`${KIMI_SKILL_DIR}/watchlist.json` 是模型可读写的自选股清单。

**对 PI-Desktop 的意义**：PI-Desktop 插件不走 MCP（registerTool 直接注册），所以「网关」形态简化为：**两个工具（get_docs + call_api）+ net.fetch 白名单 + 一份只写铁律的技能**。PI-Desktop 没有任何同类插件——现有数据类插件（usage-dashboard、token-insights）消费的是本地 usage，不是外部数据生态。

### 1.4 事件即生态：20 个 hook + wire 事件流（★★★☆☆，对宿主参考价值为主）

`packages/agent-core-v2/src/features/externalHooks/`：20 个事件（`internal/types.ts:3-24`），可阻断的仅 `PreToolUse`/`UserPromptSubmit`/`Stop`，其余观察型——`PermissionRequest/Result`、`UserPromptQueued`、`TurnStarted`、`SessionHeartbeat`（60s）、`SubagentStart/Stop`、`Pre/PostCompact`、`Notification`……契约极简：payload JSON 进 stdin，exit 2 = 阻断（stderr 是原因），stdout JSON = 结构化决策，其余一切失败 **fail-open**——官方明确"hooks 是提醒与轻量拦截，不是唯一安全防线"（`docs/zh/customization/hooks.md:22`）。

会话存储本身也是事件流：`$KIMI_CODE_HOME/sessions/<workDirKey>/<id>/agents/main/wire.jsonl`，恢复 = `SessionReplayRenderer.hydrateFromReplay` 重放渲染，`kimi vis` 是它的浏览器可视化。

**对 PI-Desktop 的意义**：PI-Desktop 插件**本身**就是「hook 的超集」（能注册代码而非脚本），所以「外部脚本 hook」插件价值低；但 20 事件清单是给宿主 `pi.events` 扩面的一张现成对照表——尤其 `PermissionRequest/Result`（工具审批流外挂审计）和 `SubagentStart/Stop`（子代理生命周期）当前宿主未广播。PI-Desktop 的 jsonl 会话文件与 wire.jsonl 同构，`local.trajectory` 已证明可直接消费。

### 1.5 值得记录的其他点

- **AgentSwarm**：模板 `{{item}}` + items 数组（≥2、上限 128）批量派发同型任务，渐进并发（先 5、每 700ms +1），配 `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` 限流与聚合报告；`/swarm on|off|<task>` 一次性模式。宿主 Task 工具已支持同消息多 Task 并行，但缺模板/并发梯度/聚合格式原语。
- **deferred MCP 工具**：server 标 `deferred: true` 后工具不进顶层列表，模型先见清单、用 `select_tools` 按需加载——**宿主已有等价物**（ToolSearch 按需激活 on-demand tools），此路已通。
- **kimi-file:// 附件协议**：媒体（图片/视频）粘贴 → staging 上传 → 稳定 URI 引用（fork 后仍有效）→ `video_in` 能力位门控 → 20MB 预算 LRU 淘汰。这是**宿主级消息管线设计**，见 §6。
- **pi-tui 与 PI-Desktop 同源**：`packages/pi-tui/LICENSE:3` 写着 `Copyright (c) 2025 Mario Zechner`——这是 pi 生态（pi-mono）的终端库被 vendored 进 kimi。**PI-Desktop 不需要「从 kimi 借鉴它」**，kimi 是下游使用者；其差分渲染/CJK IME 硬件光标标记技巧，若 PI-Desktop 内嵌终端（pi.terminal）有闪烁/输入法问题，应回上游 pi-mono 对照。
- **权限规则的参数级 pattern**：`config.toml` `[[permission.rules]]` 支持 `Bash(rm -rf*)`、`mcp__github__*` 通配——比 PI-Desktop 现有「权限模式三档」更细一层，见 §6 向宿主提。
- **kosong 的 deferred 标记**：message-level tools 不进顶层 `tools[]`，顶层字节稳定 → **prompt cache 不失效**；`onToolCall` 刻意延迟到流结束（并行工具调用的参数 delta 会交错）。这是给 PI-Desktop provider 层的两个小而关键的优化点。
- **hooks 之外的完整性设计**：manifest 路径 realpath 防逃逸（`manifest.ts:194-201`）、插件指令注入带降权声明（*"not a privileged instruction channel… system instructions win"*，`profile-shared.ts:134`）、安装 staging + 原子 rename + 回滚、semver 比较提示而非自动更新。PI-Desktop 插件体系在这些点上已等价或更强（39 权限 + security_audit + 出网白名单），无需照搬。

---

## 2. 基线核对：哪些已经覆盖（勿重复造）

| kimi 能力 | PI-Desktop 现状 | 结论 |
|---|---|---|
| 工作流编排（脚本式） | `pi.workflow` v0.1.0（ZCode 分析 P0，已上架） | ✅ 已落地 |
| 产物看板 | `pi.artifact-board` v0.1.0 | ✅ 已落地 |
| 架构治理 / 符号级依赖查询 | `pi.ts-toolkit` | ✅ 已落地 |
| 状态空间枚举 | `pi.state-forge` | ✅ 已落地 |
| Skill 来源锁定 | `pi.skill-lock` | ✅ 已落地 |
| 会话导入 + 蒸馏 | `io.github.muzimu217.session-import`（含 Claude Code/Codex 等 8 源 + 项目约定蒸馏，覆盖 kimi `/import-from-cc-codex` 的语义） | ✅ 已落地 |
| 任务清单 | `local.task-center`（todo_write/read） | ✅ 已落地 |
| Token 用量 | `pi.token-insights` + `local.token-meter` | ✅ 已落地 |
| 会话轨迹回放 | `local.trajectory`（jsonl → 时间线） | ✅ 已落地 |
| 定时任务（Cron） | 宿主 scheduled/*（系统级，比 kimi 会话级更早） | ✅ 宿主已有 |
| 按需工具加载（deferred MCP） | 宿主 ToolSearch | ✅ 宿主已有 |
| MCP OAuth 2.1 | ADR 0283（RFC 9728/8414/7591/8707 全套） | ✅ 宿主已有 |
| 远程控制 / Web UI | 宿主自建路线：ADR 0284 headless（pi-host）+ 0285 RACP-WS + 0286 remote-host kernel + 0292/0293 SSH bootstrap；kimi 的公网 relay（`code-rc.kimi.com`）是**另一条路线**（厂商中继 vs 自有 SSH），宿主明确「桌面不开网络监听器」（ADR 0286 security §7），方向已定 | ✅ 宿主在做（路线不同，插件勿碰） |
| 会话内容搜索 | 宿主 `session-content-search` ADR + `fs/index` 操作 | ✅ 宿主已有 |
| turn 队列 / steer 注入 | 宿主 ADR 0265 + `active-turn-steering` | ✅ 宿主已有 |
| 可恢复子代理委派 | 宿主 ADR 0279（resumable subagent delegations）、0270（内置子代理可关）、0258（trusted-extension 自定义 agent） | ✅ 宿主已有 |
| 自定义 subagent（markdown 定义） | 宿主 `user_subagents`（crates/host-core/src）+ `subagent/list/read/catalog` 操作 | ✅ 宿主已有（甚至暴露给了 desktop.control 读） |
| 终端通知 | `pi.ui.showNativeNotification()` | ✅ 已有 |
| Plan/Goal 模式 | 宿主 Plan checkpoint（ADR 0211）+ `pi.goal-x` | ✅ 已有 |
| /init 生成 AGENTS.md | mcode-skill-pack 的 `project-init` 技能 | ✅ 已有 |

**净空白**（本文的机会）：①配置即对话（§3.1）；②会话导出（§3.2）；③宿主文档检索（§3.3）；④外部数据源网关（§3.4）；⑤模板化批量派发（§3.5）。宿主写操作缺失（§6 向宿主提）：ACP、危险命令解析、视频附件、prompt 撤回。

---

## 3. P0/P1：三个小而确定的插件

### 3.1 `pi.config-butler` — AI 原生配置助手（P0）

**它是什么。** 一个技能 + 一个聚合工具，把 PI-Desktop 的「设置 → 技能 → 子代理 → MCP → 插件 → provider」盘点与诊断变成对话。用户说「帮我看看为什么 X 工具用不了 / 我该配哪些技能 / 这个 MCP server 状态对吗」，agent 自助查证而不是让用户去点 GUI。

**为什么可行（宿主已开放读的一半）。** `desktop.control` 操作目录（`apps/desktop/electron/main/mcp-control.ts:192-267`，48 个受审 spec）已经包含：

| 操作 | 说明 | 对 kimi 斜杠命令 |
|---|---|---|
| `mcp/list` | 列出用户 MCP server | `/mcp` |
| `skill/list` + `skill/read` | 用户技能目录与正文 | `/help` 技能段 |
| `subagent/list` + `subagent/catalog` + `subagent/read` | 子代理目录（含 effective catalog） | `/agents` |
| `plugin/list` + `plugin/settings/get` + `plugin/views` + `plugin/themes` + `plugin/services` | 插件生态自省 | `/plugins list` |
| `settings/get` | 应用设置 | `/settings` |
| `providers/list` + `providers/oauth/vendors` | provider 与账号（无明文密钥） | `/provider` |
| `market/search` | 插件市场搜索 | `/plugins marketplace` |
| `composer/commands` | 会话可用的命令与技能 | 斜杠命令补全 |
| `agent/instructions/get` + **`agent/instructions/save`**（dangerous） | 全局/项目 AGENTS.md 读写 | `/init` + 直接编辑 |

**形态。**
- 工具 `plugin_..._config_inventory`（`agent.tool.register` + `desktop.control`）：一次聚合调用上述 read 操作，返回统一快照（比 agent 逐个调 8 次 RPC 省上下文、省审批）。**白名单自约束**：工具内部只允许调用 read 级 spec，绝不代理 `session/configure`、`plans/resolve`、`session/delete` 等 dangerous 操作。
- 技能 `config-audit`（`agent.prompt.inject`）：诊断方法论——MCP server 状态核对、技能冗余检测（引用 skill-lock 的哈希账本交叉）、子代理 model fallback 检查、插件权限膨胀审查；对**可写项**（AGENTS.md，走 `agent/instructions/save` 受审门）直接对话式修改；对**不可写项**输出「精确到设置页路径的操作指引」。
- 视图（可选）：配置体检报告页（`ui.view`），复用 token-meter 的 settings 通道范式，零文件副作用。

**诚实标注（与 kimi 的差异）。** kimi 的 agent 能直接 Edit mcp.json（文件即真值源，权限弹窗即确认门）；PI-Desktop 真值源在 host-core SQLite，写操作未暴露——所以本插件先覆盖「盘点 + 诊断 + 指引 + AGENTS.md 写」四件事，MCP/技能/子代理的**写**要等宿主把内部已有的 CRUD IPC（ADR 0283 的 mcp.oauth/start、mcp.transfer 证明能力存在）暴露进 `desktop.control` 的 dangerous 目录。这条宿主需求见 §6.1。

**权限。** `agent.tool.register` + `agent.prompt.inject` + `desktop.control`（高风险，安装时说明「只读白名单」）+ 可选 `ui.view`。

### 3.2 `pi.session-export` — 会话导出器（P1）

**它是什么。** kimi 的 `/export-md`（人类可读 Markdown）+ `/export-debug-zip` 的移植：把一次 PI-Desktop 会话导出为**可分享的静态产物**——Markdown / 带 Mermaid 的 HTML / 调试 JSON，附统计（token、工具调用计数、子代理树、时长）。

**为什么可行。** `desktop.control` 有 `session/get`（读会话与 transcript）；写侧 `fs.write`（scope 收窄到用户选定输出目录）或 `clipboard.writeText`。`local.trajectory` 已证明 jsonl 可解析，本插件是它的「产物化」出口。

**为什么是空白。** `desktop.control` 48 操作里没有 export；27+ 官方插件与 8 个本地插件均无导出类；宿主 ADR 的 project-archive（0294）是归档管理不是分享导出。与 `session-import` 互逆后，PI-Desktop 的会话就有进有出（import 进来 → 蒸馏 → export 出去归档/贴 issue）。

**形态。** 工具 `export_session(session_id, format: md|html|json, output_dir)` + 视图按钮。风险标注：导出内容含用户代码与路径，技能里写明「导出即出域」提示。

### 3.3 `pi.host-docs` — 宿主文档检索技能（P1）

**它是什么。** kimi `/check-kimi-code-docs` 模式：教 agent 在回答「插件能不能 X / 宿主为什么这样设计 / 怎么配 provider」之前，先检索 PI-Desktop 的 docs（308 篇 ADR + spec）自查，而不是凭训练数据猜。

**为什么可行。** 两种形态：a) 用户装了 PI-Desktop 源码（本机场景成立）——技能指引用 Grep 检索 `E:\...\PI-Desktop\docs\adr`；b) 通用形态——插件捆绑一份 ADR 标题索引（308 行文本，几十 KB）+ 按 id 拉正文的说明，`registerTool adr_lookup(id|keyword)`。50MB 预算绰绰有余（pi.ts-toolkit 已示范捆绑 typescript ~20MB）。

**为什么有价值。** 本会话的亲身经历就是证据：回答「插件能否被外部进程连接」必须读 ADR 0286 的 security §7；「插件 agent 在 headless 可用吗」在 ADR 0284 第 66 行写死。宿主决策散在 308 篇 ADR 里，agent 不检索就会答错。这也是 config-butler 的底座（诊断要按 ADR 说话）。

---

## 4. P2：两个中等工作量的增量

### 4.1 `pi.datasource-gateway` — 数据源网关（kimi-datasource 范式）

照搬三件套：①工具 `get_source_docs(source, topic)`（运行时拉 API 文档，net.fetch，不进提示词）；②工具 `call_source(source, api, params)`；③技能只写「选源铁律」。初始源选**公开无鉴权**的：Wikipedia、MDN、arXiv、GitHub REST、Hacker News；后续支持用户自带 key 的源（key 存插件设置，不落盘明文进 transcript）。net 域白名单逐源申报，杜绝 SSRF 面。与宿主 web search（ADR 0297，provider 托管适配器）互补：一个是结构化 API、一个是网页搜索。

### 4.2 `pi.swarm` — 模板化批量派发（AgentSwarm 移植）

**建议先做成 pi.workflow 的官方技能模板**（零成本验证）：skill 指导模型在脚本里用 `for` + `Promise.all` + 并发梯度实现批量扇出与聚合报告；真正需要「免脚本一键扇出」时再升级为独立工具 `swarm_run(template, items, {maxConcurrent, ramp})`（内部走 desktop.control session/create + agent/prompt + `session:turnEnded` 事件驱动，并发梯度默认 5 → +1/700ms，上限照搬 kimi 的 128）。**注意与现有生态的边界**：SessionTask（pi.session-orchestrator）是命令式单任务，pi.workflow 是程序编排，swarm 补的是「声明式批量」——README 必须写清三者的选择规则（单任务→SessionTask；复杂流程→workflow 脚本；同型批量→swarm）。

---

## 5. 架构层借鉴（宿主/引擎级，插件做不了，但值得记录）

这些不进插件清单，但作为 agent 团队与宿主的共同参考：

- **transcript L1-L4 数据层**（`packages/transcript/src`）：L1 按 agent 粒度分桶（main/sub/independent + parent，roster 事件画子代理树）；L2 一切变更为幂等 op 流（`appendAtOffset`，断线重放/多端同步天然成立）；L3 per-agent 四档订阅（off/turn/block/delta——手机端订 turn 档省带宽，桌面订 delta 档）；L4 框架无关 ViewRegistry（registerTool/registerInput/registerMarker + fallbackTool）。**如果 PI-Desktop 要做并行多 agent 会话 UI 或把会话流推给远端，这就是现成蓝图**——RACP-WS（ADR 0285）的事件面目前只覆盖单会话 transcript。
- **agent-core-v2 的 DI 细粒度失效重建**：Fiber unit + cascadeEngine（provider 撤回 → 自动 tearDown/rebuild 受影响服务，记录 CascadeHistoryEntry）+ collection/definition token（VSCode contribution point 的运行时形态，带 onDidChange 增删事件）。PI-Desktop 的插件动态启停若遇到「依赖 A 的服务 B 无法自动重建」，这是教科书答案。
- **klient 契约模式**：单对象参数 + 每方法 zod 输入/输出 schema + 单 transport SPI（`{call, listen}`）+ ipc/memory 双实现 + 同构 conformance 测试。插件宿主 API（39 权限面）若继续膨胀，这套是防漂移模板。
- **kosong 两个小优化**：deferred 标记保 prompt cache 顶层字节稳定；onToolCall 延迟到流结束防半参数工具调用。provider 层可直接抄。
- **minidb**：快照+WAL+大于 RAM 的全文索引（中文分词），纯 TS 零依赖。插件内需要本地检索时可直接捆绑（pi.ts-toolkit 范式），也给宿主会话搜索做参考。
- **kap-server 的反射 debug RPC**（`/:service/:method` 直调任意作用域服务 + kimi-inspect DI 可视化）：PI-Desktop 调试插件化宿主时可复刻——`desktop.control` 的 plugin/services 操作已有雏形。
- **tree-sitter-bash**：纯 TS、零依赖、确定性预算（timeoutMs=50/maxNodes=50000，永不抛、降级 hasError）、与真 tree-sitter 全语料差分测试。**kimi 用它做 `git status && rm -rf /` 复合命令的危险段确认**（`dangerous-command-ask.ts` 权限策略）。它可以直接进宿主（§6.2）。

---

## 6. 插件做不了、应向宿主提的

### 6.1 desktop.control 暴露配置写操作（把「配置即对话」补全，成本最低、收益最大）

宿主内部**已有全部能力**：ADR 0283 的 `mcp/oauth/start`、`mcp.transfer` 是现成的 Electron IPC；host-core 的 `mcp_servers.rs` 就是 CRUD。缺的只是把它们加进 `mcp-control.ts` 的受审 spec 目录（`mcp/save`、`skill/save`、`subagent/save`、`settings/set`，级别标 dangerous，审批面板即确认门——正是 kimi 的「权限弹窗即确认」哲学）。开放后 config-butler 从「诊断 + 指引」升级为「直接修改」，且天生带宿主审计。

### 6.2 ACP 绑定：让 Zed/JetBrains 把 PI-Desktop 当 agent 后端

kimi 的 `packages/acp-server` 把引擎全方法（会话生命周期/prompt/cancel/权限/重放）映射到 ACP JSON-RPC over stdio，还支持**反向 RPC**——ACP 客户端声明 `clientCapabilities.terminal/fs` 时，bash 执行与文件系统回灌到客户端本地。PI-Desktop 的 ADR 0284 headless（pi-host）+ ADR 0285 RACP-WS 已把「引擎脱离 Electron」做完，**只差一个 ACP 适配层**（pi-host 加 `--acp` 绑定）。插件做不了：外部 IDE 要 spawn 的是一个宿主入口进程，而插件进程由宿主管理、无法被外部 spawn；宿主又明确禁止自开 listener。这是「向宿主提」清单里价值最高的一项。

### 6.3 Bash 工具的参数级危险确认

PI-Desktop 有工具审批三档，但确认粒度是**工具调用级**；kimi 用 tree-sitter-bash 把 `git status && rm -rf /` 拆出危险段单独触发确认（且 abort/hasError 一律按「无法分析」fail-safe 降级，不 fail-open）。插件不能拦截内置工具（基线 A6.8），此为宿主审批链增强；tree-sitter-bash（MIT、纯 TS、零依赖）可直接复用，连「与真 tree-sitter 差分测试语料」都是现成的。可顺带引入 kimi 的参数级 pattern 规则（`Bash(rm -rf*)`）作为用户自定义放行/拦截的粒度参考。

### 6.4 视频附件管线

kimi 全链：剪贴板 `ClipboardVideo` → staging 上传（TTL）→ `kimi-file://<id>` 稳定引用（fork 后有效）→ 模型能力位 `video_in` 门控（无则提交拦截）→ 会话累计 20MB 预算 LRU 淘汰。这是消息管线 + 多模态能力位 + 附件预算三件事，全部宿主级。插件侧不存在可行近似（附件注入点是宿主消息管线）。

### 6.5 prompt 撤回 /undo

kimi 的 /undo 从上下文撤回最近 n 条 prompt（连带 todo/plan 状态回滚，不回滚代码，压缩点之前不可撤），依托 wire journal 的树状结构。PI-Desktop 的 turn queue 有 ADR 0265 但无撤回语义。小而顺手的宿主功能。

---

## 7. 建议实施路线图

1. **`pi.host-docs`**（半天）——先做：它是 config-butler 的底座，也是后续所有插件对齐 ADR 的公共依赖。捆绑 ADR 索引 + Grep 检索技能。
2. **`pi.config-butler`**（1-2 天）——聚合工具 + config-audit 技能 + AGENTS.md 对话式编辑；同步向宿主提 §6.1（mcp/save 等受审写）。
3. **`pi.session-export`**（1 天）——与 session-import 成闭环。
4. **`pi.datasource-gateway`**（2-3 天）——从两个公开源起步（MDN + arXiv），验证「文档运行时拉取」模式的上下文节省。
5. **swarm 先写成 pi.workflow 技能模板**（半天），观察使用频率再决定是否工具化。
6. 宿主侧提需求清单（按价值排序）：§6.1 配置写操作 → §6.2 ACP 绑定 → §6.3 危险命令解析 → §6.5 /undo → §6.4 视频附件。

---

## 8. 风险与边界

- **`desktop.control` 是高风险权限**：config-butler 只代理 read 级 spec；`agent/instructions/save` 虽开放但标 dangerous，技能必须先播报 diff 再调用（照抄 kimi「先读后写、播报即确认」）。安装说明写清「能消耗额度 / 能改 AGENTS.md」。
- **指引幻觉**：config-butler 对不可写项输出「设置页操作指引」，但 GUI 路径随版本漂移——指引必须基于 `settings/get` 实读值 + ADR 引证（host-docs 的价值在此），而不是记忆中的 UI 布局。
- **datasource 的出网面**：逐源 https 白名单、无鉴权源起步、key 走插件设置；绝不把用户文件回传。`net.fetch` 域白名单在 manifest 里逐条申报。
- **session-export 的内容出域**：导出含源码片段与绝对路径，默认输出到用户选定目录并在 toast 提示；不默认写剪贴板。
- **与现有插件的重叠检查**：

| 候选 | 可能重叠 | 处理 |
|---|---|---|
| pi.config-butler | pi.skill-lock（技能哈希账本） | 互补：butler 做盘点诊断，lock 做来源校验；butler 可调 lock 的 verify 结果 |
| pi.session-export | local.trajectory（回放视图）、session-import（导入） | 前者是交互回放、后者是入向；export 是出向静态产物，三者分明 |
| pi.host-docs | skill-pack 的 project-init 等技能 | 前者查宿主文档，后者生成项目指引，无冲突 |
| pi.datasource-gateway | ADR 0297 web search | 结构化 API vs 网页搜索，互补 |
| swarm | SessionTask、pi.workflow | 见 §4.2 边界规则，README 写清选择条件 |

- **不建议照搬的部分**：kimi 的 `kimi.plugin.json` 极简 manifest（PI-Desktop 的 39 权限 + i18n + engines 更完整，别倒退）；公网 relay 远程控制（宿主已定 SSH/RACP 路线）；Tower 模式（实验特性，git worktree + pi.workflow 脚本可近似，单独立项过重）；外部 hook 脚本生态（插件本身是 hook 超集）。

---

## 9. 一句话总结

**kimi-code 最值得搬的不是某个功能，而是「配置即对话」这条哲学**——把宿主设置从「用户在 GUI 里找」变成「agent 用受审操作自助盘点」，而 PI-Desktop 恰好已经开放了 `desktop.control` 读的一半（mcp/list、skill/list、settings/get、subagent/catalog），差的写的一半在宿主内部早已存在（只差暴露成 dangerous spec）。

建议从 `pi.host-docs` 起步（半天，是 config-butler 的底座），**以 `pi.config-butler` 为目标**（把 PI-Desktop 的技能/子代理/MCP/插件治理变成对话），`pi.session-export` 顺手补上会话闭环；ACP、危险命令解析、视频附件三件事超出插件边界，作为提需求清单交给宿主——其中 §6.1（暴露配置写操作）是性价比最高的一个。

---

## 附录 A：证据索引

### kimi-code 侧

| 路径 | 内容 |
|---|---|
| `docs/zh/customization/{plugins,skills,hooks,mcp,agents}.md` | 扩展生态五份权威文档 |
| `docs/zh/reference/slash-commands.md` + `apps/kimi-code/src/tui/commands/registry.ts` | 斜杠命令全量（45+，四层来源） |
| `docs/zh/guides/{interaction,sessions,web,remote-control,ides}.md` | 审批三档 / 会话事件流 / 多端 |
| `packages/agent-core-v2/src/features/skill/catalog/builtin/mcp-config.md` | **/mcp-config 内置 skill 全文（本文 P0 的直接依据）** |
| `plugins/official/kimi-datasource/{kimi.plugin.json,SKILL.md,bin/kimi-datasource.mjs}` | 数据源网关三件套（文档运行时拉取） |
| `plugins/official/kimi-webbridge/skills/kimi-webbridge/SKILL.md` | 零代码插件（skill 即产品） |
| `packages/agent-core-v2/src/features/externalHooks/{internal/types.ts,internal/runHook.ts,configSection.ts}` | 20 hook 事件 + exit-code 契约 + fail-open |
| `packages/agent-core-v2/src/app/plugin/{manifest.ts,manager.ts,marketplace.ts,store.ts}` | 插件机制（realpath 防逃逸/原子安装/semver 提示） |
| `packages/agent-core-v2/src/{app/scopes.ts,_base/di/{fiber.ts,cascadeEngine.ts,collection.ts},features/feature.ts}` | DI×Scope + Fiber 级联 + contribution point |
| `packages/transcript/src/{ops/operation.ts,granularity/grade.ts,view/registry.ts,model/}` | L1-L4 数据层 |
| `packages/kosong/src/{capability.ts,generate.ts,tool.ts}` | 能力位门控 + deferred 保 prompt cache |
| `packages/tree-sitter-bash/README.md` | 纯 TS bash 解析器（预算语义 + 差分测试） |
| `packages/acp-server/src/server.ts` + `docs/zh/reference/kimi-acp.md` | ACP 全方法映射 + 反向 RPC |
| `packages/kap-server/src/transport/serviceDispatcherRoutes.ts` | 反射式 debug RPC |
| `packages/remote-control/src/remote-control.ts` | relay 隧道（header 裁剪/单实例锁） |
| `packages/klient/README.md` + `src/contract/` | zod 契约 + 单 SPI 多 transport |
| `packages/pi-tui/LICENSE` | **与 PI-Desktop 同源证明（Mario Zechner / pi-mono）** |
| `apps/kimi-code/src/tui/{commands/{registry,swarm,tower,btw}.ts,controllers/editor-keyboard.ts,utils/terminal-notification.ts}` | TUI 特色实现 |
| `apps/kimi-code/src/tui/kimi-tui.ts:1564-1593` | video_in 能力门控 |
| `docs/zh/release-notes/changelog.md` | 0.23→2.0.2 版本史（0.26 "BIIIG DAY"） |

### PI-Desktop 侧

| 路径 | 内容 |
|---|---|
| `apps/desktop/electron/main/mcp-control.ts:192-267` | **desktop.control 48 受审操作目录（本文 P0 的可行性依据）** |
| `crates/host-core/src/mcp_servers.rs` + `db/` | MCP 配置真值源（SQLite，非用户 JSON） |
| `docs/adr/0283-remote-mcp-oauth.md` | MCP OAuth 2.1 全套（RFC 9728/8414/7591/8707） |
| `docs/adr/0284-headless-runtime-boundary.md` | pi-headless 运行时（第 66 行：插件 agent 需要桌面） |
| `docs/adr/0285-racp-ws-transport.md` | RACP-WS + 设备令牌 + loopback-only |
| `docs/adr/0286-remote-host-desktop-kernel.md` | 远程内核（security §7：桌面不开 listener） |
| `docs/adr/0260-0297`（新增 38 篇） | ZCode 分析后宿主演进（主题 API/浮窗/受审开发插件/RACP/SSH/归档/web search） |
| `packages/plugin-sdk/` + `pi-desktop-plugins/AGENTS.md` | 插件能力面（23 权限在用、9 贡献点） |
| `pi-plug/ZCode-对PI-Desktop的插件化增强分析.md` 附录 B | 上轮六项落地盘点（本文 §2 基线） |
| `pi-plug/交付说明.md` | mcode 产物 + 「插件无法感知 turn/拦截内置工具」旧边界 |

## 附录 B：现有插件覆盖盘点（截至本文）

官方仓库克隆 `pi-desktop-plugins/plugins/`（27+，重点）：`pi.workflow`、`pi.artifact-board`、`pi.ts-toolkit`、`pi.state-forge`、`pi.skill-lock`、`pi.session-orchestrator`、`pi.gitlens`、`pi.terminal`、`pi.markdown`、`pi.file-manager`、`pi.todo`、`pi.log-viewer`、`pi.clipboard-history`、`pi.ssh-manager`、`pi.goal-x`、`pi.workspace-file-guard`、`pi.token-insights`、`pi.obsidian-theme`、`io.github.muzimu217.{session-import,deps-audit,usage-dashboard}`、`pi.bianqian`、`pi.scratch-calc`、`pi.idea-git`、`com.vastsa.voice-assistant`、`pi.super-domain-man`、`demo.*`。

本地开发（pi-plug 根）：`local.annotate`（Browser 标注技能包）、`local.trajectory`（会话时间线）、`obsidian-theme`、`session-import`（0.5.0 本地领先市场）、`session-orchestrator`（官方本地副本）、`skill-pack`（8 技能）、`task-center`（todo 工具）、`token-meter`（计量浮窗）。

**本文净空白**（与上表全量对照后）：①配置即对话（config-butler）；②会话导出；③宿主文档检索；④外部数据源网关；⑤声明式批量扇出。
