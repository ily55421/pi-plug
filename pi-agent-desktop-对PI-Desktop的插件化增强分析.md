# pi-agent-desktop → PI-Desktop：可插件化增强的深度分析

> **调查对象**：`abcwyc/pi-agent-desktop`（Electron + Next.js 的 AI Agent 桌面应用，commit `1cabde8`，~1200 文件）
> **对比基准**：`E:\code\ai-platform-amd64\PI-Desktop` v0.15.1-beta.7（宿主源码 + 300+ 篇 ADR + 插件规范 17 篇）
> **落点工作区**：`E:\code\ai-platform-amd64\pi-plug`
> **前序分析**：`ZCode-...md`（六项已落地）、`Kimi-Code-...md`（P0 配置即对话）、`DSH-SEP-...md`（记忆治理四范式）。**本文只写这三份没覆盖的增量**。
> **证据原则**：所有结论都带文件路径与行号；找不到的写「未找到」，不臆测。

---

## 0. 结论速览

pi-agent-desktop 与前三份研究对象都不同：它是 **PI-Desktop 的同源近亲**——两者都把 `@earendil-works/pi-coding-agent` 当作 agent 引擎、都读 `~/.pi/agent/` 的会话与凭据、都是 Electron 桌面壳。区别在于**押注方向相反**：

| | pi-agent-desktop | PI-Desktop |
|---|---|---|
| 定位 | 单机桌面应用（Next.js 服务端常驻 + Tauri/Electron 壳） | 插件平台（宿主 + 39 项权限的插件 SDK） |
| 数据层 | 直接用 pi SDK 的 `SessionManager` / `ModelRuntime`，**能拿到凭据** | 自建 SQLite + RPC，**凭据锁在宿主，插件拿不到** |
| 强项 | 把 pi 的**服务端能力**做全：余额查询、MCP 导入、模型发现、worktree、项目信任、定时任务 | 治理边界：权限矩阵、审计、插件隔离、市场 |

**最大的发现**：pi-agent-desktop 有**九家供应商的余额/配额查询**（`lib/provider-usage.ts`，374 行 + 74 行测试），而 PI-Desktop **完全没有**——`apps/desktop/src` 全库 grep `balance|credit` 零匹配，官方 `usage-dashboard` 插件只统计本地 token 计数（`pi.usage.listTurns`）。这是用插件就能吃到的真实空白，**本次已实现为 `local.provider-balance`**。

**第二个发现**：pi-agent-desktop 的 **MCP 生态工具链**比 PI-Desktop 的对应实现更完整。`lib/mcp-*.ts` 共 **24 个文件、414,832 字节**（不含测试），覆盖配置扫描 / 导入 / 测试 / 登录 / 密钥分离 / 撤销。PI-Desktop 只有 `agent-mcp-scan.ts`（扫描 7 个来源）+ `mcp-import`，缺「从 URL/JSON 导入」「MCP 登录流」「连接测试」「导入撤销」的插件侧能力。这是 P1 候选。

### 可行性矩阵

