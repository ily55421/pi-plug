# 页面标注 (local.annotate)

PI-Desktop 技能包插件：教 agent 用宿主内置 Browser 工具在网页上做**可视化标注**——
序号徽章 + 高亮框 + 截图回传 + 编号问题报告。这是把 Pace 的「DOM 标注」能力
以「工具 + 技能」组合方式落进 PI-Desktop 的形态（P5 提案）。

## 为什么是技能而不是面板

Pace 把标注做成宿主 UI（design-mode 工具条 + isolated world overlay）。
PI-Desktop 已把 Browser 工具（navigate/snapshot/click/fill/evaluate/screenshot/cdp）
直接暴露给 agent，所以标注的全部能力 = **一段注入脚本 + 一份操作规程**：
- 零 UI 成本、零工具注册；
- 唯一权限 `agent.prompt.inject`（技能文档进系统提示词）；
- 约 80% 的 Pace 体验，且任何 agent 会话里说一句话就能触发。

## 技能内容（skills/dom-annotate.md）

- 触发：用户要求圈出页面问题 / 给元素编号 / 批注截图反馈 / 产出带编号的报告；
  纯浏览操作类请求不触发。
- 流程：snapshot 定位 → 组装标注数组（CSS 选择器或文本匹配，≤8 条/批）
  → evaluate 注入 Shadow DOM overlay（徽章 + 高亮框 + 说明气泡 + 右上角状态签）
  → screenshot → 按注入返回的 results 生成报告 → 用户确认后 remove() 清理。
- 诚信边界：一次性注入（无持久工具条）、agent 中介（无 live 点选）、
  主世界注入（敌意页面可能干扰，届时回退纯文字报告）——全部在技能里如实写明。

## 注入脚本要点

- 挂在 `document.documentElement` 下、`attachShadow` 封闭样式，
  `:host{all:initial}` + 内部字体，页面 CSS 无法污染标注层；
- `pointer-events:none`，不影响页面交互；
- 重复注入幂等（先 remove 旧 overlay）；
- 返回 `placed/missed/results`（元素描述、文本摘要、矩形坐标），
  报告数据直接取自返回值，杜绝凭记忆转述。

## 已验证

- 注入脚本在真实页面通过 CDP evaluate 完成端到端验证：注入、按 CSS/文本定位、
  单 host、Shadow DOM 徽章/高亮/气泡计数、幂等替换、NOT_FOUND 缺失路径、
  remove() 清理，全部有 DOM 断言；返回值含 title/url（报告头数据来源）。
- screenshot 工具通道在工作面板隐藏时不可用，截图步骤未实测（该步骤是宿主
  Browser 工具的既有能力，不在本插件代码路径内）；
- PluginCheck 通过、PluginPack 打包产物见 `dist/`。

## License

MIT
