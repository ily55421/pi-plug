# pwshd：常驻 PowerShell 服务器（Runspace 并发池）
#
# 协议：stdin 每行 = base64(UTF8 JSON { id, command, cwd, timeoutMs })；stdout 每行 = 一行 JSON 结果。
# 设计要点：
#   1. 主线程只负责读 stdin / 入队；N 个 worker runspace 从 BlockingCollection 取请求并行执行，
#      消灭单线程循环的排队（并发工具调用不再互相等待）。
#   2. 每条命令仍新建独立 Runspace —— 状态隔离，等价于"每次新开 pwsh -NoProfile"，与内置 Bash 一致。
#      池化的是 worker（执行线程），不是被复用的 Runspace，所以变量/函数绝不跨命令残留。
#   3. cwd、输出格式化、错误分流全部在命令 Runspace 内部完成，绝不直接写宿主 stdout（否则破坏 JSON 协议）。
#   4. 退出码对齐宿主：用 $? 判定（True→0，False→1），与 `pwsh -Command` 一致。
#      显式 `exit N` 会终止 Runspace 管道且不透传 N，此时以 explicitExit 标记告知调用方。
#   5. 每命令超时在 worker 内用 BeginInvoke + WaitOne 收口（exitCode=124），只停该命令的 Runspace，
#      daemon 与其余 worker 不受影响；插件侧杀进程仅作最后兜底。
#   6. 响应经 [Console]::Out（SyncTextWriter）单行写出，多 worker 并发写也不会拆行。
param([int]$Workers = 4)

$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# 协议读取用私有 StreamReader，持有原始 stdin 管道句柄（在换句柄之前打开）。
$stdinReader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)

# 把进程级 stdin 句柄换成 NUL。worker 里的原生命令（git 等）继承的是进程 stdin 句柄，
# 而非 Console.In：若仍指向协议管道，它们会等一个永不关闭的 stdin 而卡死（主线程又在读同一根管道）。
# 换成 NUL 后原生命令拿到 EOF；协议读取走上面的私有句柄，不受 SetStdHandle 影响。
# 本 daemon 不提供交互 stdin，这与"无 TTY"的既有语义一致。
try {
    if (-not ('Win32.StdHandle' -as [type])) {
        Add-Type -Namespace Win32 -Name StdHandle -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern bool SetStdHandle(int nStdHandle, IntPtr hHandle);
'@
    }
    $nulStream = [System.IO.File]::OpenRead('NUL')
    [Win32.StdHandle]::SetStdHandle(-10, $nulStream.SafeFileHandle.DangerousGetHandle()) | Out-Null
} catch { }

if ($Workers -lt 1) { $Workers = 1 }
if ($Workers -gt 16) { $Workers = 16 }

$SEP_O = '##PWSHD_O##'
$SEP_E = '##PWSHD_E##'
$SEP_X = '##PWSHD_X##'
$SEP_L = '##PWSHD_L##'
$SEP_END = '##PWSHD_END##'
$DefaultTimeout = 60000

$queue = New-Object 'System.Collections.Concurrent.BlockingCollection[object]'

