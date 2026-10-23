# ZCode → PI-Desktop：可插件化增强的深度分析

> 调查对象：`E:\code\ai-platform-amd64\ZCode`（AI 编程工作台 monorepo，108 MB）
> 对比基准：`E:\code\ai-platform-amd64\PI-Desktop`（插件 SDK 39 项权限 + ~300 篇 ADR）
> 落点工作区：`E:\code\ai-platform-amd64\pi-plug`（现有 27 个插件 + 8 个本地开发插件）
> 结论日期：本次会话

---

## 0. 结论速览

ZCode 与 PI-Desktop 是**同一物种的两个个体**：都是 Electron + Agent 运行时 + 插件生态的 AI 编程工作台。但两者的差异化押注不同——

- **ZCode 押注「Agent 写的程序」**：让模型写 TypeScript 脚本来编排多个子 Agent，带编译期类型检查、沙箱执行、崩溃可恢复、因果图可视化。
- **PI-Desktop 押注「宿主治理的边界」**：~300 篇 ADR 把权限、所有权、事件顺序、失败语义钉死，插件 API 有 39 项显式权限、40+ 受审宿主操作。

**最大的发现**：ZCode 的旗舰能力（dynamic-workflow）恰好落在 PI-Desktop 插件 API 的**能力范围内**——不是因为 PI-Desktop 弱，而是因为它的插件面已经足够宽（`desktop.control` + `session:turnEnded` + 插件进程保留原生 Node 内建 + 50 MB 可捆绑依赖）。这是一个可以直接补上的空白。

### 可行性矩阵

| # | 能力 | 插件可行 | 价值 | 工作量 | 建议 |
|---|------|:---:|:---:|:---:|------|
| 1 | 脚本化工作流编排（dynamic-workflow 移植） | ✅ 完全 | ★★★★★ | 大 | **P0 必做** |
| 2 | 产物看板（artifact chart/table/metrics/board） | ✅ 完全 | ★★★★☆ | 中 | **P0 必做** |
| 3 | 架构治理器（module/layer/cycle 检查） | ✅ 完全 | ★★★★☆ | 中 | **P1** |
| 4 | 符号级依赖查询（dep:refs） | ✅ 完全 | ★★★☆☆ | 小 | **P1** |
| 5 | 状态空间枚举器（formal-proof 移植） | ✅ 完全 | ★★★★☆ | 中 | **P1** |
| 6 | Skill 来源锁定与哈希校验 | ✅ 完全 | ★★★☆☆ | 小 | **P2** |
| 7 | 工作流因果图可视化 | ✅ 完全 | ★★★★☆ | 中 | 并入 #1 |
| 8 | 手机远控 / relay | ❌ 宿主 | ★★★★★ | 极大 | 需宿主改 |
| 9 | 插件商店分段 IA | ❌ 宿主 | ★★★☆☆ | 大 | 需宿主改 |
| 10 | Computer Use（CUA） | ⚠️ 部分 | ★★★★☆ | 极大 | 需宿主改 |
| 11 | 原生搜索工具链打包 | ❌ 构建链 | ★★☆☆☆ | 中 | 不适用 |
| 12 | Agent 字节码保护 | ❌ 构建链 | ★★☆☆☆ | 小 | 不适用 |

---

## 1. ZCode 的八项差异化能力

### 1.1 Dynamic Workflow：Agent 写的程序（★★★★★ 最有价值）

**它是什么。** 主 Agent 不再用一串工具调用手工编排子代理，而是**写一份 TypeScript 脚本**。脚本里 `agent(name).ask<T>(instructions)` 创建一个持久化 actor 并派发任务，返回一个 `Node<T>`（thenable），可以直接 `await` 或 `Promise.all` 做 join。

源码证据（`ZCode/apps/zcode-cli/packages/dynamic-workflow/README.md`）：

> Self-contained library for the dynamic workflow feature: the TypeScript facade the main agent writes scripts against, and **the compiler that recovers rigor from those scripts (typecheck, schema synthesis, dependency inference, site identity)**.

模型面 API 只有三个名词（`ZCode/apps/zcode-cli/packages/dynamic-workflow/src/facade/dts.ts`，22 KB，作为嵌入字符串资产随 CLI 分发）：

```ts
declare function agent(name?: string, persona?: string | AgentPersona): Agent;
declare interface Agent {
  ask<T = string>(instructions: string): Node<T>;   // T 是脚本里定义的 interface
}
declare function log(message: string): void;
declare function report(item: unknown, artifactId?: string): void;
declare function phase(name: string): void;
declare function artifact.file(id, path, opts?): Promise<ArtifactRef>;   // 效应
declare function artifact.markdown(id, text, opts?): Promise<ArtifactRef>;
declare function artifact.chart(id, spec): void;    // 声明
declare function artifact.table(id, spec): void;
declare function artifact.metrics(id, spec): void;
declare function artifact.board(id, spec): void;
```

**关键设计**：`ask<T>` 里的 `T` 是脚本自己写的 `interface`。编译器从类型**合成运行时 JSON Schema**，子代理拿到的是类型化的 `submit_result` 工具——不是"请返回 JSON"的祈祷。

**沙箱执行**（`ZCode/apps/zcode-cli/packages/dynamic-workflow-runtime/README.md`）：

```
┌─ parent (harness) ──────────────┐  NDJSON  ┌─ child (vm.createContext) ──────┐
│ runWorkflowScript               │  stdio   │ 只含 ES intrinsics + __host      │
│  - lower(scriptText)            │◀────────▶│ createActor 同步返回 local 句柄   │
│  - WorkflowEngine(driver,...)   │          │ ask/worldRead → 请求父进程        │
│  - 桥接 __host.* ↔ engine       │          │ args 冻结全局（spawn 时过界一次） │
│  - spawn/kill/timeout/abort     │          │ Date.now/Math.random 运行期禁令   │
└─────────────────────────────────┘          └──────────────────────────────────┘
```

沙箱纪律：子进程只含 ES intrinsics + `__host`；`Date.now` / `Math.random` 在运行期被禁（保证重放确定性）；`args` 在 spawn 时冻结一次。

**工具族**（`ZCode/apps/zcode-cli/packages/contracts/src/tools/`）：

| 工具 | 常量 | 职责 |
|---|---|---|
| `CreateWorkflow` | `CREATE_WORKFLOW_TOOL_NAME` | 编译并后台启动一次 run（`script` / `saved` / `path` 三选一） |
| `AmendWorkflow` | `AMEND_WORKFLOW_TOOL_NAME` | 修订重跑，按 actor 名字复用已完成工作 |
| `SaveWorkflow` | `SAVE_WORKFLOW_TOOL_NAME` | 把脚本存成项目内可复用定义（带 `args` 声明） |
| `ResumeWorkflowRun` | `RESUME_WORKFLOW_RUN_TOOL_NAME` | 恢复 cancelled / failed+Interrupted 的 run |
| `GetWorkflowRun` | `GET_WORKFLOW_RUN_TOOL_NAME` | 单 run 自适应详情（进度 / 产物 / 失败 / 阶段 / 子代理 / 健康） |
| `ListWorkflowRuns` / `ListSavedWorkflows` | — | 枚举面 |
| `ResolveWorkflowQuestion` | — | 主代理回答 actor 的升级问题 |
| `EvalWorkflowSnippet` | — | 世界读取 + 纯逻辑的工作台（无 run、无 artifact） |

