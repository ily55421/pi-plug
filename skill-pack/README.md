# MCode 技能包（local.mcode-skill-pack）

从 MiniMax Code 的方法论里移植的一组**纯提示词技能**。没有工具、没有文件权限、没有网络——只是让 Agent 在合适的时机按一套更靠谱的流程做事。

其中 `skill-creator` / `skill-refiner` 是**元技能**：它们让 Agent 帮你把重复的工作流沉淀成可复用技能。用得越久，这套技能包越值钱。

## 收录的技能

| 技能 | 什么时候触发 |
|---|---|
| **skill-creator** | 你说"把这个流程做成技能"、"以后都这么做"。用短 eval 循环产出高密度 SKILL.md |
| **skill-refiner** | 你说"这个技能不好用"、"改改那个技能"。先归因再最小改动，有真实证据才动手 |
| context-summary-format | "压缩上下文"、"总结一下进度"、"准备交接"。按 Goal / Constraints / Progress / Decisions / Next Steps / Critical Context 固定结构输出 |
| project-init | "给这个项目写个 AGENTS.md"。增量更新而不覆盖 |
| code-review | "review 一下我的改动"。按 Blocker / Major / Minor / Nit 分级，带 file:line |
| deep-research | "帮我调研一下 X"。多轮检索、交叉验证、带来源 |
| x-link-reader | 你贴 x.com / twitter.com 链接问内容。走 FxTwitter API 拿结构化数据 |
| visual-page | "把这份数据做成网页"。单文件 HTML，双击即看 |

长任务复查（`todo-recheck`）**不在这里**，它随 `local.task-center` 插件提供——因为那个技能要调用的 `todo_write` / `todo_read` 工具由任务中心注册，放在一起才自洽，也避免两个插件提供同名技能造成重复触发。

## 安装

```
PluginCheck → PluginPack → 插件页安装 .piplug
```

装好后技能目录会进入 Agent 的 Skill 目录，正文按需读取，不常驻占用上下文。

## 用元技能沉淀你自己的技能

这是本包最有价值的用法：

```
你：我刚摸清了怎么查同事的飞书日历空档，把这个做成技能
```

Agent 会加载 `skill-creator`，然后：查重 → 判断该放用户级还是项目级 → 从刚才的对话提炼最短流程 → 写 description（含触发词与"不该触发"的边界）→ lint → 起两个子代理做"带技能 vs 不带技能"的对照 eval → 报告结论。

技能默认落在 `~/.agents/skills/<name>/SKILL.md`。这个目录是 **pi CLI 与 PI-Desktop 共用**的，写在那里两个宿主都能发现。

技能不好用时：

```
你：feishu-availability 这个技能老是误触发
```

Agent 会加载 `skill-refiner`：先要具体证据（哪次误触发、什么提示词），归因是技能文本的问题还是模型的问题，只做最小补丁，然后用同一个提示词验证改前改后。

## 权限与隐私

**只声明 `agent.prompt.inject` 一项权限。**

- 不注册 Agent 工具（`agent.tool.register` 未申请）
- 不读项目文件（无 `fs.read`）
- 不写任何位置（无 `fs.write`）
- 不联网（无 `net.fetch`）
- 不存储任何数据

技能正文里描述的操作（跑 git、读文件、抓网页）执行时用的都是 Agent **自己那些另行授权的常规工具**——这个插件不会替它们开权限。

## 设计取舍

**为什么技能要写得这么"克制"**：技能目录的 name + description 会进入系统提示常驻，正文按需读取。所以 description 必须精确到能区分"该触发"和"不该触发"（比如 `skill-creator` 明确写了"改进既有技能请用 skill-refiner"），否则会互相污染触发条件。这也是本包里每个技能都显式写出边界的原因。

**为什么 skill-refiner 强调"无证据不改"**：最常见的误判是"Agent 没照做 → 加更多 ALWAYS/NEVER"。规则越多遵守率越低。正确做法是先归因，很多时候结论是"不该改技能"。

**为什么正文不写 Mavis 的专有概念**：mcode 原版面向 Mavis 运行时，正文里有 `mavis` CLI、`{{DATA_DIR}}`、`skill({name})`、Task 的 `run_in_background` 等 PI-Desktop 不存在的东西。这些全部被替换成了 PI-Desktop 的实际工具（`Read`/`Grep`/`Task`/`Skill`）与真实路径（`~/.agents/skills/`）。技能里提到不存在的工具，模型会照做然后失败——这比不写技能更糟。

**来源与许可**：方法论来自 MiniMax Code（MIT）的 `packages/local-runtime/assets/skills/`。这里是**改写吸收**，不是逐字复制：保留了它验证过的流程骨架（渐进披露、短 eval 循环、反模式清单、description 四要素），但重写了所有正文以适配 PI-Desktop。`context-summary-format` 的结构取自 pi-mono 的 `docs/compaction.md`（Goal / Constraints & Preferences / Progress(Done/In Progress/Blocked) / Key Decisions / Next Steps / Critical Context + `<read-files>` / `<modified-files>`）。

## 文件

```
manifest.json   身份、技能清单、唯一权限 agent.prompt.inject
main.js         空实现（skills 是声明式贡献，无需运行时注册）
skills/*.md     8 个技能文档
```
