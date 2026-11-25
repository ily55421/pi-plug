# 快速 Shell（`local.fastsh`）

PI-Desktop 的常驻 POSIX 命令通道。`main.js` 通过 stdio 驱动随插件发布的 Go daemon，内嵌 `mvdan.cc/sh/v3`。适合轻量只读检查和简单管道，省去每次启动 PowerShell 的开销。内置命令仅实现常用选项，长构建、交互和 PowerShell 脚本使用其他通道。

## 使用

先用 `ToolSearch("fastsh_run")` 激活工具。使用 POSIX 语法和正斜杠路径。

```json
{"commands":["ls -la","wc -l src/main.go","head -n 5 package.json"],"batchTimeoutMs":10000}
```

- `command` 运行一条；非空 `commands` 优先，最多 20 条。批量只节省宿主调用，daemon 仍串行逐条执行，`results[]` 保留输入顺序，普通失败不短路。需要失败即停时用独立调用，或在单条命令中使用 `&&`。
- `cwd` 默认采用已解析的工作区根，显式相对路径以该根为基准。没有工作区时必须传有效绝对目录，否则不执行。`cd` 后，文件 shim、重定向及原生命令按当前解释器工作目录解析路径；另一条命令不继承 `cd`。
- `timeoutMs` 单条默认 60 秒，受宿主限制。`batchTimeoutMs` 默认 90 秒，范围 1–90 秒；过期后不提交其余命令，daemon 执行前也会检查期限。取消可停止等待和后续提交；不保证已发出的命令未执行。
- 单条 stdout 和 stderr 共用 8 MiB 文本输出预算，批量所有结果也共享 8 MiB，分别用 `stdoutTruncated` / `stderrTruncated` 标识。预算不等于 JSON 响应总大小或所有 shim 的总内存上限。

## 执行状态与回退

| 状态 | 含义与处理 |
|---|---|
| `not_started` | 没开始执行。若 `fallback=true`，参考 `fallbackReason` 改用合适的执行通道或先修正参数。 |
| `finished` | 使用 `exitCode` 判断结果；124 表示超时，命令仍可能有部分副作用。 |
| `unknown` | 命令可能执行过，但响应丢失。`fallback=false`，**不要自动重放**。下一次独立调用会按需启动 daemon。 |

PowerShell 判定在 POSIX 语法树上检查明显的命令和参数特征，不把引号中的普通文本当成 cmdlet。该判断不是完整的 PowerShell 解析器，不应主动用此通道尝试 PowerShell。只有明确发现整个请求未开始，才允许提示回退；命令执行中的失败不是整段回退。

## 支持范围

常用 shim：`ls`、`cat`、`grep`、`find`、`wc`、`head`、`tail`、`stat`、`sed`、`sort`、`uniq`、`tr` 等。不要假定它们兼容完整 GNU 选项（例如 `grep -P` 和 `tail -f`）。普通程序可从解释器环境查找；显式程序路径不被同名 shim 接管。工具可按照命令读写文件或运行本机程序，并非只读沙箱。

## 构建与验证

在插件目录执行（Windows / amd64）：

```powershell
Push-Location src
try { gofmt -w coreutils.go coreutils2.go coreutils_test.go detect.go main.go; go test ./...; go build -trimpath -buildvcs=false -ldflags '-s -w -buildid=' -o ../bin/fastsh.exe . } finally { Pop-Location }
node --check main.js
node tests/daemon.test.cjs
node tests/plugin.test.cjs
```

`coreutils_test.go` 覆盖流式计数、长行、tail 环形缓冲和流式复制。发布前必须用上述固定参数重建 `bin/fastsh.exe`，再运行全部测试，避免随包二进制与 Go 源码漂移。

PI-Desktop 安装清单使用 `PluginCheck` 验证，发布时使用 `PluginPack`。性能测量区分 daemon 耗时、插件往返和宿主端到端；`timings.daemonMs` 为 daemon 内部毫秒计时，`timings.pluginMs` 为该条插件响应耗时，`cwdMs` 为解析工作区耗时。比较并发吞吐应使用整批墙钟，不能直接用单条宿主日志计时相减。
