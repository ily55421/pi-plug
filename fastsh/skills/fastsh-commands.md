---
name: fastsh-commands
description: 需要执行轻量只读 POSIX 命令（ls/cat/grep/find/wc/head/tail/stat/pwd）或简单管道时使用，走 fastsh 快速通道而不是 Bash，单次开销从约 400ms 降到数十毫秒。多条独立检查用 commands 数组合并成一次调用省轮次。涉及 PowerShell、cmdlet、.ps1、反斜杠路径、长构建时不要用。
---

# 轻量命令走 fastsh 快速通道

这个项目里有一个比内置 Bash 快一个数量级的执行通道。
工具名：`plugin_local_fastsh_fastsh_run`（由 `local.fastsh` 插件注册，宿主强制加 `plugin_local_fastsh_` 前缀；下文简称 `fastsh_run`）。

它是**按需工具，不在常驻工具列表里**，第一次使用前需要 `ToolSearch("fastsh_run")` 激活；激活后本轮内可直接调用。

## 为什么值得切

同一批次实测（Windows，本机）：

| 工具 | 端到端耗时 |
|---|---|
| 内置 Bash（pwsh 冷启动） | 385–457ms |
| `fastsh_run` | 41–81ms |

Bash 那 400ms 里绝大部分是 PowerShell 进程冷启动，与命令本身无关。轻量命令越多，这笔固定开销累积越明显。

## 什么时候用它

- 只读检查：`ls` `cat` `grep` `find` `wc` `head` `tail` `stat` `pwd` `which` `env`
- 简单管道：`cat x | head -20`、`grep -n foo src/*.go`、`find . -name '*.ts'`
- 文本处理：`sed 's/a/b/g'`、`sort`、`uniq`、`tr`
- 文件操作：`cp` `mv` `rm` `mkdir` `touch`（相对路径安全，见下）
- 需要限制输出的命令：daemon 有 8MB 输出上限，超了会截断并标注，不会卡死

写法与真实 shell 一致，用正斜杠路径。

## 批量（省轮次）

多条独立检查合并成一次调用：传 `commands` 数组（≤20 条），顺序执行，结果在 `results[]` 按序返回。
例如 `{ "commands": ["ls -la", "wc -l src/main.go", "cat package.json | head -5"] }`。
N 条只付 1 次宿主开销 + 1 个轮次，比逐条调用省 (N−1) 次往返。需要看多条信息时优先批量。
批量**不短路**：一条失败其余仍执行（顶层 `ok=false`，逐条看 `results[].ok` / `okCount`）；需要"前一条成功才跑后一条"时逐条发。
文件依赖（前一条建、后一条读）放批量里是安全的——顺序有保证，这正是批量相对并发单调用的优势。

## 什么时候不要用它

- PowerShell 语义：`$env:FOO`、`Get-ChildItem`、`-ErrorAction`、`.ps1`、`C:\...`、`.\setup.ps1`、`@()`、`%{}`
- 长构建 / 长任务：`npm run build`、`go build`、测试套件（`fastsh_run` 默认超时 60s，上限 600s，但长任务用 Bash 更合适）
- `tail -f` 跟随、`grep -P`、`xargs`、`awk`、`cut`（未实现，会走到 PATH 或报错）
- 需要交互输入的命令

## 拿到 fallback 怎么办

返回 `fallback=true` 表示这条命令**没有执行**，daemon 判定它不该走 POSIX 通道。这时：

1. **不要在这个工具里重试**；
2. 立刻用内置 Bash 工具重跑同一条命令。

常见 `fallbackReason`：`pwsh_env_var` `pwsh_cmdlet` `pwsh_param` `pwsh_operator` `pwsh_script` `pwsh_array` `pwsh_block` `win_backslash_path` `win_relative_path` `posix_parse_error` `command_not_found` `cwd_not_found` `daemon_unavailable`。

## 工作目录

默认工作目录是当前工作区根目录，与内置 Bash 一致，所以相对路径命令可以放心用。

沙箱类插件要求文件写入落在工作区内或 PI scratch。`fastsh_run` 的 `cwd` 默认就是工作区根，天然满足；如果你显式传 `cwd`，要传工作区内或 scratch 下的绝对路径。
