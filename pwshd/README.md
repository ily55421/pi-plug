# 常驻 PowerShell（local.pwshd）

给 PI-Desktop Agent 的 **PowerShell 快速通道**：常驻一个 `pwsh` 进程，每条命令在独立 Runspace 中执行，
省掉每次约 250ms 的 pwsh 冷启动。

**目的：把轻量 PowerShell 命令的单次耗时从约 440ms 降到约 60ms。**

## 为什么做这个（而不是 POSIX 版本）

先前的 `local.fastsh` 走 POSIX 路线，实测在本机只有 **1.3%** 的 Bash 调用能被它接手——
本机 95% 的 shell 命令用的是 PowerShell 语法（`Get-ChildItem` 占 60%、`$env:` 占 35%）。
所以真正该消除的是 **pwsh 冷启动**，不是 POSIX 兼容性。

## 实测数据

**先分清口径**（详见下方「计时口径」）：`pluginMs` 是插件 execute 全流程，`宿主级` 还含宿主工具包装。
两者相差约一个固定的宿主地板（本机 ~118ms），不要拿 daemon 内部数去算宿主级倍数。

| 指标 | 数值 |
|---|---|
| 内置 Bash 轻命令（每次新起 pwsh，宿主级） | 385–518ms |
| `pwsh_run` 单调用（插件层 pluginMs 中位） | **~11ms**（daemonMs ~10ms） |
| `pwsh_run` 单调用（宿主级中位） | **~129ms** |
| 8 条并发（各 sleep 200ms，池 Workers=4） | **wall ~500ms**（串行同批 ~1750ms，约 3.5×） |
| 批量 8 条轻命令（1 次调用） | pluginMs ≈ 逐条合计；省 7 次宿主地板 + 7 个模型轮次 |
| daemon 启动（一次性，插件加载时预热） | 约 370ms |
| 状态隔离 | ✓ 变量与函数不跨命令残留（并发下亦成立） |
| 协议完整性 | ✓ stdout 无非 JSON 行（含并发写入） |

本机历史数据：Bash 调用占全部工具耗时的 **57%**，平均每会话 **61.8 次**。
按每次省约 380ms 计，平均每会话可省 **约 23s**（Bash 总时间的 4.4%）。

## 架构

```
Agent ──► pwsh_run 工具（插件 main.js）
              │  stdin: base64(UTF8 JSON{id,command,cwd,timeoutMs}) 每行一条
              │  stdout: 一行 JSON 结果（id 配对，并发下乱序返回）
              ▼
         ./server.ps1 -Workers 4（常驻 pwsh -NoProfile -NonInteractive）
              │
              ├─ 主线程：私有 StreamReader 读 stdin → BlockingCollection 入队（不执行命令）
              └─ 4 个 worker runspace：取请求 → 每条命令新建独立 Runspace → BeginInvoke()
                   ├─ Set-Location（在 Runspace 内，不污染宿主 stdout）
                   ├─ WaitOne(timeoutMs) 收口超时（exitCode=124，只停该命令）
                   ├─ 结果经 Out-String 格式化后打包成字符串返回
                   └─ ErrorRecord 与普通输出分流 → stdout / stderr
```

### 三个关键设计决定

**1. 池化的是 worker，不是 Runspace。**
N 个 worker runspace 并行取请求，消灭单线程循环的排队（并发工具调用不再互相等待）。
但**每条命令仍新建独立 Runspace**——变量、函数、`$ErrorActionPreference` 都不跨命令残留，
行为等价于"每次新开 pwsh"，与内置 Bash 一致。复用单 Runspace 更快，但会让 `$x=1` 漏到后续调用，
排查这类"上一条命令影响了下一条"的诡异 bug 成本远高于几毫秒。

**2. 所有副作用都留在 Runspace 内部。**
原型阶段踩过的坑：用 `SessionStateProxy.Path.SetLocation()` 会在宿主 stdout 上**泄漏一行路径**；
`Get-Location` 这类 cmdlet 的格式化结果也会泄漏 `Path`/`----` 表格——两者都会破坏 JSON 协议。
现在切目录、`Out-String` 格式化、错误分流全部在 Runspace 内完成，只返回一个打包好的字符串。

**3. 进程 stdin 句柄换成 NUL（池化必需）。**
主线程阻塞读协议管道时，worker 里的原生命令（`git` 等）继承的是**进程 stdin 句柄**而非 `Console.In`，
若仍指向协议管道，它们会等一个永不关闭的 stdin 而卡死（`node -e` 不读 stdin 故幸免，`git rev-parse` 必挂）。
启动时先以私有 `StreamReader` 持有原始管道句柄读协议，再 `SetStdHandle(STD_INPUT_HANDLE, NUL)`，
原生命令拿到 EOF 即解。这同时符合"无 TTY、不提供交互 stdin"的既有语义。

## 与 Bash 的语义对齐

语义基线取自 `pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command` 实测：

| 命令 | 宿主 Bash 退出码 | `pwsh_run` | 说明 |
|---|---|---|---|
| `'ok'` | 0 | 0 | |
| `Write-Error 'boom'; 'after'` | 0 | 0 | 最后一条成功即 0 |
| `Write-Error 'boom'` | 1 | 1 | |
| `cmd /c exit 7` | **1** | **1** | 宿主用 `$?` 而非 `$LASTEXITCODE`，本插件对齐 |
| `Get-ChildItem -Path no-such` | 1 | 1 | |
| `... -ErrorAction SilentlyContinue; 'ok'` | 0 | 0 | |
| `throw 'fatal'` | 1 | 1 | |
| `exit 3` | 3 | **1 + note** | 见下方限制 |

