# PI Agent 学习与进阶指南

> **版本核验**：Pi `0.85.1`（2026-09-05 发布）· 文档核验日期 2026-09-13
>
> **一手来源**：`@earendil-works/pi-coding-agent` v0.85.1 随包 `docs/`（30 篇 Markdown + `docs.json`）与 `examples/`；官方网站 pi.dev；仓库 earendil-works/pi
>
> **本机实测环境**：Windows 11 + Node v22.22.2（nvm-windows）+ Git Bash
>
> 凡标注「需核对」的条目，表示官方文档未逐字给出，使用前请对照源码确认。

---

## 目录

- [0. 这份文档怎么用](#0-这份文档怎么用)
- [1. 认识 PI Agent](#1-认识-pi-agent)
- [2. 安装与首次运行](#2-安装与首次运行)
- [3. 日常使用核心机制](#3-日常使用核心机制)
- [4. 定制化四件套](#4-定制化四件套)
- [5. Extensions 扩展开发（进阶核心）](#5-extensions-扩展开发进阶核心)
- [6. 编程接口：SDK / RPC / JSON / Provider](#6-编程接口sdk--rpc--json--provider)
- [7. 安全、信任与沙箱](#7-安全信任与沙箱)
- [8. 学习路线图](#8-学习路线图)
- [9. 附录](#9-附录)

---

## 0. 这份文档怎么用

Pi 的官方文档质量很高，但它是**参考手册**（按主题平铺 30 篇），不是学习路径。本文的定位是**路线图 + 提炼 + 实战纠偏**：

| 你的状态 | 建议读法 |
|---|---|
| 刚听说 Pi | 读 §1 → §2 → §3.1，先跑通一次真实任务 |
| 已在日常使用 | 精读 §3.4–§3.7，把会话与上下文管理变成肌肉记忆 |
| 想让它适应自己的流程 | 读 §4 决策树，先判断该写 Skill 还是 Extension |
| 要写扩展/接自己的模型 | 精读 §5、§6，配合 `docs/extensions.md` 原文 |
| 要上生产/跑不可信代码 | 读 §7，别跳过 |

**三条贯穿全文的原则**（理解它们，很多设计选择就不用背了）：

1. **Pi 是「原语提供者」，不是「功能集合」**。核心刻意保持最小，缺什么自己长出来。
2. **一切扩展都是本地代码，拥有你的完整权限**。没有沙箱——安全边界靠容器，不靠 Pi。
3. **能力分三层：Skill（教模型）/ Extension（给运行时加能力）/ Package（分发）**。选错层是新手最常见的浪费。

---

## 1. 认识 PI Agent

### 1.1 它是什么

Pi 是一个**极简的终端 coding harness**——"harness"（马具/外壳）这个定位很关键：它不试图成为完整的 IDE 或平台，而是提供一套原语，让你把 AI 编码代理塑造成自己工作流的样子。

| 项目 | 值 |
|---|---|
| npm 包名 | `@earendil-works/pi-coding-agent` |
| 版本 | 0.85.1（最新，2026-09-05） |
| 作者 | Mario Zechner（`badlogic`）/ Earendil Inc. |
| 仓库 | `earendil-works/pi`（Monorepo） |
| 许可 | MIT |
| 语言 | TypeScript 95.1% |
| 运行要求 | Node.js ≥ 22.19.0 |
| 官网 | pi.dev |
| 社区 | Discord（`discord.com/invite/3cU7Bz4UPx`）、X `@pidotdev` |

**默认只给模型 4 个工具**：`read`、`write`、`edit`、`bash`。只读工具 `grep`、`find`、`ls` 通过工具选项提供；Windows 上另有可选的 `powershell` 工具。这不是能力缺失，而是刻意的上下文预算管理——每个工具的定义都常驻系统提示词，工具越少，模型越专注。

### 1.2 设计哲学：理解 Pi 的钥匙

官方 README 的 Philosophy 章节列了六条「不做」，每一条都直接决定了你该用什么方式解决问题：

| Pi 刻意不内置 | 官方建议的替代方案 |
|---|---|
| **MCP** | 写带 README 的 CLI 工具（用 Skill 描述），或写个扩展自己加 MCP 支持 |
| **子代理（sub-agents）** | 用 tmux 拉起多个 pi 实例，或用扩展自己实现 |
| **权限弹窗** | 跑在容器里，或用扩展按自己的安全需求定制确认流程 |
| **Plan mode** | 把计划写进文件，或用扩展/包实现 |
| **内置 to-do** | 官方原话："They confuse models"——用 `TODO.md` 文件，或自己扩展 |
| **后台 bash** | 用 tmux。理由是 "Full observability, direct interaction" |

> 官方原话："Pi is aggressively extensible so it doesn't have to dictate your workflow."

**这对学习路径的含义**：当你遇到「Pi 怎么没有 XX 功能」时，正确的反应不是找配置项，而是判断「这是不是应该由扩展补上」——社区已经用 5424 个包回答了大部分这类问题（见 §1.4）。

### 1.3 架构分层

Pi 由多个正交分层的包构成，依赖单向向下：

```
Layer 5  UI            pi-tui（终端，差分渲染）
Layer 4  Application   pi-coding-agent（CLI，整合所有层）
Layer 3  Agent Runtime pi-agent-core（Agent Loop + Tool Calling + Session + Compaction）
Layer 2  LLM Interface pi-ai（多 Provider 统一 API）
Layer 1  Foundation    File System / Node.js 环境抽象
```

| 包 | 职责 |
|---|---|
| `@earendil-works/pi-ai` | 统一多 Provider LLM API（OpenAI / Anthropic / Google / Mistral / Bedrock 等） |
| `@earendil-works/pi-agent-core` | Agent 运行时核心：Agent Loop、Tool Calling、Session 管理、Compaction |
| `@earendil-works/pi-coding-agent` | 交互式 Coding Agent CLI，整合所有层 |
| `@earendil-works/pi-tui` | 终端 UI 库（差分渲染） |
| `@earendil-works/chord` | 独立的应用组合运行时（服务、复制状态、RPC、插件） |
| `@earendil-works/pi-telemetry` | 厂商中立的遥测契约与适配器 |

**三个值得理解的内部机制**（知道它们，写扩展时不易踩坑）：

**① Agent Loop 是双层嵌套循环，且内部消息格式统一。**
关键设计：`AgentMessage[]` 在 Agent Loop 内部全程使用，**只在调用 LLM 时才转换为 Provider 兼容格式**。这解释了为什么扩展里拿到的消息对象和最终发给模型的东西不完全一样。

**② 工具调用是 Prepare → Execute → Finalize 三阶段。**
- **Prepare**：校验参数，可被 `beforeToolCall` 钩子拦截（返回 `{ block: true, reason }`）
- **Execute**：实际运行，支持通过 `onUpdate` 回调流式汇报中间结果
- **Finalize**：`afterToolCall` 钩子可修改结果，包括 `terminate: true` 提前终止整个批次

工具默认**并行执行**（`ToolExecutionMode = "sequential" | "parallel"`）；结果按 LLM 输出顺序排序返回。写会改文件的工具时必须显式串行化（见 §5.8）。

**③ Skill 不需要代码注册。**
Agent 在推理时自然发现并调用 Skill，Skill 内容被格式化为 XML 标签嵌入 prompt：

```
<skill name="add-block" location="/path/to/SKILL.md">
References are relative to /path/to/skills.

<!-- Skill 内容全文 -->
</skill>
```

这意味着 Skill 可以版本控制、可以互相组合，扩展行为**无需改代码**。

### 1.4 生态现状（2026-09 数据）

| 指标 | 值 |
|---|---|
| GitHub Stars | 107k |
| Forks | 13.5k |
| Releases | 259 |
| Contributors | 290 |
| npm 生态包数 | 5424（pi.dev/packages 收录） |

**下载量最高的扩展**（说明社区真实需求分布）：

| 包 | 用途 | 月下载 |
|---|---|---|
| `pi-mcp-adapter` | 给 Pi 补上 MCP 支持 | 986.9K |
| `pi-subagents` | 单代理委派 + 脚本化多代理工作流 | 450.7K |
| `pi-web-access` | 网页搜索、URL 抓取、GitHub 克隆、PDF/YouTube 解析 | 442.2K |
| `pi-background-tasks` | 持久后台 shell 任务、只读委派代理 | 135.6K |
| `pi-lens` | 实时代码反馈：LSP、linter、formatter、类型检查 | 96K |
| `@tintinweb/pi-subagents` | Claude Code 风格子代理 + 工作流编排 | 44.4K |
| `@gotgenes/pi-permission-system` | 权限强制扩展 | 40.7K |

**这个表格本身就是一份需求清单**：下载量前列的包，恰好对应 §1.2 里 Pi 刻意不内置的那六项。社区用扩展把「缺失功能」补齐了——这就是 Pi 的设计闭环。

**官方的取舍态度**：Pi 不内置权限系统。`docs/security.md` 明确说 "It runs with the permissions of the user account that starts it, and it treats files writable by that user as inside the same local trust boundary."，需要更强边界就容器化（Gondolin 微 VM / 纯 Docker / OpenShell 等模式，见 §7）。

---

## 2. 安装与首次运行

### 2.1 安装

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

`--ignore-scripts` 禁用依赖生命周期脚本——Pi 正常安装不需要安装脚本，这是供应链加固的一部分（官方对 npm 依赖变更按「代码变更」审阅：直接依赖锁定精确版本、`.npmrc` 设 `save-exact=true` 与 `min-release-age=2`、发布包含 `npm-shrinkwrap.json`）。

**Linux / macOS 也可用安装脚本**（底层同样走 npm 全局）：

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

**卸载**（注意：卸载后 `~/.pi/agent/` 里的设置、凭证、会话、已装包会保留）：

```bash
npm uninstall -g @earendil-works/pi-coding-agent
# pnpm remove -g @earendil-works/pi-coding-agent
# yarn global remove @earendil-works/pi-coding-agent
# bun uninstall -g @earendil-works/pi-coding-agent
```

**启动**：进入项目目录再运行，Pi 会在当前工作目录运行并可直接修改其中文件——**建议先用 git 建立检查点**。

```bash
cd /path/to/project
pi
```

### 2.2 认证：两条路

**路线 A：订阅登录（OAuth）**——在交互模式运行 `/login`：

| Provider | 说明 |
|---|---|
| Claude Pro/Max | ⚠️ 第三方 harness 用量走 extra usage，按 token 计费，**不计入套餐额度** |
| ChatGPT Plus/Pro (Codex) | 需 Plus/Pro 订阅 |
| GitHub Copilot | 回车选 github.com，或输入 GHES 域名 |
| xAI (Grok) | `/login xai` → Use a subscription |
| OpenRouter | PKCE 流程，铸造用户可控的 API key |
| Radius | Earendil 的动态网关 |

Token 存于 `~/.pi/agent/auth.json`（权限 `0600`），过期自动刷新；`/logout` 清除。

**路线 B：API key**——设环境变量后启动，或 `/login` 存入 `auth.json`。

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

**⚠️ 优先级陷阱**：`auth.json` 中的凭证**优先于环境变量**。如果改了环境变量却不生效，先检查 `auth.json` 是否已有旧 key。

**常用 provider 环境变量**（完整 35 个见 `docs/providers.md`）：

| Provider | 环境变量 | auth.json key |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic` |
| OpenAI | `OPENAI_API_KEY` | `openai` |
| Google Gemini | `GEMINI_API_KEY` | `google` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek` |
| Amazon Bedrock | `AWS_BEARER_TOKEN_BEDROCK` | `amazon-bedrock` |
| Groq | `GROQ_API_KEY` | `groq` |
| Mistral | `MISTRAL_API_KEY` | `mistral` |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter` |
| xAI | `XAI_API_KEY` | `xai` |
| Cloudflare Workers AI | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` | `cloudflare-workers-ai` |
| Hugging Face | `HF_TOKEN` | `huggingface` |

**auth.json 的 key 字段支持三种写法**（很实用）：

- `!command` 开头 → 执行 shell 命令取 stdout 作为值（进程生命周期内缓存）
- `$ENV_VAR` / `${ENV_VAR}` → 环境变量插值，可嵌在字面量内；`$$` → 字面 `$`，`$!` → 字面 `!`
- 纯字面量 → 直接用。注意：全大写字符串如 `MY_API_KEY` 会被当作**字面量**，要取环境变量必须写 `$MY_API_KEY`

### 2.3 第一次会话：把「能跑通」变成「能验收」

新手最容易犯的错是第一次就扔一个大任务，然后无法判断结果对不对。建议按官方 Quickstart 的顺序：

1. `cd` 到一个**练习目录**（不是重要仓库）
2. `pi` 启动，`/login` 或确认 API key 已生效
3. `/model` 选一个模型（或 `--list-models` 先看有哪些可用）
4. 给一个小而**可独立核对**的任务：

```
把 meeting-notes.md 里的内容整理成行动清单，写进 actions.md
```

5. **自己打开文件核对**——不要把 Agent 说的「完成了」当作完成

这个习惯（自己验收）是后面所有进阶内容的地基。Pi 的会话树、压缩、扩展全都建立在「你能判断结果对不对」之上。

### 2.4 Windows 特别注意

本机（Windows 11）实测要点：

**① Shell 查找顺序**（`docs/windows.md`）：

1. `~/.pi/agent/settings.json` 里自定义的路径
2. Git Bash：`C:\Program Files\Git\bin\bash.exe`
3. PATH 上的 `bash.exe`（Cygwin、MSYS2、WSL）

**多数用户装 Git for Windows 即可**。自定义路径用 `shellPath`，但 **Windows 路径在 JSON 里必须用正斜杠或转义反斜杠**：

```json
{ "shellPath": "C:/Program Files/Git/bin/bash.exe" }
```

**② 可选的 `powershell` 工具**：有 `pwsh.exe` 则用之，否则用 Windows PowerShell。启动参数为 `-NoProfile -NonInteractive -ExecutionPolicy Bypass`（管理员强制的执行策略仍可能优先）。

用 `defaultTools` 可以把模型面向的 `bash` 换成 `powershell`：

```json
{ "defaultTools": ["read", "powershell", "edit", "write"] }
```

两者并存便于对比：`["read", "bash", "powershell", "edit", "write"]`。**注意**：编辑器里的 `!` 与 `!!` 命令始终走 Bash，不受此影响。

**③ 快捷键差异**（Windows 专属，容易困惑）：

| 功能 | 默认 | Windows |
|---|---|---|
| 粘贴图片 | `ctrl+v` | `alt+v` |
| follow-up 消息 | `alt+enter` | `ctrl+q` |
| 取回队列消息 | `alt+up` | `alt+q` |
| 上一个模型 | `shift+ctrl+p` | `alt+p` |
| 编辑器 undo | `ctrl+-` | `ctrl+z`（WSL 为 `alt+z`） |
| 全屏 transcript 搜索 | `ctrl+shift+f` | `ctrl+f` |

另外 `app.suspend` 在 Windows 无默认绑定；跳标记消息额外支持 `ctrl+up` / `ctrl+down`。

**④ 多行输入**：`Shift+Enter`；Windows Terminal 也可 `Ctrl+Enter`。Windows Terminal 的 `Alt+Enter` 默认被全屏占用，想让 Pi 收到需按 `docs/terminal-setup.md` 重映射。

**⑤ 外部编辑器**回退链：`externalEditor` → `$VISUAL` → `$EDITOR` → **Notepad**。

---

## 3. 日常使用核心机制

### 3.1 交互模式：编辑器的隐藏能力

Pi 的输入框不只是输入框：

| 操作 | 效果 |
|---|---|
| `@` | 触发文件路径补全，把文件内容带进消息 |
| `!command` | 执行 shell 命令，输出**进入** LLM 上下文 |
| `!!command` | 执行 shell 命令，输出**不进**上下文（自己看） |
| `/` | 斜杠命令补全 |
| `Shift+Enter` | 多行输入 |
| 拖入/粘贴图片 | 多模态输入（Windows 用 `alt+v`） |

`!` 与 `!!` 的区别是日常最高频的实用技巧：查看 `git status`、`ls` 这类信息，用 `!!` 不污染上下文；需要模型基于输出推理时，用 `!`。

**消息队列**是另一个核心机制：Agent 工作时你仍可继续输入。

- **steer**：改变方向——「别做 X 了，改成 Y」
- **follow-up**：追加任务——「做完这个再检查一下 Z」

这两个概念贯穿 SDK 与 RPC 接口（`streamingBehavior: "steer" | "followUp"`），理解它们对后面接编程接口很有帮助。

### 3.2 斜杠命令

| 命令 | 用途 |
|---|---|
| `/login` `/logout` | 认证管理 |
| `/model` | 切换模型 |
| `/thinking` | 调整思考等级 |
| `/scoped-models` | 管理 Ctrl+P 循环的模型列表 |
| `/compact` | 手动压缩上下文 |
| `/tree` | 会话树导航（分支切换） |
| `/fork` `/clone` | 从历史条目分叉新会话 |
| `/new` `/resume` | 新会话 / 恢复会话 |
| `/name` | 给当前会话命名 |
| `/reload` | 热重载扩展（**仅对自动发现路径生效**） |
| `/settings` | 交互式设置 |
| `/hotkeys` | 查看快捷键 |
| `/trust` | 项目信任管理 |
| `/llama` | 本地 llama.cpp 模型管理 |
| `/export` | 导出会话为 HTML |
| `/debug` | 写调试日志到 `~/.pi/agent/pi-debug.log` |
| `/skill:<name>` | 强制加载并执行指定 Skill |

**多个扩展注册同名命令时不会冲突**：Pi 全部保留，按加载顺序加数字后缀（`/review:1`、`/review:2`）。

### 3.3 上下文文件：AGENTS.md

Pi 会自动发现并加载项目指令文件（**无论项目是否被信任都加载**，除非用 `--no-context-files` 禁用）：

- `AGENTS.md`——项目规则，你和 Agent 共享
- `CLAUDE.md`——兼容 Claude Code 的约定
- `AGENTS.override.md`——目录级替代

**这是投入产出比最高的定制手段**：不用写一行代码，把项目约定（代码风格、提交格式、禁止事项、常用命令）写进 `AGENTS.md`，所有会话立即受益。

> ⚠️ 官方文档没有明确 `AGENTS.md` 与 `CLAUDE.md` 同目录共存时谁优先，也没明确各层覆盖方向——**不要臆测**，实测确认后再依赖。

### 3.4 会话机制：session / 分支 / fork / clone

Pi 的会话不是线性日志，而是**树**（append-only，条目通过 `id` / `parentId` 链接）。这是它区别于大多数工具的核心设计。

**会话文件存储**：按项目路径哈希分目录，如 `~/.pi/agent/sessions/--C--Users-84168-AppData-Roaming-pi-desktop-chat-workspace--/`。格式为 JSONL（每行一个条目）。

**CLI 会话参数**：

| 参数 | 用途 |
|---|---|
| `-c`, `--continue` | 继续最近的会话 |
| `-r`, `--resume` | 浏览并选择会话 |
| `--session <path\|id>` | 指定会话文件或部分 UUID |
| `--session-id <id>` | 精确项目会话 ID，不存在则创建 |
| `--fork <path\|id>` | 把指定会话分叉为新会话 |
| `--session-dir <dir>` | 自定义存储目录 |
| `--no-session` | 临时模式，不保存 |
| `-n`, `--name <name>` | 启动时设置显示名 |

**/fork 与 /clone 的区别**（易混淆）：

| 命令 | `position` | 行为 |
|---|---|---|
| `/fork` | `"before"` | 在选中条目**之前**分叉（回到那个点重来） |
| `/clone` | `"at"` | 在选中条目**处**分叉（保留到该点） |

**会话条目类型**（`docs/session-format.md`）：消息、工具结果、压缩摘要（`compaction`）、分支摘要、标签（label）等。扩展可以往会话里写自定义条目（`pi.appendEntry(customType, data)`），它**持久化但不进 LLM 上下文**——这是给扩展做状态持久化的标准姿势。

### 3.5 上下文压缩（Compaction）

长会话必然撞上下文上限，Pi 的应对是**压缩**：把旧对话用 LLM 总结成摘要，替换掉原始消息。

**三种触发原因**（扩展事件里能看到 `reason` 字段）：

| reason | 触发条件 |
|---|---|
| `manual` | 用户执行 `/compact` |
| `threshold` | 超过配置阈值自动触发 |
| `overflow` | 撞上上下文上限 |

**压缩做了什么**（关键理解）：

1. 提取对话中的文件操作（read / edit / write）
2. 用 Branch Summary 机制总结分支对话
3. 生成压缩摘要消息注入上下文
4. 删除中间的消息历史（保留 `firstKeptEntryId` 之后的）

**配置**（`settings.json`）：

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

- `reserveTokens`：为回复预留的 token 数
- `keepRecentTokens`：保留最近多少 token 不压缩

**扩展可以完全接管压缩**——监听 `session_before_compact`，返回自己的摘要（见 §5.7）。常见用途：用便宜的小模型做摘要，或保留特定类型的上下文。

**⚠️ 实用提醒**：压缩是有损的。重要结论**写进文件**（`TODO.md`、设计文档），不要指望它活在对话历史里。这也是官方推荐「计划写进文件」的原因之一。

### 3.6 settings.json 配置

**位置**：全局 `~/.pi/agent/settings.json`，项目级 `.pi/settings.json`（**项目级仅在项目被信任后加载**）。

**本机实测配置**（真实案例，已脱敏）：

```json
{
  "packages": ["npm:pi-mcp-adapter"],
  "defaultProvider": "myprovider",
  "defaultModel": "My-Model-2.0",
  "theme": "dark",
  "hideThinkingBlock": false,
  "defaultProjectTrust": "ask",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": { "enabled": true, "maxRetries": 3 }
}
```

**常用配置项**：

| 键 | 用途 |
|---|---|
| `defaultProvider` / `defaultModel` | 默认模型 |
| `enabledModels` | Ctrl+P 循环的模型 pattern 列表 |
| `packages` | 已安装的包（`pi install` 自动写入） |
| `extensions` | 额外扩展路径数组 |
| `skills` / `prompts` / `themes` | 额外资源路径数组 |
| `defaultTools` | 模型可用的工具列表 |
| `theme` | 主题名 |
| `shellPath` | 自定义 shell 路径（Windows 常用） |
| `shellCommandPrefix` | 执行 bash 命令前注入的脚本 |
| `defaultProjectTrust` | `"ask"` / `"always"` / `"never"` |
| `enableSkillCommands` | 是否启用 `/skill:<name>` 命令 |
| `hideThinkingBlock` | 是否隐藏思考块 |
| `compaction` | 压缩配置 |
| `retry` | 自动重试配置 |
| `npmCommand` | 自定义 npm 包装器 |
| `externalEditor` | 外部编辑器 |

**项目级 vs 全局的优先级**：同一包同时出现在全局与项目 settings 时，**项目条目胜出**，除非项目条目设 `autoload: false`（此时它作为对全局条目的增量）。

**shell 别名技巧**：Pi 以 `bash -c` 非交互方式运行 bash，默认不展开别名。要用别名需显式开启：

```json
{
  "shellCommandPrefix": "shopt -s expand_aliases\neval \"$(grep '^alias ' ~/.bashrc)\""
}
```

### 3.7 模型与 Provider 配置

#### 模型 pattern 语法

```bash
pi --model sonnet:high            # 模型名 + 思考等级
pi --model anthropic/claude-...   # provider/id 形式
pi --models "claude-*,gpt-4o"     # Ctrl+P 循环列表（逗号分隔）
pi --list-models [search]         # 列出可用模型
```

`--model` 支持 `provider/id` 与可选 `:<thinking>` 两部分。**思考等级全集**：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。

> 💡 说明：`--model` 支持 `provider/id` 与可选 `:<thinking>` 两种成分（`pi --help` 原文）。文档未给出 `provider/id:thinking` 三段连写的示例，但语义上应受支持——稳妥起见以实测为准。

#### 自定义模型（models.json）

位置 `~/.pi/agent/models.json`。**支持的 API 类型**：

| `api` 值 | 说明 |
|---|---|
| `openai-completions` | 兼容性最好，绝大多数第三方服务用这个 |
| `openai-responses` | OpenAI Responses API |
| `anthropic-messages` | Anthropic Messages API |
| `google-generative-ai` | Google Generative AI |

**最小可用示例**（Ollama 本地模型）：

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{ "id": "llama3.1:8b" }]
    }
  }
}
```

**本机实测：接入国产/自建 OpenAI 兼容服务**（已脱敏）：

```json
{
  "providers": {
    "myprovider": {
      "baseUrl": "https://api.example.com/openai/v1",
      "api": "openai-completions",
      "apiKey": "$MY_API_KEY",
      "models": [
        {
          "id": "My-Model-2.0",
          "contextWindow": 1000000,
          "maxTokens": 131072,
          "input": ["text"],
          "reasoning": true,
          "thinkingLevelMap": { "xhigh": "xhigh", "max": "max" }
        }
      ],
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": true
      }
    }
  }
}
```

**模型字段**（每模型仅 `id` 必填）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `id` | 必填 | 传给 API 的模型标识 |
| `name` | = `id` | 人读名称，用于 pattern 匹配 |
| `api` | provider 的 `api` | 本模型覆盖 API 类型 |
| `reasoning` | `false` | 是否支持扩展思考 |
| `thinkingLevelMap` | 省略 | Pi 思考级 → provider 值的映射（三态：省略/字符串/`null`） |
| `input` | `["text"]` | `["text"]` 或 `["text","image"]` |
| `contextWindow` | `128000` | 上下文窗口 token 数 |
| `maxTokens` | `16384` | 最大输出 token |
| `samplingParams` | 省略 | 逐字合并进请求体（**仅 OpenAI 兼容 API 生效**） |
| `cost` | 全 0 | 每百万 token 费率，支持 `tiers` 分档 |
| `compat` | provider 的 `compat` | 与 provider 级合并 |

**关键 `compat` 开关**（接第三方 OpenAI 兼容服务时最常改的两个）：

| 字段 | 用途 |
|---|---|
| `supportsDeveloperRole` | 有些服务不支持 `developer` role，设 `false` |
| `supportsReasoningEffort` | 是否支持 reasoning effort 参数 |
| `supportsUsageInStreaming` | 流式响应是否带 usage 统计 |
| `maxTokensField` | 输出长度字段名差异 |
| `thinkingFormat` | 思考格式差异（`reasoning_effort` / `deepseek` / `qwen` / `zai` 等） |

**覆盖内置 provider 的路由**（保留全部内置模型，只改地址——接代理时很有用）：

```json
{ "providers": { "anthropic": { "baseUrl": "https://my-proxy.example.com/v1" } } }
```

**`modelOverrides`**：不改整张模型表，只微调内置模型：

```json
{ "providers": { "openai": { "modelOverrides": { "gpt-5.6-sol": { "contextWindow": 1050000 } } } } }
```

支持字段：`name`、`reasoning`、`thinkingLevelMap`、`input`、`cost`、`contextWindow`、`maxTokens`、`samplingParams`、`headers`、`compat`。未知 id 会被忽略。

**⚠️ keyless 本地服务的坑**：无认证的本地服务仍需保留一个 dummy key（如 `"apiKey": "ollama"`），否则模型能加载但在 `/model` 与 `--list-models` 中不可用。
---

## 4. 定制化四件套

### 4.0 先做决策：我该写什么？

这是全文档最该先看的一张表。**新手最大的浪费是选错层**——用 Extension 做了 Skill 能做的事（写了几百行代码，其实一段 Markdown 就够），或者用 Skill 做 Extension 才能做的事（反复写提示词，其实需要真实代码能力）。

| 你想要的效果 | 该用什么 | 成本 |
|---|---|---|
| 教模型**在特定场景按什么规范干活** | **Skill** | 一份 Markdown |
| 让模型**复用一段固定提示词** | **Prompt Template** | 一份 Markdown + frontmatter |
| 给运行时**加真实能力**（新工具、拦截、UI、接外部系统） | **Extension** | TypeScript 代码 |
| 换**终端配色** | **Theme** | 一份 JSON |
| 把上面这些**打包分享给别人** | **Package** | package.json |

**一句话区分 Skill 与 Extension**：

> **Skill（SKILL.md）：面向模型的流程指南**——教模型按什么规范干活。
> **Extension（.ts）：面向运行时的能力插槽**——写真实 TypeScript 代码，注入新工具、事件监听与终端 UI 交互。

判断方法：**如果一句话能说清「怎么做」，用 Skill；如果需要真正执行代码、访问网络/文件系统、或拦截 Pi 的行为，用 Extension。**

### 4.1 Skills：按需加载的能力包

#### 核心机制：渐进式披露（Progressive Disclosure）

这是 Skill 最巧妙的设计，理解它就知道为什么 Skill 不占上下文：

1. **启动时**：Pi 扫描各位置，只提取每个 skill 的 `name` 与 `description`
2. **常驻**：系统提示词里以 XML 格式包含可用 skill 的**列表（只有 name + description）**
3. **匹配时**：任务匹配某 skill，Agent 用 `read` 工具加载完整 `SKILL.md` 内容
4. **执行**：Agent 按指令执行，用相对路径引用脚本与资源

> **即：只有 description 常驻上下文，完整指令按需加载。**

这也解释了为什么 `description` 字段的质量直接决定 Skill 会不会被用上——它是唯一的「广告位」。

#### 存放位置与优先级

| 位置 | 作用域 |
|---|---|
| `~/.pi/agent/skills/` | 全局 |
| `~/.agents/skills/` | 全局（跨工具约定） |
| `.pi/skills/` | 项目级（**仅在项目被信任后加载**） |
| cwd 及祖先目录的 `.agents/skills/` | 项目级（向上到 git 仓库根） |
| Package 的 `skills/` 或 `package.json` 的 `pi.skills` | 随包分发 |
| settings 的 `skills` 数组 | 手动追加 |
| CLI `--skill <path>` | 单次运行（**即使加了 `--no-skills` 仍生效**） |

**发现规则细节**：
- `~/.pi/agent/skills/` 与 `.pi/skills/` 中，根级 `.md` 文件若含有效 frontmatter 且 `description` 非空，可作为独立 skill 被发现
- 所有位置中含 `SKILL.md` 的目录会**递归**发现
- `--no-skills` 关闭自动发现（显式 `--skill` 路径仍加载）
- **同名冲突**：警告并保留**第一个找到的**

#### SKILL.md 格式

```
my-skill/
├── SKILL.md              # 必需：frontmatter + 指令
├── scripts/              # 辅助脚本
│   └── process.sh
├── references/           # 按需加载的详细文档
│   └── api-reference.md
└── assets/
    └── template.json
```

**Frontmatter 字段**：

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | 最长 64 字符；小写 a-z、0-9、连字符。**Pi 不要求与父目录同名** |
| `description` | ✅ | 最长 1024 字符；说明「做什么 + 何时用」 |
| `license` | | 许可证名或指向打包文件 |
| `compatibility` | | 最长 500 字符；环境要求 |
| `metadata` | | 任意键值映射 |
| `allowed-tools` | | 空格分隔的预批准工具列表（实验性） |
| `disable-model-invocation` | | `true` 时对系统提示词隐藏，只能用 `/skill:name` 调用 |

**Name 规则**：1–64 字符、仅小写字母/数字/连字符、无首尾连字符、无连续连字符。
✅ `pdf-processing` ❌ `PDF-Processing` ❌ `-pdf` ❌ `pdf--processing`

**Description 最佳实践**（决定 Skill 能否被触发）：

```yaml
# ✅ 好：具体说明能力 + 触发场景
description: Extracts text and tables from PDF files, fills forms, and merges documents. Use when working with PDF documents.

# ❌ 差：含糊
description: Helps with PDFs.
```

#### 校验规则（宽松但需注意）

- 违规多数**仅警告但仍加载**：名字超长/非法字符、首尾或连续连字符、description 超 1024
- 未知 frontmatter 字段被忽略
- **声明了 skill 但缺 description → 不加载**
- 畸形 `SKILL.md` 或无 description → 警告且不加载

#### 完整示例

```
brave-search/
├── SKILL.md
├── search.js
└── content.js
```

`SKILL.md`：

````markdown
---
name: brave-search
description: Web search and content extraction via Brave Search API. Use for searching documentation, facts, or any web content.
---

# Brave Search

## Setup

```bash
cd /path/to/brave-search && npm install
```

## Search

```bash
./search.js "query"              # Basic search
./search.js "query" --content    # Include page content
```

## Extract Page Content

```bash
./content.js https://example.com
```
````

#### 调用方式

```bash
/skill:brave-search           # 加载并执行
/skill:pdf-tools extract      # 带参数（参数以 `User: <args>` 追加到 skill 内容）
```

需在 settings 开启：`{"enableSkillCommands": true}`。

#### 复用其他工具的 Skills

**这是很实用的一招**——把 Claude Code / Codex 的 skill 目录直接接过来：

```json
{ "skills": ["~/.claude/skills", "~/.codex/skills"] }
```

项目级写入 `.pi/settings.json`：`{"skills": ["../.claude/skills"]}`。

**推荐资源**：Anthropic Skills（docx/pdf/pptx/xlsx 文档处理）、`badlogic/pi-skills`（web search、浏览器自动化、Google APIs、转写）。

### 4.2 Prompt Templates：从斜杠命令展开的提示词

**定义**：Markdown 片段，展开为完整 prompt。输入 `/name` 调用，`name` 是去掉 `.md` 的文件名。

**存放位置**：`~/.pi/agent/prompts/*.md`（全局）、`.pi/prompts/*.md`（项目级，**仅项目被信任后**）、Package 的 `prompts/` 或 `pi.prompts`、settings 的 `prompts` 数组、CLI `--prompt-template <path>`。

`--no-prompt-templates` 关闭发现。

**格式**：

```markdown
---
description: Review staged git changes
argument-hint: "<PR-URL>"
---
Review the staged changes (`git diff --cached`). Focus on:
- Bugs and logic errors
- Security issues
- Error handling gaps
```

- 文件名即命令名：`review.md` → `/review`
- `description` 可选；缺省时用**第一个非空行**
- `argument-hint` 可选；显示在补全下拉中。必填参数用 `<尖括号>`，可选参数用 `[方括号]`

补全渲染效果：

```
→ pr   <PR-URL>       — Review PRs from URLs with structured issue and code analysis
  is   <issue>        — Analyze GitHub issues (bugs or feature requests)
```

**调用**：

```bash
/review                           # 展开 review.md
/component Button                 # 带参数展开
/component Button "click handler" # 多参数
```

### 4.3 Themes：终端配色

**内置主题 + 自定义 JSON 主题**。选主题：`--use-theme <name>`，或在 `/settings` 里选；`--theme <path>` 加载自定义主题文件/目录，`--no-themes` 禁用发现。

主题 JSON 使用 **53+3 个颜色 token**，覆盖消息、工具、Markdown、语法高亮、思考块等。完整 token 列表见 `docs/themes.md`。

> 本机实测：`settings.json` 里 `"theme": "dark"`。主题切换后，**预烘焙主题色的扩展组件必须 override `invalidate()` 重建内容**，否则换主题不生效（详见 §5.9）。

### 4.4 Pi Packages：打包与分发

**Package 结构**：在 `package.json` 里用 `pi` 字段声明包含哪些资源：

```json
{
  "name": "my-pi-package",
  "pi": {
    "extensions": ["extensions"],
    "skills": ["skills"],
    "prompts": ["prompts"],
    "themes": ["themes"]
  }
}
```

**安装 / 管理命令**：

```bash
pi install npm:@foo/bar@1.0.0
pi install git:github.com/user/repo@v1
pi install https://github.com/user/repo       # 原始 URL 也支持
pi install /absolute/path/to/package
pi install ./relative/path/to/package

pi remove npm:@foo/bar
pi list                     # 列出已装包
pi update                   # 只更新 pi 本身
pi update --all             # 更新 pi + 包 + 校准 git ref
pi update --extensions      # 只更新包
pi update --models          # 只刷新模型目录
pi update --self            # 只更新 pi
pi update --self --force    # 强制重装
pi update npm:@foo/bar      # 更新单个包
```

**`-l` 标志与作用域**：

- 默认 `install` / `remove` 写**用户设置** `~/.pi/agent/settings.json`
- 加 `-l` 写**项目设置** `.pi/settings.json`（可随团队共享；项目被信任后，Pi 启动时自动安装缺失包）

**试用不安装**（很实用，安装到临时目录，仅本次运行有效）：

```bash
pi -e npm:@foo/bar
pi --extension git:github.com/user/repo
```

**npm 来源写法**：

```
npm:@scope/pkg@1.2.3
npm:pkg
```

带版本号的 spec 会被**锁定**，`pi update --extensions` / `--all` 会跳过它。用户安装到 `~/.pi/agent/npm/`，项目安装到 `.pi/npm/`。

**git 来源写法**：

```
git:github.com/user/repo@v1
git:git@github.com:user/repo@v1
https://github.com/user/repo@v1
ssh://git@github.com/user/repo@v1
```

- 无 `git:` 前缀时只接受协议 URL（`https://`、`http://`、`ssh://`、`git://`）
- 带 `git:` 前缀接受简写（含 `github.com/user/repo`）
- ref 锁定为 tag 或 commit；`pi update --extensions/--all` **不会**移到新 ref，换 ref 要重新 `install`
- 克隆位置：`~/.pi/agent/git/<host>/<path>`（全局）或 `.pi/git/<host>/<path>`（项目）

**依赖规则（打包时必须遵守）**：

| 依赖类型 | 放哪 |
|---|---|
| 第三方运行时依赖 | `dependencies` |
| 五个核心包 | `peerDependencies`，范围必须 `"*"`，**不打包** |

五个核心包：`@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`typebox`。

**包过滤**（settings 中对象形式，只收窄不放宽）：

```json
{
  "packages": [
    "npm:simple-pkg",
    {
      "source": "npm:my-package",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"],
      "themes": ["+themes/legacy.json"]
    }
  ]
}
```

- 省略键 → 加载该类型全部；`[]` → 该类型全不加载
- `!pattern` 排除；`+path` 强制包含；`-path` 强制排除

**`pi config`**：交互式启用/禁用已装包及本地目录的资源（Tab 切换全局/项目作用域）；`pi config -l` 以项目覆盖起步。

**身份判定**：npm = 包名；git = 去 ref 的仓库 URL；local = 解析后的绝对路径。同一包同时出现在全局与项目时，**项目条目胜出**（除非 `autoload: false`）。

---

## 5. Extensions 扩展开发（进阶核心）

这是 Pi 最强的能力，也是最需要精确理解 API 的部分。

### 5.1 扩展是什么、放在哪、如何加载

**定义**：Extensions 是扩展 Pi 行为的 TypeScript 模块——可订阅生命周期事件、注册 LLM 可调用的自定义工具、添加斜杠命令等。通过 [jiti](https://github.com/unjs/jiti) 加载，**TypeScript 无需编译**。

**自动发现路径**（trusted locations）：

| 位置 | 作用域 |
|---|---|
| `~/.pi/agent/extensions/*.ts` | 全局 |
| `~/.pi/agent/extensions/*/index.ts` | 全局（子目录形式） |
| `.pi/extensions/*.ts` | 项目本地（**仅在项目被信任后加载**） |
| `.pi/extensions/*/index.ts` | 项目本地（子目录形式） |

> ⚠️ **`/reload` 热重载只对自动发现路径生效**；`pi -e ./path.ts` 仅用于快速测试，不能热重载。

**settings.json 追加路径**：

```json
{
  "packages": ["npm:@foo/bar@1.0.0", "git:github.com/user/repo@v1"],
  "extensions": ["/path/to/local/extension.ts", "/path/to/local/extension/dir"]
}
```

**CLI 参数**：

| 参数 | 说明 |
|---|---|
| `-e`, `--extension <source>` | 从 path/npm/git 加载扩展；可重复 |
| `--no-extensions` | 禁用自动发现（显式 `-e` 仍生效） |
| `--no-builtin-tools`, `-nbt` | 禁用内置工具，保留扩展/自定义工具 |
| `--tools <list>` / `--exclude-tools <list>` | 工具白名单/排除 |
| `-a`, `--approve` / `-na` | 本次运行信任/忽略项目本地文件 |

```bash
pi --no-extensions -e ./my-extension.ts   # 只加载这一个扩展
```

**加载顺序与优先级**：

- **Handlers run in extension load order**（多个钩子均如此）
- 多个扩展注册**同名命令**：全部保留，按加载顺序加数字后缀（`/review:1`、`/review:2`）
- 多个扩展注册**同名工具**：**先注册者胜**（`first registration per name wins`）；但扩展工具注册在内置工具之后，因此**同名注册可覆盖内置工具**（交互模式会显示警告）
- 项目本地扩展在 `project_trust` 事件**之后**才加载；只有用户/全局扩展和 CLI `-e` 扩展参与 `project_trust` 决策

### 5.2 模块导出契约

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) { /* 同步工厂 */ }
// 或
export default async function (pi: ExtensionAPI) { /* 异步工厂 */ }
```

**唯一的契约是 default export 一个接收 `ExtensionAPI` 的工厂函数**（同步/异步均可）。

- 工厂返回 `Promise` 时，Pi 会 await 完成后才继续启动——异步初始化发生在 `session_start`、`resources_discover` 之前
- 命名导出可选：可导出工具输入类型供 `isToolCallEventType` 使用（见 §5.7）
- 多文件扩展：`my-extension/index.ts` 为入口

**关键类型名**：`ExtensionAPI`、`ExtensionContext`、`ExtensionCommandContext`、`SessionEntry`、`SlashCommandInfo`、`Theme`、`CustomEditor`、`BashToolDetails` / `ReadToolDetails` 等工具详情类型。

### 5.3 可用导入

| 包 | 用途 |
|---|---|
| `@earendil-works/pi-coding-agent` | 扩展类型 `ExtensionAPI`、`ExtensionContext`、事件 |
| `typebox` | 工具参数 schema（`Type.Object` 等） |
| `@earendil-works/pi-ai` | `StringEnum`、`uuidv7`、`Message`、`Type` 重导出 |
| `@earendil-works/pi-tui` | TUI 基础组件：`Text`、`Box`、`Component`、`Loader`、`matchesKey` 等（⚠️ `BorderedLoader`、`DynamicBorder` 实际由 `@earendil-works/pi-coding-agent` 导出） |
| `@earendil-works/pi-agent-core` | `AgentMessage` |

Node 内建模块（`node:fs`、`node:path`）可用。扩展旁放 `package.json` + `npm install` 后即可从 `node_modules/` 解析依赖。

> 💡 小坑：`hello.ts` 示例从 `@earendil-works/pi-ai` 导入 `Type`（pi-ai 重导出了 typebox），而文档示例统一写 `from "typebox"`——**两种都能用**，建议以文档口径为准。

### 5.4 完整事件清单

这是扩展开发的「能力地图」。所有事件通过 `pi.on("<event>", handler)` 订阅，handler 签名为 `(event, ctx) => ...`，返回值控制拦截行为。

#### 启动 / 信任 / 资源

| 事件 | 时机 | 返回值能做什么 |
|---|---|---|
| `project_trust` | Pi 决定是否信任带动态配置的项目之前 | **必填** `{ trusted: "yes" \| "no" \| "undecided", remember?: true }`。首个 yes/no 决策胜出 |
| `resources_discover` | `session_start` 之后 | `{ skillPaths, promptPaths, themePaths }` 贡献额外资源路径 |

#### 会话生命周期

| 事件 | 时机 | 返回值能做什么 |
|---|---|---|
| `session_start` | 会话启动、加载或重载 | 无拦截作用，用于重建内存状态（`event.reason` 有 5 种值） |
| `session_info_changed` | 设置显示名时 | 通知型 |
| `session_before_switch` | `/new` 或 `/resume` 之前 | `{ cancel: true }` 取消 |
| `session_before_fork` | `/fork` 或 `/clone` 之前 | `{ cancel: true }` 取消；或 `{ skipConversationRestore: true }`（保留字段，文档标注 *Reserved for future conversation restore control*） |
| `session_before_compact` | 压缩前（manual/threshold/overflow） | `{ cancel: true }` 或 `{ compaction: { summary, firstKeptEntryId, tokensBefore, usage? } }` **提供自定义摘要** |
| `session_compact` | 压缩成功 | 通知型 |
| `session_compact_failed` | 压缩失败或中止 | 通知型 |
| `session_before_tree` | `/tree` 导航前 | `{ cancel: true }` 或 `{ summary: { summary, usage?, details } }` **提供自定义分支摘要** |
| `session_tree` | `/tree` 导航完成 | 通知型 |
| `session_shutdown` | 会话运行时拆除前 | 清理资源，**handler 必须幂等** |

`session_start` 的 `event.reason` 取值：`"startup"` / `"reload"` / `"new"` / `"resume"` / `"fork"`。

#### Agent 回合 / 消息

| 事件 | 时机 | 返回值能做什么 |
|---|---|---|
| `before_agent_start` | 用户提交 prompt 后、agent 循环前 | `{ message: {...} }` 注入持久消息；`{ systemPrompt: string }` **替换本回合系统提示**（跨扩展链式） |
| `agent_start` | 低层 run 开始 | 通知型 |
| `agent_end` | 该 run 结束（**仍可能自动重试/压缩/续跑**） | 通知型 |
| `agent_settled` | 不再自动续跑 | 通知型。**状态集成应监听这个，而非 `agent_end`** |
| `ui_prompt_start` / `ui_prompt_end` | 阻塞式扩展 UI 出现/结束前后 | 通知型（best-effort，不 await） |
| `turn_start` / `turn_end` | 每回合（一次 LLM 响应 + 工具调用） | 通知型 |
| `message_start` / `message_update` / `message_end` | 消息生命周期 | `message_end` 可返回 `{ message }` 替换定稿消息（**必须保持同一 `role`**） |
| `context` | **每次 LLM 调用前** | `{ messages: filtered }` 非破坏性替换发给 LLM 的消息（`event.messages` 是深拷贝，可安全修改） |

#### Provider 层

| 事件 | 时机 | 返回值能做什么 |
|---|---|---|
| `before_provider_headers` | 出站 HTTP 头组装后 | **原地 mutate** `event.headers`（赋字符串添加/覆盖，赋 `null` 删除）。⚠️ 每次请求跑一次，**重试复用同一组头，不重触发** |
| `before_provider_request` | provider 载荷构建后、发送前 | 返回其它值**替换载荷**。可重写 provider 级 system instructions（**不会**反映到 `ctx.getSystemPrompt()`） |
| `after_provider_response` | 收到 HTTP 响应后、流被消费前 | 按加载顺序执行 |

**实用示例**（给请求加自定义头）：

```typescript
pi.on("before_provider_headers", (event, ctx) => {
  event.headers["x-session-id"] = ctx.sessionManager.getSessionId();
  event.headers["X-OpenRouter-Title"] = null;  // 删除
});
```

#### 模型 / 工具 / 输入

| 事件 | 时机 | 返回值能做什么 |
|---|---|---|
| `model_select` | 模型切换 | 通知型 |
| `thinking_level_select` | 思考等级切换 | **通知型，返回值被忽略** |
| `tool_call` | 工具调用前 | `{ block: true, reason }` **拦截**；`{ terminate: true }` 终止整个批次；可**原地改 `event.input`** |
| `tool_result` | 工具结果返回后 | 中间件链，按加载顺序执行 |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | 工具执行过程 | 通知型（可用于进度展示） |
| `user_bash` | 用户执行 `!` 命令 | 可拦截/改写 |
| `input` | 用户输入进入前 | 可转换输入 |

### 5.5 `ctx` API 完整清单

`ctx` 是 handler 的第二个参数。**注意 `ExtensionContext` 与 `ExtensionCommandContext` 的区别**——后者只在命令/快捷键中可用。

#### ExtensionContext（事件 handler 也能用）

| 成员 | 用途 |
|---|---|
| `ctx.ui` | UI 交互：`select` / `confirm` / `input` / `editor` / `custom` / `notify` 等 |
| `ctx.mode` | 运行模式；`=== "tui"` 才能用 `custom()`、组件工厂、终端输入 |
| `ctx.hasUI` | 是否有 UI（TUI + RPC 为 true）。**权限类扩展无 UI 时应默认拒绝** |
| `ctx.cwd` | 当前工作目录 |
| `ctx.isProjectTrusted()` | 项目是否被信任 |
| `ctx.sessionManager` | 会话**只读**访问（`ReadonlySessionManager`）：`getCwd()` / `getSessionId()` / `getSessionFile()` / `getLeafId()` / `getLeafEntry()` / `getEntry()` / `getLabel()` / `getBranch()` / `getEntries()` / `getTree()` / `getSessionName()` / `buildContextEntries()` 等。**不含写方法**——`appendLabelChange()` / `branch()` 属于 `SessionManager`，在扩展上下文中不可用 |
| `ctx.modelRegistry` / `ctx.model` / `ctx.thinkingLevel` / `ctx.scopedModels` | 模型注册表与当前状态 |
| `ctx.signal` | `AbortSignal`。⚠️ **空闲/命令/快捷键中通常是 `undefined`，用前判空** |
| `ctx.isIdle()` / `ctx.abort()` / `ctx.hasPendingMessages()` | 控制流助手 |
| `ctx.shutdown()` | 关闭 |
| `ctx.getContextUsage()` | 当前上下文用量 |
| `ctx.compact()` | 触发压缩 |
| `ctx.getSystemPrompt()` | 当前系统提示词 |

#### ExtensionCommandContext 额外提供（⚠️ 只在命令里可用）

| 成员 | 用途 |
|---|---|
| `ctx.getSystemPromptOptions()` | 系统提示词构造选项（含 context 文件内容，**视为敏感数据**） |
| `ctx.waitForIdle()` | 等待 agent 空闲 |
| `ctx.newSession(options?)` | 新建会话 |
| `ctx.fork(entryId, options?)` | 分叉会话 |
| `ctx.navigateTree(targetId, options?)` | 会话树导航 |
| `ctx.switchSession(sessionPath, options?)` | 切换会话 |
| `ctx.reload()` | 重载扩展 |

> ⚠️ **这些方法在事件 handler 中调用会死锁**——这是新手最容易踩的坑之一。

### 5.6 `pi.*` API（ExtensionAPI 方法）

| API | 用途 |
|---|---|
| `pi.on(event, handler)` | 订阅事件 |
| `pi.registerTool(definition)` | 注册工具；**加载期与运行期均可调用**，无需 `/reload` 即刻生效 |
| `pi.registerCommand(name, options)` | 注册 `/name` 命令（`description` / `getArgumentCompletions` / `handler`） |
| `pi.registerShortcut(shortcut, options)` | 注册快捷键，如 `"ctrl+shift+p"` |
| `pi.registerFlag(name, options)` | 注册 CLI flag（`description` / `type: "boolean"` / `default`） |
| `pi.getFlag(name)` | 读取 flag 值 |
| `pi.sendMessage(message, options?)` | 注入自定义消息（进 LLM 上下文）；`triggerTurn` / `deliverAs: "steer" \| "followUp" \| "nextTurn"` |
| `pi.sendUserMessage(content, options?)` | 以用户身份发消息（必触发 turn）；`expandPromptTemplates: true` 可走命令/skill/模板展开 |
| `pi.appendEntry(customType, data?)` | **持久化扩展数据到会话（不进 LLM 上下文）** |
| `pi.registerEntryRenderer(customType, renderer)` | 为 `appendEntry` 的条目注册 TUI 渲染器 |
| `pi.registerMessageRenderer(customType, renderer)` | 为 `sendMessage` 的自定义消息注册 TUI 渲染器 |
| `pi.registerMarkdownTransformer(transformer)` | 链式改写 Markdown 显示（**仅显示层，不改会话存储**） |
| `pi.setSessionName(name)` / `pi.getSessionName()` | 会话显示名 |
| `pi.setLabel(entryId, label)` | 给条目打/清标签（在 `/tree` 中可见） |
| `pi.getCommands()` | 列出所有可用斜杠命令（返回 `SlashCommandInfo[]`） |
| `pi.exec(command, args, options?)` | 执行外部命令 |
| `pi.getActiveTools()` / `pi.getAllTools()` / `pi.setActiveTools(names)` | 工具集管理（见动态加载） |
| `pi.setModel(model)` | 切换模型（**只影响当前会话**，不改 `defaultProvider`/`defaultModel`） |
| `pi.getThinkingLevel()` / `pi.setThinkingLevel(level)` | 思考等级 |
| `pi.events` | 扩展间事件总线 |
| `pi.registerProvider(name, config)` / `pi.unregisterProvider(name)` | 动态注册 Provider |

### 5.7 自定义工具（Custom Tools）

**工具定义完整字段**：

```typescript
pi.registerTool({
  name: "greet",                          // 工具名（LLM 调用时用）
  label: "Greet",                         // UI 显示名
  description: "Greet someone by name",   // 给 LLM 看的说明（决定工具会不会被用）
  promptSnippet: "...",                   // 可选：注入系统提示的工具摘要
  promptGuidelines: ["..."],              // 可选：使用该工具的指导
  parameters: Type.Object({               // typebox schema
    name: Type.String({ description: "Name to greet" }),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return {
      content: [{ type: "text", text: `Hello, ${params.name}!` }],
      details: {},                        // 任意附加数据（供渲染/调试）
    };
  },
});
```

**execute 完整签名**：`(toolCallId, params, signal, onUpdate, ctx) => Promise<{ content, details }>`

- `params`：按 `parameters` schema 校验后的参数
- `signal`：`AbortSignal`
- `onUpdate`：**部分结果回调，用于流式更新**（会 emit `tool_execution_update` 事件）
- 报错请 **throw**，不要靠返回值表达错误

**自定义渲染**：工具可提供 `renderCall` / `renderResult` 控制 TUI 中的呈现（详见 `docs/extensions.md` 的 Custom Rendering 章节）。

**覆盖内置工具**：注册同名工具即可覆盖内置的 `read` / `bash` / `powershell` / `edit` / `write` / `grep` / `find` / `ls`。

### 5.8 可运行代码骨架

#### ① Hello 扩展（最小可运行）

```typescript
// ~/.pi/agent/extensions/my-extension.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // 响应事件
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Extension loaded!", "info");
  });

  // 注册自定义工具
  pi.registerTool({
    name: "greet",
    label: "Greet",
    description: "Greet someone by name",
    parameters: Type.Object({
      name: Type.String({ description: "Name to greet" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}!` }],
        details: {},
      };
    },
  });

  // 注册命令
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Hello ${args || "world"}!`, "info");
    },
  });
}
```

