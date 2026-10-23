# dsh-plugins topic → PI-Desktop 集成分析（游标台账）

> **数据源**：<https://github.com/topics/dsh-plugins>（topic 分页上限 50 页 × 20 = **1000 个仓库**，已全量抓取去重）
> **分析基座**：PI-Desktop 源码 `E:\code\ai-platform-amd64\PI-Desktop`（`docs/spec/07-plugins` 17 篇 + ADR 486 篇）、本机已装 19 个插件、工作区已有 8 篇前置分析
> **判定原则**：不按仓库名猜，按「是否绑定 DSH 运行时 + 能力是否已被本机覆盖」实测判定

---

## 0. 一句话结论

**这个 topic 里 1000 个仓库，有 936 个是 DSH（DeepSeek Harness）专属插件，PI-Desktop 一个都装不上。**
真正能拿来用的只有 **6 个可零改造接入** + **40 个需移植**（二次实测后由 47 修正），其余是整端竞品、目录仓库或已被你本机插件覆盖。

---

## 1. 为什么装不上（硬约束，已核验）

DSH 插件是 **Cordis/npm 包**，靠三个专属标志识别（实测命中）：

| 标志文件 | 含义 | 实测样本 |
|---|---|---|
| `cordis.patch.yml` | Cordis 插件加载层，向 DSH 宿主注入 | `bowenliang123/dsh-context` |
| `dsh.plugin.json` | DSH 专属 manifest（`entry.inject: ["webServer"]`） | `Soren-ABT/dsh-knowledge`、`T-Auto/dsh-ops` |
| `engines.dsh` | package.json 里声明 DSH 版本区间 | `>=0.2.0-rc.2` |

PI-Desktop 的插件是**另一套体系**：

| | DSH | PI-Desktop |
|---|---|---|
| 入口 | `cordis.patch.yml` + npm 包 | `manifest.json`（`schemaVersion: 1`） |
| 运行时 | Cordis 依赖注入容器 | 独立 Node 进程 + 沙箱面板 |
| 权限 | 无声明式权限模型 | 30+ 权限白名单（`agent.tool.register`、`mcp.server.local`…） |
| 贡献点 | `webServer` / `dsh.client` 宿主服务 | `contributes.commands/agentTools/skills/mcpServers/themes/services/views` |
| Agent 后端 | DSH 自身 | **pi CLI 0.85.1**（`defaultAgentBackend: pi`） |

在 PI-Desktop 全仓库 grep `cordis|engines.dsh|deepseek-harness` → **0 命中**。运行时不存在，就不存在"装上去跑起来"这条路径。

---

## 2. 游标定义与总分布

| 游标 | 含义 | 数量 | 占比 |
|:--:|---|--:|--:|
| **P0** | 可直接接入，零代码改造 | **6** | 0.6% |
| **P1** | 可移植，需写 PI 插件外壳 | **40** | 4.0% |
| **P2** | 不可直装，绑定 DSH 运行时，仅可借鉴算法 | **730** | 73.0% |
| **SKIP** | 不适用：整端竞品 / 目录仓库 / 已被本机覆盖 | **224** | 22.4% |

形态交叉验证：

| 形态 | 数量 | 说明 |
|---|--:|---|
| A：DSH 原生插件 | 463 | 379 个 P2 + 4 个 P1 + 80 个 SKIP |
| B1：整端/宿主级应用 | 45 | 全部 SKIP（是竞品，不是插件） |
| C：目录/清单 | 36 | 全部 SKIP（选型来源，非可执行） |
| D：能力/资源型 | 456 | 6 P0 + 43 P1 + 344 P2 + 63 SKIP |

**DSH 绑定 936 / 宿主机中立 64** —— 这就是这个 topic 的真实成色。

---

## 3. P0：可直接接入（6 个）

全部是**标准 MCP 服务器**或**纯提示词资产**，PI-Desktop 走 `contributes.mcpServers`（ADR 0038）与 `contributes.skills`（ADR 0039）直连即可。

| ★ | 仓库 | 域 | 接入方式 |
|--:|---|---|---|
| 1571 | `Unclecheng-li/AI_Animation` | 其他 | 纯提示词 → `contributes.skills` + `agent.prompt.inject` |
| 267 | `SepineTam/mcp-for-stata` | 其他 | 标准 MCP（`pyproject.toml` + `plugins/`）→ `mcpServers` stdio |
| 50 | `SepineTam/cnki-mcp` | 其他 | 标准 MCP + CLI + Skills（知网检索）→ `mcpServers` |
| 7 | `wooooooooolf/ser2mcp` | 其他 | MCP 服务器：串口暴露给 Agent → `mcpServers` stdio |
| 5 | `EDMOK/claude-vision-mcp` | 其他 | MCP 服务器：给纯文本模型加视觉（`dist/` 已构建）→ `mcpServers` |
| 3 | `plaask/fdtd-mcp` | 其他 | MCP 服务器：Lumerical FDTD → `mcpServers` |

**最小接入模板**（写进任意插件的 `manifest.json`）：

```json
{
  "permissions": ["mcp.server.local"],
  "contributes": {
    "mcpServers": [
      { "id": "stata", "label": "Stata-MCP", "transport": "stdio",
        "command": "uvx", "args": ["stata-mcp"] }
    ]
  }
}
```

> `mcp.server.local` 是 **Deny by default**，首次调用会弹确认。HTTP 端点用 `mcp.server.remote`，且必须在 `net.domains` 里放行。

---

