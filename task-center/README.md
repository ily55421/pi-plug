# 任务中心（local.task-center）

版本 **0.3.0**，要求 **PI-Desktop 0.23.0 或更新版本**。提供按会话隔离的任务清单、右侧进度视图，以及有界的无进展提醒。

## 工具与面板

| 工具 | 行为 |
|---|---|
| `todo_write` | 替换调用会话的完整清单，返回摘要、`runId` 和 `revision`。最多 200 项，每项描述最多 500 个 UTF-16 码元，最多一项 `in_progress`。 |
| `todo_read` | 默认返回一次完整清单和统计；`detail:"summary"` 只返回摘要。收尾前检查 `ok` 和 `remainingCount`。 |
| `todo_guard_status` | Agent 扩展提供的只读状态：当前计划、预算、待投递提醒、读取错误。 |

面板只展示当前可见会话，通过插件只读 `taskCenter.snapshot` 接口获取统一快照。任务按进行中、待办、完成、取消排列；同组保留清单顺序。

**进度表示已结束比例**：`(completed + cancelled) / total`，并分别显示完成与取消数量。空清单为 0%。工具和面板使用同一个后端统计函数。

可见时每次请求完成后等待约 3 秒再读取；隐藏时暂停，恢复立即刷新。未变化只返回版本提示，不重建列表。主题优先通过 `appearance:changed` 推送；无订阅接口时每 30 秒回退读取，隐藏时暂停。读取失败会保留上次成功快照并标注过期；无活动会话或会话切换时清空旧内容。任务文本使用 `textContent`，不会解析 HTML。

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
- 所有会话共享设置文件，整个读改写在插件进程内串行，避免跨会话丢失更新。
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

设置：`guardEnabled` 默认 true；`maxNudges` 为每计划实际提醒上限，默认 10（1–50）；`stallLimit` 为连续无进展结束次数上限，默认 3（1–10），第 N 次即命中。守卫计数保存在 Runner 内存，重载插件或关闭会话会重置。

## 数据、升级和错误

状态保存在插件私有 `settings.json` 的 `todoSessions` 键：

```json
{
  "version": 2,
  "sessions": {
    "session:<sessionId>": {
      "runId": "计划标识",
      "revision": 1,
      "updatedAt": 1700000000000,
      "todos": []
    }
  }
}
```

旧版 `todoState` 保留原样。因为它没有可靠会话归属，不会自动迁移进当前会话；工具与面板通过 `legacyAvailable` 提示旧记录存在。需要继续旧工作时，在目标会话重新明确建立清单。

普通入口通过 `pi.plugin.getDataPath()` 定位私有目录并严格读取设置文件；扩展使用宿主数据根目录读取同一文件。这样可避免宿主 `getSettings()` 将损坏 JSON 回退为默认值时造成误判。保存仍使用宿主设置 API，不读取或写入用户项目文件。

| 错误码 | 含义和处理 |
|---|---|
| `SESSION_REQUIRED` | 工具缺少调用会话；不使用全局回退清单。 |
| `NO_ACTIVE_SESSION` / `SESSION_CHANGED` | 面板无可见会话或读取中切换，稍后重试。 |
| `STORAGE_READ_FAILED` / `STATE_CORRUPT` | 状态未知；不能当作空清单或已完成。保存会被拒绝，修复数据后重试。 |
| `STORAGE_WRITE_FAILED` | 保存未确认，先重新读取实际版本。 |
| `REVISION_CONFLICT` | 旧版本提交，先读取合并。 |
| `STATE_TOO_LARGE` | 设置超过 8 MiB 边界，拒绝继续扩大；先备份并归档旧会话。 |

权限为 `ui.view`、`agent.tool.register`、`agent.prompt.inject`、`agent.extension`，没有新增权限。不联网，不执行命令，不碰剪贴板或凭据。私有文件没有宿主级跨进程事务；串行队列保护的是本插件进程中的清单写入，手工外部修改设置不属于并发编辑接口。

## 检查与打包

无需安装第三方依赖。测试中临时文件只放 `PI_SCRATCH_DIR`；在其他环境中把该变量设为项目内专用临时目录。

```powershell
$env:TEMP = $env:PI_SCRATCH_DIR
$env:TMP = $env:PI_SCRATCH_DIR
npm --prefix .\task-center test
npm --prefix .\task-center run check
```

运行宿主进程 IPC 集成测试时，提供对应版本的插件宿主进程 `.mjs` 路径：

```powershell
$env:PI_PLUGIN_HOST_ENTRY = Join-Path $env:PI_SCRATCH_DIR 'task-center-host.mjs'
node --test .\task-center\tests\host.test.mjs
```

该测试运行真实插件宿主进程，宿主 API 由隔离夹具模拟；不代表运行中应用的权限、真实 Agent 生命周期及窗口事件均已端到端验证。

然后执行 `PluginCheck` 和 `PluginPack`。结构校验通过不等于运行权限已授权。`.piplug` 必须由 `PluginPack` 产生，不使用普通 ZIP 工具。

## 文件职责

| 文件 | 职责 |
|---|---|
| `manifest.json` | 身份、权限、唯一工具 schema、视图和设置声明 |
| `main.js` | 工具、串行保存、版本冲突及只读快照接口 |
| `state.cjs` / `storage.cjs` | 共享数据校验、统计和私有设置读取 |
| `extension/core.mjs` / `extension/index.mjs` | 守卫纯逻辑及生命周期接线 |
| `renderer/index.html` / `renderer/panel.js` | 面板样式和串行刷新 |
| `tests/` | 状态、守卫、面板与可选宿主 IPC 测试 |
| `skills/todo-recheck.md` | Agent 清单维护与收尾复查规范 |