**崩溃恢复**：脚本逐字节落库（`dwf_run.script_text`），resume 以 `scriptHash` 为前提；已完结节点纯 replay，未完结节点重新派发；`args` 落 `dwf_run.args_json`，resume 重放存下的那一份，永不接受新的。

**升级通道**（`ZCode/apps/zcode-cli/packages/contracts/src/interfaces/workflow-escalate.port.ts`）：actor 遇到阻塞问题时可以 `escalate` 向主代理提问并**阻塞等待**。设计上刻意不设超时——

> resolve 可能耗时任意长（按设计不设超时——「超时后自行判断」恰恰重新引入本特性要消灭的投机绕过）。

**可视化**（`ZCode/packages/ui/src/components/workflow-timeline/`，40 个文件）：
- `timeline-model.ts`（20.6 KB）——纯函数把 run 投影折成**站（阶段）/ 轨道段 / 弧**三样东西，无 React、无 DOM、无时间。注释写明「一个模型，三处消费」：聊天卡、确认窗、侧栏清单都从这里出发。
- `timeline-geometry.ts` / `timeline-bands.ts` / `timeline-ledge.ts` / `timeline-summary.ts`
- `WorkflowAgentFace.tsx`（agent 头像，九色固定调色板按实例序号分配）、`WorkflowMarchLight.tsx`（行进光）、`WorkflowTimelineArcs.tsx`（跨轨道弧）
- `DESIGN.md` 有专门的 `--color-workflow-*` 令牌族

**四类分析投影**（`ZCode/apps/zcode-cli/packages/dynamic-workflow/README.md`）：site-graph（站点图）、causality-graph（因果图）、actor-graph（参与者图）、control-flow-graph（控制流图）、handoff-graph（交接图）。每个都有 Mermaid 发射器和规范文本形式。

---

### 1.2 产品行为状态空间枚举器（formal-proof，★★★★☆）

`ZCode/packages/formal-proof/README.md`：

> 这是 ZCode 的产品行为状态空间枚举器。当前版本聚焦对话场景里的 compact、fork、goal、消息队列和 query 编辑组合。

`ZCode/packages/formal-proof/src/model.ts`（25 KB）定义了状态机：

```ts
export type RunPhase = "idle" | "running" | "completed" | "compacting" | "goalVerifying";
export type QueueState = "empty" | "text" | "goal" | "compact" | "mixed";
export type CompactMemory = "never" | "compactable" | "justCompacted" | "notNeeded";
export type GoalState = "none" | "active" | "verifying" | "verified" | "failed";
export type TurnTarget = "latest" | "old" | "none";
export type DecisionKind = "allow" | "reject" | "enqueue" | "choice" | "system" | "undefined";
```

枚举 `ProductContext`（7 个维度）× `Candidate`（用户动作 8 种 + 系统事件 6 种）→ `Decision`（带 `ruleId` / `reason` / `next` / `assertion`）→ `TraceNode` 树 → `TraceStats`。

**为什么值得移植**：PI-Desktop 有 ~300 篇 ADR 描述状态机（compaction、turn queue、plan checkpoint、subagent lifetime），但**没有枚举器**。ADR 写得再细，也是散文；枚举器把散文变成可遍历的树，每个叶子挂一条断言和一个 E2E 场景 id。这是"用状态空间证明替代 E2E 覆盖"的思路。

---

### 1.3 架构治理（★★★★☆）

`ZCode/architecture-policy.yaml` 是**可执行策略**（AGENTS.md 明确：「可执行策略是 `architecture-policy.yaml`；不要在本文件或 AGENTS.md 中复制其规则」）：

```yaml
modules:
  - id: storage
    roots: [packages/services/src/storage]
    managed: true
    requires: [shared, rpc, services]
    publicEntrypoints: [packages/services/src/storage/contract.ts]
    layers: { domain: domain, app: app, adapters: adapters }
    layerOrder: [domain, app, adapters]
    owner: desktop-settings

global:
  maxFileLines: 400
  maxContractLines: 300
  maxPublicMethods: 12
  forbidCycles: true
  forbidDeepImports: true
  managedOnly: true
```

四个命令（`ZCode/package.json`）：
- `architecture:check [--changed]` — 检查
- `architecture:report` — 报告
- `architecture:baseline:update` — 只在校阅过的变更有意改变遗留基线时使用；**CI 从不自动刷新基线**
- `architecture:context <module-id>` — 生成**受控上下文包**（模块阅读包）

分层纪律写死在 skill 里（`ZCode/.agents/skills/architecture-governance/SKILL.md`）：

> `domain` 是纯的（无 IO，不对世界 `await`），`app` 通过端口决定副作用，`adapters` 执行它们，`ui` 只依赖本模块的 `contract.ts`。快速测试：需要 `await`？不是 domain。知道自己是 sqlite / MessagePort / 定时器？是 adapters。

**与 PI-Desktop 的差距**：PI-Desktop 有 `docs/architecture/allowlist.json` + `scripts/check-architecture.mjs`，但**只做文件行数预算**（main/index.ts ≤ 1500、app-store.ts ≤ 1000、新增 TS/TSX ≤ 800、Rust > 1000 需申请）。没有模块依赖方向、没有分层检查、没有环检测、没有深导入检查、没有公共入口强制。

---

### 1.4 符号级依赖查询（dep:refs，★★★☆☆）

`ZCode/package.json`：`dep:refs = node scripts/dep-refs.mjs`，配合 `knip` 使用。

`ZCode/.agents/skills/dep-refs/SKILL.md`：

> Use the repository's `pnpm dep:refs` CLI to answer **symbol-level** questions before changing or deleting TypeScript exports.

能力：`--list-exports <file>`、查某导出的引用点、删除前证明无人使用、重构时追谁 import 了某符号。与 knip 的"未使用导出"结果互补——knip 说"看起来没人用"，dep:refs 说"具体谁在用"。

---

### 1.5 Skill 来源锁定（skills-lock.json，★★★☆☆）

`ZCode/apps/zcode-cli/skills-lock.json`：

```json
{
  "version": 1,
  "skills": {
    "vercel-react-best-practices": {
      "source": "vercel-labs/agent-skills",
      "sourceType": "github",
      "skillPath": "skills/react-best-practices/SKILL.md",
      "computedHash": "ca7b0c0c6e5f2750043f7f0cd72d16ac4e2abc48f9b5500d047a4b77a2506212"
    }
  }
}
```

