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

# ── 지금 누가 쓰고 있는지 ─────────────────────────────────────────
#    ★ 예약 작업은 SYSTEM 계정으로 돕니다. SYSTEM 은 화면이 없는 별도 공간에서
#      실행되기 때문에, 마지막 키보드·마우스 입력을 묻는 방식으로는
#      실제 사용자의 조작이 보이지 않습니다 (항상 "사용중 아님"으로 나옵니다).
#      그래서 quser(로그온한 사용자 목록)로 판단합니다. 이건 SYSTEM 에서도 보입니다.
#      (실제로 겪었습니다 — 쓰고 있는데 사용중=아니오 로 올라갔습니다)
function Get-IdleMinutes {
  try {
    $lines = & quser 2>$null
    if (-not $lines) { return $null }        # 아무도 로그온하지 않음
    $best = $null
    foreach ($l in $lines) {
      # 줄 모양 : 사용자  세션이름  ID  상태  유휴시간  로그온시간
      # 화면 글자는 윈도우 언어에 따라 다르므로, 숫자 ID 를 기준으로 잘라냅니다.
      $m = [regex]::Match($l, '\s(\d+)\s+(\S+)\s+(\S+)\s')
      if (-not $m.Success) { continue }      # 머리글 줄
      $idle = $m.Groups[3].Value
      $min =
        if ($idle -match '^(none|\.|없음|-)$') { 0 }
        elseif ($idle -match '^(\d+)\+(\d+):(\d+)$') { [int]$Matches[1]*1440 + [int]$Matches[2]*60 + [int]$Matches[3] }
        elseif ($idle -match '^(\d+):(\d+)$')        { [int]$Matches[1]*60 + [int]$Matches[2] }
        elseif ($idle -match '^\d+$')                { [int]$idle }
        else { continue }
      if ($null -eq $best -or $min -lt $best) { $best = $min }
    }
    return $best
  } catch { return $null }
}

# 예비 수단 — quser 를 못 쓰는 환경에서만 씁니다 (화면이 있는 계정으로 돌 때)
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

# ── 이 컴퓨터를 구별하는 값 만들기 ─────────────────────────────────
#    ★ 메인보드 일련번호 하나만 믿으면 안 됩니다.
#      조립 PC 는 이 값이 'Default string' 이거나 비어 있는 경우가 흔해서,
#      서로 다른 PC 가 전부 같은 값을 갖게 됩니다. 그러면 서버에서
#      한 품번을 계속 덮어써 3대를 등록해도 1대만 남습니다.
#      (2026-08-17 실제로 겪었습니다. B550M 보드에서 'Default string' 확인)
#
#    그래서 여러 곳에서 값을 모아, 쓸 만한 것만 골라 합친 뒤 해시합니다.
#    하나도 쓸 만한 게 없으면 빈 값을 돌려주고, 서버는 그때 항상 새 품번을 줍니다.
function Test-HwValue([string]$v) {
  if ([string]::IsNullOrWhiteSpace($v)) { return $false }
  $s = $v.Trim()
  if ($s.Length -lt 8) { return $false }
  if ($s -eq '00000000-0000-0000-0000-000000000000') { return $false }
  # 제조사가 채우지 않고 내보낸 기본값들
  if ($s -match '(?i)default|to be filled|o\.?e\.?m|^none$|^n/?a$|unknown|system serial|invalid|^0+$|^1234') { return $false }
  return $true
}

