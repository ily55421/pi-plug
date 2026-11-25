# 常驻 PowerShell（local.pwshd）

`plugin_local_pwshd_pwsh_run` 复用本机 `pwsh` 进程，适合短时 PowerShell 查询、`$env:` 读取和普通原生程序调用（如 `git`）。首次使用可通过 `ToolSearch("pwsh_run")` 激活。

```json
{ "commands": ["Get-ChildItem -File | Select-Object -First 5", "git status --short"], "parallel": true, "batchTimeoutMs": 5000 }
```

- `command` 执行单条；`commands` 优先，接受 1–20 条。默认顺序执行，不因普通失败而短路；只有独立任务才设 `parallel: true`（最多 4 条同时提交）。`results[]` 始终按输入顺序返回。需要「前一条成功才继续」时，请分次调用。
- `cwd` 默认是实际工作区根；相对路径基于该根解析。没有可用工作区就提供绝对文件系统路径，不会降到插件进程目录。目录不存在或不可用时不执行命令。
- `timeoutMs` 是每条命令的执行时限（默认 60 秒，范围 1–600 秒，受宿主和批量截止限制）；worker 成功停止该 Runspace 时返回 124。`batchTimeoutMs` 是批量总时限（1–90000 毫秒，默认 90000，含 cwd 解析、daemon 启动及等待）。取消或总截止后不提交新条目；服务端也不会启动在截止后出队的条目。已经提交但未收到结果的条目可能已开始或仍在收口，不能推断副作用已撤销。

## 看结果再决定是否重试

| `status` | 含义 | `fallback` |
| --- | --- | --- |
| `not_started` | 启动、定位目录、准备失败或有界队列已满（`reason: "queue_full"`）；或者 `skipped: true`（取消／截止） | 仅非跳过情形允许回退 |
| `finished` | 已收到执行结果。常见命令按最后的 `$?` 映射到 0/1，执行超时为 124 | `false` |
| `unknown` | 已尝试发送，未确认结果（如 I/O 错误、daemon 崩溃、等待超时或取消） | `false`；先核对状态，不要自动重跑 |

连接失效后，下次新命令会拉起新的 daemon。批量逐条检查状态，不要重放整批。

## 输出及限制

- 捕获 PowerShell 成功流及错误流。普通对象用 `Out-String -Stream -Width 300` 格式化；也捕获经 PowerShell 管道转发的原生程序标准流。不保留独立的进度、警告、详细、调试及信息流（包括默认的 `Write-Host`）；直接 Console 写入或绕过管道的输出不属于支持范围。
- stdout 和 stderr 合计最多 **8 MiB UTF-8**，单次批量所有条目也合计最多 8 MiB。顺序模式沿用前一条剩余预算；并发模式按条目分配份额，空余份额不转移。截断由 `outputTruncated`、`stdoutTruncated`、`stderrTruncated` 标注。预算限制的是捕获文本，不是 JSON 开销、命令自行分配的内存、上游缓冲或文件输出。
- 每条命令使用新 Runspace，普通变量和函数不跨命令保留；**不是进程隔离**。`$env:` 和进程 cwd 等进程级状态仍共享，不要在此修改。环境写入、修改进程 cwd、长构建／测试、交互式命令及要求精确退出码的命令，请直接用 **Bash**。会中止 Runspace 管道的 `exit` 按 1 上报并附 `explicitExit`，不承诺与新建 `pwsh` 进程完全等价。无 TTY，Windows 原生程序的标准输入为 EOF。

## 实现与测试

插件通过 stdio 与自身的 `server.ps1` 通信，默认 4 个 worker 和 64 项待处理队列。队列已满时不会阻塞协议主线程，立即返回同一请求 id 的 `not_started`/`queue_full` 响应；其他响应不会因拒绝入队而丢失或重排。Node 仅在 Windows 子进程环境中补必需的 `PATHEXT` 项，缺 `ComSpec` 时从现有本机 `SystemRoot\System32` 补齐；不修改宿主环境。工具描述和 schema 以 `manifest.json` 为准，仅声明原有的 `agent.tool.register` 与 `agent.prompt.inject` 权限。

在 `pwshd` 目录，用可用的 PI scratch 配置测试临时目录，再分别运行独立 Node 进程：

```powershell
$env:TMP = $env:TEMP = $env:TMPDIR = $env:PI_SCRATCH_DIR
node --check main.js
node tests/daemon.test.cjs
node tests/plugin.test.cjs
```

崩溃测试只终止测试进程启动的 daemon，不触碰 PI-Desktop 宿主的 daemon。