从 GitHub 拉取技能并**锁定哈希**，可检出漂移。PI-Desktop 有 skill market（ADR 0243，`skills.create` 写路径 + 公共 HTTPS 分类器），但**没有来源追踪、没有哈希锁定**。

---

### 1.6 Browser Use 的插件化架构（参考价值 ★★★★☆）

`ZCode/apps/zcode-cli/packages/browser-use-plugin/README.md` 展示了一个值得借鉴的分层：

- **`node_repl` 共享宿主**（`ZCode/apps/zcode-cli/packages/node-repl-host/`）——只暴露一个 `js` 工具（模型面 `mcp__node_repl__js`）。每次调用开一个**全新 kernel**，import 只限 `node:*` 内建和 skill root 下的绝对 `file://` URL。
- **连续性由 BrowserControl tabs 提供，不是 JS 全局**——这是关键洞察：不依赖长驻进程状态，而依赖外部资源句柄。
- **宿主独立成包的理由**（README 原文）：宿主是**官方能力共用的**，不属于任何一个插件。它过去长在 `browser-use-plugin` 里，后果是「改 Computer Use 必须动 browser-use 这个包」。
- **两个技能**：`control-browser`（DOM snapshot → locator → act 工作流）、`web-gui-tester`（纯 GUI 黑盒测试，要求 Browser Use 语义证据 + 受检截图）。
- **ZCode 自己的插件格式** `.zcode-plugin/plugin.json`，极简：`name` / `version` / `description` / `author` / `license` / `skills`。

---

### 1.7 双链路语义（★★★★★ 但需宿主改）

`ZCode/AGENTS.md` 把两条链路的区别写成了硬约束：

> Desktop 的 `desktop-continuous` 实时链路与手机的 `web-remote-replayable` 恢复链路必须明确区分。修改 stream、snapshot、queue 或重连时，同时验证两种语义。

以及：

> 手机远控连接桌面已有 Host attachment，复用会话运行时；不为手机另起 Agent、Local Host 或远程会话。

> 外部 relay 与 Main 只做鉴权、配对、心跳、转发及 attachment 调度，**不保存任务队列、快照等业务状态**。

这是"同一 owner、同一序号，两种投递语义"的设计——桌面是连续直播流，手机是可重放的快照+缺口修复。

---

### 1.8 其他值得记录的点

| 能力 | 证据 | 说明 |
|---|---|---|
| **CommandInbox 串行 admission** | `ZCode/AGENTS.md` | 已接受的 busy/running 输入由 CLI/runtime 串行 admission；Renderer 只保留未提交草稿与 pending optimistic overlay |
| **Workspace Identity 隔离** | `ZCode/AGENTS.md` | `workspaceIdentity` 管身份隔离，`workspacePath` 管文件操作；身份 key 统一为 `workspaceIdentity?.trim() \|\| workspacePath` |
| **model-option-map** | `ZCode/packages/model-option-map/src/` | 完整 tokenizer/parser/compiler/evaluator/merge-patch——把模型选项映射编译成可求值表达式 |
| **原生搜索工具链** | `ZCode/scripts/native-search-tools-*.mjs` | 跨平台原生二进制打包（Windows PE / Unix / CMake），含 verify 与 package |
| **Agent 字节码保护** | `ZCode/scripts/build-desktop-agent-bytecode.mjs` | 把桌面 Agent 编译成字节码防逆向 |
| **插件商店 IA** | `ZCode/CONTEXT.md` | Official Marketplace / Personal Source / Catalog Auto-Refresh / Manual Refresh / Public Segment / Personal Segment / Featured / Installed Strip / Manage Installed View / Restorable Builtin / Orphaned Installed Plugin |
| **CUA 契约（未实装）** | `ZCode/packages/zcode-cua/README.md` | API 兼容占位包，所有运行时面 fail-closed；但 broker / PiP session / frame contract / helper health 契约完整 |
| **确定性归档** | `ZCode/scripts/deterministic-tar-archive.mjs` | 可复现的 tar 打包 |

---

## 2. 为什么这些能力**能**做成 PI-Desktop 插件

判断依据来自 PI-Desktop 的插件 SDK 与规格，而非猜测。

### 2.1 插件进程保留原生 Node 内建

`PI-Desktop/docs/zh-CN/spec/07-plugins/01-plugin-system.md` 原文：

> 当前实用程序进程插件运行时不是 Node 功能沙箱：插件代码可以独立于 `pi.*` 到达原始 Node 内置函数。

**推论**：插件可以自由使用 `node:child_process`（沙箱子进程）、`node:vm`（vm.createContext）、`node:crypto`（哈希）、`node:path` 等。dynamic-workflow 的沙箱 harness 原样可搬。

### 2.2 可捆绑第三方依赖

`PI-Desktop/docs/zh-CN/spec/07-plugins/06-plugin-packaging.md`：

> 如果插件需要第三方库：自己将它们捆绑到插件目录中

包上限：**解压后 50 MB / 2000 个文件**。TypeScript 编译器（`typescript` 包）约 20 MB——**在预算内**。这意味着编译期类型检查 + schema 合成可以原样实现。

### 2.3 插件能驱动真实会话（关键）

`PI-Desktop/apps/desktop/electron/main/mcp-control.ts` 的 `desktop.control` 操作目录里有：

```
spec("sessionCreate",  "session/create",  "Create a durable session.",   "write", ["input"])
spec("agentPrompt",    "agent/prompt",    "Send a prompt to a session's Agent.", "write", ["request"])
spec("agentAbort",     "agent/abort",     "Abort an active Agent turn.",  "write", ["request"])
spec("agentGetStatus", "agent/getStatus", "Read Agent runtime status.",   "read",  ["sessionId"])
spec("sessionGet",     "session/get",     "Read a session and its transcript.", "read", ["input"])
spec("sessionList",    "session/list",    "List durable sessions.",       "read",  [])
spec("sessionConfigure","session/configure","Configure a session for its next turn, including permission mode.","dangerous",["id","config"])
```

**推论**：`agent(name).ask(task)` 可以完整映射到 `session/create` + `agent/prompt` + `agent/getStatus`。这正是 `pi.session-orchestrator` 已经在做的事（ADR 0237 记录了 `SessionTask` 的 spawn/send/supervise/status/wait/result/accept/cancel/list/models）。

### 2.4 有完成通知，不需要轮询

`PI-Desktop/docs/adr/0252-plugin-host-turn-end-event.md` 定义了宿主事件：

```
session:turnEnded → { sessionId, turnId, reason: "completed" | "aborted" | "error" }
```

> The event travels on the existing plugin event channel to every loaded plugin... subscribing to an unknown event name does not error.

**推论**：工作流引擎等待 actor 完成不必轮询（对比：ADR 0237 说 session-orchestrator 当前靠 1 秒轮询，因为"直到生命周期订阅存在"）。插件可以用 `pi.events.on("session:turnEnded", ...)` 做事件驱动调度。

### 2.5 有常驻服务与跨插件总线

