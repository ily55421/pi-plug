# pwshd：stdin 每行 base64(UTF-8 JSON)，stdout 每行一个 JSON 响应。
# 每条命令新建 Runspace；变量和函数独立，但进程级状态（例如 $env:）仍然共享。
param([int]$Workers = 4)

$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# 协议保留自己的同步 writer。命令直接调用 Console.WriteLine 不属于支持的输出流。
$protocolOut = [Console]::Out
[Console]::SetOut([System.IO.TextWriter]::Null)

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

# 在追加到 StringBuilder 前共享计量 stdout/stderr 的 UTF-8 字节数。
# 按 Unicode 码点截断，不拆代理对，也不为超限文本分配整个 UTF-8 数组。
Add-Type -ErrorAction Stop -TypeDefinition @"
using System;
using System.Globalization;
using System.Management.Automation.Host;
using System.Text;

namespace Pwshd {
    // 由 PowerShell 引擎通知 exit；不把 break/continue 等其他提前结束误报为 exit。
    public sealed class CommandHost : PSHost {
        public bool Exited { get; private set; }
        public override Guid InstanceId { get; } = Guid.NewGuid();
        public override string Name { get { return "pwshd"; } }
        public override Version Version { get { return new Version(1, 0); } }
        public override PSHostUserInterface UI { get { return null; } }
        public override CultureInfo CurrentCulture { get { return CultureInfo.CurrentCulture; } }
        public override CultureInfo CurrentUICulture { get { return CultureInfo.CurrentUICulture; } }
        public override void SetShouldExit(int code) { Exited = true; }
        public override void EnterNestedPrompt() { throw new NotSupportedException(); }
        public override void ExitNestedPrompt() { throw new NotSupportedException(); }
        public override void NotifyBeginApplication() { }
        public override void NotifyEndApplication() { }
    }

    public sealed class Capture {
        private readonly StringBuilder stdout = new StringBuilder();
        private readonly StringBuilder stderr = new StringBuilder();
        private static readonly char[] trailing = new[] { '\r', '\n' };
        private int remaining;
        private bool stdoutLine;
        private bool stderrLine;
        public Capture(int limit) { remaining = limit; }
        public bool StdoutTruncated { get; private set; }
        public bool StderrTruncated { get; private set; }
        public bool Started { get; set; }
        public bool Completed { get; set; }
        public bool Success { get; set; } = true;
        public string SkipReason { get; set; }
        public bool CanWriteStdout { get { return remaining > 0 && !StdoutTruncated; } }
        public void MarkStdoutTruncated() { StdoutTruncated = true; }
        public string Stdout { get { return stdout.ToString().TrimEnd(trailing); } }
        public string Stderr { get { return stderr.ToString().TrimEnd(trailing); } }

        private bool Append(StringBuilder dest, string text) {
            int i = 0;
            while (i < text.Length && remaining > 0) {
                char c = text[i];
                bool pair = char.IsHighSurrogate(c) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]);
                int bytes = pair ? 4 : c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
                if (bytes > remaining) break;
                remaining -= bytes;
                i += pair ? 2 : 1;
            }
            if (i > 0) dest.Append(text, 0, i);
            return i < text.Length;
        }

        public void Write(string text, bool error) {
            // 延迟插入行分隔符；末尾换行不返回，也不占用另一条流的预算。
            if (error && !StderrTruncated) {
                StderrTruncated = (stderrLine && Append(stderr, Environment.NewLine)) || Append(stderr, text);
                stderrLine = true;
            } else if (!error && !StdoutTruncated) {
                StdoutTruncated = (stdoutLine && Append(stdout, Environment.NewLine)) || Append(stdout, text);
                stdoutLine = true;
            }
        }
    }
}
"@

$queue = [System.Collections.Concurrent.BlockingCollection[object]]::new()