测试：`pi -e ./my-extension.ts`

#### ② 注册自定义工具（官方示例，含 `defineTool`）

```typescript
/**
 * Hello Tool - Minimal custom tool example
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const helloTool = defineTool({
	name: "hello",
	label: "Hello",
	description: "A simple greeting tool",
	parameters: Type.Object({
		name: Type.String({ description: "Name to greet" }),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		return {
			content: [{ type: "text", text: `Hello, ${params.name}!` }],
			details: { greeted: params.name },
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(helloTool);
}
```

> `defineTool()` 用于独立定义工具与数组（如 SDK 的 `customTools: [myTool]`）；内联 `pi.registerTool({...})` 已能正确推断参数类型。

#### ③ 注册斜杠命令（含参数补全）

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("deploy", {
    description: "Deploy to an environment",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const envs = ["dev", "staging", "prod"];
      const items = envs.map((e) => ({ value: e, label: e }));
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      ctx.ui.notify(`Deploying: ${args}`, "info");
    },
  });
}
```

#### ④ 注册快捷键 / flag

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // 注册快捷键
  pi.registerShortcut("ctrl+shift+p", {
    description: "Toggle plan mode",
    handler: async (ctx) => {
      ctx.ui.notify("Toggled!");
    },
  });

  // 注册 CLI flag
  pi.registerFlag("plan", {
    description: "Start in plan mode",
    type: "boolean",
    default: false,
  });

  // 读取值
  if (pi.getFlag("plan")) {
    // plan mode enabled
  }
}
```