- `pi.services.register({ id, start, stop? })` + `background.service` 权限 → 常驻调度循环
- `pi.bus.publish/subscribe` + `bus.publish`/`bus.subscribe` 权限 → 多插件协作（64 KB/消息、16 订阅/插件、100 发布/10 秒）
- `pi.agent.complete({ modelKey, system, messages, includeSessionContext })` + `agent.complete` 权限 → 宿主代发一次性补全（凭据不出宿主）

### 2.6 有工作面板视图与浮窗

- `contributes.views[]` + `ui.view` → 停靠在右侧工作面板的隔离 HTML 页（同一插件可声明多个，如 Git 插件可出"Changes"和"History"）
- `contributes.ui.panel` + `ui.panel` → 独立窗口；`ui.shape: "widget"` → 透明无边框置顶浮窗
- 图标是**闭集**（`PLUGIN_VIEW_ICONS`，25 个 token），不接受插件 SVG——防注入

### 2.7 有完整开发与分发链

- `PluginScaffold` / `PluginCheck` / `PluginPack` 三个 Agent 工具
- `pnpm pi-plugin init|check|pack|publish` CLI
- 四个官方模板：`panel-basic` / `agent-tool-basic` / `skill-pack` / `full-demo`
- `publish` 记录规范化仓库 URL + commit + 子目录 + 校验和（拒绝有未提交改动的工作区）

---

## 3. P0：两个必做插件

### 3.1 `pi.workflow` — 脚本化工作流编排器

**目标**：把 ZCode 的 dynamic-workflow 核心语义搬进 PI-Desktop，让 Agent 写 TypeScript 脚本编排多个持久会话。

#### 3.1.1 能力映射表

| ZCode 侧 | PI-Desktop 侧 | 状态 |
|---|---|---|
| `agent(name, persona)` 创建 actor | `desktop.invoke({ operation: "session/create" })` | ✅ 直接映射 |
| `ask<T>(instructions)` 派发任务 | `desktop.invoke({ operation: "agent/prompt" })` | ✅ 直接映射 |
| `await node` 等待完成 | `pi.events.on("session:turnEnded")` | ✅ 事件驱动 |
| `ask<T>` 的 T → JSON Schema 合成 | 捆绑 `typescript` 编译器做虚拟宿主 typecheck | ✅ 20 MB 在预算内 |
| 子进程沙箱 + NDJSON 桥 | `node:child_process` + `node:vm`（原生 Node 内建可用） | ✅ 直接映射 |
| journal + replay + resume | 插件数据目录 JSONL（`pi.plugin.getDataPath()`） | ⚠️ 自建，无宿主级 replay |
| `report(item, artifactId?)` | 插件自有工具 + 数据目录 | ⚠️ 自建 |
| `artifact.chart/table/metrics/board` | 插件自有视图渲染 | ⚠️ 自建（见 3.2） |
| 因果图 / 时间线可视化 | `contributes.views` + 自绘 SVG/Canvas | ⚠️ 自建 |
| `escalate` → `ResolveWorkflowQuestion` | 复用 `AskTool` 交互（ADR 0077） | ✅ 语义吻合 |
| 主代理 `TaskStop` 取消 run | `agent/abort` | ✅ 直接映射 |

#### 3.1.2 manifest 骨架

```json
{
  "schemaVersion": 1,
  "id": "pi.workflow",
  "name": "Workflow Forge",
  "version": "0.1.0",
  "main": "main.js",
  "ui": { "panel": "renderer/index.html", "title": { "en": "Workflow Forge", "zh-CN": "工作流锻造" } },
  "contributes": {
    "views": [
      { "id": "runs",    "title": { "en": "Runs",    "zh-CN": "运行" }, "icon": "workflow", "entry": "renderer/runs.html",    "order": 30 },
      { "id": "saved",   "title": { "en": "Saved",   "zh-CN": "已保存" }, "icon": "book",   "entry": "renderer/saved.html",   "order": 31 },
      { "id": "graph",   "title": { "en": "Graph",   "zh-CN": "因果图" }, "icon": "branch", "entry": "renderer/graph.html",   "order": 32 }
    ],
    "agentTools": [
      { "name": "RunWorkflow",   "risk": "high", "planSafeActions": ["list", "get"], "schema": { "type": "object", "properties": { "script": {"type":"string"}, "saved": {"type":"object"}, "path": {"type":"string"}, "args": {"type":"object"}, "name": {"type":"string"} }, "required": [] } },
      { "name": "AmendWorkflow", "risk": "high", "planSafeActions": ["list"],       "schema": { "type": "object", "properties": { "run_id": {"type":"string"}, "script": {"type":"string"} }, "required": ["run_id"] } },
      { "name": "SaveWorkflow",  "risk": "medium",                                  "schema": { "type": "object", "properties": { "name": {"type":"string"}, "description": {"type":"string"}, "whenToUse": {"type":"string"}, "args": {"type":"object"}, "script": {"type":"string"}, "script_path": {"type":"string"} }, "required": ["name","description"] } },
      { "name": "ResumeWorkflow","risk": "high",                                    "schema": { "type": "object", "properties": { "run_id": {"type":"string"} }, "required": ["run_id"] } },
      { "name": "GetWorkflowRun","risk": "low",  "planSafeActions": ["get","list"], "schema": { "type": "object", "properties": { "run_id": {"type":"string"}, "action": {"type":"string","enum":["get","list"]} }, "required": [] } }
    ],
    "services": [{ "id": "scheduler", "label": "Workflow run scheduler", "autoRestart": true }],
    "settings": [
      { "key": "maxConcurrency",  "type": "number", "default": 4,     "title": "Max concurrent actors" },
      { "key": "runTimeoutMs",    "type": "number", "default": 1800000, "title": "Run wall-clock timeout (ms)" },
      { "key": "autoApprovePlan", "type": "boolean","default": false, "title": "Skip per-run confirmation" }
    ]
  },
  "permissions": [
    "ui.view", "agent.tool.register", "desktop.control", "models.list",
    "fs.read", "fs.write", "background.service", "session.read"
  ],
  "fs": { "read": { "scope": ["**/*"] }, "write": { "scope": ["Temp/workflow/**", ".pi-workflow/**"] } },
  "engines": { "piDesktop": ">=0.14.7" },
  "activationEvents": ["onStartup", "onView:runs"]
}
```

**权限理由**：
- `desktop.control` — 唯一能创建会话/发提示词的通道（高风险，安装时显式确认）
- `agent.tool.register` — 注册工具族
- `fs.read/write` — 脚本落盘、journal 持久化；**写范围收窄**到 `Temp/workflow/**` 与 `.pi-workflow/**`，避免全工作区写权限
- `background.service` — 常驻调度器，负责超时、恢复、通知
- `models.list` — actor 模型选择（复用 SessionTask 的 `models` action 语义）
- `session.read` — 读回 actor 结果（`pi.session.listMessages`）

#### 3.1.3 执行架构

