---
name: pwshd-commands
description: 短时 PowerShell 查询可使用常驻工具 plugin_local_pwshd_pwsh_run（首次 ToolSearch("pwsh_run")）。环境写入、进程级目录修改、长任务、交互或需要精确退出码时用 Bash。已提交但结果未知时不要自动重跑。
---

# 常驻 PowerShell 工具

- 适用：`Get-ChildItem`、`Get-Content`、`Test-Path`、读取 `$env:`、`git status --short` 等短命令。传 `command`；默认使用真实工作区根目录。`cwd` 可为基于工作区的相对路径，没有可用工作区时请传绝对路径。
- 多条命令传 `commands`（最多 20 条）；默认顺序执行，普通失败不短路。只对互不依赖的命令设 `parallel: true`（最多 4 条并发）。结果按输入顺序返回。若必须等前一条成功，请分次调用。
- `timeoutMs` 限制单条执行时间（默认 60 秒），`batchTimeoutMs` 限制整批用时（默认 90 秒）。取消或到达总截止后不再提交新条目，未开始的条目会标为 `skipped`；已提交的条目仍可能产生副作用。
- 每次调用捕获的 stdout/stderr 合计最多 8 MiB；查看 `outputTruncated`。普通失败按 `$?` 映射为 1，worker 超时收口为 124；显式 `exit N` 不透传精确的 N。

**按条检查 `status` 和 `fallback`**：只有 `fallback: true` 才表示可以改用 Bash 执行；不要重跑 `skipped` 项。`unknown` 表示命令可能已经运行，先核对副作用，不自动重跑。不要因一条失败而重跑整批。

**这不是独立 PowerShell 进程**：Runspace 隔离普通变量和函数，不隔离 `$env:`、进程 cwd 等。环境写入、进程级目录修改、精确 `exit N`、交互式命令和长构建／测试直接用 Bash。