> 快捷键 handler 收到 `ctx`（不含参数）；命令 handler 收到 `(args, ctx)`。

#### ⑤ 事件钩子拦截工具调用（permission-gate 模式）

```typescript
/**
 * Permission Gate Extension
 *
 * Prompts for confirmation before running potentially dangerous bash commands.
 * Patterns checked: rm -rf, sudo, chmod/chown 777
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const dangerousPatterns = [/\brm\s+(-rf?|--recursive)/i, /\bsudo\b/i, /\b(chmod|chown)\b.*777/i];

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		const isDangerous = dangerousPatterns.some((p) => p.test(command));

		if (isDangerous) {
			if (!ctx.hasUI) {
				// 非交互模式：默认阻止
				return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
			}

			const choice = await ctx.ui.select(`⚠️ Dangerous command:\n\n  ${command}\n\nAllow?`, ["Yes", "No"]);

			if (choice !== "Yes") {
				return { block: true, reason: "Blocked by user" };
			}
		}

		return undefined;
	});
}
```

**类型化拦截变体**（用 `isToolCallEventType` 窄化并原地改参）：

```typescript
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

pi.on("tool_call", async (event, ctx) => {
  // 内置工具：无需类型参数
  if (isToolCallEventType("bash", event)) {
    // event.input 类型为 { command: string; timeout?: number }
    event.input.command = `source ~/.profile\n${event.input.command}`;

    if (event.input.command.includes("rm -rf")) {
      return { block: true, reason: "Dangerous command", terminate: true };
    }
  }

  if (isToolCallEventType("read", event)) {
    // event.input 类型为 { path: string; offset?: number; limit?: number }
    console.log(`Reading: ${event.input.path}`);
  }
});
```