```
┌─ 插件进程 (utilityProcess, 原生 Node 可用) ────────────────────────┐
│                                                                    │
│  RunWorkflow 工具处理                                               │
│    ├─ ① 编译期：typescript 虚拟宿主 typecheck                       │
│    │     · facade.d.ts 作为嵌入字符串资产（照搬 ZCode 做法）         │
│    │     · ask<T> 的 T → JSON Schema 合成                          │
│    │     · 站点表采集（ask / actor / world-read / join）            │
│    │     · 失败 → 返回 positioned diagnostics，模型可自修            │
│    ├─ ② 降级：type-strip + site-id 插桩到 __host.*                  │
│    ├─ ③ 沙箱：spawn(node child.mjs) + vm.createContext             │
│    │     · child 只含 ES intrinsics + __host                        │
│    │     · NDJSON over stdio                                        │
│    │     · Date.now / Math.random 运行期禁令                        │
│    └─ ④ 引擎：WorkflowEngine + AskScheduler                         │
│          · journal 落插件数据目录                                   │
│          · 重放 + 恢复                                              │
│                                                                    │
│  __host.ask() 实现                                                  │
│    ├─ desktop.invoke("session/create", { project, model, mode })   │
│    ├─ desktop.invoke("agent/prompt",   { sessionId, prompt })      │
│    ├─ 注册 pending promise，key = sessionId                        │
│    └─ pi.events.on("session:turnEnded") → resolve promise          │
│                                                                    │
│  scheduler 常驻服务                                                  │
│    ├─ 墙钟超时 → desktop.invoke("agent/abort")                     │
│    ├─ 崩溃恢复 → 读 journal，重放已完成节点                          │
│    └─ 完成通知 → pi.ui.showNativeNotification                       │
└────────────────────────────────────────────────────────────────────┘
         │ 视图 (沙箱 HTML)                    │ 会话
         ▼                                     ▼
   renderer/graph.html                  session/create + agent/prompt
   读插件数据目录的 core.json
   现场重算投影（照搬 ZCode：
   "下游浏览器端在冻结产物上现场重算投影"）
```

#### 3.1.4 必须照搬的三个设计决策

1. **编译一次**。ZCode 的 harness 明确拒绝校验 `scriptText` 与 `lowered` 是否自洽——「判断 `lowered` 是否真由 `scriptText` 降级而来，等于把编译再跑一遍，而那正是『编译一次』要省掉的那次」。插件应把编译产物和源码分别落盘，信任调用方。

2. **失败结算归引擎所有，harness 只管子进程清理**。ZCode 的 `harness.ts` 注释：终结失败（脚本抛错、子进程崩溃、墙钟超时、JSON 解析失败）都调 `engine.fail(error)`；abort 信号是唯一的"真取消"。**harness 侧的 first-wins finalize 不自造结算**。这是避免双重结算的关键纪律。

3. **`report()` 的语义是「第 12 个任务死掉时，前 11 个的成果要活下来」**。ZCode 的 facade 注释：`report` 是 journal 化的（resumed run 不会重复显示同一条），且「run 以失败告终时也会随完成通知投递」。上限 256 条/run、32 KB/条，超限**失败整个 run 而不是那一次调用**（因为 void 返回没有拒绝通道）。

#### 3.1.5 已知缺口（诚实标注）

| 缺口 | 影响 | 缓解 |
|---|---|---|
| 无宿主级 journal/replay | resume 语义自建，跨版本迁移有风险 | 插件数据目录 + 显式 schemaVersion + 迁移函数 |
| `pi.agent.complete` 无 JSON Schema 约束输出 | 无法像 ZCode 那样把 T 合成到补全请求 | 用 `agent.tool.register` 注册带 schema 的 `submit_result` 工具给 actor（SessionTask 已验证可行） |
| Plan 模式下插件工具默认隐藏（ADR 0211） | 工作流不能在 Plan 模式跑 | 用 `planSafeActions` 放行只读 action（`list` / `get`），执行类保持隐藏 |
| `session.read.own` 只读自己 import 的会话 | 读 actor 结果需绕道 | 用 `desktop.control` 的 `session/get`（受审操作） |
| 50 MB 包上限 | 捆绑 typescript 后余量约 30 MB | 只捆 `typescript` 的 `lib/` 子集；或按需下载（需 `net.fetch` + 声明域） |

---

### 3.2 `pi.artifact-board` — 产物看板

**目标**：把"Agent 干活的中间结果"变成一等交付物，而不是聊天记录里的一段文本。

#### 3.2.1 契约（照搬 ZCode 的 artifact 族）

```ts
// 内容成员：效应，async，可 catch 拒绝
artifact.file(id: string, path: string, opts?): Promise<ArtifactRef>
artifact.markdown(id: string, text: string, opts?): Promise<ArtifactRef>

// 预置成员：声明，void，数据来自 report(item, id) 的 tag
artifact.chart(id,   { type: "line"|"bar"|"scatter", x, y, scale?, baseline?, ...opts })
artifact.table(id,   { columns: ArtifactField[], key?, ...opts })
artifact.metrics(id, { metrics: ArtifactField[], ...opts })
artifact.board(id,   { key, status, columns: string[], cardTitle?, detail?, ...opts })
```

关键语义（照搬 ZCode facade 注释）：
- **id 必须是编译期字符串字面量**（非空、≤64 字符 `[A-Za-z0-9_.-]`），run 可发布的集合在提交时固定，编译器拒绝计算出来的 id
- **一个 run 内一个 id 属于恰好一个成员**
- **`{ primary: true }` 标记交付物**——run 卡片和详情页以它领衔，每 run 至多一个
- **看板是给看 run 的人用的**：值得中途观察时才声明。两条测试：用户会单独打开它吗？它是否重复了另一个 artifact？

#### 3.2.2 为什么这是 P0

ZCode 的 facade 注释点破了价值：

> EVERY RUN PUBLISHES ITS DELIVERABLE, whatever the user asked for... 一旦 run 结束，用户看到的是产物，不是 transcript。

PI-Desktop 当前的 `usage.read` 是"扁平计数行 + 标识符，不含消息正文"（`PluginUsageTurn`），`pi.token-insights` 与 `io.github.muzimu217.usage-dashboard` 已在消费它。但**没有任何插件提供通用的产物看板**——Agent 产出表格/图表只能贴在聊天里。

#### 3.2.3 manifest 要点

```json
{
  "id": "pi.artifact-board",
  "contributes": {
    "views": [{ "id": "board", "title": { "en": "Artifacts", "zh-CN": "产物" }, "icon": "diff", "entry": "renderer/index.html", "order": 25 }],
    "agentTools": [
      { "name": "publish_artifact", "risk": "medium", "schema": { "type": "object", "properties": { "id": {"type":"string"}, "kind": {"type":"string","enum":["file","markdown","chart","table","metrics","board"]}, "spec": {"type":"object"} }, "required": ["id","kind"] } },
      { "name": "report_item",      "risk": "low",    "schema": { "type": "object", "properties": { "item": {}, "artifactId": {"type":"string"} }, "required": ["item"] } }
    ]
  },
  "permissions": ["ui.view", "agent.tool.register", "fs.read", "fs.write"],
  "fs": { "read": { "scope": ["**/*"] }, "write": { "scope": ["Temp/artifacts/**"] } }
}
```