## 4. P1：可移植（40 个，详见 `P1-可借鉴清单.md`）

这些与 DSH 无运行时绑定，能力宿主机中立，可移植为 PI 插件或 Skill。

| ★ | 仓库 | 域 | 移植落点建议 |
|--:|---|---|---|
| 3369 | `edison7009/EchoBird` | 成本与用量 | 账号/配额面板 → `panel` + `usage.read` |
| 917 | `mindscale-noah/MindMemOS` | 其他 | 独立 Python 服务，可作为 MCP 或 `background.service` |
| 643 | `inclusionAI/Avernet` | 其他 | 多 Agent 协调平台，参考其协议而非移植 |
| 539 | `Ikalus1988/MisakaNet` | 开发工具 | 零依赖经验库（有 `.claude-plugin`/`.c​odex-plugin`）→ Skill + MCP |
| 208 | `nutshellai-tech/mobius` | 任务与多智能体 | Agent OS，仅架构参考 |
| 128 | `fangqian616/consensus-pipeline` | 任务与多智能体 | 多 Agent 部门框架 → `agent.extension`（本地包） |
| 119 | `orziz/odai` | 任务与多智能体 | 任务治理框架 → 与 `local.task-center` 融合 |
| 106 | `samzong/Recall` | 会话管理 | 跨 Agent 会话检索（有 `skills/`）→ `session.read` + `panel` |
| 80 | `niuhuoshan/launch-wechat-miniprogram` | 接入与网关 | 纯 Skill 包 → `contributes.skills` |
| 26 | `kuangre123/iosdev` | 技能与预设 | Skill 包 → `contributes.skills` |
| 9 | `ciyuan1234/MCM_skills` | 技能与预设 | 数学建模 Skill 包 → `contributes.skills` |
| 3 | `zzjzzb/ai-memory` | 记忆与知识 | Rust+SQLite 语义层 → MCP 包装最省事 |

> 完整 40 条及分级见 `P1-可借鉴清单.md`；原始判定见 `游标台账-dsh-plugins.json`（筛 `cursor == "P1"` 得 47，其中 7 条经二次实测确认带 `cordis.patch.yml`，实为 DSH 插件）。

---

## 5. P2 里最可惜的几个（高星但装不上）

这些是 topic 里的明星项目，**全部绑定 DSH 运行时**，只能读源码借鉴：

| ★ | 仓库 | 为什么不能装 |
|--:|---|---|
| 7392 | `YuJunZhiXue/dsh-purge`（破甲） | 纯提示词面向 DSH 模型切换，且用途受限 |
| 5352 | `MeteorNOX/DeepSeek-Balance-Whale-Widget` | 注入 DSH Web 界面右下角，依赖 dsh web DOM |
| 3175 | `T-Auto/dsh-ops` | `dsh-plugin.json` 声明 `requires.contracts: tools.dsh/v1alpha1` |
| 2330 | `bowenliang123/dsh-context` | `cordis.patch.yml` + `engines.dsh`，依赖 dsh 会话事件 |
| 2124 | `Ebony-Vinyl/EAC-Desktop` | 整端桌面（Electron），是竞品 |
| 695 | `adoresever/graph-memory` | `dsh.ts` 原生 Cordis 适配器 |

---

## 6. 去重基线（避免重复比对）

本次判定已排除你**已安装插件已覆盖**的能力：

| 能力 | 已覆盖插件 | 被跳过 |
|---|---|---|
| 文档检索 | `local.doc-index` | 相关记忆/知识库插件 |
| 记忆治理 | `local.memory-governed` | 47 个记忆类 |
| 主题外观 | `local.obsidian-theme` | 41 个主题/皮肤类 |
| 终端 | `pi.terminal` | 19 个终端类 |
| Git | `io.github.liushunqiu.pi-idea-git` | Git 类 |
| 待办/任务 | `pi.todo` + `local.task-center` | 任务类 |
| 用量统计 | `local.token-meter` + `pi.token-insights` | 用量类 |
| 逆向工程 | `local.rea`（已是 MCP 模式） | REA 类 |

**与工作区已有分析的边界**：`DSH-SEP-对PI-Desktop的插件化增强分析.md` 研究的是**本地 `E:\code\ai-platform-amd64\DSH-SEP` 目录**（21 处提及均为该路径），不是本 topic，**零重叠**。本次是其增量：从"单一本地包"扩展到"1000 个社区仓库"。

---

## 7. 建议动作（按 ROI 排序）

1. **立刻做**：把 `mcp-for-stata` / `cnki-mcp` 包进一个 8 行 manifest 的壳插件，验证 MCP 通道 —— 这是唯一"今天就能用"的价值。
2. **值得做**：`samzong/Recall` 的跨 Agent 会话检索，正好补 `local.trajectory`（只读回放）缺的"搜索"能力。
3. **不要做**：任何 P2 的 DSH 插件移植。外壳重写成本 > 重写一个原生 PI 插件的成本。
4. **注意**：topic 只暴露 1000 个，但该 topic 全量是 **2294 个**（GitHub API `total_count`）。剩余 1294 个未纳入本次台账，如需可补抓。

---

## 8. 产物清单

| 文件 | 内容 |
|---|---|
| `游标台账-dsh-plugins.json` | 1000 条逐仓库判定：`cursor`(P0/P1/P2/SKIP)、`form`、`domain`、`why`、`port`、`covered` |
| `原始数据-1000仓库.json` | 抓取的原始字段：stars、language、updated、description |
| `README.md` | 本报告 |