#### ⑥ 自定义压缩摘要

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  const { preparation, signal } = event;
  const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;

  const model = ctx.modelRegistry.find("google", "gemini-2.5-flash");
  if (!model) return;                               // 回落默认压缩

  const text = serializeConversation(convertToLlm([...messagesToSummarize, ...turnPrefixMessages]));
  const response = await ctx.modelRegistry.complete(model, { messages: [/* 摘要请求 */] },
    { maxTokens: 8192, signal, cacheRetention: "none", sessionId: uuidv7() });

  const summary = response.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  if (!summary.trim()) return;

  return { compaction: { summary, firstKeptEntryId, tokensBefore, usage: response.usage } };
});
```

#### ⑦ 动态注册工具（运行期）

```typescript
export default function dynamicToolsExtension(pi: ExtensionAPI) {
  const registered = new Set<string>();

  const registerEchoTool = (name: string, prefix: string) => {
    if (registered.has(name)) return false;
    registered.add(name);
    pi.registerTool({
      name,
      label: `Echo ${name}`,
      description: `Echo a message with prefix: ${prefix}`,
      promptSnippet: `Echo back user-provided text with ${prefix.trim()} prefix`,
      promptGuidelines: ["Use echo_session when the user asks for exact echo output."],
      parameters: Type.Object({ message: Type.String({ description: "Message to echo" }) }),
      async execute(_id, params) {
        return { content: [{ type: "text", text: `${prefix}${params.message}` }], details: { tool: name, prefix } };
      },
    });
    return true;
  };

  pi.on("session_start", (_e, ctx) => { registerEchoTool("echo_session", "[session] "); });

  pi.registerCommand("add-echo-tool", {
    description: "Register a new echo tool: /add-echo-tool <name>",
    handler: async (args, ctx) => { /* 校验后 registerEchoTool(...) */ },
  });
}
```

#### ⑧ 自定义消息渲染

```typescript
pi.registerMessageRenderer("status-update", (message, { expanded, outputPad }, theme) => {
  const details = message.details as { level: string; timestamp: number } | undefined;
  let text = `${theme.fg(details?.level === "error" ? "error" : "success", "[STATUS]")} ${message.content}`;
  if (expanded && details?.timestamp) {
    text += `\n${theme.fg("dim", `  at ${new Date(details.timestamp).toLocaleTimeString()}`)}`;
  }
  const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
  box.addChild(new Text(text, 0, 0));
  return box;
});

