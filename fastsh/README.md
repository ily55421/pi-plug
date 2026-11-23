# 快速 Shell（local.fastsh）

给 PI-Desktop Agent 的 **POSIX 快速通道**：内嵌 [`mvdan.cc/sh`](https://github.com/mvdan/sh) v3 的常驻守护进程，用 Go 原生实现 29 个 Windows 上缺失的核心工具。

**目的：把轻量命令的端到端开销从 PowerShell 7 的约 400ms 降到数十毫秒。**

## 为什么需要它

PI-Desktop 的 Bash 工具在 Windows 上固定 spawn `pwsh.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`。本机实测：

| 场景 | 端到端耗时 |
|---|---|
| `pwsh -NoProfile -Command exit`（裸冷启动） | 271ms（240–321ms） |
| **本插件常驻 daemon，单条命令** | **41–81ms** |
| 内置 Bash 工具同一批次对照 | 385–457ms |

同一批次配对实测（本会话 JSONL 的 `durationMs`）：

| 时间 | `fastsh_run` | Bash | 倍数 |
|---|---|---|---|
| 12:40:12 | 41ms | 385ms | 9.4× |
| 12:42:09 | 81ms | 457ms | 5.6× |

**注意口径**：daemon 自身内部耗时确实是 0.16–0.2ms，但那不含宿主 IPC 与插件进程跳转。对使用者有意义的是上面的端到端数字。

## ⚠️ 关键前提：它需要被"发现"

插件工具在 PI-Desktop 里是**延迟加载的（deferred behind `ToolSearch`）**，不会出现在模型的常驻工具列表里，而内置 Bash 一直在。历史数据：

| 指标 | 数值 |
|---|---|
| Bash 调用（299 个会话） | 13,909 |
| `fastsh_run` 调用 | 9（全是开发时手动测试） |
| 采用率 | 0.065% |

这就是"装了插件却看不到任何性能提升"的真正原因——不是插件没效果，而是**几乎从未被调用**。

v0.2.0 起通过 `contributes.skills` + `agent.prompt.inject` 注册了一个 `fastsh-commands` 技能：技能目录会进入提示词，description 告诉模型"轻量只读 POSIX 命令走 fastsh_run"，从而让模型先 `ToolSearch("fastsh_run")` 激活再使用。

> **这个权限必须由用户从插件页重新加载并批准。** 开发态热重载遇到新增权限会按安全设计拒绝（日志：`PERMISSION_DENIED: manifest now requests agent.prompt.inject`），不会自动授权。

## 架构

```
Agent ──► fastsh_run 工具（插件 main.js）
              │  JSON-lines over stdio
              ▼
         bin/fastsh.exe（常驻，内嵌 mvdan.cc/sh v3）
              │
              ├─ interp.Runner（POSIX 语法解析 + 执行）
              └─ ExecHandler 拦截
                   ├─ PATH 里有的真实程序 → 直接 exec（git/node/go…）
                   └─ PATH 里没有的 → Go 原生 coreutils shim
```

- **daemon 常驻**：随插件启动、随插件退出，崩溃后下次调用自动重启。
- **协议**：stdin 每行一个 JSON 请求，stdout 每行一个 JSON 响应，带 `id` 配对。
- **硬限制**：单命令超时（默认 60s，上限 600s）、输出上限 8MB（超出**截断并标注**，不会挂住）。
- **管道读取并发化**：stdout/stderr 各由一个 goroutine 与 `runner.Run` 并行排空，超限后继续读取并丢弃。详见下方"修复记录"。

## 内置的 29 个 coreutils

Windows 上这些命令要么不存在、要么 System32 里躺着语义完全不同的古董程序（`sort.exe`、`find.exe`），因此**一律由 shim 接管，不回退 PATH**：

`ls` `cat` `cp` `mv` `rm` `mkdir` `rmdir` `touch` `wc` `head` `tail` `grep` `sed` `sort` `uniq` `find` `stat` `env` `printenv` `dirname` `basename` `tr` `sleep` `date` `seq` `yes` `true` `false` `pwd` `which`

`grep` 支持 `-i -v -n -c -l -r -E` 与 `--` 终止符；`sed` 支持 `s/pat/rep/[g|I]`（含转义分隔符与非 `/` 分隔符）；`head`/`tail` 支持 `-n N`、`-nN`、老式 `-N`，`tail` 另支持 `-n +N`；`find` 支持 `-name -type -maxdepth`，glob 的 `*` `?` `[abc]` `[!abc]` 均正确翻译。

## 回退判定（关键安全设计）

**原则：宁错杀不错漏。** 错杀只会回退到 pwsh（慢但正确）；漏杀或静默跑错会产生错误结果。

以下情况返回 `fallback=true` + 精确 `reason`，**不执行**，让模型立刻改用内置 Bash：

| reason | 触发条件 |
|---|---|
| `pwsh_env_var` | `$env:` / `${env:` / `$using:` 等 PowerShell 作用域变量 |
| `pwsh_cmdlet` | `Verb-Noun` 形式（Get-ChildItem、Select-Object…） |
| `pwsh_param` | `-ErrorAction` `-ExecutionPolicy` `-Recurse` 等专有参数 |
| `pwsh_operator` | `-eq` `-ne` `-match` 等比较运算符 |
| `pwsh_script` | `.ps1` |
| `pwsh_array` / `pwsh_block` | `@(` 数组、`%{}` / `?{}` 块 |
| `win_backslash_path` | `C:\...` 形式路径 |
| `win_relative_path` | `.\...` 形式相对路径 |
| `posix_parse_error` | 无法按 POSIX 语法解析 |
| `command_not_found` | 首命令不在内置/shim/PATH 中 |
| `cwd_not_found` | 工作目录不存在或不合法（**绝不在旧目录里继续执行**） |
| `daemon_unavailable` | daemon 起不来或管道断开 |
| `daemon_panic` | 单条命令内部 panic 被兜住（不会带走常驻进程） |
| `empty_command` | 缺少 command 参数 |

不会误伤 POSIX 合法写法：`${VAR:-default}`、`$HOME:/usr/bin`、`$(...)` 命令替换。

## 工作目录

默认工作目录 = **当前工作区根**，与内置 Bash 一致，因此相对路径命令（`rm` `cp` `mv`）可以放心用。

`main.js` 的 `resolveCwd` 会依次尝试宿主的 `pi.workspace.get/getActive/current/resolve`，兼容同步与返回 Promise 两种形状。只有全部失败才退回插件进程 cwd。daemon 侧对拿到的目录做 `Stat` + `IsDir` + `Chdir` 校验，任何一步失败都返回 `cwd_not_found` 而不是硬跑。

## 批量命令（commands[]）

一次工具调用发多条命令，摊薄宿主地板与模型轮次：

```jsonc
{ "commands": ["ls -la", "cat package.json | head -20", "wc -l src/main.go"] }
```

- 与 `command` 二选一（同时给则 `commands` 优先）；最多 **20** 条，超出回退 `batch_too_large`。
- **顺序执行**，保持命令间顺序语义；返回 `{ ok, batch:true, count, okCount, results:[...] }`。
- 收益在**宿主级**：N 条合并只付 1 次宿主地板 + 1 个模型轮次，省 (N−1) 次。
  插件层 pluginMs ≈ 逐条合计（内部串行），别拿 pluginMs 衡量批量收益。
- 注意：fastsh daemon 仍是**串行**循环（内部 0–6ms，排队可忽略），并发池只在 pwshd 侧。

## 计时口径（重要）

结果里的 `timings` 字段是插件自计时，**不依赖宿主日志、不受并发归因污染**：

| 字段 | 含义 |
|---|---|
| `pluginMs` | execute 全流程（含 IPC、cwd 解析、序列化） |
| `cwdMs` | resolveCwd 耗时（本机 0.01–0.6ms，无优化空间） |
| `daemonMs` | daemon 内部 handle 耗时（本机 0–6ms） |

- `pluginMs − daemonMs ≈ IPC + cwd + 序列化`。fastsh 插件层 pluginMs 中位 ~0.4ms。
- **宿主级**耗时 ≈ pluginMs + 固定宿主地板（本机 ~39ms），需从宿主会话 JSONL 取。
- **采样规则**：顺序单调用取 ≥5 次中位数；**禁止用并发样本的宿主级计时算倍数**（宿主会把墙钟全记到一条、其余记 0，产生伪值）。
- 不要拿 daemon 内部数（0–6ms）去对比宿主级数算倍数——口径不同。

## 权限与安全

- 声明 `agent.tool.register`（注册工具）与 `agent.prompt.inject`（把技能目录带进提示词）。
- 只 spawn 自带的 `bin/fastsh.exe`，不读项目文件、不联网、不碰剪贴板与凭据。
- daemon 是 app spawn 的子进程，外部无法连接（无管道、无端口）。

## 源码与构建

daemon 源码在 `src/`（`main.go` / `coreutils.go` / `coreutils2.go` / `detect.go`），随插件目录一起版本化：

```bash
cd src && go build -ldflags="-s -w" -o ../bin/fastsh.exe .
```

产物约 4.5MB，与仓库内已提交的 `bin/fastsh.exe` 一致。

## 测试

```bash
node --check main.js
node tests/daemon.test.cjs   # 直接驱动 bin/fastsh.exe：shim 语义 + 死锁 + cwd 校验
node tests/plugin.test.cjs   # 模拟宿主：工具注册、cwd 解析、fallback 格式、性能、崩溃自恢复
```

当前结果：**51 + 38 = 89 项断言全部通过**，常驻调用平均 0.20ms/次。

`tests/daemon.test.cjs` 覆盖：
1. shim 语义精确断言（wc/head/tail/grep/sed/find/sort/uniq/tr…）
2. PowerShell 语义回退判定
3. **大输出不再死锁**：3.9KB → 6.4KB → 20KB 文件 → 109KB → 1.2MB
4. 超过 8MB 上限截断、`yes` 无限输出按超时收口
5. 大输出之后 daemon 仍然响应（旧版这里会变砖）
6. 无效 cwd 明确回退，且不污染后续请求

## 修复记录（v0.2.0）

| 级别 | 问题 | 修法 |
|---|---|---|
| **P0** | 输出超过 Windows 管道缓冲（实测 4KB）后 **死锁**，`cat` 一个 9KB 文件即触发，且 daemon **永久变砖**（连 `echo` 都不再响应） | stdout/stderr 各起 goroutine 与 `runner.Run` 并发排空；超限后继续读取丢弃，避免写端再次阻塞 |
| **P1** | 默认 cwd 解析成 **PI-Desktop 安装目录**（`pi.workspace.get` 在真实宿主拿不到），`rm`/`cp`/`mv` 有打在安装目录的风险 | 多形状尝试 + 支持 Promise；daemon 侧增加 `cwd_not_found` 校验 |
| **P1** | `head -3` 静默返回 **10 行** | 支持老式 `-N`，`tail` 另支持 `-n +N` |
| **P1** | `wc -m` 把中文字符按字节算（`中文abc` 得 9，应为 5） | 拆开 `-c`(bytes) 与 `-m`(runes) |
| **P1** | `find -name` 的 glob 直接拼正则：`foo?` 匹配不到、`c++*` 编译报错、`[!b]` 排除失效 | 新增 `globToRegex`，逐字符翻译并 `QuoteMeta` |
| **P1** | `sed 's/a\/b/X/'` 正则编译失败 | 新增 `parseSCommand` 按转义规则手工切分；替换串里的 `$` 转义为 `$$` |
| **P1** | `grep -- -x` 报"缺少匹配模式" | 支持 `--` 终止符 |
| P2 | 单条命令 panic 会带走整个常驻进程 | `safeHandle` 兜住 panic，返回 `daemon_panic` |
| P2 | 无条件码不区分原因 | `posix_parse_error`=2、`command_not_found`=127、超时=124 |
| P2 | 采用率 0.065% | 新增 `fastsh-commands` 技能 + `agent.prompt.inject` |

## 已知限制

- **不能替换内置 Bash 工具**。PI-Desktop 插件 API 只有 `agent.tool.register`，没有 override 能力，所以这是"加一条快路"而不是"换掉终端"。
- `sed` 只实现 `s` 命令，且正则走 Go 的 RE2：**BRE 中间位置的 `$` / `^` 被当锚点**（`sed 's/a$b/x/'` 不会像 GNU sed 那样匹配字面量 `a$b`），反向引用 `\1` 不支持。
- `tail -f`、`grep -P`、`xargs`、`cut`、`awk` 未实现，用到时会走到 PATH 或报错。
- `find` 输出不带 `./` 前缀（输出 `main.go` 而非 `./main.go`），与 GNU find 略有差异。
- `yes` 单次最多输出 10 万行（既保证 `yes | head -3` 能终止，也避免无限输出）。
- glob 会在执行前按当前目录展开（与真实 shell 行为一致），`find . -name '*.go'` 记得加引号。
