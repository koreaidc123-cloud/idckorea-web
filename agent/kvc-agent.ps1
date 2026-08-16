<#
═══════════════════════════════════════════════════════════════
  한국 가상컴 — 랙PC 에이전트
  랙에 꽂힌 컴퓨터 한 대에 설치합니다.

  하는 일
    1분마다 자기 상태(살아있음·사양·애니데스크 번호·사용중 여부)를
    서버실 중계기의 공유폴더에 파일 한 개로 적어 놓습니다.

  왜 파일인가
    프로그램을 상주시키면 죽었는지 살았는지 확인이 어렵습니다.
    파일은 눈으로 바로 보이고, 작업 스케줄러가 1분마다 깨워주므로
    중간에 꺼져도 다음 1분에 저절로 되살아납니다.

  설치 (세팅하시는 분이 딱 한 번)
    관리자 권한 PowerShell 에서
      powershell -ExecutionPolicy Bypass -File kvc-agent.ps1 -Setup

  ※ 애니데스크 비밀번호는 이 프로그램이 다루지 않습니다.
     비밀번호는 관리자 화면에서만 등록합니다.
═══════════════════════════════════════════════════════════════
#>
param(
  [switch]$Setup,      # 처음 한 번: 품번 입력 + 자동 실행 등록
  [switch]$Once        # 지금 한 번만 보내보기 (테스트용)
)

$ErrorActionPreference = 'Stop'
$CfgDir  = 'C:\KVC'
$CfgFile = Join-Path $CfgDir 'pc.json'

# ── 마지막으로 사람이 마우스·키보드를 만진 지 몇 초 됐는지 ──────────
#    원격으로 접속해서 쓰고 있으면 이 값이 계속 0 에 가깝습니다.
#    이걸로 "지금 사용중인가"를 판단합니다.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class KvcIdle {
  [StructLayout(LayoutKind.Sequential)]
  struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
  public static uint Seconds() {
    LASTINPUTINFO i = new LASTINPUTINFO();
    i.cbSize = (uint)Marshal.SizeOf(i);
    if (!GetLastInputInfo(ref i)) return 0;
    return ((uint)Environment.TickCount - i.dwTime) / 1000;
  }
}
'@ -ErrorAction SilentlyContinue

# ── 애니데스크 번호 읽기 ──────────────────────────────────────────
function Get-AnydeskId {
  # 설치형은 ProgramData, 무설치형은 AppData 에 설정 파일이 있습니다
  $paths = @(
    "$env:ProgramData\AnyDesk\service.conf",
    "$env:APPDATA\AnyDesk\service.conf",
    "$env:APPDATA\AnyDesk\system.conf"
  )
  foreach ($p in $paths) {
    if (Test-Path $p) {
      $line = Select-String -Path $p -Pattern '^ad\.anynet\.id=' -ErrorAction SilentlyContinue |
              Select-Object -First 1
      if ($line) { return ($line.Line -split '=', 2)[1].Trim() }
    }
  }
  # 설정 파일에 없으면 실행 파일에 직접 물어봅니다
  $exe = @("$env:ProgramFiles(x86)\AnyDesk\AnyDesk.exe", "$env:ProgramFiles\AnyDesk\AnyDesk.exe") |
         Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($exe) {
    try { $id = (& $exe --get-id 2>$null | Out-String).Trim(); if ($id -match '^\d{6,12}$') { return $id } } catch {}
  }
  return $null
}

# ── 이 컴퓨터의 사양 읽기 ─────────────────────────────────────────
function Get-Spec {
  $cpu  = Get-CimInstance Win32_Processor | Select-Object -First 1
  $ramB = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
  $gpu  = Get-CimInstance Win32_VideoController |
          Where-Object { $_.Name -notmatch 'Basic|Remote|Meta|Virtual' } |
          Select-Object -First 1
  # C 드라이브 크기를 SSD 용량으로 봅니다 (실제 판매 기준과 같습니다)
  $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
  $ip   = (Get-NetIPAddress -AddressFamily IPv4 |
           Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } |
           Select-Object -First 1).IPAddress
  $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime

  [pscustomobject]@{
    cpu    = $cpu.Name.Trim()
    core   = "$($cpu.NumberOfCores)코어"
    ramGb  = [int][Math]::Round($ramB / 1GB)
    ssdGb  = [int][Math]::Round($disk.Size / 1GB)
    gpu    = if ($gpu) { $gpu.Name.Trim() } else { $null }
    ip     = $ip
    upSec  = [int]((Get-Date) - $boot).TotalSeconds
    hwId   = (Get-CimInstance Win32_BaseBoard).SerialNumber
  }
}

