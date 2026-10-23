# Format on Edit —— 编辑后格式化

> `local.format-on-edit` v0.2.0 · 只申请一项权限：`agent.extension`

PI-Desktop 有完整的编辑工具，但**没有自动格式化**。这个插件补上它——同时处理掉它在 PI-Desktop 上独有的那个坑。

---

## 这个插件真正解决的问题不是「格式化」

PI-Desktop 的 `Edit` 要求一个 **4-hex 文件 tag**（`4 uppercase hex from the latest Read, Grep, Write, or Edit`）。tag 是整文件内容的哈希：

```
tag(text) = uppercase_hex_4(low_16_bits(SHA-256(hash_input)))
hash_input = 每一行去掉尾随 [空格|tab|CR]，用 LF join
（算之前先剥 BOM；CRLF 先归一成 LF）
```

来源：`crates/host-core/src/tools/hashline/tag.rs:93-123`。

**所以格式化一旦改了文件，tag 就变了。** 如果插件只把文件格式化掉却不告诉模型，模型手里还是旧 tag，下一次 `Edit` 就会 `EDIT_PARSE_FAILED`——看起来像「插件把编辑搞坏了」，实际是 tag 没回传。

opencode 不存在这个问题：它的 `edit` 用精确字符串替换、格式化在工具内部同步跑完才返回。**移植到 PI-Desktop 必须自己补这一环。**

本插件在 `tool_result` 里做三件事：算旧 tag → 跑 formatter → 算新 tag 并回传：

```
[format-on-edit] gofmt reformatted src/main.go.
The file tag changed from A1B2 to C3D4.
Line count changed by -2.
Use `C3D4` as the tag in your next Edit for this path, re-read the file if you need exact line numbers.
```

---

## 提供的东西

| 类型 | 名称 | 说明 |
|---|---|---|
| 事件 | `tool_result` | `Edit` / `Write` 成功后格式化，并把新 tag 并入工具结果 |
| 工具 | `format_on_edit_status` | 只读：是否启用、考虑/格式化/跳过/失败各多少次、最近一次的决策与原因 |

---

## 默认关闭，且层层设闸

自动改写用户文件是侵入性操作，所以**未显式开启时完全不动**（需要 `pluginSettings.formatOnEdit === true`）。开启后仍要过这些闸，**任何一条不满足就不格式化**：

| 闸门 | 理由 |
|---|---|
| 工具必须是 `Edit` / `Write` | 其他工具不写文件 |
| 该次调用未失败 | 失败时文件可能只写了一半，格式化会更乱 |
| 路径不在 `node_modules`/`dist`/`build`/`target`/`vendor`/`.git`/`coverage` | 不碰生成物 |
| 扩展名有对应 formatter | 没表就不猜 |
| 项目确实声明了该 formatter 的依赖或配置 | 全局同名命令可能在乱跑，把风格改坏 |
| 文件 ≤ 2 MiB | 大文件会拖垮宿主 30 秒的事件窗口 |
| formatter 8 秒内退出且退出码为 0 | 超时即放弃 |

**失败一律退回原结果**，并在结果里写明「未格式化 + 原因」。一次成功的编辑绝不会因为格式化失败而变成失败——静默不格式化比报错更难排查，所以失败也要说出来。

### formatter 表（刻意只收「命令可用即用」的）

| formatter | 扩展名 | 前置要求 |
|---|---|---|
| prettier | js/jsx/ts/tsx/json/css/md/yaml/html… | 项目有 `prettier` 依赖 |
| biome | js/ts/json/css/md | 项目有 `biome.json` |
| ruff | py/pyi | 项目有 `ruff` 依赖 |
| gofmt | go | 无 |
| rustfmt | rs | 无 |
| shfmt | sh/bash | 无 |

**刻意排除** clang-format、ocamlformat、pint、rubocop、ktlint：它们必须靠项目配置文件才能正确工作，没有配置就跑可能改变用户的代码风格。

---

## 已知边界

1. **设置的读取通道**。agent extension 的 ctx 不暴露插件设置（`runner.ts:713` 的 `createContext` 没有 settings 字段），所以本插件读宿主落盘的 `<PI_DESKTOP_DATA_DIR|~/.pi-desktop>/plugins/data/local.format-on-edit/settings.json`（与宿主 `setPluginSettings` 的写入路径一致）。默认关闭；在插件设置页打开后立即生效。
2. **`Write` 之后也会格式化**。整文件写入同样改变内容，tag 同样会变，所以一并处理。
3. **Windows 上 JS 系 formatter 受宿主 exec 限制**。宿主 `exec` 用无 shell 的 `spawn`（`runner.ts:641`），Windows 上 npm 安装的 `prettier`/`biome` 是 `.cmd` shim，`CreateProcess` 只自动补 `.exe` —— 这类命令会 ENOENT。`.exe` 类工具（`gofmt`/`rustfmt`/`ruff`/`shfmt`）不受影响。失败会在结果里注明原因而不是静默跳过。
4. **不格式化「用户自己改的文件」**。宿主没有 `file.edited` 事件广播给插件（这是向宿主提的需求 #6），所以只能覆盖 agent 自己的编辑。
5. **超时交给宿主**。`pi.exec(..., { timeout: 8000 })`（`runner.ts:654` 到点 SIGTERM），保证 formatter 不会在后台继续写盘、让我们算出与磁盘最终内容不符的 tag。

---

## 测试

```powershell
node --test tests/core.test.mjs tests/extension.test.mjs
```

- `tests/core.test.mjs`（35 项）：tag 算法（含 18 个与 Rust 交叉验证的向量）、formatter 选择、跳过路径、**每一条闸门的 fail-closed 行为**、提示文案。
- `tests/extension.test.mjs`（19 项）：用**真实临时文件 + 真实子进程**跑通完整链路——默认关闭不动、开启后格式化并把新 tag 回传、内容未变时报当前 tag、行数变化、formatter 失败退回、`exec` 抛错、相对路径解析、状态工具。

### tag 算法与 Rust 侧的一致性是实测的

`tag.rs` 的哈希只用到 `sha2`，没法在无 crate 环境直接编译整个文件。所以做了**交叉验证**：用 std-only Rust 复刻 `hash_input`（`split('\n')` + 逐行 `trim_end_matches([' ', '\t', '\r'])` + LF join），把结果 hex 交给 JS 端算 SHA-256，与 JS 实现逐值比对：

```
PASS "hello\n"                rust=BE03 js=BE03
PASS "hello"                  rust=9824 js=9824
PASS ""                       rust=B855 js=B855
PASS "a\r\nb\r\n"             rust=59A2 js=59A2
PASS "a\rb\rc\r"              rust=E4D2 js=E4D2
PASS "中文内容\n第二行  \n"    rust=24D8 js=24D8
PASS "   \n   \n   \n"        rust=2167 js=2167
… 共 18 例，18/18 一致
```

这些向量已固化进 `tests/core.test.mjs`，回归时可复现。

**经宿主同款 jiti loader 实测**：`typeof default === "function"`，事件为 `session_shutdown, tool_result`，工具为 `format_on_edit_status`，默认关闭时不改写结果。`PluginCheck` 通过（唯一提示是预期的 `agent.extension` 授权）。