# worker 循环：取请求 → 新建 Runspace 执行 → 打包响应单行写出。
# 单引号 here-string 内的变量（$queue / $SEP_* / $DefaultTimeout）由 SessionStateProxy 注入，
# 在 worker runspace 运行时求值；命令脚本里的 `$ 转义保持与原实现一致。
$workerScript = @'
$ErrorActionPreference = "Continue"
while ($true) {
    $req = $queue.Take()
    if ($req.shutdown) { break }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $id = [int]$req.id
    $pack = ''
    $errMsg = ''
    $timedOut = $false
    $ps = $null
    $rs = $null
    $timeoutMs = $DefaultTimeout

    try {
        $code = [string]$req.command
        $cwd = [string]$req.cwd
        if ($req.timeoutMs -and [int]$req.timeoutMs -gt 0) { $timeoutMs = [int]$req.timeoutMs }

        # 切目录放在 Runspace 内部：用 SessionStateProxy 会在宿主 stdout 上泄漏一行路径
        $loc = if ($cwd) {
            "Set-Location -LiteralPath '" + ($cwd -replace "'", "''") + "' -ErrorAction Stop | Out-Null"
        } else { "" }

        # 组装在 Runspace 内执行的脚本：全部结果打包成一个字符串返回，不写 Console
        $sb = New-Object System.Text.StringBuilder
        [void]$sb.AppendLine("`$ProgressPreference = 'SilentlyContinue'")
        [void]$sb.AppendLine("`$PSModuleAutoLoadingPreference = 'All'")
        if ($loc) { [void]$sb.AppendLine($loc) }
        [void]$sb.AppendLine("`$___errs = [System.Collections.Generic.List[object]]::new()")
        [void]$sb.AppendLine("`$___ok = `$true")
        [void]$sb.AppendLine("`$___prog = & {")
        [void]$sb.AppendLine($code)
        # 必须在用户代码之后、任何后续管道之前取 $?，否则失败信号会被 ForEach-Object 吃掉
        [void]$sb.AppendLine("  `$script:___ok = `$?")
        [void]$sb.AppendLine("} 2>&1")
        [void]$sb.AppendLine("`$___le = `$LASTEXITCODE")
        [void]$sb.AppendLine("`$___text = ((`$___prog | ForEach-Object { if (`$_ -is [System.Management.Automation.ErrorRecord]) { `$___errs.Add(`$_) } else { `$_ } }) | Out-String -Width 300)")
        [void]$sb.AppendLine("`$___etext = ((`$___errs | ForEach-Object { [string]`$_ }) -join [Environment]::NewLine)")
        [void]$sb.AppendLine("'" + $SEP_O + "' + `$___text + '" + $SEP_E + "' + `$___etext + '" + $SEP_X + "' + [string]`$___ok + '" + $SEP_L + "' + [string]`$___le + '" + $SEP_END + "'")
        $wrapped = $sb.ToString()

        $ps = [powershell]::Create()
        $rs = [runspacefactory]::CreateRunspace()
        $rs.Open()
        $ps.Runspace = $rs
        [void]$ps.AddScript($wrapped)
        $async = $ps.BeginInvoke()
        if (-not $async.AsyncWaitHandle.WaitOne($timeoutMs)) {
            $timedOut = $true
            try { $ps.Stop() } catch { }
            # 给 Stop 一点时间收口，避免 Dispose 撞上仍在跑的管道
            try { $async.AsyncWaitHandle.WaitOne(2000) | Out-Null } catch { }
        } else {
            $o = $ps.EndInvoke($async)
            $pack = (($o | ForEach-Object { [string]$_ }) -join '')
        }
    } catch {
        $errMsg = [string]$_
    } finally {
        if ($null -ne $ps) { try { $ps.Dispose() } catch { } }
        if ($null -ne $rs) { try { $rs.Dispose() } catch { } }
    }

    $sw.Stop()

    $stdout = ''
    $stderr = ''
    $ok = $false
    $exitCode = 0
    $explicitExit = $false

    $i1 = $pack.IndexOf($SEP_O)
    $i2 = $pack.IndexOf($SEP_E)
    $i3 = $pack.IndexOf($SEP_X)
    $i4 = $pack.IndexOf($SEP_L)
    $i5 = $pack.IndexOf($SEP_END)

    if ($i1 -ge 0 -and $i2 -gt $i1 -and $i3 -gt $i2 -and $i4 -gt $i3 -and $i5 -gt $i4) {
        $stdout = $pack.Substring($i1 + $SEP_O.Length, $i2 - $i1 - $SEP_O.Length)
        $stderr = $pack.Substring($i2 + $SEP_E.Length, $i3 - $i2 - $SEP_E.Length)
        $okStr = $pack.Substring($i3 + $SEP_X.Length, $i4 - $i3 - $SEP_X.Length)
        $ok = ($okStr.Trim() -eq 'True')
        $exitCode = if ($ok) { 0 } else { 1 }
    } elseif ($timedOut) {
        $exitCode = 124
        $stderr = "[pwshd] 命令超时（${timeoutMs}ms），已停止该命令的 Runspace；daemon 与其余 worker 不受影响。"
    } elseif (-not $errMsg) {
        # 没有出现收尾标记：脚本被显式 exit 提前终止，退出码无法透传
        $explicitExit = $true
        $exitCode = 1
        $stderr = "[pwshd] 这条命令调用了 exit，Runspace 管道被提前终止，具体退出码无法透传；需要精确退出码时请改用内置 Bash 工具。"
    }

    if ($errMsg) {
        $stderr = if ($stderr) { $stderr + [Environment]::NewLine + $errMsg } else { $errMsg }
        $exitCode = 1
    }

    $resp = [ordered]@{
        id           = $id
        ok           = ($exitCode -eq 0)
        exitCode     = $exitCode
        stdout       = $stdout.TrimEnd("`r", "`n")
        stderr       = $stderr.TrimEnd("`r", "`n")
        durationMs   = [math]::Round($sw.Elapsed.TotalMilliseconds, 2)
        explicitExit = $explicitExit
    }
    [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
}
'@

# 启动 worker 池
$workerPs = @()
$workerRs = @()
$workerHandles = @()
for ($i = 0; $i -lt $Workers; $i++) {
    $rs = [runspacefactory]::CreateRunspace()
    $rs.Open()
    $rs.SessionStateProxy.SetVariable("queue", $queue)
    $rs.SessionStateProxy.SetVariable("SEP_O", $SEP_O)
    $rs.SessionStateProxy.SetVariable("SEP_E", $SEP_E)
    $rs.SessionStateProxy.SetVariable("SEP_X", $SEP_X)
    $rs.SessionStateProxy.SetVariable("SEP_L", $SEP_L)
    $rs.SessionStateProxy.SetVariable("SEP_END", $SEP_END)
    $rs.SessionStateProxy.SetVariable("DefaultTimeout", $DefaultTimeout)
    $ps = [powershell]::Create()
    $ps.Runspace = $rs
    [void]$ps.AddScript($workerScript)
    $workerPs += $ps
    $workerRs += $rs
    $workerHandles += $ps.BeginInvoke()
}

# 主线程：只读 stdin / 入队，不执行命令
while ($null -ne ($line = $stdinReader.ReadLine())) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }

    $obj = $null
    try {
        $obj = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json
    } catch {
        $resp = [ordered]@{ id = 0; ok = $false; exitCode = 2; stdout = ''; stderr = "pwshd: 请求解析失败: $_"; durationMs = 0; explicitExit = $false }
        [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress))
        [Console]::Out.Flush()
        continue
    }

    if ($obj.shutdown) {
        $resp = [ordered]@{ id = [int]$obj.id; ok = $true; exitCode = 0; stdout = ''; stderr = ''; durationMs = 0; explicitExit = $false; shutdown = $true }
        [Console]::Out.WriteLine(($resp | ConvertTo-Json -Compress))
        [Console]::Out.Flush()
        break
    }

    $queue.Add($obj)
}

# 正常 shutdown 或 stdin EOF 都走到这里：通知 worker 退出并收口
for ($i = 0; $i -lt $Workers; $i++) {
    try { $queue.Add([pscustomobject]@{ shutdown = $true }) } catch { }
}
for ($i = 0; $i -lt $workerHandles.Count; $i++) {
    try { $workerHandles[$i].AsyncWaitHandle.WaitOne(5000) | Out-Null } catch { }
}
for ($i = 0; $i -lt $workerPs.Count; $i++) {
    try { $workerPs[$i].Dispose() } catch { }
    try { $workerRs[$i].Dispose() } catch { }
}
try { $queue.Dispose() } catch { }