**渲染**：纯前端，无外部依赖。`chart` 用 Canvas/SVG 手绘（线/柱/散点三种 + baseline 参考线），`table` 虚拟滚动，`metrics` 磁贴，`board` 看板列。数据以 JSONL 追加写 `Temp/artifacts/<runId>.jsonl`。

**与 #1 的关系**：artifact-board 可以独立使用（Agent 直接 `report_item`），也可以作为 workflow 的产物出口。建议**先做 artifact-board**——它更小、独立价值更高，且是 workflow 的天然前置。

---

## 4. P1：三个高性价比插件

### 4.1 `pi.arch-guard` — 架构治理器

**移植 `architecture-policy.yaml` 的执行语义。**

**输入**：工作区根的 `architecture-policy.yaml`（或插件设置里的 JSON 等价物）。

**工具**：
- `ArchCheck` — 按 `--changed` 或全量检查；返回违规清单，**区分新增违规与基线违规**（照搬 ZCode 的 `architecture:baseline:update` 纪律：只在有意变更时刷新基线）
- `ArchContext <module-id>` — 生成**受控上下文包**：目标契约 + 直接引用的契约 + 相关 spec 与测试。这是 ZCode 最有价值的单点创新之一——它让 Agent 先读"模块阅读包"而不是把整个实现塞进提示词。

**检查项**（对应 ZCode 的 `global` 段）：
| 检查 | 参数 | PI-Desktop 现状 |
|---|---|---|
| 文件行数 | `maxFileLines: 400` | 有（但阈值是 800/1000/1500，且只覆盖少数文件） |
| 契约行数 | `maxContractLines: 300` | 无 |
| 公共方法数 | `maxPublicMethods: 12` | 无 |
| 模块依赖方向 | `requires: [...]` | 无 |
| 分层方向 | `layerOrder: [domain, app, adapters]` | 无 |
| 环检测 | `forbidCycles: true` | 无 |
| 深导入 | `forbidDeepImports: true` | 无 |
| 公共入口 | `publicEntrypoints: [...]` | 无 |

**实现**：TypeScript Compiler API 或正则+AST 混合。`fs.read` + `fs.glob` 拿文件，纯静态分析。**无需网络、无需 desktop.control**——权限面极小，安装门槛低。

**为什么值得**：PI-Desktop 自己就有 `docs/architecture/README.md` 的预算体系，但只有行数。插件可以把这套预算升级成完整的分层治理，而且**同样的插件对任何 TS 项目都有用**。

### 4.2 `pi.dep-refs` — 符号级依赖查询

**移植 `scripts/dep-refs.mjs`。**

**工具**：`DepRefs`（`action: "list-exports" | "refs" | "unused" | "graph"`）
- `list-exports <file>` — 列出一个文件的所有导出
- `refs <symbol>` — 谁引用了这个符号（含文件:行号）
- `unused` — 结合 knip 结果做符号级确认
- `graph` — 输出依赖图

**实现**：捆绑 `typescript`，用 LanguageService 做符号解析。约 3 MB 插件 + 20 MB typescript。**与 #4.1 共用 typescript 依赖**，建议做成一个插件的两个工具族（`pi.ts-toolkit`）以省一份 20 MB。

**为什么值得**：PI-Desktop 有 `biome`（格式/lint）和可能的 knip，但**没有符号级引用追踪**。删除导出前证明无人使用、重构时追调用点——这是 Agent 高频需求，且当前只能靠 grep（会误命中注释和字符串）。

### 4.3 `pi.state-forge` — 状态空间枚举器

**移植 `packages/formal-proof/`。**

**形态**：一个 `ui.panel`（Vite 构建的静态页）+ 一个 Agent 工具。

**工具**：`EnumerateStates`（输入：状态维度声明 + 候选动作 + 决策规则；输出：TraceNode 树 + TraceStats）

**UI**：交互式枚举器——左侧选 `ProductContext` 剖面，中间展开 `TraceNode` 树，右侧显示每个叶子的 `Decision`（`ruleId` / `reason` / `assertion` / `e2e`）。

**为什么值得**：PI-Desktop 的 ~300 篇 ADR 里，状态机是最密集的部分（compaction、turn queue、plan checkpoint、subagent lifetime、permission mode）。ADR 是散文，枚举器是树。把它接进 PI-Desktop 的工作流，可以直接回答"这个改动覆盖了哪些状态组合、漏了哪些"。

**注意**：这个插件**不绑定 PI-Desktop 内部状态**——它是个通用的状态空间建模工具，Agent 负责把 ADR 转成模型声明。这样插件不需要读宿主内部数据，权限面极小。

---

## 5. P2：两个小而美

### 5.1 `pi.skill-lock` — Skill 来源锁定

**移植 `skills-lock.json` 语义。**

- 从 GitHub / 任意 URL 拉 skill → 记录 `{ source, sourceType, skillPath, computedHash }`
- 检出时校验哈希，报告漂移
- 支持批量更新 + diff 预览

**权限**：`fs.read` / `fs.write` / `net.fetch`（域白名单：`raw.githubusercontent.com` 等）/ `agent.prompt.inject`

**与宿主的关系**：PI-Desktop 已有 skill market（ADR 0243）走 `skills.create`。本插件是**它之上的锁定层**，不重复实现下载——只做"来源+哈希"的账本与漂移检测。

### 5.2 `pi.workflow-graph` — 工作流因果图

如果不并入 #3.1，可以独立成一个**回放历史会话成因果图**的视图：
- 输入：会话转录本（`pi.session.listMessages` 或 `desktop.control` 的 `session/get`）
- 输出：站点 / 轨道 / 弧 / agent 药丸 / 行进光

**注意与现有插件区分**：工作区已有 `local.trajectory`（把历史会话回放成时间线：turn 分组、工具调用链、思考块、token 徽章、可拖动播放头）。新插件应聚焦**多 Agent 的因果结构**（谁派发给谁、依赖顺序、跨轨道弧），而不是单会话的时间轴。否则重复。

---

## 6. 插件做不了、必须改宿主的

诚实划清边界，避免把宿主能力误报成插件机会。

