# Loop Brake —— 重复工具调用闸

> `local.loop-brake` v0.2.0 · 只申请一项权限：`agent.extension`

模型陷入死循环时，常见表现不是「想不明白」，而是**用完全相同的参数反复调用同一个工具**，每次都拿到同样的结果，然后继续重试。提示词里的纪律挡不住它，因为它发生在工具层。

这个插件在 agent 循环里装了道闸：同一工具以同一组入参**连续**重复达到阈值，先给出一次警告；再重复就阻断，并把原因交给模型。

它对应 opencode 的 `doom_loop` 权限键，并多做了两件事：

1. **连续语义**——中间夹一次别的调用就清零，所以「分页读取」「读文件→搜索→再读」这类合法重复不会被误杀。
2. **先警告后阻断**——第一次撞线只提醒不拦，给模型一次自我纠正的机会。

---

## 为什么它只申请 `agent.extension`

`agent.extension` 是 PI-Desktop 里最强、风险也最高的扩展点：代码跑在 agent sidecar 内，具备 agent 自身的能力。只要这一项，就已经能改系统提示、替换工具结果、带原因阻断工具调用、在会话 cwd 执行命令。

因此本插件**故意不申请** `fs.*`、`net.*`、`clipboard.*`、`process` 之类的权限：它不需要。判定完全在内存里做，不落盘、不联网、不起子进程、不调用模型。

> ⚠️ 安装时会要求你**显式授予** `agent.extension`（`PluginCheck` 会给出 `permission.high-risk` 提示，这是预期行为）。
> ⚠️ 按 PI-Desktop 规范，持有 `agent.extension` 的插件在 v1.1 **不能上架市场**，只能从本地导入或作为开发插件加载（`16-trusted-extensions.md:51-53`）。

---

## 行为

| 连续相同调用 | warn 模式（默认） | block 模式 |
|---|---|---|
| 第 1 次 | 放行 | 放行 |
| 第 2 次 | 放行 | 放行 |
| 第 3 次 | 放行 + 记一次警告 | **阻断** |
| 第 4 次及以后 | **阻断** | **阻断** |

默认阈值 3（对齐 opencode）。阻断时返回宿主认识的 `{ block: true, reason }`，`reason` 是给模型看的，措辞刻意给出下一步动作：

> `Blocked: 3 identical back-to-back calls to Read with arguments {file_path="/a"}. The loop-brake extension stopped this call because an identical one already ran 3 times. Do not retry the same arguments. Either change the arguments, use a different strategy, or tell the user what is blocking you.`

警告走 `context` 事件注入一条 `system` 消息（`tool_call` 的返回值只认 `block/reason`，没有「放行 + 提示」这一档）。这条消息**只在有警告待发时**才注入，且每次警告只注入一次。

### 什么算「同一组入参」

指纹 = 工具名 + 归一化后的入参：

- 对象键**排序**后参与计算（`{a,b}` 与 `{b,a}` 是同一身份）
- 数组**保持顺序**（顺序是语义的一部分）
- 数字 `1` 与 `1.0` 等同
- 超过 2048 字符的字符串取「头部 + 尾部 64 字符 + 总长度」摘要——只截断会导致「头部相同、尾部不同」的两次 `Write` 被误判
- 过深嵌套与循环引用按深度截断，**绝不抛错**

**刻意不做**的归一化：绝对路径、时间戳、UUID。剥掉它们就等于承认「不同目录的两次 `Read` 是同一次」，那会误杀合法调用。**宁可漏判，不可误杀**——漏判还有 warn 阶段兜底。

---

## 提供的东西

| 类型 | 名称 | 说明 |
|---|---|---|
| 事件 | `tool_call` | 主闸。返回 `{block, reason}` 或 `undefined` |
| 事件 | `context` | 把警告作为 `system` 消息递进上下文 |
| 事件 | `session_shutdown` | 释放该会话状态 |
| 工具 | `loop_brake_status` | 只读：当前阈值、模式、连续次数、警告/阻断计数、最近一次被阻断的工具 |
| 命令 | `/loop-brake-reset` | 清空当前会话的连续计数（误判时的逃生口） |

被本插件自己注册的工具不参与判定（避免「查状态」被自己的闸拦下）。

---

## 测试

```powershell
# 必跑：44 项，无外部依赖
node --test tests/core.test.mjs tests/extension.test.mjs

# 可选：经宿主同款 jiti loader 的集成测试（装了就 4 项全跑，没装则明确跳过）
npm i --no-save jiti
node --test tests/host-loader.test.mjs
```

`tests/core.test.mjs`（28 项）覆盖指纹归一化的每个误判场景、设置净化、闸门状态机、文案不泄露。
`tests/extension.test.mjs`（16 项）用假 `pi` 跑真实入口，覆盖事件订阅、返回值形状、会话隔离、异常兜底、状态清理。
`tests/host-loader.test.mjs`（4 项）用与 PI-Desktop `loader.ts` 完全相同的方式加载入口——验证的是「打包后宿主能不能真的取出并执行这个模块」。

**已实测**：`PluginCheck` 通过（仅 `permission.high-risk` 一条预期提示）；经 jiti 以宿主同款参数加载，`typeof default === "function"`，事件订阅为 `tool_call,context,session_shutdown`，第 1–3 次放行、第 4 次返回 `{block:true, reason}`。

---

## 已知边界

1. **只认「连续」重复。** 交互式的 `A,B,A,B,A` 这类交替循环不会触发——这是为不误杀正常探索而做的取舍（分析文档 §8.5 讨论了误判的两类来源与缓解手段）。
2. **阈值目前不可配。** 宿主 `createContext`（`runner.ts:713`）不暴露插件设置给 extension，因此 `threshold` / `mode` / `ignoreTools` 走默认值。`core.mjs` 的 `normalizeSettings` 已完整实现且被测试覆盖，接上设置通道即可生效——那是宿主侧的事，不是插件的缺口。需要「允许重复」时，用 `/loop-brake-reset` 或临时禁用插件。
3. **改设置会清空计数**（设计如此）：否则用户收紧阈值时会立刻误伤下一个调用。
4. **警告依赖 `context` 事件**：若某会话始终不触发 `context`（例如工具调用后立即结束），警告会滞留到下一次 `context` 才注入，不会丢失也不会重复。
5. **命令可达性未做端到端验证**：`registerCommand` 已按契约注册（`runner.ts` 的 registerCommand 校验 name + handler），但「在输入框里敲 `/loop-brake-reset` 能命中」取决于宿主命令解析与扩展加载时机（`16-trusted-extensions.md` §8 要求会话运行期已加载扩展）。本插件只保证注册成功，未在真实应用里手测这条路径。
6. **不覆盖子代理内部的工具循环**：`subagent.ts` 中没有 `extensionRunner` 引用，子代理的工具调用不经过 extension 事件通道。此结论**基于源码结构推断**，未运行验证。

---

## 与 `loop-guard` 技能的分工

`loop-guard` 是**纯提示词 + 事后扫描**（诊断历史会话里 token 异常烧毁、thinking 尾部空转）；本插件是**实时拦截**。两者互补：插件负责在发生的那一刻挡住，技能负责事后复盘与预防纪律。
