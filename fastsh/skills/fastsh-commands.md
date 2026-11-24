---
name: fastsh-commands
description: 轻量 POSIX 文件检查和管道走 fastsh_run；已知的独立短命令用 commands 批量；PowerShell 或长任务走对应通道，响应未知时不重跑。
---

# 轻量 POSIX 命令走 fastsh

先用 `ToolSearch("fastsh_run")` 激活工具。本会话后续直接使用。

- 适合 `ls`、`cat`、`grep`、`find`、`wc`、`head`、`tail`、`stat`、`pwd` 和简单管道，用正斜杠路径。内置工具只支持部分 POSIX 选项，较复杂的源码查询优先使用专用 `Read` / `Grep` / `Glob` 工具。
- 默认工作目录为工作区根；相对 `cwd` 基于工作区解析，找不到工作区时显式给绝对路径。不要让命令在插件进程目录盲跑。
- PowerShell 命令（如 `$env:FOO`、cmdlet、`.ps1`）用 `pwsh_run` 或内置 Bash；长构建、交互和须精确控制进程的任务用合适的宿主工具。

## 顺序批量

```json
{"commands":["ls -la","wc -l src/main.go","head -n 5 package.json"],"batchTimeoutMs":10000}
```

最多 20 条，共用 8 MiB UTF-8 输出预算；`stdoutTruncated`、`stderrTruncated` 表示相应输出已截断。`results[]` 保序，每条命令独立，不共享变量和 `cd`。普通失败不短路；后续命令依赖前项成功时分开调用，或在同一条 POSIX 命令用 `&&`。批量总时限默认 90 秒，过期后不提交后续命令。

## 回退

- `fallback=true` / `executionState=not_started`：快速通道确认未开始。按原因修正参数和 cwd，或选择 PowerShell / Bash；不要无条件照抄整批重跑。
- `executionState=unknown`：请求可能已经生效，只是没有可靠响应，先核对副作用，不自动重放。
- `executionState=finished`：依据 `exitCode` 及输出判断结果；124 表示超时，不是可重试的回退。
