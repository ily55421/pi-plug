# Learn —— 洞见回写

> `local.learn` v0.2.0 · 只申请一项权限：`agent.extension`

---

## 先说清楚：注入半场宿主已经有了

我最初把这项能力规划成「读文件时自动带出该子树 AGENTS.md」，但**动手前核实发现宿主已经原生实现**：

- `packages/agent-runtime/src/project-instructions.ts:78` 的 `loadProjectInstructions()` 会从 workspace 根一路走到目标目录，每层取一个文件，`AGENTS.override.md` 优先于 `AGENTS.md`，嵌套文件后到、有最后发言权；
- `runtime.ts:5127` 的 `loadPathInstructions()` 在 **`Read` / `Write` / `Edit` / `BrowserPreview`** 执行前，按 `params.path` 重建指令链并重算系统提示（工具集合见 `runtime.ts:578`）；
- 还带缓存、2 秒超时、失败回退到基础指令、改文件立即生效。

**所以注入半场不重做。** 本插件只补宿主没有的**回写半场**：把会话里学到的洞见写回就近那一层。

opencode 的 `.opencode/command/learn.md` 也是做这件事的，但它只是一段提示词，没有任何校验。本插件补的就是校验与安全。

---

## 提供的东西

| 工具 | 写入 | 说明 |
|---|:---:|---|
| `learn_scope` | 否 | 只读：这条洞见该写进哪个文件，以及该文件当前占多少预算。**绝不创建文件。** |
| `learn_append` | 是 | 真正写入。**默认关闭**，需显式开启 `learnAppend`。 |

作用域规则：给了 `file` 就写它所在目录；给了 `directory` 就写该目录；都没给就写 workspace 根。越界一律拒绝。

---

## 为什么这个插件必须带校验

AGENTS.md 会进入**每一次会话的系统提示**。写坏一条，代价是长期的上下文占用加上一个可能误导模型的错误约定。所以 `learn_append` 在写入前过这几道闸：

| 闸门 | 拒绝什么 |
|---|---|
| 长度 | 单条 > 600 字符（约定是 1-3 行） |
| 太短 | < 12 字符，或没有实际文字（`TODO`、`!!!`） |
| 会话细节 | 会话 id、ISO 时间戳、「the user asked me to…」、「好的，我明白了」 |
| 显然事实 | 「TypeScript is a programming language」这类标准框架行为 |
| 重复 | 与已有条目逐字相同（忽略首尾空白与 bullet 前缀）→ 跳过，不写第二次 |
| 体积 | 结果 > 32 KiB（与宿主 `MAX_INSTRUCTION_BYTES` 一致）→ **拒绝，不静默截断** |
| 越界 | 段级消解后不在 workspace 内 → 拒绝 |

> 截断尤其不能做：那会悄悄删掉别人的内容。超限就报错，让人来决定删哪条。

---

## 写入长什么样

已有文件不会被破坏，只会多一个 `## Learned` 段：

```markdown
# Project rules

Always use pnpm.

## Conventions

- two spaces

## Learned

- Run bun run generate after changing the public protocol; the client is generated and will drift otherwise.
```

`## Learned` 已存在就追加到该段末尾（不是文件末尾），段后还有别的段落也不会插错位置。CRLF 文件保持 CRLF。

---

## 权限：只有 `agent.extension`

**不要 `fs.read` / `fs.write`。** 规范原文（`04-plugin-security.md`）：

> `fs.*` permissions gate the plugin API, not the process

本插件的文件读写走 sidecar 内的 `node:fs`，属于进程能力——那两项权限**根本不生效**，声明只会让用户以为多了一层保护。真正的保护来自代码里的路径消解、文件名白名单、体积上限与内容校验。

实测：一开始我按「需要写文件」的直觉声明了 `fs.read` + `fs.write`，`PluginCheck` 直接报出 `permission.unused`（`main.js` 从未调用 `fs.*`）与 `fs-no-scope`。删掉后警告从 4 条降到 1 条（只剩预期的 `agent.extension` 高风险提示）。

---

## 已知边界

1. **写入默认关闭**，需要显式 `pluginSettings.learnAppend === true`。`agent.extension` 的 ctx 不暴露插件设置（`runner.ts:713`），所以目前只能靠显式注入——但「改别人每次会话都要读的文件」这件事，默认关才是对的。
2. **以 `ctx.cwd` 作为 workspace 根**。`agent.extension` 的 ctx 没有独立的 workspaceRoot 字段；`cwd` 与宿主 `loadInstructionChain(projectPath)` 的语义一致。
3. **只写三个文件名**：`AGENTS.override.md`、`AGENTS.md`、`CLAUDE.md`（沿用宿主优先级）。不碰其他任何路径。
4. **不做近重复检测**。两条措辞不同但意思相近的洞见会被都写入——判断「哪条该留」是人的事，插件不该替他删。（对比 `local.skill-budget`：那里也是只报近重复、不自动合并。）
5. **写入后不主动触发重新加载**。宿主的指令链是按工具调用路径懒惰重建的，所以下一次触及该目录的工具调用就会生效；`learn_append` 的返回里也写明了这一点。

---

## 测试

```powershell
node --test tests/core.test.mjs tests/extension.test.mjs
```

- `tests/core.test.mjs`（27 项）：路径消解与越界（含 `..` 穿越）、作用域推荐、六道校验闸门、`## Learned` 段的插入位置、重复检测、CRLF 保留、体积上限拒绝。
- `tests/extension.test.mjs`（17 项）：真实临时目录 + 真实文件读写——只读工具不建文件、默认关闭不写、开启后写入、第二次追加、重复跳过、校验不过不落盘、越界不写、既有内容不被破坏、会话隔离。

**经宿主同款 jiti loader 实测**（真实临时目录）：

```
typeof loaded = function
tools = learn_scope,learn_append
默认关闭 → 不写 ✓
learn_scope → src/AGENTS.md | 未建文件: ✓
开启后 → 写入 ✓ 目标 src/AGENTS.md
文件内容: "## Learned\n\n- Always regenerate the client after protocol changes."
重复写入 → 跳过 ✓
越界 → 拒绝 ✓
```

`PluginCheck` 通过（唯一提示是预期的 `agent.extension` 授权）。

---

## 与其它插件的关系

- 与 `local.memory-governed` 分工明确：那个是**证据绑定的结构化记忆库**（候选/确认状态机、revision 锁、可查询），这个是**路径作用域的纯文本工程约定**（随代码走、进 Git、人和模型都直接读）。
- 与 `local.mcode-skill-pack/project-init`：那个负责**初始化**根级 AGENTS.md，这个负责**运行期按层维护**，可衔接。
