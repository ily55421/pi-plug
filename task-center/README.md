# 任务中心（local.task-center）

版本 **0.4.1**，要求 **PI-Desktop 0.23.0 或更新版本**。提供按会话隔离的任务清单、右侧进度视图，以及有界的无进展提醒。

## 工具与面板

| 工具 | 行为 |
|---|---|
| `todo_write` | 替换调用会话的完整清单，返回摘要、`runId` 和 `revision`。最多 200 项，每项描述最多 500 个 UTF-16 码元，最多一项 `in_progress`。 |
| `todo_read` | 默认返回一次完整清单和统计；`detail:"summary"` 只返回摘要。收尾前检查 `ok` 和 `remainingCount`。 |
| `todo_history` | 只读查看各会话清单占用、归档状态与总容量。永久清理须由用户手动运行 `taskCenter.purgeArchived` 命令。 |
| `todo_guard_status` | Agent 扩展提供的只读状态：当前计划、预算、待投递提醒、读取错误、容量与存储指标。 |

面板只展示当前可见会话，通过插件只读 `taskCenter.snapshot` 接口获取统一快照。任务按进行中、待办、完成、取消排列；同组保留清单顺序。

**进度表示已结束比例**：`(completed + cancelled) / total`，并分别显示完成与取消数量。空清单为 0%。工具和面板使用同一个后端统计函数。

可见时按需轮询：清单还有未完成项约 3 秒一次，已结束或为空降到 20 秒；宿主推送的 `session:turnEnded` 会立即触发一次刷新。读取失败按 3、6、15、30 秒退避，成功后恢复常规间隔。隐藏时暂停，恢复立即刷新。未变化只返回版本提示，不重建列表。主题优先通过 `appearance:changed` 推送；无订阅接口时每 30 秒回退读取。读取失败会保留上次成功快照并标注过期；无活动会话或会话切换时清空旧内容。占用达到 8 MiB 预算的 80% 时，面板提示可手动运行 `taskCenter.purgeArchived` 清理归档。任务文本使用 `textContent`，不会解析 HTML。

## 建立和更新计划

工具的会话身份取自宿主执行上下文，模型无需也不能指定其他会话。首次创建示例：

```json
{
  "expectedRevision": 0,
  "newPlan": true,
  "todos": [
    { "content": "定位问题并确认复现", "status": "in_progress", "priority": "high" },
    { "content": "完成修复并运行回归检查", "status": "pending", "priority": "medium" }
  ]
}
```

后续更新携带最近读取或写入返回的 `revision` 作为 `expectedRevision`。遇到 `REVISION_CONFLICT`，先读取，再合并后提交；不要直接重试旧清单。为兼容原调用，版本参数可省略，但省略时无法识别逻辑上的过期提交。

- 新目标使用 `newPlan:true`，生成新的 `runId` 并重置守卫预算。
- 同一目标补充或调整步骤保持原计划。
- 旧计划全部结束后提交新的未完成任务，也会自动生成新 `runId`。
- 相同清单重复提交不保存、不增加版本；显式 `newPlan:true` 除外。
- 每个会话的清单是独立文件；索引与容量在插件进程内串行更新，避免跨会话丢失更新。
- `todos:[]` 清空当前会话清单。

简要复查：

```json
{ "detail": "summary" }
```

计划模式只允许只读工具，以显式 action 调用：

```json
{ "action": "read", "detail": "full" }
```

输入空白、非字符串描述、超限和多项 `in_progress` 会拒绝保存。缺失优先级补 `medium`；直接调用绕过 schema 时，非法状态或优先级会修正并在 `notes` 中说明。读取持久化数据时严格校验，损坏状态不会被悄悄降级。

## 守卫的实际行为

守卫**不会调用模型、自动续跑或停止模型调度**。它在 `before_agent_start` 建立基线，在 `tool_result` 观察可确认的变更，执行稳定结束后的 `agent_settled` 结算；需要提醒时，在下一次启动的系统提示末尾追加一次提示。因此没有下一次启动时，不会凭空发起新一轮。