| # | 能力 | pi-agent-desktop 出处 | 插件可行 | 价值 | 工作量 | 建议 |
|---|------|---------------------|:---:|:---:|:---:|------|
| 1 | **供应商余额/配额查询** | `lib/provider-usage.ts`（374 行） | ✅ 完全 | ★★★★★ | 中 | **P0 已落地** |
| 2 | **MCP 配置导入（URL/JSON/多客户端扫描）** | `lib/mcp-import*.ts`（5 文件，~15 万字节） | ✅ 完全 | ★★★★☆ | 中 | **P1** |
| 3 | **MCP 连接测试 + 登录流** | `lib/mcp-test.ts`、`mcp-sign-in.ts` | ⚠️ 部分 | ★★★★☆ | 大 | P1（需 net + 本地进程） |
| 4 | **只读会话的 MCP 工具闸** | `lib/mcp-read-only-policy.ts` | ⚠️ 近似 | ★★★☆☆ | 小 | P1（宿主已有部分） |
| 5 | **工作区记忆（切项目恢复上次会话）** | `lib/workspace-memory.ts` | ✅ 完全 | ★★★★☆ | 小 | **P1** |
| 6 | **会话内容全文搜索** | `lib/session-search.ts` | ⚠️ 宿主已有 | ★★☆☆☆ | 小 | 已有（`use-session-search.ts`） |
| 7 | **会话族谱 / 子代理树** | `lib/session-tree.ts`、`session-family.ts` | ✅ 完全 | ★★★☆☆ | 小 | P2 |
| 8 | **按模型成本分解** | `lib/usage-breakdown.ts` | ⚠️ 无价格表 | ★★★☆☆ | 中 | P2（PI-Desktop 转录本无 cost 字段） |
| 9 | **Git worktree 切换** | `lib/worktree.ts` | ❌ 宿主未暴露 | ★★★☆☆ | 大 | 向宿主提 |
| 10 | **项目信任（trust.json）** | `lib/project-trust.ts` | ❌ 宿主已内建 | — | — | 已有 |
| 11 | **定时任务（cron + 补跑 + 租约）** | `lib/scheduled-tasks/`（31 文件） | ❌ 宿主已有 | — | — | 已有（scheduled/*） |
| 12 | **扩展 widget（aboveEditor 行）** | `lib/extension-widgets.ts` | ❌ 宿主无此面 | ★★★☆☆ | 大 | 向宿主提 |
| 13 | **会话分支导航（BranchNavigator）** | `components/BranchNavigator.tsx` | ❌ 宿主已有 | — | — | 已有（`session/fork`） |
| 14 | **PDF / DOCX 预览** | `components/FileViewer.tsx` | ❌ 宿主缺依赖 | ★★☆☆☆ | 大 | 不建议 |
| 15 | **插件/技能更新检查** | `lib/plugin-updates.ts`、`skill-updates.ts` | ❌ 宿主已有 | — | — | 已有（skill market） |

---

## 1. P0：供应商余额与配额查询（已实现）

### 1.1 pi-agent-desktop 的实现

```
lib/provider-usage.ts          374 行  端点表 + 凭据解析 + 9 家响应归一化
lib/provider-usage-ids.ts       14 行  供应商 ID 白名单
lib/provider-usage.test.mjs     74 行  归一化夹具测试
app/api/provider-usage/query/route.ts   POST 路由
components/ProviderUsageSummary.tsx     UI 呈现
```

端点表（`lib/provider-usage.ts:46-63`）：

| 供应商 | 端点 | 归一化要点 |
|---|---|---|
| `openai-codex` | `chatgpt.com/backend-api/wham/usage` | 主/次窗口 `used_percent` → `remaining`；`windowLabel()` 把秒数渲染成 `5h`/`Weekly` |
| `deepseek` | `api.deepseek.com/user/balance` | `balance_infos[]` 按币种拆成 total/granted/topped-up |
| `openrouter` | `openrouter.ai/api/v1/key` | `limit`/`limit_remaining` → 已用/剩余；日/周/月/累计四档 |
| `moonshotai(-cn)` | `api.moonshot.{ai,cn}/v1/users/me/balance` | 校验 `code===0 && status===true`；available/voucher/cash |
| `minimax(-cn)` | `api.minimax{,.i}.com` | **按 token 前缀分流两个端点**；`status===3` 表示不限量；用「哪种解释更接近上报百分比」判定 count 语义 |
| `vercel-ai-gateway` | `ai-gateway.vercel.sh/v1/credits` | 余额 + 累计消费 |
| `opencode-go` | `opencode.ai/zen/go/v1/usage` | 滚动/周/月窗口百分比 + 重置时间 |

三个值得学的工程细节：

1. **`isOfficialProviderUsageOrigin()`**（`:141-150`）：拿 provider 的 `baseUrl` 与端点 origin 比对，**自定义 origin 一律拒绝查询**。理由写在注释里：把 API key 发给非官方域名等于泄露凭据。
2. **`decimal()` 返回字符串**（`:395`）：金额不走浮点往返，避免 `0.1+0.2` 类精度事故。
3. **MiniMax 的双端点分流**（`:124-128`）：`sk-api-` 前缀走 `/account/query_balance`，否则走 `/v1/token_plan/remains`。

### 1.2 PI-Desktop 的空白（已验证）

| 检查 | 命令 | 结果 |
|---|---|---|
| 宿主有余额能力吗 | `grep -r 'balance\|credit' apps/desktop/src` | **零匹配** |
| 宿主有成本计算吗 | `grep -r 'pricing\|costPer' apps packages` | 只命中 subagent 预设文案 |
| 官方插件有吗 | `usage-dashboard` manifest | 只用 `pi.usage.listTurns`，本地 token 计数 |
| 插件能拿凭据吗 | `spec/07-plugins/03-plugin-api.md` | 「No secrets」——`pi.models.list` 不带 key |

结论：**PI-Desktop 生态里"余额还剩多少"是空白**，用户只能挨个开供应商网页后台。

### 1.3 移植方案与落地

已实现为 `provider-balance/`（插件 id `local.provider-balance` v0.1.0）。

**关键适配**：pi-agent-desktop 在服务端用 `ModelRuntime` 解析凭据；插件进程没有那个运行时。改为直接读 pi 的 agent 目录——**PI-Desktop 自己也是这么定位凭据的**（`packages/agent-runtime/src/native-pi-session.ts:310`：`join(homedir(), ".pi", "agent")`，可用 `PI_CODING_AGENT_DIR` 覆盖）。

三处刻意的行为差异：

| # | 差异 | 原因 |
|---|---|---|
| 1 | 归一化不抛错，返回 `{ok:false, reason}` | 上游在服务端抛异常由路由兜底；插件里抛错会打断整批查询，一家失败不该让其他家消失 |
| 2 | 新增 origin 闸 | 上游用 `ModelRuntime` 校验；插件进程没有，自己实现 `isOfficialOrigin()` |
| 3 | 新增「本机另有 N 个供应商不在此看板内」盘点 | 本机长期挂聚合网关（apigoto/longcat/a1888）时，只看九行「未登录」会以为插件坏了 |

**权限**：`ui.view` + `net.fetch`（配 `net.domains` 白名单 9 个官方域名）。
**验证**：27 项逻辑测试 + 12 项视图自检 + `PluginCheck` 通过 + 打包 88 KB。

---

## 2. P1：MCP 工具链（尚未实现）

pi-agent-desktop 的 MCP 相关代码量：`lib/mcp-*.ts` **24 个文件、414,832 字节**（不含测试），是全仓库最重的模块。按字节排序的前 10 个：

| 文件 | 字节 | 做什么 |
|---|---|---|
| `mcp-import-core.ts` | 53,712 | 导入核心：多来源解析与去重 |
| `mcp-host.ts` | 49,852 | MCP 客户端宿主：连接、生命周期、工具发现 |
| `mcp-config-read.ts` | 38,370 | 读取各客户端配置 |
| `mcp-import-cli.ts` | 35,649 | 从 CLI 导入 |
| `mcp-test.ts` | 32,934 | 连接测试（含超时、hang 处理） |
| `mcp-sign-in.ts` | 30,026 | OAuth 登录流 |
| `mcp-import-json.ts` | 29,143 | 从 JSON 粘贴导入 |
| `mcp-config-file.ts` | 21,784 | 配置文件读写 |
| `mcp-import.ts` | 21,775 | 导入编排 |
| `mcp-secrets.ts` | 20,632 | 密钥与配置分离存储 |

其余还有 `mcp-entry-request`、`mcp-add`、`mcp-status`、`mcp-import-links`、`mcp-server-display`、`mcp-sign-out`、`mcp-transport`、`mcp-json-error`、`mcp-command`、`mcp-undo`（导入撤销）、`mcp-config-key`、`mcp-config-values`、`mcp-read-only-policy`（只读会话的 MCP 工具闸）、`mcp-tool-display`。

配套测试夹具也很完整：`lib/__fixtures__/mcp-env-server.mjs`、`mcp-hang-server.mjs`、`mcp-oauth-server.mjs`（含「会挂起的 MCP server」用例）。

**PI-Desktop 的对应能力**（已核实）：`apps/desktop/electron/main/importers/agent-mcp-scan.ts` 支持 7 个来源（`claude-desktop`/`claude-code`/`cursor-global`/`cursor-project`/`codex`/`opencode`/`chatgpt-desktop`），产出 `McpCandidate[]`。**缺口**：没有「从 URL / 粘贴 JSON 导入」「连接测试」「OAuth 登录」「导入撤销」的插件侧能力。

**建议 P1 立项**：`local.mcp-importer`——把「粘贴一个 MCP JSON / URL → 解析 → 预检 → 写入宿主配置」做成插件。权限需要 `fs.write`（写 `~/.pi/agent/settings.json` 的 MCP 段）或走宿主的 MCP 配置 API（需先确认宿主是否对插件开放）。

---

## 3. P1：工作区记忆（尚未实现）

`lib/workspace-memory.ts`（~90 行）解决的问题写在文件头：

> Switching to a workspace restores the session the user had open there last, instead of landing on a blank new-session page. Without this, every workspace switch required re-picking the session by hand.

实现极简：`localStorage` 里一张 `workspaceKey → sessionId` 的表，key 优先用服务端给的 project identity（这样 Windows 路径变体与同一仓库的所有 worktree 共享一个槽位）。

**PI-Desktop 现状**：`apps/desktop/src/components/Sidebar.tsx` 有 `lastSessionDate()`，但那只是**排序**用的日期函数，不是「恢复上次打开的会话」。grep `lastOpenSession|workspaceMemory` 零匹配。

**移植价值**：★★★★☆，工作量小。插件侧可用 `workspace:changed` 事件 + `pi.plugin.setSettings` 实现（无需 `fs.*`）。

---

## 4. 不建议移植的（避免重复劳动）

| 能力 | 为什么不建议 |
|---|---|
| 定时任务 | PI-Desktop 已有完整实现：`scheduled/*` 工具 + `ScheduledTaskList/Create/Update/Delete`，含 cron、补跑、通知 |
| 会话搜索 | 宿主已有 `use-session-search.ts` + `SessionSearchController`，且支持 `searchMatchRanges` 高亮 |
| 会话分支/fork | 宿主已有 `session/fork`（desktop.control 受审操作） |
| 项目信任 | 宿主已有 `project-trust.ts` + trust 对话框 |
| 技能市场/更新 | 宿主已有 `skill-market`、`skill-updates` |
| 扩展 widget | pi-agent-desktop 的 `ExtensionWidgets` 依赖它的 `ExtensionAPI.ui.setWidget`；PI-Desktop 的 trusted-extension 明确把 `ui.setWidget` 列为 **Unsupported**（`16-trusted-extensions.md` §5）。插件无法复现，只能向宿主提需求 |
| PDF/DOCX 预览 | pi-agent-desktop 的 `FileViewer` 依赖 Next.js 端的解析库；插件视图是沙盒页面，引入同等依赖不划算 |
| worktree 切换 | pi-agent-desktop 的 `lib/worktree.ts` 直接跑 `git`；PI-Desktop 的插件无 `child_process` 白名单，且宿主未暴露 worktree 操作 |
| 成本分解 | PI-Desktop 的会话转录本里 `usage` 只有 token 计数（`costStatus: "unknown"`，已用真实文件核实），没有 `cost.total` 字段。要算钱得自带价格表，维护成本高 |

---

## 5. 两处架构对照（供宿主提需求）

1. **凭据面**：pi-agent-desktop 的插件等价物（它的 `builtin-extensions`）能经 `ModelRuntime` 拿凭据；PI-Desktop 插件被明确挡在凭据之外。这是**安全上的正确取舍**，但代价是「余额查询」这类能力必须绕道读 `~/.pi/agent/auth.json`。若宿主未来开放一个「按 provider 查询官方端点」的受审操作（如 `provider/usage`），插件就能走网关而不是自己读文件。
2. **扩展 UI 面**：pi-agent-desktop 支持 `ui.setWidget`（在输入框上方挂自定义行）、`ui.setFooter`、`registerMessageRenderer`；PI-Desktop 把这些都列为 Unsupported。插件目前只能通过 `contributes.views`（右侧工作面板）与 `ui.panel`（独立窗口）呈现 UI。

---

## 6. 参考

- 仓库：`https://github.com/abcwyc/pi-agent-desktop`（MIT）
- 上游依赖：`@earendil-works/pi-coding-agent`
- 本次交付：`provider-balance/`（见 `provider-balance/README.md` 与根目录 `provider-balance-交付说明.md`）
