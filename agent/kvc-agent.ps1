<#
═══════════════════════════════════════════════════════════════
  한국 가상컴 — 랙PC 에이전트
  랙에 꽂힌 컴퓨터 한 대에 설치합니다. 중계기는 필요 없습니다.

  하는 일
    2분마다 자기 상태(살아있음 · 사양 · 애니데스크 번호 · 사용중 여부)를
    데이터베이스로 직접 보냅니다.

  왜 안전한가
    이 PC 는 자기 전용 열쇠(토큰)로 "자기 한 줄"만 고칠 수 있습니다.
    남의 PC 도, 고객 정보도, 주문도 볼 수 없습니다.
    열쇠가 새어나가도 이 PC 한 대만 영향입니다.

  설치 (세팅하시는 분이 딱 한 번)
    관리자 권한 PowerShell 에서
      powershell -ExecutionPolicy Bypass -File kvc-agent.ps1 -Setup

    묻는 것은 세 가지뿐입니다 — 품번, 현장 등록 암호, 애니데스크 비밀번호.
    사양과 애니데스크 번호는 알아서 읽어옵니다.

  ※ 애니데스크 비밀번호는 이 PC 에 저장하지 않습니다.
     입력받은 즉시 서버로 보내고 메모리에서 지웁니다.
     서버는 자물쇠를 채워서 보관하며, 관리자가 열람할 때마다 기록이 남습니다.
═══════════════════════════════════════════════════════════════
#>
param(
  [switch]$Setup,      # 처음 한 번: 품번 입력 + 자동 실행 등록
  [switch]$Once,       # 지금 한 번만 보내보기 (테스트용)
  [string]$Server = 'https://idckorea-dusky.vercel.app'
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$CfgDir  = 'C:\KVC'
$CfgFile = Join-Path $CfgDir 'pc.json'
$LogFile = Join-Path $CfgDir 'agent.log'

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

function Log([string]$m) {
  try {
    if (-not (Test-Path $CfgDir)) { New-Item -ItemType Directory -Path $CfgDir -Force | Out-Null }
    "$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))  $m" | Add-Content -Path $LogFile -Encoding UTF8
    # 기록이 너무 커지지 않게 최근 500줄만 남깁니다
    $l = @(Get-Content $LogFile -ErrorAction SilentlyContinue)
    if ($l.Count -gt 500) { $l[-500..-1] | Set-Content -Path $LogFile -Encoding UTF8 }
  } catch { }
}

# ── 애니데스크 번호 읽기 ──────────────────────────────────────────
function Get-AnydeskId {
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
  $exe = @("${env:ProgramFiles(x86)}\AnyDesk\AnyDesk.exe", "$env:ProgramFiles\AnyDesk\AnyDesk.exe") |
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
          Where-Object { $_.Name -notmatch 'Basic|Remote|Meta|Virtual|DameWare' } |
          Select-Object -First 1
  $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
  $ip   = (Get-NetIPAddress -AddressFamily IPv4 |
           Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } |
           Select-Object -First 1).IPAddress
  $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime

  [pscustomobject]@{
    cpu   = $cpu.Name.Trim()
    core  = "$($cpu.NumberOfCores)코어"
    ramGb = [int][Math]::Round($ramB / 1GB)
    ssdGb = [int][Math]::Round($disk.Size / 1GB)
    gpu   = if ($gpu) { $gpu.Name.Trim() } else { $null }
    ip    = $ip
    upSec = [int]((Get-Date) - $boot).TotalSeconds
    hwId  = (Get-CimInstance Win32_BaseBoard).SerialNumber
  }
}