# ── 설치 ──────────────────────────────────────────────────────────
if ($Setup) {
  Write-Host ''
  Write-Host '  한국 가상컴 - 랙PC 등록' -ForegroundColor Cyan
  Write-Host '  ─────────────────────────────────────────' -ForegroundColor DarkGray

  $pn = ''
  while ($pn -notmatch '^[KYD]-\d{3}$') {
    $pn = (Read-Host '  품번을 입력하세요 (예: Y-042)').ToUpper().Trim()
    if ($pn -notmatch '^[KYD]-\d{3}$') { Write-Host '  형식이 다릅니다. K-001 / Y-042 / D-113' -ForegroundColor Red }
  }

  $relay = ''
  while (-not $relay) {
    $relay = (Read-Host '  중계기 공유폴더 (예: \\192.168.0.10\kvc-beat)').Trim()
    if (-not (Test-Path $relay)) {
      Write-Host '  그 폴더에 접근할 수 없습니다. 주소와 공유 권한을 확인해 주세요.' -ForegroundColor Red
      $relay = ''
    }
  }

  if (-not (Test-Path $CfgDir)) { New-Item -ItemType Directory -Path $CfgDir -Force | Out-Null }
  [pscustomobject]@{ pn = $pn; room = $pn.Substring(0,1); relay = $relay } |
    ConvertTo-Json | Set-Content -Path $CfgFile -Encoding UTF8

  # 부팅할 때 + 그 뒤로 1분마다 실행되도록 작업 스케줄러에 등록
  $me = $MyInvocation.MyCommand.Path
  $act = New-ScheduledTaskAction -Execute 'powershell.exe' `
         -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$me`""
  $trg = New-ScheduledTaskTrigger -AtStartup
  $trg.Delay = 'PT30S'
  $rep = New-ScheduledTaskTrigger -Once -At (Get-Date) `
         -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration ([TimeSpan]::MaxValue)
  $prn = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
  $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
         -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 3)
  Register-ScheduledTask -TaskName 'KVC-Agent' -Action $act -Trigger @($trg, $rep) `
    -Principal $prn -Settings $set -Force | Out-Null

  Write-Host ''
  Write-Host "  등록 완료 - $pn" -ForegroundColor Green
  Write-Host '  1분 뒤부터 관리자 화면에 이 컴퓨터가 나타납니다.' -ForegroundColor DarkGray
  Write-Host ''
  $Once = $true
}

# ── 상태 한 번 보내기 (스케줄러가 1분마다 여기를 부릅니다) ─────────
if (-not (Test-Path $CfgFile)) {
  Write-Host '아직 등록되지 않았습니다. -Setup 으로 먼저 등록해 주세요.' -ForegroundColor Yellow
  exit 1
}
$cfg  = Get-Content $CfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
$spec = Get-Spec
$idle = try { [int][KvcIdle]::Seconds() } catch { 99999 }

$beat = [pscustomobject]@{
  pn      = $cfg.pn
  hwId    = $spec.hwId
  online  = $true
  inUse   = ($idle -lt 300)          # 5분 안에 마우스·키보드를 만졌으면 사용중
  idleSec = $idle
  ip      = $spec.ip
  cpu     = $spec.cpu
  core    = $spec.core
  ramGb   = $spec.ramGb
  ssdGb   = $spec.ssdGb
  gpu     = $spec.gpu
  anydesk = Get-AnydeskId
  upSec   = $spec.upSec
  at      = (Get-Date).ToUniversalTime().ToString('o')
}

try {
  $out = Join-Path $cfg.relay ($cfg.pn + '.json')
  $beat | ConvertTo-Json -Compress | Set-Content -Path $out -Encoding UTF8 -Force
  if ($Once) { Write-Host "보냈습니다 -> $out" -ForegroundColor Green; $beat | Format-List }
} catch {
  # 중계기가 잠깐 꺼져 있어도 조용히 넘어갑니다. 다음 1분에 다시 시도합니다.
  if ($Once) { Write-Host "실패: $($_.Exception.Message)" -ForegroundColor Red }
  exit 1
}