| 能力 | 为什么插件做不到 |
|---|---|
| **手机远控 / relay** | 需要宿主级 Host attachment 复用、`desktop-continuous` vs `web-remote-replayable` 双链路、外部 relay 的鉴权/配对/心跳/转发。插件 API 无会话运行时入口 |
| **插件商店分段 IA** | Official Marketplace / Personal Source / Featured / Installed Strip / Manage Installed View 是宿主 UI 与目录协议。插件不能改宿主设置页结构 |
| **插件生命周期状态** | Restorable Builtin（卸载后抑制重新播种）、Orphaned Installed Plugin（来源删除但安装保留）是宿主持久化状态 |
| **Computer Use（CUA）** | 需要 broker（socket / ports / helper 健康）、PiP 会话、frame contract、host display contract、request access contract、原生 addon loader。PI-Desktop 的 `desktop.control` 是**受审操作白名单**，不是任意 UI 驱动 |
| **原生搜索工具链** | 构建链能力（跨平台二进制打包 + verify + package）。插件 50 MB 上限装不下多平台二进制 |
| **Agent 字节码保护** | 构建链能力，作用于宿主自己的 Agent 代码 |
| **架构检查基线（CI 集成）** | `architecture:baseline:update` 需要写仓库并进 CI。插件可以检查，但基线刷新应是人的动作 |
| **CommandInbox 串行 admission** | 宿主运行时语义，插件只能消费其效果（`agent/prompt` 的排队行为） |

**其中值得单独向宿主提需求的两项**：
1. **双链路语义**（`desktop-continuous` vs `web-remote-replayable`）——这是 PI-Desktop 相对 ZCode 的真实差距，且是产品级而非插件级
2. **插件商店分段 IA**——PI-Desktop 当前是 `catalog.json` + `.piplug`（ADR 0276 official channel + backup channels），比 ZCode 的 Official/Personal 双分段简单

---

## 7. 建议实施路线图

```
第 1 步（1-2 周）pi.artifact-board
  ├─ 最小可用：report_item + table + metrics
  ├─ 渲染：手绘 Canvas 表格与磁贴
  └─ 独立价值：Agent 产出结构化结果不再埋在聊天里

第 2 步（2-4 周）pi.ts-toolkit（arch-guard + dep-refs 合并）
  ├─ 捆绑 typescript 一次，两个工具族共用
  ├─ arch-guard：policy 解析 + 8 项检查 + context 包生成
  └─ dep-refs：list-exports / refs / unused

第 3 步（4-8 周）pi.workflow（核心）
  ├─ 里程碑 A：facade 编译（typecheck + schema 合成 + 站点表）
  ├─ 里程碑 B：沙箱 harness（子进程 + vm + NDJSON）
  ├─ 里程碑 C：actor 桥（session/create + agent/prompt + session:turnEnded）
  ├─ 里程碑 D：journal + resume
  ├─ 里程碑 E：因果图视图
  └─ 里程碑 F：AmendWorkflow（按名字复用已完成工作）

第 4 步（1 周）pi.skill-lock
  └─ 可与第 2 步并行

第 5 步（2-3 周）pi.state-forge
  └─ 可与第 3 步并行
```

**依赖关系**：第 3 步的产物出口依赖第 1 步；第 2 步与第 3 步共享 typescript 依赖，可先抽一个共享包（工作区已有 `pi-desktop-plugins/plugins/shared/` 目录，可作为落点）。

---

## 8. 风险与边界

### 8.1 安全风险（pi.workflow 尤其）

`desktop.control` 是**高风险**权限——插件能创建会话、发提示词、配置权限模式（含 `auto`）。缓解：

- 安装时显式确认 + 权限说明里写清"能消耗模型额度"
- `session/configure` 标为 `dangerous`，需要 `confirm: true`（宿主的受审操作目录已经这样定义）
- 插件侧：run 级并发上限（默认 4，照搬 SessionTask 的"每 parent 4 worker / 插件级 16"）
- Plan 模式用 `planSafeActions` 只放行只读 action

### 8.2 沙箱边界必须说清

ZCode 的沙箱是**真沙箱**（子进程 + 仅 ES intrinsics + `__host`）。PI-Desktop 插件进程**不是** Node 功能沙箱（规格原文承认）。所以：

- `pi.workflow` 的沙箱是**插件自己实现的**，不是宿主保证的
- 用户看到的权限列表是插件级的，**不能宣称"脚本被沙箱隔离于宿主"**——脚本隔离于插件，插件对宿主有 `desktop.control`
- 安装说明必须诚实表述这一点

### 8.3 与现有插件的重叠检查

| 候选插件 | 可能重叠 | 处理 |
|---|---|---|
| `pi.workflow` | `pi.session-orchestrator`（SessionTask）、`pi.goal-x` | 定位不同：SessionTask 是**命令式 API**（一次一个动作），workflow 是**脚本式**（一份程序编排）；goal-x 管目标持久化，workflow 管执行编排。可在 README 里明确指向 |
| `pi.workflow-graph` | `local.trajectory` | 前者聚焦多 Agent 因果结构，后者聚焦单会话时间轴 |
| `pi.artifact-board` | `io.github.muzimu217.usage-dashboard`、`pi.token-insights` | 那两个消费 `usage.read`（token 统计），本插件消费 Agent 主动发布的产物。无重叠 |
| `pi.arch-guard` | 无 | 空白 |
| `pi.dep-refs` | `io.github.muzimu217.deps-audit`（OSV 漏洞扫描） | 完全不同的检查维度 |
| `pi.skill-lock` | 宿主 skill market | 本插件是市场之上的锁定层 |

### 8.4 不建议照搬的部分

- **ZCode 的 `.zcode-plugin/plugin.json` 极简格式**——PI-Desktop 的 manifest 已经更完整（39 权限、fs/net 策略、i18n、engines），不要倒退
- **ZCode 的 `formal-proof` 具体模型**——照搬 `RunPhase`/`GoalState` 等维度没有意义（那是 ZCode 自己的产品状态）。应移植**方法**（枚举器结构），让 Agent 为 PI-Desktop 生成模型
- **`model-option-map`**——PI-Desktop 有 ADR 0114（provider/model 绑定与思考配置）+ ADR 0144（思考级别覆盖）+ ADR 0192（模型别名），已经是宿主能力，插件重复实现只会造成两套真相

---

## 9. 一句话总结

**ZCode 最值得搬的不是某个功能，而是「让 Agent 写程序来编排 Agent」这个范式**——它把多 Agent 协作从"模型逐个工具调用"提升到"模型写一份带类型检查的程序"，附带沙箱、journal、resume 和因果图。

而 PI-Desktop 的插件 API **恰好够用**：`desktop.control` 给会话生命周期，`session:turnEnded` 给事件驱动，原生 Node 内建给沙箱，50 MB 预算给 TypeScript 编译器。

**建议从 `pi.artifact-board` 起步**（小、独立价值高、是 workflow 的前置），**以 `pi.workflow` 为目标**（大、差异化最强），中间用 `pi.ts-toolkit` 垫一步（复用 typescript 依赖，验证插件内的重型静态分析可行）。

---

## 附录 A：证据索引

### ZCode 侧