// 发送：
pi.sendMessage({
  customType: "status-update",
  content: "Deploy ok",
  display: true,
  details: { level: "info", timestamp: Date.now() },
});
```

### 5.9 陷阱、限制与安全

#### 安全（最重要）

- **扩展以你的完整系统权限运行，可执行任意代码——只安装可信来源**
- 项目本地 `.pi/extensions` 只有在项目被信任后才加载；`project_trust` 阶段项目本地扩展**尚未加载**，无法参与决策
- `ctx.getSystemPromptOptions()` 可能含完整 context 文件内容，**视为敏感数据**，勿泄入日志/命令列表/补全元数据

#### 生命周期陷阱

| 陷阱 | 正确做法 |
|---|---|
| 在工厂函数里启动后台资源（进程/socket/监听/定时器） | 推迟到 `session_start` 或实际需要时——工厂可能在 `pi --list-models` 这类永不开启会话的调用中运行；在 `session_shutdown`（幂等）里清理 |
| 会话替换后继续用旧对象 | `newSession`/`fork`/`switchSession` 后旧 `pi`/旧 `ctx.sessionManager` 会 throw；只捕获纯数据（字符串、id、序列化配置） |
| `await ctx.reload()` 后继续执行 | 当前 handler 仍在旧调用帧继续跑；正确姿势是 `await ctx.reload(); return;` |
| 工具里调 `ctx.reload()` | 工具拿到的是 `ExtensionContext`，不能直接调；用命令做入口 |
| 在事件 handler 里调命令专属方法 | `ctx.newSession` / `fork` / `switchSession` / `navigateTree` / `reload` / `waitForIdle` / `getSystemPromptOptions` **只在命令里可用**，事件 handler 中会死锁 |

#### 工具与并行

- **工具默认并行执行**：会改文件的自定义工具**必须**用 `withFileMutationQueue(absolutePath, fn)`（传**解析后的绝对路径**，整个读-改-写窗口都要进队列），否则与内置 `edit`/`write` 竞态互相覆盖
- 并行模式下 `tool_call` **不保证**能看到同一 assistant 消息里兄弟工具的结果
- `event.input` 原地 mutate 后**不再做 schema 校验**
- 模型可能给路径参数加 `@` 前缀：内置工具会剥离，自定义路径工具也应自行归一化
- **输出必须截断**：上限 50KB / 2000 行（`DEFAULT_MAX_BYTES` / `DEFAULT_MAX_LINES`），否则上下文溢出、压缩失败、模型降智；截断后要告知 LLM 全量输出存在哪个临时文件

#### 动态工具 / 缓存

- `pi.setActiveTools()` 动态加载**必须纯增量**（不移除现有工具）才能走原生 deferred loading（Anthropic 的 `defer_loading` + `tool_reference`；OpenAI `gpt-5.4+` 的 `tool_search_call`/`tool_search_output`）；非纯增量或其它 provider 走 fallback（全量重发工具列表，**会打爆 prompt prefix 缓存**）
- 激活带 `promptSnippet`/`promptGuidelines` 的工具会重建系统提示，**即使支持 deferred schema 也可能击穿 prefix**；懒加载工具应只依赖 `description`

#### UI / 模式

- `ctx.mode === "tui"` 才能用 `custom()`、组件工厂、终端输入；`ctx.hasUI` 才能用对话框与通知
- RPC 模式 `custom()` 返回 `undefined`；json/print 模式 UI 方法是 no-op
- **无 UI 时权限类扩展应默认拒绝**
- Markdown transformer 是**纯显示层**，且会在流式更新、恢复会话、终端宽度变化时反复跑——**必须同步、便宜**
- 对话框超时返回值：`select` → `undefined`、`confirm` → `false`、`input` → `undefined`
- **主题切换**：预烘焙主题色的组件必须 override `invalidate()` 重建内容，否则换主题不生效
- 调试 UI：`PI_TUI_WRITE_LOG=<path>` 捕获原始 ANSI 流

#### 杂项

- `thinking_level_select` 是通知型事件，返回值被忽略
- `before_provider_headers` 每次请求只跑一次，重试复用同一组头
- **`agent_end` ≠ 完成**：自动重试/压缩重试/队列续接仍可能发生，状态集成应监听 `agent_settled`
- `pi.setModel()` 只影响当前会话，不改 `defaultProvider`/`defaultModel`
- `ctx.signal` 在空闲/命令/快捷键中通常是 `undefined`，用前判空
- 扩展报错只记录日志、agent 继续；但 `tool_call` 内 handler 抛错会**阻塞该工具**（fail-safe）

#### ⚠️ 实战纠偏：警惕网上教程的过时/错误 API

第三方中文教程（含一些流传较广的）里存在这样的写法：

```typescript
// ❌ 错误：这是把 ExtensionContext 当成了入口，且 parameters 用了裸 JSON Schema 对象
export default function myExtension(ctx: ExtensionContext) {
  ctx.registerTool({
    name: "notify_slack",
    parameters: { type: "object", properties: { message: { type: "string" } } },
    execute: async ({ message }) => { /* ... */ },
  });
  ctx.on("session_start", (session) => { /* ... */ });
}
```

**与官方 API 的差异**：

| 网上写法 | 官方写法 |
|---|---|
| `export default function(ctx: ExtensionContext)` | `export default function(pi: ExtensionAPI)` |
| `ctx.registerTool(...)` | `pi.registerTool(...)` |
| `ctx.on("session_start", (session) => ...)` | `pi.on("session_start", (event, ctx) => ...)` |
| `parameters` 用裸 JSON Schema | `parameters: Type.Object({...})`（typebox） |
| `execute: async ({ message }) => {...}` | `execute(toolCallId, params, signal, onUpdate, ctx)` |
| `pi pkg install git@...` | `pi install git:github.com/...` |

**判断标准：以随包 `docs/` 原文和 `examples/` 里的真实源码为准**。本文所有 API 名、事件名、字段名均逐字对照 v0.85.1 的文档与示例核验。
---

## 6. 编程接口：SDK / RPC / JSON / Provider

Pi 不只是终端工具。它有四种运行模式，前三种都能被程序驱动：

| 模式 | 用途 |
|---|---|
| （默认）交互模式 | 人机交互 |
| `-p`, `--print` | 打印响应后退出（可管道） |
| `--mode json` | 所有事件以 JSON lines 输出 |
| `--mode rpc` | RPC 模式，供进程集成（stdin/stdout JSONL） |
| `--export <in> [out]` | 导出会话为 HTML |

```bash
# print 模式还会读取管道输入并合并进初始 prompt
cat README.md | pi -p "Summarize this text"
```

### 6.1 SDK：把 Pi 嵌进 Node.js 应用

**包名**：`@earendil-works/pi-coding-agent`（SDK 内置于主包，无需单独安装）。

```typescript
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai";
```

**创建会话**：`createAgentSession(options?) => Promise<CreateAgentSessionResult>`

```typescript
interface CreateAgentSessionResult {
  session: AgentSession;                     // 会话对象
  extensionsResult: LoadExtensionsResult;    // 扩展加载结果
  modelFallbackMessage?: string;             // 模型无法恢复时的警告
}
```

**主要 options**：

| 选项 | 说明 |
|---|---|
| `cwd` | 工作目录 |
| `agentDir` | 默认 `~/.pi/agent` |
| `model: Model` | 模型 |
| `thinkingLevel` | `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` |
| `scopedModels` | `[{ model, thinkingLevel }]`，Ctrl+P 轮换列表 |
| `tools: string[]` | 内置工具名允许列表 |
| `excludeTools` | 排除工具 |
| `noTools` | `"all"` \| `"builtin"` |
| `customTools` | 自定义工具数组 |
| `resourceLoader` | 默认 `DefaultResourceLoader` |
| `sessionManager` | 会话管理 |
| `settingsManager` | 设置管理 |

未传 model 时的解析顺序：**session 恢复 → settings 默认 → 第一个可用模型**。

**发送 prompt**：

```typescript
await session.prompt("What files are here?");