| 场景 | 规则 |
|---|---|
| 有进展 | 不提醒，不消耗提醒额度，清零连续停滞计数。 |
| 无进展且有剩余任务 | 增加停滞计数，准备下一次启动时的提醒。 |
| 达到上限 | 准备一次带准确原因的收束提示，投递后暂停重复提醒。 |
| 用户中止或模型错误 | 不累计停滞，不触发该次提醒。 |
| 新计划、全部结束、关闭开关 | 清理相应计数与待提醒状态。 |
| 重复结束事件 | 只结算一次。 |
| 提示投递前计划或版本变化 | 丢弃过期提示，不消耗投递额度。 |

确认进展的证据：成功 `Edit` / `Write` / `Patch`；其他工具需要结构化结果明确报告 `changed:true` 或非空 `changedFiles`，且没有错误、后台启动或未变化标记；同文案任务从待办/进行中转为完成/取消也算进展。

**退出码为 0 的 Bash 本身不算修改**，只读命令不能重置停滞。删除、改名、重排任务及重复提交清单也不算完成。守卫无法证明任务质量，真实完成仍需要 Agent 验证；纯调查型任务应及时记录已验证步骤。

设置：`guardEnabled` 默认 true；`maxNudges` 为每计划实际提醒上限，默认 10（1–50）；`stallLimit` 为连续无进展结束次数上限，默认 3（1–10），第 N 次即命中；`maxStoredSessions` 为保留的最近会话数，默认 100（1–1000）。守卫计数保存在 Runner 内存，重载插件或关闭会话会重置；超过 30 分钟没有活动、且不在运行、没有待投递提醒的会话状态会被回收，最多同时保留 100 个会话状态（当前会话始终保留）。

## 数据、升级和错误

`settings.json` 只保存插件设置和轻量索引，每个会话的清单单独成文件：

```text
<插件私有目录>/settings.json                    设置 + 索引
<插件私有目录>/sessions/<sha256>.json           当前会话清单
<插件私有目录>/sessions/archive/<sha256>.json   超出保留数量的旧会话
```

```json
{
  "version": 3,
  "index": {
    "<sha256>": {
      "id": "session:<sessionId>", "runId": "计划标识", "revision": 1,
      "updatedAt": 1700000000000, "bytes": 186, "total": 2, "remaining": 1, "archived": false
    }
  }
}
```

会话文件是权威数据，索引只服务容量、保留与历史列表；索引落后时以文件为准，下一次写入会修正。会话文件用「临时文件 + 同目录 `rename`」原子替换，读者不会读到写了一半的内容。文件名取自 sessionId 的 SHA-256，会话名不能影响路径。

**0.3.0 升级**：首次写入时把旧版内联的 `todoSessions`（version 2）迁移为每会话文件，然后只保留索引。只读路径不带迁移，直接读内联数据；迁移可重入，已有更新的会话文件不会被旧数据覆盖。旧版 `todoState` 保留原样——它没有可靠会话归属，不会自动迁移进当前会话；工具与面板通过 `legacyAvailable` 提示旧记录存在。

**容量与保留**：所有当前会话文件、归档文件与索引共同受 8 MiB 预算约束，单个会话文件上限 2 MiB。写入前核对实际归档文件大小，超限返回 `STATE_TOO_LARGE` 且不落盘。未归档会话超过 `maxStoredSessions` 时，最旧会话移动到归档目录并标记 `archived`，**只移动不删除**。`todo_history` 只读；用户可手动运行 `taskCenter.purgeArchived` 永久清理已归档及旧版遗留归档文件。索引达到 1000 条时拒绝新增会话而不丢弃索引；先手动清理归档再重试。归档清理在索引中记录 `purgePending`，部分失败可再次运行同一命令。

读取带文件指纹缓存（字节数 + mtime + ctime）：文件未变化时直接复用解析结果，不重复读盘；自身写入后按真实指纹预热缓存；文件被外部修改时指纹变化会重新读取，损坏检测不会被缓存跳过。

普通入口通过 `pi.plugin.getDataPath()` 定位私有目录并严格读取设置文件；扩展使用宿主数据根目录读取同一文件。这样可避免宿主 `getSettings()` 将损坏 JSON 回退为默认值时造成误判。保存仍使用宿主设置 API，不读取或写入用户项目文件。