# 每条命令边运行边写入有界收集器，不把原始 PSObject 或格式化结果汇成一个无界数组。
$workerScript = @'
$ErrorActionPreference = "Continue"
while ($true) {
    $req = $queue.Take()
    if ($req.shutdown) { break }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $id = [long]$req.id
    $limit = if ($null -eq $req.outputLimitBytes) { 8MB } else { [Math]::Clamp([int]$req.outputLimitBytes, 0, 8MB) }
    $capture = [Pwshd.Capture]::new($limit)
    $status = 'not_started'
    $reason = $null
    $exitCode = $null
    $explicitExit = $false
    $timedOut = $false
    $errMsg = $null
    $ps = $null
    $rs = $null
    $timeoutMs = if ($req.timeoutMs -gt 0) { [int]$req.timeoutMs } else { 60000 }

    try {
        $cwd = [string]$req.cwd
        if (-not [IO.Path]::IsPathFullyQualified($cwd)) {
            throw '必须提供绝对文件系统工作目录'
        }
        $commandHost = [Pwshd.CommandHost]::new()
        $rs = [runspacefactory]::CreateRunspace($commandHost)
        $rs.Open()
        $rs.SessionStateProxy.SetVariable('__pwshdCapture', $capture)
        $rs.SessionStateProxy.SetVariable('__pwshdCwd', $cwd)
        $rs.SessionStateProxy.SetVariable('__pwshdDeadline', [long]$req.deadlineMs)
        $rs.SessionStateProxy.SetVariable('__pwshdBatchDeadline', [long]$req.batchDeadlineMs)
        $ps = [powershell]::Create()
        $ps.Runspace = $rs
        # 在命令作用域尾部立即读取 $?；外层再单独记录是否正常返回。
        # 普通 return 不经过内层尾部，但外层仍能收尾；exit 由 CommandHost 单独识别。
        $prefix = @"
`$ProgressPreference = 'SilentlyContinue'
try { Set-Location -LiteralPath `$__pwshdCwd -ErrorAction Stop }
catch { `$__pwshdCapture.SkipReason = 'cwd_invalid'; throw }
`$__pwshdNow = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
if (`$__pwshdDeadline -gt 0 -and `$__pwshdNow -ge `$__pwshdDeadline) {
    `$__pwshdCapture.SkipReason = if (`$__pwshdBatchDeadline -gt 0 -and `$__pwshdNow -ge `$__pwshdBatchDeadline) { 'batch_timeout' } else { 'request_timeout' }
    return
}
`$__pwshdCapture.Started = `$true
& {
"@
        $suffix = @"
    `$__pwshdCapture.Success = `$?
} 2>&1 3>`$null 4>`$null 5>`$null 6>`$null | ForEach-Object {
    if (`$_ -is [System.Management.Automation.ErrorRecord]) {
        if (-not `$__pwshdCapture.StderrTruncated) { `$__pwshdCapture.Write([string]`$_, `$true) }
    } elseif (`$__pwshdCapture.CanWriteStdout) { `$_ }
    else { `$__pwshdCapture.MarkStdoutTruncated() }
} | Out-String -Stream -Width 300 | ForEach-Object {
    `$__pwshdCapture.Write([string]`$_, `$false)
}
`$__pwshdCapture.Completed = `$true
"@
        [void]$ps.AddScript($prefix + "`n" + [string]$req.command + "`n" + $suffix)
        # 批量截止同时覆盖服务端可能的排队时间，不让排队命令在截止后开始。
        if ($req.batchDeadlineMs -gt 0) {
            $timeoutMs = [int][Math]::Min($timeoutMs, [Math]::Max(0, [long]$req.batchDeadlineMs - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()))
        }
        if ($timeoutMs -eq 0) {
            $capture.SkipReason = 'batch_timeout'
        } else {
            $async = $ps.BeginInvoke()
            if (-not $async.AsyncWaitHandle.WaitOne($timeoutMs)) {
                $timedOut = $true
                try { $ps.Stop() } catch { }
            } else {
                try { [void]$ps.EndInvoke($async) }
                catch { $errMsg = [string]$_.Exception.InnerException; if (-not $errMsg) { $errMsg = [string]$_ } }
            }
        }
    } catch {
        $errMsg = [string]$_
    } finally {
        if ($null -ne $ps) { try { $ps.Dispose() } catch { } }
        if ($null -ne $rs) { try { $rs.Dispose() } catch { } }
    }

    if ($capture.Started) {
        $status = 'finished'
        if ($timedOut) {
            $reason = 'command_timeout'
            $exitCode = 124
            $capture.Write("[pwshd] 命令达到执行时限（${timeoutMs}ms），已停止 Runspace。", $true)
        } elseif ($errMsg) {
            $exitCode = 1
        } elseif ($commandHost.Exited) {
            $exitCode = 1
            $explicitExit = $true
            $capture.Write('[pwshd] 命令执行了 exit；此工具不返回精确退出码。', $true)
        } elseif (-not $capture.Completed) {
            $reason = 'pipeline_ended_early'
            $exitCode = 1
        } else {
            $exitCode = if ($capture.Success) { 0 } else { 1 }
        }
    } elseif ($capture.SkipReason) {
        $reason = $capture.SkipReason
    } elseif ($timedOut) {
        $reason = if ($req.batchDeadlineMs -gt 0 -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge [long]$req.batchDeadlineMs) { 'batch_timeout' } else { 'request_timeout' }
        $exitCode = 124
    } else {
        $reason = 'command_setup_failed'
    }
    if ($errMsg) { $capture.Write($errMsg, $true) }

    $resp = [ordered]@{
        id = $id
        status = $status
        reason = $reason
        ok = ($exitCode -eq 0)
        exitCode = $exitCode
        stdout = $capture.Stdout
        stderr = $capture.Stderr
        stdoutTruncated = $capture.StdoutTruncated
        stderrTruncated = $capture.StderrTruncated
        durationMs = [math]::Round($sw.Elapsed.TotalMilliseconds, 2)
        explicitExit = $explicitExit
    }
    $protocolOut.WriteLine(($resp | ConvertTo-Json -Compress))
    $protocolOut.Flush()
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
    $rs.SessionStateProxy.SetVariable('protocolOut', $protocolOut)
    $ps = [powershell]::Create()
    $ps.Runspace = $rs
    [void]$ps.AddScript($workerScript)
    $workerPs += $ps
    $workerRs += $rs
    $workerHandles += $ps.BeginInvoke()
}

$protocolOut.WriteLine('{"ready":true}')
$protocolOut.Flush()

# 主线程：只读 stdin / 入队，不执行命令
while ($null -ne ($line = $stdinReader.ReadLine())) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }

    $obj = $null
    try {
        $obj = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json
    } catch {
        $protocolOut.WriteLine('{"id":0,"status":"not_started","reason":"invalid_request"}')
        $protocolOut.Flush()
        continue
    }

    if ($obj.shutdown) {
        $resp = [ordered]@{ id = [long]$obj.id; status = 'finished'; ok = $true; exitCode = 0; stdout = ''; stderr = ''; durationMs = 0; explicitExit = $false; shutdown = $true }
        $protocolOut.WriteLine(($resp | ConvertTo-Json -Compress))
        $protocolOut.Flush()
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