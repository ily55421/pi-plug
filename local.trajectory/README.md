# 轨迹回放 (local.trajectory)

PI-Desktop 停靠视图插件：把任意历史会话回放成时间线——turn 分组、工具调用链、
思考块折叠、逐轮 token/时长徽章、可拖动的播放头。设计对齐 Pace 的 Trajectory
Cockpit 词汇（Strip / Ledger / Inspector / Playhead），在 PI-Desktop 的插件体系内实现。

## 功能

- **三段式回放器**：左侧会话列表（搜索、最近活跃排序、stale/partial 徽章）→
  顶部 turn 时间线（等宽格、token 柱、工具/思考计数、compaction 切分线、拖动播放头）→
  下方 Inspector（逐条消息展开，工具卡片含参数与结果，思考块默认折叠）。
- **逐轮计量**：每 turn 的输出 token（实测）、模型用时（实测 Σ responseDurationMs）、
  墙钟跨度（推导）、上下文规模近似 ctx≈（推导）。
- **按需加载**：索引只存每块 ≤160 字预览与字节偏移；完整内容按块原位读取，
  单条消息超 8MB 时如实标记「未整段加载」。
- **对齐当前会话**：面板每次打开自动切换到用户当前交互的会话（宿主 messages 表
  「最近真人输入」为一级信号，索引 lastUserTs 与 mtime 逐级降级；mtime 会被后台
  长任务的流式写入污染，真人输入时间更贴近「当前」）。会话名对齐宿主侧栏显示名，
  绿色「当前」徽章标记。跟随模式可开启持续对齐；关闭时手动翻看不被打断。
- **跟随最新 turn**：对齐/刷新后停在该会话最新 turn，开启跟随可实时追新。
- **命令**：`轨迹回放：重建全部会话索引`（后台执行，完成 toast 提醒）。

## 诚信纪律（对齐 Pace Trajectory 的设计）

1. **turn 边界是推导的**：jsonl 里不存在 run/turn 边界，本插件按「用户消息切分」
   推导 turn，所有 UI 明标 `derived`（虚线徽章 / ○ 记号）。
2. **token 数字是实测的**：来自 Pi 记录的 `meta.usage`，标注 `measured`
   （实线徽章 / ● 记号）；缺失就是缺失，不伪造 0。
3. **不显示费用**：宿主记录中没有费用数据，本插件拒绝显示任何估算费用。
4. **超长内容不假装加载**：超过上限的内容明确标注截断，不悄悄丢弃。

## 数据与安全

- 只读 `~/.pi-desktop/sessions/*.jsonl`（排除 `*.revisions.jsonl`），不联网，
  除自己数据目录下的索引缓存外不写入任何位置。
- 插件进程用原生 Node fs 读取（宿主权限网关不介入原生 Node 调用，
  与官方 pi.token-insights / local.token-meter 同一取舍），因此只声明 `ui.view`
  权限，并在 manifest 的 safetyNotes 里如实披露。
- 索引缓存在插件数据目录 `cache/{idx,row}/` 下，按 mtime+size 自动失效与重建。

## 架构

```
engine.js   纯 Node 索引引擎：按字节偏移流式解析 jsonl、turn 推导、
            缓存层、原位随机读取（可用 node 直接测试，不依赖 pi）
main.js     pi 胶水层：onPanelInvoke 通道分发、外观读取、预热与重建命令
views/      停靠视图（CSP 白名单、无内联脚本、textContent 渲染防注入）
  ├─ index.html  三段式骨架
  ├─ app.css     dark/light 双主题（宿主只给 base）
  └─ app.js      列表/时间线/Inspector 渲染、播放头拖动、跟随轮询
```

视图 ↔ 插件进程通道（onPanelInvoke 自定义 RPC，宿主已验证的范式）：

| 通道 | 说明 |
|---|---|
| `trajectory.list` | 会话列表；每次调用最多重建 3 个索引，`pendingCount` 驱动渐进构建 |
| `trajectory.timeline` | turn 序列 + compaction 标记 + 诚信标记 |
| `trajectory.turn` | 一页 turn 内容（默认 120 条/页） |
| `trajectory.block` | 单块完整内容（按 off/len/bi 原位读） |
| `trajectory.appearance` | 宿主明暗/语言（3s TTL 缓存） |
| `trajectory.rebuild` | 强制重建（单个或全部） |

## 已知边界

- **「当前会话」是判定不是 API**：宿主没有暴露「当前会话」，本插件用三级信号判定
  （宿主 messages 表最近真人输入 → 索引 lastUserTs → mtime），basis 字段在响应里
  如实标注来源。并行多会话时对齐「最后输入的会话」；正在处理请求但用户已切去
  另一会话输入时，以后者为准（无更强信号可得）。
- **停靠视图收不到 push**：跟随/外观靠可见性感知的轮询实现。
- **工具结果是独立消息行**：role=`tool`，每行一个 tool_call 块（实测 schema，
  本插件按此渲染）。
- **pi.sqlite 只读两处**：kv 表取主题/语言（既有），sessions/messages 表取会话
  标题、删除态与「最近真人输入」（本次新增，只读，读失败自动降级）。

## 开发与验证

```bash
node --check local.trajectory/engine.js
node --check local.trajectory/main.js
node --check local.trajectory/views/app.js

# 引擎真实数据测试（18MB 会话：1549 条消息 / 851 工具调用 / 11 turn）
node Temp/scripts/test-trajectory-engine.js

# 生成回放 UI 视觉测试台（mock pluginBridge + 真实数据 fixtures）
node Temp/scripts/make-trajectory-harness.js
# 打开 Temp/trajectory-harness/index.html 检查渲染
```

PluginScaffold 模板改动说明：由 panel-basic 改为停靠视图——manifest 的
`ui.panel` → `ui.view` + `contributes.views`，删除模板的 `renderer/` 目录。
**权限形状变化需在插件页对该插件执行一次「重新加载」才会生效。**

## License

MIT