# ══════════════════ 설치 ══════════════════════════════════════════
if ($Setup) {
  Write-Host ''
  Write-Host '  한국 가상컴 - 랙PC 등록' -ForegroundColor Cyan
  Write-Host '  ─────────────────────────────────────────' -ForegroundColor DarkGray

  $pn = ''
  while ($pn -notmatch '^[KYD]-\d{3}$') {
    $pn = (Read-Host '  품번을 입력하세요 (예: Y-042)').ToUpper().Trim()
    if ($pn -notmatch '^[KYD]-\d{3}$') {
      Write-Host '  형식이 다릅니다. K-001 / Y-042 / D-113' -ForegroundColor Red
    }
  }

  $key = ''
  while (-not $key) { $key = (Read-Host '  현장 등록 암호').Trim() }

  # 애니데스크에서 설정하신 그 비밀번호를 여기서 같이 등록합니다.
  # 화면에 찍히지 않게 가려서 받고, 서버에서 자물쇠를 채워 보관합니다.
  # 이 PC 안에는 남기지 않습니다.
  Write-Host ''
  Write-Host '  애니데스크에서 설정하신 비밀번호를 입력하세요.' -ForegroundColor DarkGray
  Write-Host '  (지금 건너뛰고 나중에 관리자 화면에서 넣으셔도 됩니다 - 그냥 Enter)' -ForegroundColor DarkGray
  $adPwSec = Read-Host '  애니데스크 비밀번호' -AsSecureString
  $adPw = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [Runtime.InteropServices.Marshal]::SecureStringToBSTR($adPwSec))

  Write-Host ''
  Write-Host '  사양을 읽는 중...' -ForegroundColor DarkGray
  $spec = Get-Spec
  $ad   = Get-AnydeskId
  Write-Host "    CPU      : $($spec.cpu)"
  Write-Host "    메모리   : $($spec.ramGb)GB"
  Write-Host "    저장장치 : $($spec.ssdGb)GB"
  Write-Host "    그래픽   : $($spec.gpu)"
  Write-Host "    애니데스크: $(if($ad){$ad}else{'아직 없음 (애니데스크를 한 번 실행해 주세요)'})"
  Write-Host ''

  $body = @{
    pn = $pn; hwId = $spec.hwId; cpu = $spec.cpu; core = $spec.core
    ramGb = $spec.ramGb; ssdGb = $spec.ssdGb; gpu = $spec.gpu
    ip = $spec.ip; anydesk = $ad; adPw = $adPw
  } | ConvertTo-Json -Compress

  try {
    $r = Invoke-RestMethod -Uri "$Server/api/pc-register" -Method Post `
          -Headers @{ 'x-kvc-key' = $key } `
          -ContentType 'application/json; charset=utf-8' `
          -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 30
  } catch {
    Write-Host '  등록 실패' -ForegroundColor Red
    $msg = $_.Exception.Message
    try {
      $sr = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
      $msg = ($sr.ReadToEnd() | ConvertFrom-Json).error
    } catch {}
    Write-Host "    $msg" -ForegroundColor Red
    Write-Host ''
    Write-Host '  확인해 보세요 :' -ForegroundColor Yellow
    Write-Host '    · 현장 등록 암호가 맞는지'
    Write-Host '    · 이 PC 가 인터넷에 연결돼 있는지'
    exit 1
  }

  # 비밀번호는 서버로 보냈으니 이 PC 메모리에서 즉시 지웁니다
  $adPw = $null; $adPwSec = $null; $body = $null
  [GC]::Collect()

  if (-not (Test-Path $CfgDir)) { New-Item -ItemType Directory -Path $CfgDir -Force | Out-Null }
  [pscustomobject]@{
    pn      = $r.pn
    token   = $r.token
    url     = $r.supabaseUrl
    key     = $r.publicKey
    beatSec = $r.beatSec
  } | ConvertTo-Json | Set-Content -Path $CfgFile -Encoding UTF8

  # 설정 파일은 이 PC 관리자만 읽을 수 있게 막습니다
  try {
    icacls $CfgFile /inheritance:r /grant:r "SYSTEM:(R)" "Administrators:(F)" 2>&1 | Out-Null
  } catch {}

  # 2분마다 실행되도록 등록합니다.
  # ※ New-ScheduledTaskTrigger 의 "무기한 반복"은 쓰지 않습니다 —
  #    일부 윈도우10 버전에서 P99999999DT23H59M59S 라는 값을 만들어 내고
  #    그 버전의 작업 스케줄러가 "범위를 벗어난 값"이라며 거부합니다.
  Copy-Item $MyInvocation.MyCommand.Path (Join-Path $CfgDir 'kvc-agent.ps1') -Force -ErrorAction SilentlyContinue
  $cmd = 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\KVC\kvc-agent.ps1'
  $out = & schtasks.exe /Create /TN 'KVC-Agent' /TR $cmd /SC MINUTE /MO 2 /RU SYSTEM /RL HIGHEST /F 2>&1
  if ($LASTEXITCODE -ne 0) { Write-Host ('작업 등록 실패 : ' + (($out | Out-String).Trim())) -ForegroundColor Red; exit 1 }

  Write-Host "  등록 완료 - $($r.pn)$(if($r.renewed){' (기존 PC 재등록)'})" -ForegroundColor Green
  if ($r.pwSaved) { Write-Host '  애니데스크 비밀번호도 함께 등록되었습니다.' -ForegroundColor Green }
  else            { Write-Host '  비밀번호는 건너뛰었습니다 - 관리자 화면에서 넣어 주세요.' -ForegroundColor Yellow }
  Write-Host '  잠시 뒤 관리자 화면 [미등록 PC] 에 이 컴퓨터가 나타납니다.' -ForegroundColor DarkGray
  Write-Host ''
  Log "등록 완료 $($r.pn)"
  $Once = $true
}

# ══════════════ 상태 보내기 (스케줄러가 2분마다 부릅니다) ═════════
if (-not (Test-Path $CfgFile)) {
  Write-Host '아직 등록되지 않았습니다. -Setup 으로 먼저 등록해 주세요.' -ForegroundColor Yellow
  exit 1
}
$cfg  = Get-Content $CfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
$spec = Get-Spec
$idle = try { [int][KvcIdle]::Seconds() } catch { 99999 }

$payload = @{
  p_pn      = $cfg.pn
  p_token   = $cfg.token
  p_online  = $true
  p_in_use  = ($idle -lt 300)      # 5분 안에 마우스·키보드를 만졌으면 사용중
  p_ip      = $spec.ip
  p_cpu     = $spec.cpu
  p_core    = $spec.core
  p_ram_gb  = $spec.ramGb
  p_ssd_gb  = $spec.ssdGb
  p_gpu     = $spec.gpu
  p_anydesk = Get-AnydeskId
  p_up_sec  = $spec.upSec
} | ConvertTo-Json -Compress

try {
  $r = Invoke-RestMethod -Uri "$($cfg.url)/rest/v1/rpc/beat" -Method Post `
        -Headers @{ apikey = $cfg.key } `
        -ContentType 'application/json; charset=utf-8' `
        -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 25

  if ("$r" -eq 'OK') {
    if ($Once) { Write-Host "보냈습니다 - $($cfg.pn) (사용중: $(if($idle -lt 300){'예'}else{'아니오'}))" -ForegroundColor Green }
  } else {
    Log "거절됨 ($r) - 품번이나 토큰이 맞지 않습니다. -Setup 으로 다시 등록하세요."
    if ($Once) { Write-Host "거절됨 : $r  →  -Setup 으로 다시 등록해 주세요" -ForegroundColor Red }
    exit 1
  }
} catch {
  # 인터넷이 잠깐 끊겨도 조용히 넘어갑니다. 2분 뒤 다시 시도합니다.
  Log "전송 실패 : $($_.Exception.Message)"
  if ($Once) { Write-Host "전송 실패 : $($_.Exception.Message)" -ForegroundColor Red }
  exit 1
}