// 带图片
await session.prompt("What's in this image?", {
  images: [{ type: "image", source: { type: "base64", mediaType: "image/png", data: "..." } }],
});

// 流式期间排队
await session.prompt("Stop and do this instead", { streamingBehavior: "steer" });
await session.prompt("After you're done, also check X", { streamingBehavior: "followUp" });

// 显式排队
await session.steer("New instruction");
await session.followUp("After you're done, also do this");
```

`PromptOptions` 完整字段：

```typescript
interface PromptOptions {
  expandPromptTemplates?: boolean;
  images?: ImageContent[];
  streamingBehavior?: "steer" | "followUp";
  source?: InputSource;
  preflightResult?: (success: boolean) => void;
}
```

**行为要点**：扩展命令（`/mycommand`）立即执行，即使正在流式；流式中未指定 `streamingBehavior` 会抛错；`prompt()` 只在整个 accepted run（含重试）结束后 resolve。

**消费事件流**：`session.subscribe(listener): () => void`（返回退订函数）

`AgentSessionEvent.type` 清单：

| 分类 | 事件 |
|---|---|
| 流式 | `message_update`（内部 `event.assistantMessageEvent.type` 为 `text_delta` / `thinking_delta` 等） |
| 工具 | `tool_execution_start` / `tool_execution_update` / `tool_execution_end` |
| 消息 | `message_start` / `message_end` |
| Agent | `agent_start` / `agent_end` |
| Turn | `turn_start` / `turn_end` |
| 会话 | `queue_update` / `compaction_start` / `compaction_end` / `auto_retry_start` / `auto_retry_end` / `summarization_retry_scheduled` / `summarization_retry_attempt_start` / `summarization_retry_finished` |

**完整可运行示例**：

```typescript
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai";

const { session } = await createAgentSession({
  cwd: process.cwd(),
  model: getModel("anthropic", "claude-sonnet-4-5"),
  thinkingLevel: "medium",
});

// 订阅事件流
const unsubscribe = session.subscribe((event) => {
  switch (event.type) {
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      break;
    case "tool_execution_start":
      console.log(`\n[tool] ${event.toolName}`);
      break;
    case "agent_end":
      console.log("\n[done]");
      break;
  }
});

await session.prompt("List all .ts files in src/ and summarize what they do");

unsubscribe();
await session.dispose();
```

**Agent 状态访问**：`session.agent.state` 含 `messages: AgentMessage[]`、`model`、`thinkingLevel`、`systemPrompt`、`tools`、`streamingMessage?`、`errorMessage?`。可整体替换 `state.messages` / `state.tools`（拷贝顶层数组）。`await session.agent.waitForIdle()` 等待空闲。

**`AgentSession` 成员**：`prompt` / `steer` / `followUp` / `subscribe` / `sessionFile` / `sessionId` / `setModel` / `setThinkingLevel` / `cycleModel` / `cycleThinkingLevel` / `agent` / `model` / `thinkingLevel` / `messages` / `isStreaming` / `navigateTree(targetId, options?)` / `compact(customInstructions?)` / `abortCompaction()` / `abort()` / `dispose()`。

**Session 管理**：

```typescript
SessionManager.inMemory()                              // 不持久化
SessionManager.inMemory(cwd, { id }, entries)          // 从外部存储恢复
SessionManager.create(process.cwd())                   // 新建持久会话
SessionManager.continueRecent(process.cwd())           // 继续最近的
SessionManager.open("/path/to/session.jsonl")          // 打开指定文件
SessionManager.list(cwd) / SessionManager.listAll(cwd) // 列出
```

**会话树 API**：`getEntries()` / `getTree()` / `getLeafEntry()` / `getEntry(id)` / `getChildren(id)` / `getLabel(id)` / `appendLabelChange(id, "checkpoint")` / `branch(entryId)` / `branchWithSummary(id, "Summary...")` / `createBranchedSession(leafId)`。（⚠️ `docs/sdk.md` 还列有 `getPath()`，但 v0.85.1 随包 `dist` 中未见该声明——**需核对**）

**高级层**：`createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager })` 创建 `AgentSessionRuntime`，负责替换活动会话：`newSession()` / `switchSession(path)` / `fork(entryId, { position: "at" })` / `importFromJsonl()`。**替换后 `runtime.session` 变化，需重新 `subscribe`、重新 `bindExtensions`**。内置的 interactive/print/rpc 三种模式都用这一层。

### 6.2 RPC 模式：进程集成

**启动**：`pi --mode rpc`，通过 **stdin/stdout 上的 JSONL** 通信。

**典型用法**：把它当子进程拉起，写入 JSON 请求行，读取 JSON 响应/事件行。

**关键命令**（完整清单见 `docs/rpc.md`）：

| 命令 | 用途 |
|---|---|
| `prompt` | 发送消息 |
| `get_state` | 获取会话状态 |
| `get_entries` | 获取会话条目（支持 `since` 游标增量拉取） |
| `get_commands` | 获取可用命令列表 |
| `set_steering_mode` / `set_follow_up_mode` | 设置队列模式 |
| `clear_queue` | 清空队列 |
| `bash` | 执行 shell 命令 |

**两个实用细节**：

- **`bash` 命令的结果进入 LLM 上下文的时机**：命令立即执行并生成 `BashExecutionMessage` 存入消息状态，但**在下一次 `prompt` 时**才转换为 `Ran \`cmd\` + 输出` 格式发给模型。所以可以先连发多条 bash，再一次 prompt 一起带上下文。
- **`get_entries` 的 `since` 游标语义**：entry id 是持久游标，跨客户端重启仍可用；`since` 不匹配任何 entry id 时返回 `success: false`。

