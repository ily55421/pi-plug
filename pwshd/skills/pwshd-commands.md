---
name: pwshd-commands
description: 执行 PowerShell 命令时优先用 plugin_local_pwshd_pwsh_run 而不是 Bash：常驻 pwsh 省掉每次约 250ms 冷启动，轻量命令从约 440ms 降到约 60ms。首次用先 ToolSearch("pwsh_run")，之后本会话直接调。多条独立检查用 commands 数组合并成一次调用省轮次；并发调用自动并行。长构建/测试套件、需要精确 exit N、交互式命令仍走 Bash。
---

# PowerShell 命令走常驻通道

工具名：`plugin_local_pwshd_pwsh_run`（由 `local.pwshd` 插件注册，宿主强制加 `plugin_local_pwshd_` 前缀；下文简称 `pwsh_run`）。

它是**按需工具**，不在常驻工具列表里。本会话第一次用之前执行一次 `ToolSearch("pwsh_run")`，
激活后本会话内可直接调用，不需要反复搜索。

## 为什么值得切

同一台机器实测：

| 方式 | 单次耗时 |
|---|---|
| 内置 Bash（每次新起 pwsh） | 385–457ms |
| `pwsh_run`（常驻） | 24–70ms |

Bash 那 400ms 里绝大部分是 PowerShell 进程启动，与命令本身无关。
本机历史数据里 Bash 调用占全部工具耗时的 57%，平均每会话 61.8 次，所以这笔固定开销累积很可观。

## 用法

写法与内置 Bash 完全一致，PowerShell 语法，不需要改任何引号/转义习惯：

```
Get-ChildItem -File | Select-Object -First 5 Name, Length
(Get-ChildItem -Recurse -Filter *.ts).Count
Test-Path .\package.json
$env:PATH -split ';' | Select-Object -First 3
git rev-parse --short HEAD
```

默认工作目录 = 工作区根，与 Bash 相同。

## 批量与并发（省轮次）

- **多条独立检查合并成一次调用**：传 `commands` 数组（≤20 条），顺序执行，结果在 `results[]` 按序返回。
  例如 `{ "commands": ["(Get-ChildItem -File).Count", "Test-Path .\\package.json", "$env:OS"] }`。
  这样 N 条只付 1 次宿主开销 + 1 个轮次，比逐条调用省 (N−1) 次往返。需要看多条信息时优先批量。
- **并发调用会自动并行**：daemon 是 4-worker 池，同时发多个 `pwsh_run` 不再排队。
- 批量内部是顺序执行（保持顺序语义）；每条仍独立 Runspace，互不污染。
- **批量不短路**：一条失败其余仍执行（顶层 `ok=false`，逐条看 `results[].ok` / `okCount`）；需要"前一条成功才跑后一条"时逐条发。
  文件依赖（前一条建、后一条读）放批量里安全，且优于并发单调用——并发单调用走 4-worker 池会并行乱序，只有批量保序。

## 语义与 Bash 一致

- 每条命令在**独立 Runspace** 中执行，变量/函数不会跨命令残留，等价于每次新开 pwsh。
- 退出码按 `$?` 判定（成功 0 / 失败 1），与 `pwsh -Command` 一致。
  例如 `cmd /c exit 7` 在两者下都是 1。
- 输出上限 8MB，超出截断并标注，不会卡死。

## 什么时候仍用 Bash

| 场景 | 原因 |
|---|---|
| 需要精确的 `exit N` 退出码 | `pwsh_run` 里 `exit` 会终止 Runspace 管道，只上报 1 并附 note |
| 长构建 / 测试套件（npm、go build/test、cargo、msbuild） | 会占住一个 worker；每命令超时按 124 自收口，但长任务仍建议走 Bash |
| 交互式命令、需要真实终端的工具 | 常驻通道没有 TTY |
| 拿到 `fallback=true` | 表示**没有执行**，别在本工具重试，直接用 Bash 重跑 |

## 排查

如果 `pwsh_run` 返回 `fallback=true` 且 `fallbackReason=daemon_unavailable`，
说明 daemon 起不来或已崩溃；下次调用会自动重启，仍然失败就用内置 Bash。
