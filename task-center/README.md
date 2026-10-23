# 任务中心（local.pi-todo）

给 Agent 用的结构化任务清单 + 右侧工作面板的进度视图。补上 PI-Desktop 缺的 `todowrite` 能力。

## 它做什么

**两个 Agent 工具**

| 工具 | 作用 |
|---|---|
| `todo_write` | 建/改整份清单。每条含 `content`、`status`（pending / in_progress / completed / cancelled）、`priority`（high / medium / low）。**每次提交完整清单，覆盖上一份。** |
| `todo_read` | 读当前清单快照：逐条状态、计数、完成度、当前进行项。收尾前用它复查剩余步骤。 |

**一个工作面板视图**（右侧面板 → 任务）：进度条、`已完成/总数 · 百分比`、当前进行项、按状态排序的清单（进行中 → 待办 → 已完成 → 已取消），优先级用颜色区分。

**一个技能**（`todo-recheck`）：教 Agent 长任务开工建清单、每步更新、收尾前复查，把"漏做最后一步"这类问题挡在报告之前。

## 安装

```
PluginCheck → PluginPack → 插件页安装 .piplug
```

开发时用「加载开发插件」选目录，保存即热重载。

## 使用

让 Agent 做一个多步任务，例如"重构 X 模块并补测试"，它会自动建清单；面板实时显示进度。也可以直接说"先列个任务清单"。

Agent 侧调用示例：

```json
{
  "todos": [
    { "content": "读现有实现，定位耦合点", "status": "completed", "priority": "high" },
    { "content": "抽出 X 模块接口", "status": "in_progress", "priority": "high" },
    { "content": "迁移调用方", "status": "pending", "priority": "medium" },
    { "content": "补单元测试", "status": "pending", "priority": "medium" }
  ]
}
```

## 数据与隐私

- 清单存在**插件自己的设置**里（`todoState` 键），路径在宿主数据目录的插件设置文件下。
- **不读工作区文件、不联网、不执行命令、不碰剪贴板与凭据。**
- 权限只声明 `agent.tool.register`、`agent.prompt.inject`、`ui.view`、`notify` 四项，无 `fs.*`、无 `net.*`。
- 工具只接收纯文本任务描述并写回插件设置；`content` 上限 500 字符，清单上限 200 条。

## 设计取舍

**为什么状态存在插件设置里而不是工作区文件**：方案文档原设想写 `workspace: .pi-todo.json`，但那需要 `fs.write` 高风险权限，并且会在用户项目里留下一个非项目文件。视图页拿到的 `window.pluginBridge` 恰好有固定的 `plugin.getSettings` 通道，插件进程用 `pi.plugin.setSettings` 写、视图轮询读——本机 `local.token-meter` 与官方 `pi.token-insights` 用的就是这个范式，零文件副作用。

**容错而非报错**：模型漏传 `priority` 补 `medium`，状态非法降级为 `pending`；只有 `content` 全空或条数超限才抛错。工具报错会打断模型的执行流，不值得为可推断的字段这么做。多条同时 `in_progress` 只作为 `notes` 提示，不阻断。

## 已知边界

- 插件无法拦截内置工具，也无法感知 turn 结束，所以"连续 N 轮不调用工具就提醒复查"这类机制级防空转做不到——那是宿主钩子的范围。这里用**技能约束 + 面板可见性**双保险替代。
- 清单是会话级的：换会话后 Agent 需要重新建，但旧清单仍在设置里，可用 `todo_read` 查看。

## 文件

```
manifest.json          身份、权限、工具 schema、视图与技能声明
main.js                工具实现、清单规范化与统计（含 __test 导出）
renderer/index.html    任务视图（轮询 plugin.getSettings 渲染）
skills/todo-recheck.md 长任务复查技能
```