**⚠️ 默认值注意**：`rpc.md` 的示例中显示 `steeringMode: "all"`，但 `set_steering_mode` 一节明确**默认是 `"one-at-a-time"`**——示例值仅为演示，**以命令小节为准**。

**⚠️ 模式差异**：内置 TUI 命令（`/settings`、`/hotkeys`）**不会**出现在 RPC 的 `get_commands` 中，经 `prompt` 发送也不会执行。

### 6.3 JSON 事件流模式

`pi --mode json` 输出结构化事件流（JSON lines）。事件类型与 SDK 的 `AgentSessionEvent` 一致。

**解析要点**（`json.md` 与 `rpc.md` 一致）：

- `message_update` 是 **delta-only**：没有 `partial` 字段也没有累计的完整 `message`
- 用 `contentIndex` + `delta` 组装内容
- **以 `message_end` 为权威**（它才是最终完整消息）

### 6.4 Custom Provider：接入私有模型服务

**两种做法**：

1. **models.json 声明式**（推荐，见 §3.7）——适用于任何 OpenAI/Anthropic/Google 兼容 API
2. **实现 custom provider**（`docs/custom-provider.md`）——需要自定义 API 协议或 OAuth 流程时

**models.json 的 provider 字段**：

| 字段 | 说明 |
|---|---|
| `baseUrl` | API 地址（非内置 provider 必需） |
| `api` | API 类型（provider 级或 model 级） |
| `apiKey` | 可选；**无认证时模型能加载但在 `/model` 中不可用** |
| `oauth` | 动态 OAuth provider 类型（当前支持 `"radius"`） |
| `headers` | 自定义请求头 |
| `authHeader` | `true` 则自动加 `Authorization: Bearer <apiKey>` |
| `models` | 模型列表 |
| `modelOverrides` | 微调内置模型 |

**支持的 API 类型**：`openai-completions`（兼容性最好）、`openai-responses`、`anthropic-messages`、`google-generative-ai`。

**`apiKey` / `headers` 值解析**：

- `!command` 开头 → 整值作为 shell 命令执行取 stdout（models.json 中在**请求时**解析，**不做 TTL/缓存/失败重试**，慢或限流的命令请自己包装缓存）
- `$ENV_VAR` / `${ENV_VAR}` → 环境变量插值；`$$` → 字面 `$`；`$!` → 字面 `!`

### 6.5 TUI 组件：给扩展写终端 UI

Pi 的 TUI 库（`@earendil-works/pi-tui`）用于扩展自定义界面。核心要点：

**组件**：`Text`、`Box`、`SelectList`、`SettingsList`、`Loader` 等来自 `@earendil-works/pi-tui`；`BorderedLoader`、`DynamicBorder` 由 `@earendil-works/pi-coding-agent` 导出。官方建议：**`SelectList` / `SettingsList` / `BorderedLoader` 覆盖 90% 场景，先复用**。

**主题色使用**：

```typescript
theme.fg(color, text)   // 前景色
theme.bg(color, text)   // 背景色
getMarkdownTheme()      // Markdown 渲染主题
```

**颜色类别**：`text` / `accent` / `muted` / `dim` / `searchMatchText`、`success` / `error` / `warning`、`border` / `borderAccent` / `borderMuted`、`userMessageText` / `customMessageText` / `customMessageLabel`、`toolTitle` / `toolOutput`、`toolDiffAdded` / `toolDiffRemoved` / `toolDiffContext`、`mdHeading` / `mdLink` / `mdCode` / `mdQuote` 等、`syntax*`（Comment/Keyword/Function/Variable/String/Number/Type/Operator/Punctuation）、`thinkingOff`…`thinkingMax`、`bashMode`。背景色：`selectedBg` / `searchMatchBg` / `userMessageBg` / `customMessageBg` / `toolPendingBg` / `toolSuccessBg` / `toolErrorBg`。

**ctx.ui 钩子**：

| API | 用途 |
|---|---|
| `ctx.ui.setStatus(key, text \| undefined)` | footer 状态 |
| `ctx.ui.setWorkingIndicator({ frames, intervalMs } \| undefined)` | 流式指示器（空数组隐藏） |
| `ctx.ui.setWidget(key, string[] \| factory, { placement: "belowEditor" }?)` | 编辑器上下方的持久 widget |
| `ctx.ui.setFooter(factory)` | 自定义 footer（`footerData` 提供 `getGitBranch()` / `getExtensionStatuses()` / `onBranchChange()`） |
| `ctx.ui.setEditorComponent(factory \| undefined)` | 自定义编辑器 |
| `ctx.ui.notify(message, "info" \| "warning" \| "error")` | 通知 |

**性能规则**：`render()` 按 width 缓存行数组，`invalidate()` 清缓存并 `tui.requestRender()`。**主题变更时 TUI 会调所有组件的 `invalidate()`**——预烘焙主题色的组件必须 override `invalidate()` 重建内容，否则换主题不生效。

**Key Rules（官方）**：

1. 用回调参数里的 `theme`，勿直接 import
2. `DynamicBorder` 颜色参数显式标 `(s: string)`
3. `handleInput` 改状态后调 `tui.requestRender()`
4. 自定义组件返回 `{ render, invalidate, handleInput }`
5. 先复用 `SelectList` / `SettingsList` / `BorderedLoader`

### 6.6 开发 Pi 本身

```bash
git clone https://github.com/earendil-works/pi
cd pi
npm install --ignore-scripts
npm run build         # 刷新模型数据 + 构建所有包
npm run build         # 刷新模型数据 + 构建所有包
npm run check         # lint + format + type check
./test.sh            # 跑测试（无 API key 时跳过 LLM 相关测试）
./pi-test.sh         # 从源码运行 pi（可在任意目录调用）
```

**仓库结构**：`packages/ai`（LLM provider 抽象）、`packages/agent`（agent 循环与消息类型）、`packages/tui`（终端 UI）、`packages/coding-agent`（CLI 与交互模式）。

**调试**：隐藏命令 `/debug` 写 `~/.pi/agent/pi-debug.log`（含带 ANSI 的渲染行 + 最近发给 LLM 的消息）。

### 6.7 本地模型（llama.cpp）

Pi 支持 llama.cpp **router** 模式（`llama-server` 不带 `--model` 启动，自动发现多 GGUF 模型、按需加载卸载）：

```bash
llama-server --models-dir ~/models --no-models-autoload --jinja \
  --host 127.0.0.1 --port 8080 -ngl 999 -c 32768
```

配置：`/login llama.cpp`（默认 URL `http://127.0.0.1:8080`），或环境变量 `LLAMA_BASE_URL`、`LLAMA_API_KEY`。

管理：`/llama` 加载/卸载/从 Hugging Face 搜索下载（`owner/repository[:quant]`，支持 `HF_TOKEN`）。**只有已加载的模型出现在 `/model`**；Pi 不会静默卸载或删模型。

排错：`curl http://127.0.0.1:8080/health`、`curl .../models`；加载失败或内存高 → 降 `-c` 或卸载别的模型。

---

## 7. 安全、信任与沙箱

### 7.1 信任边界

**Pi 是本地编码 agent，以启动它的用户账号权限运行**。用户可写的文件视为同一信任边界内。

### 7.2 项目信任（Project Trust）

**关键理解：项目信任不是沙箱**，它只控制是否加载项目级配置资源，**不限制模型请求工具做什么**。

**触发信任的资源**（自 cwd 检出）：

- `.pi/settings.json`
- `.pi/extensions`、`.pi/skills`、`.pi/prompts`、`.pi/themes`
- `.pi/SYSTEM.md` 或 `.pi/APPEND_SYSTEM.md`
- 当前或祖先目录的项目 `.agents/skills`

（裸 `.pi` 目录不算。）

**决策流程**：

1. 交互式会话无已存决策时，遵循全局 `defaultProjectTrust`（默认 `"ask"`）
2. 决策按 canonical 目录存于 `~/.pi/agent/trust.json`
3. **当前/父路径上最近的已存决策优先于全局默认**

**信任后允许加载**：`.pi/settings.json`、`.pi` 各类资源、项目 settings 配置的缺失包、项目级扩展。

**拒绝信任则跳过受保护资源**；但 `AGENTS.md`、`CLAUDE.md` 等 context 文件**无论信任与否都加载**（除非禁用 context 加载）。

**非交互模式**（`-p`、`--mode json`、`--mode rpc`）不弹提示：无适用已存决策时，`"ask"` 与 `"never"` 忽略此类资源，`"always"` 信任之。单次运行可用 `--approve` / `-a` 或 `--no-approve` / `-na` 覆盖。

**扩展可以参与信任决策**：用户/全局与 CLI `-e` 扩展可处理 `project_trust` 事件，**第一个返回 yes/no 的扩展拥有决定权**。

### 7.3 无内置沙箱

官方明确：**Pi 没有内置沙箱**。内置工具可读、写、编辑文件并以 Pi 进程权限运行 shell 命令；**扩展是 TypeScript 模块，权限相同**。

> 这是有意设计：真正的隔离必须来自操作系统或虚拟化/容器边界。

**项目信任只是「输入加载闸门」**——防止仓库在你批准前悄悄改 Pi 的 settings/扩展；它**不能**使不可信代码、提示或模型输出变安全。来自仓库文件/注释/文档/context/构建输出的**提示注入是预期的本地 agent 风险，Pi 无法可靠阻止**。

### 7.4 容器化三种模式

跑不可信或无人值守任务时，把整个 `pi` 进程放进容器/VM/微 VM/远程沙箱/策略沙箱，**只给任务必需的文件与凭据**。

| 模式 | 做法 | 要求 |
|---|---|---|
| **Gondolin 扩展** | 主机 Pi + 工具执行路由进本地 Linux micro-VM；覆盖 `read`/`write`/`edit`/`bash`/`grep`/`find`/`ls` 与 `!` 命令；host cwd 挂载为 VM 内 `/workspace` 透写 | Node ≥ 23.6.0 + QEMU |
| **纯 Docker** | 整个 Pi 进程进容器。`node:24-bookworm-slim` 基镜像装 bash/ca-certificates/git/ripgrep 后全局装 Pi；`-v "$PWD:/workspace"`、`-v pi-agent-home:/root/.pi/agent`（⚠️ provider key 会进容器） | Docker |
| **OpenShell** | 策略控制沙箱（filesystem/process/network/credential/inference 管控）；模型密钥可留在沙箱外，经 `https://inference.local` 由网关注入 | gateway（Docker/Podman/VM 或远程 K8s） |
| **Docker Sandboxes (`sbx`)** | 整进程进沙箱；容器内只拿 sentinel 占位值，`sbx` 代理在出口替换真实凭证 | `sbx` |

**Docker Sandboxes 关键提醒**：沙箱内**勿执行 `/login`**（会写入真实 token，破坏代理模型）。

### 7.5 密钥处理要点

- 只传**最少必需**的 API key，或用短时效凭据
- 任务不需要时**限制网络**
- 除非容器需要宿主会话/设置/凭据，否则**不要挂载宿主 `~/.pi/agent`**
- 把结果拷回可信系统前**先审查 diff 与输出**
- bind-mount 为读写时，容器内写入仍会改宿主文件——需更强保护时用**只读挂载**或文件进出拷贝

### 7.6 报告安全问题

按仓库 Security Policy（`github.com/earendil-works/pi-mono/blob/main/SECURITY.md`）；**安全敏感报告不要开公开 issue**。

---

## 8. 学习路线图

### 阶段一：能用（第 1 天）

**目标**：跑通一次可验收的真实任务。

1. `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`
2. `pi` → `/login` 或设 API key
3. 在练习目录给一个小任务，**自己核对输出**
4. 掌握 `@` 引文件、`!` 与 `!!` 的区别、`/model`、`/help`

**验收标准**：你能说清「我怎么知道它做对了」。

### 阶段二：用得舒服（第 1 周）

**目标**：会话与上下文管理变成肌肉记忆。

1. 在项目里写 `AGENTS.md`（**投入产出比最高的一步**）
2. 练习 `-c` / `-r` / `/tree` / `/fork` / `/clone`
3. 理解压缩：什么时候触发、为什么重要结论要写进文件
4. 配置 `models.json` 接入自己常用的模型
5. 从 pi.dev/packages 装 1–2 个扩展（推荐先试 `pi-web-access`）

