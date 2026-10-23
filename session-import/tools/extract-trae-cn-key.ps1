# One-time SQLCipher key extractor for Trae CN's ai-agent database.
#
# The database is encrypted; the key lives in process memory only while a
# connection is open (sqlcipher wipes it on close). This script watches the
# cipher's NOACCESS secure pages + RW heap of the ai_agent.dll host process
# and verifies every 32-byte candidate against page 1 of the database.
#
# HOW TO USE
# 1. Start Trae CN and keep it running.
# 2. Run this script from any PowerShell 7 window:
#        pwsh -File extract-trae-cn-key.ps1
# 3. Switch to Trae CN and send one chat message (any content).
# 4. The script prints the key and writes docs/trae-cn-key.json into the
#    current directory. Copy that file into any workspace where you want to
#    import Trae CN sessions.
#
# The key is stable across restarts; re-extract only after reinstalling
# Trae CN or switching accounts.

param(
  [string]$OutFile = "docs\trae-cn-key.json"
)

$ErrorActionPreference = "Stop"

$dbPath = Join-Path $env:APPDATA "Trae CN\ModularData\ai-agent\database.db"
if (-not (Test-Path $dbPath)) {
  Write-Error "找不到 Trae CN 数据库：$dbPath"
}

$page1 = New-Object byte[] 4096
$fs = [System.IO.File]::Open($dbPath, 'Open', 'Read', [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
try { [void]$fs.Read($page1, 0, 4096) } finally { $fs.Close() }

$src = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.IO;

public class TraeKeyExtract {
  [StructLayout(LayoutKind.Sequential)]
  public struct MEMORY_BASIC_INFORMATION {
    public UIntPtr BaseAddress;
    public UIntPtr AllocationBase;
    public uint AllocationProtect;
    public uint _alignment1;
    public UIntPtr RegionSize;
    public uint State;
    public uint Protect;
    public uint Type;
    public uint _alignment2;
  }
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool ReadProcessMemory(IntPtr h, UInt64 addr, byte[] buf, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern int VirtualQueryEx(IntPtr h, UInt64 addr, out MEMORY_BASIC_INFORMATION info, int len);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool VirtualProtectEx(IntPtr h, UInt64 lpAddress, UIntPtr dwSize, uint flNewProtect, out uint lpflOldProtect);

  static string Hex(byte[] b, int off, int len) {
    var sb = new StringBuilder();
    for (int i = 0; i < len; i++) sb.Append(b[off + i].ToString("x2"));
    return sb.ToString();
  }

  public static bool TestKeyV4(byte[] key, byte[] page1) {
    try {
      byte[] iv = new byte[16];
      Array.Copy(page1, 4096 - 80, iv, 0, 16);
      using (var aes = Aes.Create()) {
        aes.KeySize = 256;
        aes.Key = key;
        aes.Mode = CipherMode.CBC;
        aes.Padding = PaddingMode.None;
        using (var dec = aes.CreateDecryptor()) {
          byte[] outBuf = dec.TransformFinalBlock(page1, 16, 16);
          return outBuf.Length >= 14 && Encoding.ASCII.GetString(outBuf, 0, 14) == "SQLite format ";
        }
      }
    } catch { return false; }
  }

  // scan NOACCESS private pages + RW heap for 32-byte raw-key candidates
  public static List<string> Scan(int pid, byte[] page1) {
    var results = new List<string>();
    const uint PROCESS_VM_READ = 0x0010;
    const uint PROCESS_QUERY_INFORMATION = 0x0400;
    const uint PROCESS_VM_OPERATION = 0x0008;
    IntPtr h = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION | PROCESS_VM_OPERATION, false, pid);
    if (h == IntPtr.Zero) { results.Add("ERR OpenProcess"); return results; }
    var seen = new HashSet<string>();
    try {
      ulong addr = 0;
      var mbi = new MEMORY_BASIC_INFORMATION();
      int mbiSize = Marshal.SizeOf(typeof(MEMORY_BASIC_INFORMATION));
      const uint MEM_COMMIT = 0x1000;
      while (VirtualQueryEx(h, addr, out mbi, mbiSize) != 0) {
        ulong regionSize = (ulong)mbi.RegionSize;
        ulong regionBase = (ulong)mbi.BaseAddress;
        uint p = mbi.Protect & 0xFF;
        bool isNoAccess = mbi.State == MEM_COMMIT && mbi.Type == 0x20000 && p == 0x01;
        bool isRwHeap = mbi.State == MEM_COMMIT && mbi.Type == 0x20000 && (p == 0x04 || p == 0x40);
        if ((isNoAccess || isRwHeap) && regionSize > 0 && regionSize <= 256UL * 1024 * 1024) {
          bool flipped = false;
          uint oldProtect = 0;
          try {
            if (isNoAccess) {
              if (!VirtualProtectEx(h, regionBase, (UIntPtr)regionSize, 0x04, out oldProtect)) { isNoAccess = false; isRwHeap = false; }
              else flipped = true;
            }
            if (isNoAccess || isRwHeap) {
              for (ulong off = 0; off < regionSize; off += 8UL * 1024 * 1024) {
                int toRead = (int)Math.Min(8UL * 1024 * 1024, regionSize - off);
                var buf = new byte[toRead];
                IntPtr read;
                if (ReadProcessMemory(h, regionBase + off, buf, (IntPtr)toRead, out read) && read.ToInt64() > 0) {
                  int got = (int)read.ToInt64();
                  for (int i = 0; i + 32 <= got; i++) {
                    var cand = new byte[32];
                    Array.Copy(buf, i, cand, 0, 32);
                    string hx = Hex(cand, 0, 32);
                    if (!seen.Add(hx)) continue;
                    if (TestKeyV4(cand, page1)) {
                      results.Add(hx);
                      return results;
                    }
                  }
                }
              }
            }
          } finally {
            if (flipped) { uint restore; VirtualProtectEx(h, regionBase, (UIntPtr)regionSize, oldProtect, out restore); }
          }
        }
        ulong next = regionBase + regionSize;
        if (next <= addr) break;
        addr = next;
      }
    } finally { CloseHandle(h); }
    return results;
  }
}
"@

Add-Type -TypeDefinition $src -Language CSharp

function Get-AgentHostPid {
  foreach ($proc in (Get-Process -Name "Trae CN" -ErrorAction SilentlyContinue)) {
    try {
      if ($proc.Modules | Where-Object { $_.ModuleName -eq "ai_agent.dll" }) { return $proc.Id }
    } catch {}
  }
  return 0
}

Write-Output "Trae CN SQLCipher 密钥提取器"
Write-Output "数据库: $dbPath"
Write-Output ""
Write-Output "正在等待 ai-agent 宿主进程…（保持 Trae CN 运行）"

$deadline = [DateTime]::UtcNow.AddSeconds(600)
$pass = 0
while ([DateTime]::UtcNow -lt $deadline) {
  $pass++
  $hostPid = Get-AgentHostPid
  if ($hostPid -eq 0) {
    Start-Sleep -Seconds 2
    continue
  }
  $t0 = Get-Date
  $hits = [TraeKeyExtract]::Scan([int]$hostPid, $page1)
  $dt = [int]((Get-Date) - $t0).TotalMilliseconds
  if ($hits.Count -gt 0 -and $hits[0] -match '^[0-9a-f]{64}$') {
    $keyHex = $hits[0]
    Write-Output ""
    Write-Output "=== 密钥已找到（pid $hostPid，第 $pass 轮，$dt ms）==="
    Write-Output "keyHex: $keyHex"
    $outDir = Split-Path (Join-Path (Get-Location) $OutFile) -Parent
    if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
    Set-Content -Path (Join-Path (Get-Location) $OutFile) -Value (@{ keyHex = $keyHex } | ConvertTo-Json) -Encoding UTF8
    Write-Output "已写入: $(Join-Path (Get-Location) $OutFile)"
    Write-Output "把这个文件放进工作区的 docs/ 目录即可导入 Trae CN 会话。"
    exit 0
  }
  Write-Output ("pass {0} pid {1} ({2}ms): 未捕获（请在 Trae CN 里发一条聊天消息）" -f $pass, $hostPid, $dt)
  Start-Sleep -Milliseconds 300
}
Write-Error "10 分钟内未捕获到密钥。请确认已在 Trae CN 的聊天里发过消息，然后重试。"