面板身份来源：插件进程没有 `session.getActive`，因此优先使用宿主注入的执行上下文；面板读取时用 bridge 的 `session.getActive` 提供可见会话身份，插件进程也会记住宿主 `session:turnEnded` 事件里的会话身份作为后备。身份只用于读本插件自己的清单，且参数经过长度与类型校验。

| 错误码 | 含义和处理 |
|---|---|
| `SESSION_REQUIRED` | 工具缺少调用会话；不使用全局回退清单。 |
| `NO_ACTIVE_SESSION` / `SESSION_CHANGED` | 面板无可见会话或读取中切换，稍后重试。 |
| `STORAGE_READ_FAILED` / `STATE_CORRUPT` | 状态未知；不能当作空清单或已完成。保存会被拒绝，修复数据后重试。 |
| `STORAGE_WRITE_FAILED` | 保存未确认；若正在执行归档清理，先查看历史中的 `purgePending`，再手动重试清理命令。 |
| `ABORTED` | 调用被取消（宿主以 `PLUGIN_TOOL_ABORTED` 拒绝在途调用时归一化为此码）；提交期间会尝试回滚会话文件和索引。 |
| `REVISION_CONFLICT` | 旧版本提交，先读取合并。 |
| `STATE_TOO_LARGE` | 单个会话超过 2 MiB、总预算超过 8 MiB 或索引达到 1000 条，拒绝继续扩大；用 `todo_history` 查看后手动运行 `taskCenter.purgeArchived`。 |

权限为 `ui.view`、`agent.tool.register`、`agent.prompt.inject`、`agent.extension`，没有新增权限。不联网，不执行命令，不碰剪贴板或凭据。私有文件没有宿主级跨进程事务；串行队列与「先写会话文件、再提交索引、失败即回滚」保护的是本插件进程中的写入，手工外部修改设置不属于并发编辑接口。

## 检查与打包

无需安装第三方依赖。测试中临时文件只放 `PI_SCRATCH_DIR`；在其他环境中把该变量设为项目内专用临时目录。

```powershell
$env:TEMP = $env:PI_SCRATCH_DIR
$env:TMP = $env:PI_SCRATCH_DIR
npm --prefix .\task-center test        # 状态、存储、守卫、面板单元测试
npm --prefix .\task-center run check   # node --check 全部入口
npm --prefix .\task-center run test:all  # 单元测试 + 宿主集成测试
```

宿主进程 IPC 集成测试单独一条命令，避免默认 `npm test` 静默跳过：

```powershell
$env:PI_PLUGIN_HOST_ENTRY = 'E:\code\ai-platform-amd64\PI-Desktop\apps\desktop\electron\main\plugin-host-process.mjs'
npm --prefix .\task-center run test:host
```

该测试运行真实插件宿主进程（`plugin-host-process.mjs`），宿主 API 由隔离夹具模拟；覆盖加载、会话隔离、快照、损坏数据、取消时文件与索引回滚和卸载。它不代表运行中应用的权限、真实 Agent 生命周期及窗口事件均已端到端验证。

然后执行 `PluginCheck` 和 `PluginPack`。结构校验通过不等于运行权限已授权。`.piplug` 必须由 `PluginPack` 产生，不使用普通 ZIP 工具。

## 文件职责

| 文件 | 职责 |
|---|---|
| `manifest.json` | 身份、权限、唯一工具 schema、视图和设置声明 |
| `main.js` | 工具、串行保存、迁移与归档、版本冲突及只读快照接口 |
| `state.cjs` | 共享数据契约：校验、统计与快照 |
| `storage.cjs` | 私有文件布局、指纹缓存、原子写、保留与容量 |
| `extension/core.mjs` / `extension/index.mjs` | 守卫纯逻辑及生命周期接线、守卫状态回收 |
| `renderer/index.html` / `renderer/panel.js` | 面板样式与串行刷新 |
| `tests/` | 状态、存储、守卫、面板与宿主 IPC 测试 |
| `skills/todo-recheck.md` | Agent 清单维护与收尾复查规范 |