退出码按 `$?` 判定（成功 0 / 失败 1），与 `pwsh -Command` 完全一致。

## 已知限制

- **`exit N` 无法透传退出码**。`exit` 会终止 Runspace 管道，且 PowerShell 不把 N 暴露给宿主 API。
  本插件检测到这种情况（收尾标记缺失）后按 1 上报，并在 `note` 字段里说明，避免给出静默的错误值。
  需要精确退出码时用内置 Bash。
- **长任务会占住一个 worker**。`npm run build`、`go test`、`msbuild` 这类应继续走 Bash：
  池有 4 个 worker，长命令占住其一，其余仍可服务；但把 worker 全占满就会排队。
  每命令超时由 worker 自行收口（`exitCode=124`，只停该命令的 Runspace，daemon 与其余 worker 不受影响）；
  插件侧杀进程重建仅作最后兜底（worker 也卡死时）。
- **没有 TTY**，交互式命令不适用；原生命令的 stdin 为 EOF（NUL），需要交互输入的命令不适用。
- 输出上限 8MB（超出截断并标注）。这一项在实现里由 `Out-String` + 响应裁剪保证。

## 批量命令（commands[]）

一次工具调用发多条命令，摊薄宿主地板与模型轮次：

```jsonc
{ "commands": ["Get-ChildItem -File | Measure-Object", "Test-Path ./main.js", "$env:OS"] }
```

- 与 `command` 二选一（同时给则 `commands` 优先）；最多 **20** 条，超出回退 `batch_too_large`。
- **顺序执行**，保持命令间顺序语义；每条仍在独立 Runspace 中跑。
- 返回 `{ ok, batch:true, count, okCount, results:[...] }`，`results[]` 按序含每条的 stdout/exitCode/timings。
- 收益在**宿主级**：N 条合并只付 1 次宿主地板（本机 ~118ms）+ 1 个模型轮次，省 (N−1) 次。
  插件层 pluginMs ≈ 逐条合计（内部本就串行），所以别拿 pluginMs 衡量批量收益。

## 计时口径（重要）

结果里的 `timings` 字段是插件自计时，**不依赖宿主日志、不受并发归因污染**：

| 字段 | 含义 |
|---|---|
| `pluginMs` | execute 全流程（含 IPC、cwd 解析、序列化） |
| `cwdMs` | resolveCwd 耗时（本机 0.01–0.6ms，无优化空间） |
| `daemonMs` | server.ps1 内部执行耗时（Runspace 创建 + 命令） |
| `ipcMs` | 请求写入管道 → 收到响应行的往返（含 daemon 读取排队） |

- `pluginMs − daemonMs ≈ IPC + cwd + 序列化`；`ipcMs` 在并发下会因池内排队而升高，但总 wall 下降。
- **宿主级**耗时（宿主工具包装）≈ pluginMs + 固定地板（本机 ~118ms），需从宿主会话 JSONL 取。
- **采样规则**：顺序单调用取 ≥5 次中位数；**禁止用并发样本的宿主级计时算倍数**——宿主会把墙钟全记到其中一条、其余记 0，产生伪值。并发收益用 wall 对比串行理论值。

## 权限与安全

- 声明 `agent.tool.register`（注册工具）与 `agent.prompt.inject`（把技能目录带进提示词）。
- 只通过本机 `pwsh` 执行自带的 `server.ps1`，不读项目文件、不联网、不碰剪贴板与凭据。
- daemon 是 app 的子进程，外部没有管道或端口可连。
- 工作目录默认取真实工作区根（多形状兼容宿主的 workspace API），拿不到才退回进程 cwd。

## 测试

```bash
node --check main.js
node tests/daemon.test.cjs   # 直接驱动 server.ps1：语义对齐、协议完整性、状态隔离、大输出
node tests/plugin.test.cjs   # 模拟宿主：工具注册、cwd、fallback、性能、崩溃自恢复、卸载
```

当前结果：**30 + 42 = 72 项断言全部通过**。

`tests/daemon.test.cjs` 的重点覆盖面（都是原型阶段真实踩到的问题）：
1. 退出码与宿主逐条对齐（含 `cmd /c exit 7` → 1 这种反直觉项）
2. stdout/stderr 分流正确
3. 变量与函数不跨命令泄漏
4. `exit` 被识别并明确告知，而不是静默错值
5. 大输出不卡死、之后 daemon 仍响应
6. **stdout 无非 JSON 行**（协议污染回归测试）
7. **并发池吞吐**：8 条并发 wall 远低于串行；**每命令超时 124 且 daemon 存活**；并发下状态隔离

## 使用

Agent 会看到一个名为 `plugin_local_pwshd_pwsh_run` 的工具。它是按需工具，首次使用前需要
`ToolSearch("pwsh_run")` 激活；技能 `pwshd-commands` 的目录条目会进入提示词，告诉模型何时该用它。

- 轻量 PowerShell 命令 → 用它
- 长构建 / 测试套件 / 需要精确 `exit N` / 交互式 → 用内置 Bash
- 拿到 `fallback=true` → **不要重试**，直接用 Bash 重跑