**验收标准**：遇到长任务不再慌，知道上下文会怎么变。

### 阶段三：定制它（第 2–3 周）

**目标**：让 Pi 适应你的流程。

1. 写第一个 **Skill**（把你反复对模型说的话固化成 `SKILL.md`）
2. 写第一个 **Prompt Template**（`/review` 之类）
3. 用 `--skill` / `-e` 试验，再决定是否装到全局
4. 读 §4.0 的决策表，**纠正自己选错层的习惯**

**验收标准**：重复性的提示词不再手打；有 2–3 个自己的 Skill。

### 阶段四：扩展它（第 1 个月）

**目标**：给运行时加真实能力。

1. 从 §5.8 的骨架复制一个最小扩展，用 `pi -e ./x.ts` 跑通
2. 实现一个 `tool_call` 拦截（安全护栏）
3. 注册一个自定义工具（对接自己的内部系统）
4. 理解并行执行与 `withFileMutationQueue`
5. 读 `docs/extensions.md` 原文（3023 行，值得完整读一遍）

**验收标准**：你有至少一个自用扩展，且知道它为什么必须用 Extension 而不是 Skill。

### 阶段五：集成与生产（第 2 个月+）

**目标**：把 Pi 变成系统的一部分。

1. 用 SDK 把 Pi 嵌进自己的 Node 应用（§6.1）
2. 或用 RPC 模式做进程集成（§6.2）
3. 打包自己的 Pi Package 分享（§4.4）
4. 上容器化方案（§7.4）
5. 关注上游演进（仓库近期提交中出现 `docs(agent): track extension v2 design`，提示扩展体系正在设计下一代）

### 常见误区速查

| 误区 | 正解 |
|---|---|
| 用 Extension 做 Skill 的事 | 先问「一段 Markdown 够不够」 |
| 期望 Pi 有权限弹窗 | 它刻意没有；用扩展或容器 |
| 把「Agent 说完成了」当完成 | 自己核对输出 |
| 依赖对话历史记住结论 | 写进文件 |
| 在事件 handler 里调 `ctx.newSession` | 会死锁；只在命令里用 |
| 自定义写文件工具不加锁 | 必须用 `withFileMutationQueue` |
| 工具输出不截断 | 上限 50KB / 2000 行 |
| 改了环境变量却不生效 | 检查 `auth.json`（优先级更高） |
| 在不可信仓库直接 `pi` | 先看信任提示，或直接进容器 |
| 照抄网上教程的 API | 以随包 `docs/` 与 `examples/` 为准 |

---

## 9. 附录

### 9.1 文件与目录速查

| 路径 | 内容 |
|---|---|
| `~/.pi/agent/settings.json` | 全局设置 |
| `.pi/settings.json` | 项目设置（需信任） |
| `~/.pi/agent/models.json` | 自定义模型与 Provider |
| `~/.pi/agent/auth.json` | 凭证（0600，优先于环境变量） |
| `~/.pi/agent/trust.json` | 项目信任决策 |
| `~/.pi/agent/AGENTS.md` | 全局上下文文件 |
| `~/.pi/agent/SYSTEM.md` | 系统提示词覆盖 |
| `~/.pi/agent/skills/` | 全局 Skills |
| `~/.pi/agent/prompts/` | 全局 Prompt Templates |
| `~/.pi/agent/extensions/` | 全局 Extensions |
| `~/.pi/agent/sessions/` | 会话存储（JSONL） |
| `~/.pi/agent/npm/` | npm 包安装位置 |
| `~/.pi/agent/git/` | git 包克隆位置 |
| `~/.pi/agent/pi-debug.log` | `/debug` 输出 |
| `.pi/extensions/` `.pi/skills/` `.pi/prompts/` `.pi/themes/` | 项目级资源（需信任） |
| `~/.agents/skills/` | 跨工具约定的全局 skills |

### 9.2 CLI 参数速查

**模式与输出**

| 参数 | 说明 |
|---|---|
| `-p`, `--print` | 打印响应后退出 |
| `--mode json` | JSON 事件流 |
| `--mode rpc` | RPC 模式 |
| `--export <file>` | 导出会话为 HTML |
| `--verbose` | 强制详细启动 |
| `--offline` | 禁用启动网络操作（同 `PI_OFFLINE=1`） |

**模型**

| 参数 | 说明 |
|---|---|
| `--provider <name>` | Provider |
| `--model <pattern>` | 模型 pattern（支持 `provider/id` 与可选 `:<thinking>`） |
| `--api-key <key>` | API key（覆盖环境变量） |
| `--thinking <level>` | `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max` |
| `--models <patterns>` | Ctrl+P 循环列表（支持 glob 与模糊匹配） |
| `--list-models [search]` | 列出可用模型 |

**资源加载**

| 参数 | 说明 |
|---|---|
| `-e`, `--extension <path>` | 加载扩展（可重复） |
| `--no-extensions` | 禁用扩展发现 |
| `--skill <path>` | 加载 skill（可重复） |
| `--no-skills` | 禁用 skills 发现 |
| `--prompt-template <path>` | 加载模板 |
| `--no-prompt-templates` | 禁用模板发现 |
| `--theme <path>` / `--use-theme <name>` / `--no-themes` | 主题 |
| `--no-context-files`, `-nc` | 禁用 AGENTS.md / CLAUDE.md 发现 |

**工具**

| 参数 | 说明 |
|---|---|
| `--no-tools`, `-nt` | 禁用所有工具 |
| `--no-builtin-tools`, `-nbt` | 禁用内置工具，保留扩展工具 |
| `--tools`, `-t <list>` | 工具允许列表 |
| `--exclude-tools`, `-xt <list>` | 工具排除列表 |

**其他**

| 参数 | 说明 |
|---|---|
| `--system-prompt <text>` | 覆盖系统提示词 |
| `--append-system-prompt <text>` | 追加系统提示词（可重复） |
| `--tui-mode <mode>` | `regular` / `fullscreen` |
| `-a`, `--approve` / `-na` | 信任/忽略项目本地文件 |
| `--` | 结束选项解析 |

### 9.3 官方文档索引（随包 `docs/`，30 篇 Markdown + `docs.json`）

| 文件 | 主题 |
|---|---|
| `index.md` | 总目录 |
| `quickstart.md` | 安装、认证、首次会话 |
| `usage.md` | 交互模式、斜杠命令、CLI 参考 |
| `providers.md` | 订阅与 API key 设置 |
| `security.md` | 信任边界、沙箱、漏洞报告 |
| `containerization.md` | Gondolin / Docker / OpenShell |
| `settings.md` | 全局与项目设置 |
| `keybindings.md` | 快捷键与自定义 |
| `sessions.md` | 会话管理、分支、树导航 |
| `session-format.md` | JSONL 格式、条目类型、SessionManager API |
| `compaction.md` | 上下文压缩与分支摘要 |
| `extensions.md` | **扩展开发（3023 行，进阶必读）** |
| `skills.md` | Skills 规范 |
| `prompt-templates.md` | 提示词模板 |
| `themes.md` | 主题与颜色 token |
| `packages.md` | 打包与分发 |
| `models.md` | 自定义模型 |
| `custom-provider.md` | 自定义 API 与 OAuth |
| `sdk.md` | Node.js SDK |
| `rpc.md` | RPC 模式 |
| `json.md` | JSON 事件流 |
| `tui.md` | TUI 组件 |
| `environment-variables.md` | 环境变量 |
| `windows.md` / `termux.md` / `tmux.md` / `terminal-setup.md` | 平台设置 |
| `shell-aliases.md` | shell 别名 |
| `llama-cpp.md` | 本地模型 |
| `development.md` | 从源码开发 |
| `docs.json` | 文档导航配置 |

**本地路径**（本机实测）：

```
C:\Users\84168\AppData\Local\nvm\v22.22.2\node_modules\@earendil-works\pi-coding-agent\docs\
```

> `C:\nvm4w\nodejs` 是 nvm-windows 的符号链接，指向当前激活的 Node 版本目录。

### 9.4 精选外部资源

**官方**

| 资源 | 链接 |
|---|---|
| 官方网站 | https://pi.dev |
| 官方文档 | https://pi.dev/docs/latest |
| 包目录（5424 个） | https://pi.dev/packages |
| 版本公告 | https://pi.dev/news |
| GitHub 仓库 | https://github.com/earendil-works/pi |
| npm 包 | https://www.npmjs.com/package/@earendil-works/pi-coding-agent |
| Discord 社区 | https://discord.com/invite/3cU7Bz4UPx |
| 作者博客（设计理念） | https://mariozechner.at/posts/2025-11-30-pi-coding-agent/ |
| 为什么不需要 MCP | https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/ |

**中文社区**

| 资源 | 说明 |
|---|---|
| Pi 中文学习蓝皮书 | https://pi.xiaomovps.com —— 小墨同学整理，非官方，按「场景 → 概念 → 实操 → 验收」组织，含 14 课 + 8 个案例 + Earendil 官方授权译文专区 |
| pi-bluebook 仓库 | https://github.com/xiaomoBoy/pi-bluebook |
| Pi 中文文档 | https://pi-doc.com/docs/latest/skills.html |
| 模块化 Agent Harness 架构深度解析 | 第三方架构分析，含 Agent Loop / Tool Calling 三阶段 / Skill / Compaction 源码级拆解 |

**推荐 Skills 来源**

| 来源 | 内容 |
|---|---|
| Anthropic Skills | docx / pdf / pptx / xlsx 文档处理 |
| `badlogic/pi-skills` | web search、浏览器自动化、Google APIs、转写 |

### 9.5 核验说明

本文所有 API 名、事件名、字段名、命令、路径均逐字对照以下一手来源核验：

- `@earendil-works/pi-coding-agent` **v0.85.1** 随包 `docs/`（30 篇 Markdown，含 3023 行的 `extensions.md`）
- 同包 `examples/extensions/` 真实源码（`hello.ts`、`permission-gate.ts`、`commands.ts`、`dynamic-tools.ts`、`custom-compaction.ts`、`message-renderer.ts` 等）
- `package.json`、`README.md`（含 Philosophy 章节原文）
- pi.dev 官方站点（文档地图、包目录、News）
- GitHub 仓库 earendil-works/pi（版本、生态数据）
- 本机实测：`settings.json`、`models.json`、`trust.json`、skills 目录结构

**文档未明但已从随包源码确认的条目**（本版已核实，可放心依赖）：

1. **`AGENTS.md` 与 `CLAUDE.md` 的优先级**：候选顺序为 `AGENTS.override.md` → `AGENTS.md` → `AGENTS.MD` → `CLAUDE.md` → `CLAUDE.MD`，取第一个命中，即 **`AGENTS.md` 优先于 `CLAUDE.md`**（依据 `dist/core/resource-loader.js`）
2. **扩展加载先后次序**：项目本地 `cwd/.pi/extensions/` → 全局 `agentDir/extensions/` → settings/CLI 显式路径（依据 `dist/core/extensions/loader.js`）
3. **`writeTempFile()` 不是正式导出**：`dist` 全树无此符号，`index.d.ts` 未导出（`docs/extensions.md` 的示例使用了未导出符号）
4. **扩展间同名工具是先注册者胜**（`first registration per name wins`）；扩展工具可覆盖内置工具是因为注册顺序在内置之后

**仍需核对**（文档与构建产物不一致，或未验证）：

1. `ctx.abort()` 的确切行为语义
2. `SessionManager.getPath()`：`docs/sdk.md` 有，但 v0.85.1 随包 `dist` 中未见声明

**无法在本地核实的第三方数据**（来自 GitHub/pi.dev 站点快照，非官方文档）：

- Stars 107k / Forks 13.5k / Releases 259 / Contributors 290 / npm 包数 5424 / TypeScript 占比 95.1%
- §9.4 的外部与中文社区资源链接

**已纠正的外部错误信息**：

- 某些第三方教程使用 `ctx.registerTool()` / `ctx.on()` / 裸 JSON Schema 作为参数定义，**与官方 `pi.registerTool()` / `pi.on()` / typebox 不符**（详见 §5.9 末尾对比表）
- `pi pkg install` 并非官方命令，正确命令是 `pi install`

---

*本文档基于 Pi v0.85.1 编写，核验日期 2026-09-13。Pi 迭代速度很快（GitHub 上有 259 个 release，CHANGELOG 记录 274 个版本条目），涉及具体 API 时请以随包 `docs/` 与官方仓库为准。*