function Get-HwId {
  $parts = @()
  try { $v = (Get-CimInstance Win32_ComputerSystemProduct -ErrorAction Stop).UUID
        if (Test-HwValue $v) { $parts += "uuid=$($v.Trim())" } } catch {}
  try { $v = (Get-CimInstance Win32_DiskDrive -ErrorAction Stop |
              Where-Object { $_.MediaType -like '*Fixed*' -and $_.SerialNumber } |
              Sort-Object DeviceID | Select-Object -First 1).SerialNumber
        if (Test-HwValue $v) { $parts += "disk=$($v.Trim())" } } catch {}
  try { $v = (Get-CimInstance Win32_BaseBoard -ErrorAction Stop).SerialNumber
        if (Test-HwValue $v) { $parts += "board=$($v.Trim())" } } catch {}
  try { $v = (Get-CimInstance Win32_BIOS -ErrorAction Stop).SerialNumber
        if (Test-HwValue $v) { $parts += "bios=$($v.Trim())" } } catch {}

  # 위에서 하나도 못 건졌을 때만 쓰는 예비 수단.
  # CPU ID 와 랜카드 주소는 같은 모델끼리 겹칠 수 있어 마지막에 둡니다.
  if ($parts.Count -eq 0) {
    try { $v = (Get-CimInstance Win32_Processor -ErrorAction Stop | Select-Object -First 1).ProcessorId
          if (Test-HwValue $v) { $parts += "cpu=$($v.Trim())" } } catch {}
    try { $v = (Get-CimInstance Win32_NetworkAdapter -ErrorAction Stop |
                Where-Object { $_.PhysicalAdapter -and $_.MACAddress } |
                Sort-Object DeviceID | Select-Object -First 1).MACAddress
          if ($v) { $parts += "mac=$($v.Trim())" } } catch {}
  }

  if ($parts.Count -eq 0) { return '' }     # 못 믿을 기계 — 서버가 새 품번을 줍니다

  $joined = ($parts -join '|')
  $sha = [Security.Cryptography.SHA256]::Create()
  $hash = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($joined))
  $sha.Dispose()
  return 'hw1-' + (($hash | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 28)
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
    hwId  = Get-HwId
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

# 누가 쓰고 있나 — quser 를 먼저 보고, 못 쓰면 마지막 입력 시각으로 갈음합니다
$idleMin = Get-IdleMinutes
if ($null -ne $idleMin) {
  $inUse = ($idleMin -lt 5)                 # 5분 안에 조작이 있었으면 사용중
  $idle  = $idleMin * 60
} else {
  $idle  = try { [int][KvcIdle]::Seconds() } catch { 99999 }
  $inUse = ($idle -lt 300)
}

$payload = @{
  p_pn      = $cfg.pn
  p_token   = $cfg.token
  p_online  = $true
  p_in_use  = $inUse
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

  $resp = "$r"

  if ($resp -eq 'OK') {
    if ($Once) { Write-Host "보냈습니다 - $($cfg.pn) (사용중: $(if($inUse){'예'}else{'아니오'}) / 유휴 $([int]($idle/60))분)" -ForegroundColor Green }
  }
  elseif ($resp -like 'CMD:*') {
    # ── 관리자가 걸어둔 명령 ──────────────────────────────────
    #    서버가 명령을 한 번만 주고 바로 지웁니다. 여기서 실패해도
    #    다시 걸리지 않으므로, 반복 재부팅에 빠질 걱정이 없습니다.
    $cmd = $resp.Substring(4).Trim()
    Log "명령 받음 : $cmd"
    if ($Once) { Write-Host "명령 받음 : $cmd" -ForegroundColor Yellow }

    switch ($cmd) {
      'reboot' {
        Log '재부팅합니다 (관리자 요청)'
        # 쓰고 계신 분이 있으면 안내를 띄우고 60초 뒤에 끕니다.
        # 아무도 안 쓰면 20초 뒤 바로 끕니다.
        $wait = if ($inUse) { 60 } else { 20 }
        $msg  = '한국 가상컴 - 관리자 요청으로 이 컴퓨터를 다시 시작합니다. 작업 중인 내용을 저장해 주세요.'
        try { & shutdown.exe /r /t $wait /c $msg /d p:2:4 | Out-Null }
        catch { Log "재부팅 실패 : $($_.Exception.Message)" }
      }
      'cancel' {
        # 잘못 눌렀을 때 되돌리기
        Log '재부팅 취소'
        try { & shutdown.exe /a | Out-Null } catch {}
      }
      default { Log "모르는 명령이라 넘어갑니다 : $cmd" }
    }
  }
  else {
    Log "거절됨 ($resp) - 품번이나 토큰이 맞지 않습니다. -Setup 으로 다시 등록하세요."
    if ($Once) { Write-Host "거절됨 : $resp  →  -Setup 으로 다시 등록해 주세요" -ForegroundColor Red }
    exit 1
  }
} catch {
  # 인터넷이 잠깐 끊겨도 조용히 넘어갑니다. 2분 뒤 다시 시도합니다.
  Log "전송 실패 : $($_.Exception.Message)"
  if ($Once) { Write-Host "전송 실패 : $($_.Exception.Message)" -ForegroundColor Red }
  exit 1
}