| 路径 | 内容 |
|---|---|
| `ZCode/AGENTS.md` | 双链路语义、CommandInbox、Workspace Identity、日志分级 |
| `ZCode/DESIGN.md` | `--color-workflow-*` 令牌族、`text-ui-*` 字阶 |
| `ZCode/CONTEXT.md` | 插件商店领域词汇表 |
| `ZCode/architecture-policy.yaml` | 可执行架构策略（模块/分层/预算） |
| `ZCode/apps/zcode-cli/packages/dynamic-workflow/README.md` | facade + compiler 边界 |
| `ZCode/apps/zcode-cli/packages/dynamic-workflow/src/facade/dts.ts` | 模型面 API（22 KB 嵌入资产） |
| `ZCode/apps/zcode-cli/packages/dynamic-workflow/src/index.ts` | 四类投影导出 |
| `ZCode/apps/zcode-cli/packages/dynamic-workflow-runtime/README.md` | 沙箱架构图 + NDJSON 协议 |
| `ZCode/apps/zcode-cli/packages/dynamic-workflow-runtime/src/harness.ts` | 父子时序 + 结算纪律 |
| `ZCode/apps/zcode-cli/packages/contracts/src/tools/create-workflow.ts` | CreateWorkflow 契约 |
| `ZCode/apps/zcode-cli/packages/contracts/src/tools/save-workflow.ts` | SaveWorkflow 契约 |
| `ZCode/apps/zcode-cli/packages/contracts/src/tools/resume-workflow-run.ts` | ResumeWorkflowRun 契约 |
| `ZCode/apps/zcode-cli/packages/contracts/src/tools/get-workflow-run.ts` | GetWorkflowRun 契约 |
| `ZCode/apps/zcode-cli/packages/contracts/src/interfaces/workflow-escalate.port.ts` | escalate 端口（刻意不设超时） |
| `ZCode/apps/zcode-cli/packages/contracts/src/interfaces/dynamic-workflow-run.port.ts` | run 提交/观察/取消边界 |
| `ZCode/apps/zcode-cli/packages/browser-use-plugin/README.md` | Browser Use 架构 |
| `ZCode/apps/zcode-cli/packages/browser-use-plugin/.zcode-plugin/plugin.json` | ZCode 插件格式 |
| `ZCode/apps/zcode-cli/packages/node-repl-host/README.md` | 共享宿主独立成包的理由 |
| `ZCode/apps/zcode-cli/skills-lock.json` | skill 来源 + 哈希锁定 |
| `ZCode/packages/formal-proof/README.md` | 状态空间枚举器定位 |
| `ZCode/packages/formal-proof/src/model.ts` | 状态维度 + 候选 + 决策 + TraceNode |
| `ZCode/packages/ui/src/components/workflow-timeline/timeline-model.ts` | 时间线模型（一个模型三处消费） |
| `ZCode/packages/zcode-cua/README.md` | CUA fail-closed 占位 |
| `ZCode/packages/zcode-cua/index.d.ts` | CUA 运行时契约 |
| `ZCode/packages/zcode-cua/pip-session.d.ts` | PiP 会话事件契约 |
| `ZCode/.agents/skills/architecture-governance/SKILL.md` | 分层纪律 + 设计草图 |
| `ZCode/.agents/skills/dep-refs/SKILL.md` | 符号级查询工作流 |
| `ZCode/package.json` | `architecture:*` / `dep:refs` / `knip` 脚本 |

### PI-Desktop 侧

| 路径 | 内容 |
|---|---|
| `PI-Desktop/packages/plugin-sdk/src/index.ts` | `PluginHostApi` 全貌 + 39 项权限 |
| `PI-Desktop/docs/adr/0252-plugin-host-turn-end-event.md` | `session:turnEnded` |
| `PI-Desktop/docs/adr/0237-session-orchestrator-as-a-plugin.md` | SessionTask 设计与宿主原语 |
| `PI-Desktop/docs/adr/0259-plugin-declared-providers.md` | 插件声明 provider |
| `PI-Desktop/docs/adr/0215-agent-extensions-as-plugin-contribution.md` | agent extension 通道 |
| `PI-Desktop/docs/adr/0258-trusted-extension-custom-agents.md` | 自定义 agent/provider |
| `PI-Desktop/docs/adr/0243-skill-market-public-https-catalog.md` | skill market |
| `PI-Desktop/docs/adr/0211-plan-safe-plugin-actions.md` | Plan 模式插件工具策略 |
| `PI-Desktop/docs/zh-CN/spec/07-plugins/01-plugin-system.md` | 插件运行时（原生 Node 内建可用） |
| `PI-Desktop/docs/zh-CN/spec/07-plugins/04-plugin-security.md` | 四道门、deny-list、出网白名单 |
| `PI-Desktop/docs/zh-CN/spec/07-plugins/06-plugin-packaging.md` | 50 MB / 2000 文件 / 捆绑依赖 |
| `PI-Desktop/docs/zh-CN/spec/07-plugins/10-plugin-devex.md` | devkit + check/pack/publish |
| `PI-Desktop/apps/desktop/electron/main/mcp-control.ts` | `desktop.control` 操作目录 |
| `PI-Desktop/docs/architecture/README.md` | 行数预算（当前唯一架构检查） |
| `PI-Desktop/docs/adr/0062-bounded-subagents-behind-a-task-tool.md` | Task 子代理边界 |
| `PI-Desktop/docs/adr/0165-withdraw-a2a-peer-stack.md` | A2A/Peer 栈已撤回 |

---

## 附录 B：现有插件覆盖盘点（避免重复造）

工作区 `pi-plug/pi-desktop-plugins/plugins/` 已有 27 个插件，覆盖：

**开发者工具**：`pi.gitlens`、`io.github.liushunqiu.pi-idea-git`、`pi.terminal`、`pi.log-viewer`、`io.github.muzimu217.deps-audit`、`io.github.muzimu217.session-import`、`pi.session-orchestrator`
**文档与笔记**：`pi.markdown`、`pi.bianqian`、`demo.workspace-notes`
**项目治理**：`pi.goal-x`、`pi.workspace-file-guard`、`local.pi-matt-workflow`
**数据可视化**：`io.github.muzimu217.usage-dashboard`、`pi.token-insights`
**外观**：`pi.obsidian-theme`、`pi.parchment`、`pi.clipboard-history`
**系统集成**：`pi.ssh-manager`、`pi.super-domain-man`、`com.vastsa.voice-assistant`、`pi.file-manager`、`pi.scratch-calc`、`pi.todo`
**开发辅助**：`local.pi-desktop-install-guard`、`demo.hello`、`demo.workspace-summary`

工作区根另有 8 个本地开发插件：`local.annotate`、`local.trajectory`、`local.token-meter`（token-meter）、`local.task-center`（task-center）、`skill-pack`、`session-orchestrator`、`session-import`、`obsidian-theme`。

**空白区域**（本报告的机会）：
1. 工作流编排（脚本式）——`pi.session-orchestrator` 只做命令式
2. 通用产物看板——两个 usage 插件只做 token 统计
3. 架构治理——完全空白
4. 符号级依赖查询——完全空白
5. 状态空间枚举——完全空白
6. Skill 来源锁定——完全空白
