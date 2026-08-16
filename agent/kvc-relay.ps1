<#
═══════════════════════════════════════════════════════════════
  한국 가상컴 — 서버실 중계기
  서버실마다 딱 한 대(관리자 상주 PC)에만 설치합니다.

  하는 일
    1분마다 공유폴더에 쌓인 랙PC 상태 파일들을 모아서
    홈페이지 서버로 한 번에 올립니다.

  왜 중계기를 두나
    1,200대가 각자 인터넷으로 쏘면 하루 172만 건입니다. 요금도 부담이고
    랙PC를 전부 바깥으로 열어야 합니다.
    중계기가 모아서 "달라진 것만" 올리면 하루 수천 건으로 줄고,
    랙PC는 내부망 밖으로 나갈 필요가 없어 훨씬 안전합니다.

  설치 (딱 한 번)
    관리자 권한 PowerShell 에서
      powershell -ExecutionPolicy Bypass -File kvc-relay.ps1 -Setup
═══════════════════════════════════════════════════════════════
#>
param(
  [switch]$Setup,
  [switch]$Once        # 지금 한 번만 올려보기 (테스트용)
)

$ErrorActionPreference = 'Stop'
$CfgDir   = 'C:\KVC'
$CfgFile  = Join-Path $CfgDir 'relay.json'
$SnapFile = Join-Path $CfgDir 'relay-snapshot.json'

$STALE_SEC = 180     # 상태 파일이 이 시간보다 오래됐으면 그 PC 는 꺼진 것으로 봅니다
$FULL_MIN  = 10      # 이 주기(분)마다 한 번은 전체를 통째로 올려 서로 어긋난 걸 맞춥니다

# ── 설치 ──────────────────────────────────────────────────────────
if ($Setup) {
  Write-Host ''
  Write-Host '  한국 가상컴 - 서버실 중계기 설치' -ForegroundColor Cyan
  Write-Host '  ─────────────────────────────────────────' -ForegroundColor DarkGray

  $room = ''
  while ($room -notin @('K','Y','D')) {
    $room = (Read-Host '  서버실 기호 (K / Y / D)').ToUpper().Trim()
  }
  $dir = (Read-Host '  랙PC 상태 파일이 쌓이는 폴더 (예: C:\kvc-beat)').Trim()
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

  $api = (Read-Host '  서버 주소 (예: https://idckorea-dusky.vercel.app)').TrimEnd('/')
  $key = Read-Host '  중계기 암호 (Vercel 의 KVC_RELAY_KEY 와 같은 값)'

  if (-not (Test-Path $CfgDir)) { New-Item -ItemType Directory -Path $CfgDir -Force | Out-Null }
  [pscustomobject]@{ room = $room; dir = $dir; api = $api; key = $key } |
    ConvertTo-Json | Set-Content -Path $CfgFile -Encoding UTF8

  # 이 폴더를 랙PC 들이 쓸 수 있게 공유합니다
  $share = 'kvc-beat'
  if (-not (Get-SmbShare -Name $share -ErrorAction SilentlyContinue)) {
    New-SmbShare -Name $share -Path $dir -ChangeAccess 'Everyone' | Out-Null
    Write-Host "  공유폴더 만들었습니다 : \\$env:COMPUTERNAME\$share" -ForegroundColor Green
  }

  $me  = $MyInvocation.MyCommand.Path
  $act = New-ScheduledTaskAction -Execute 'powershell.exe' `
         -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$me`""
  $trg = New-ScheduledTaskTrigger -AtStartup
  $rep = New-ScheduledTaskTrigger -Once -At (Get-Date) `
         -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration ([TimeSpan]::MaxValue)
  $prn = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
  $set = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
  Register-ScheduledTask -TaskName 'KVC-Relay' -Action $act -Trigger @($trg, $rep) `
    -Principal $prn -Settings $set -Force | Out-Null

  Write-Host ''
  Write-Host "  설치 완료 - $room 서버실" -ForegroundColor Green
  Write-Host "  랙PC 에이전트에는 이 주소를 넣어 주세요 : \\$env:COMPUTERNAME\$share" -ForegroundColor DarkGray
  Write-Host ''
  $Once = $true
}

if (-not (Test-Path $CfgFile)) {
  Write-Host '아직 설치되지 않았습니다. -Setup 으로 먼저 설치해 주세요.' -ForegroundColor Yellow
  exit 1
}
$cfg = Get-Content $CfgFile -Raw -Encoding UTF8 | ConvertFrom-Json

# ── 1. 랙PC 상태 파일 모으기 ──────────────────────────────────────
$now = Get-Date
$list = @()
foreach ($f in Get-ChildItem -Path $cfg.dir -Filter '*.json' -ErrorAction SilentlyContinue) {
  try {
    $b = Get-Content $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    # 파일이 오래 안 바뀌었으면 그 컴퓨터가 꺼진 것입니다
    $age = ($now - $f.LastWriteTime).TotalSeconds
    if ($age -gt $STALE_SEC) { $b.online = $false; $b.inUse = $false }
    $list += $b
  } catch { }   # 파일을 쓰는 순간과 겹치면 다음 1분에 다시 읽습니다
}
if (-not $list.Count) { if ($Once) { Write-Host '올릴 것이 없습니다.' -ForegroundColor Yellow }; exit 0 }

# ── 2. 지난번과 달라진 것만 골라내기 ──────────────────────────────
$prev = @{}
if (Test-Path $SnapFile) {
  try { (Get-Content $SnapFile -Raw -Encoding UTF8 | ConvertFrom-Json).PSObject.Properties |
        ForEach-Object { $prev[$_.Name] = $_.Value } } catch { }
}
# 무엇이 "달라진 것"인가 — 켜짐/사용중/사양/애니데스크번호/IP 가 바뀌었을 때
$fingerprint = { param($b) "$($b.online)|$($b.inUse)|$($b.cpu)|$($b.ramGb)|$($b.ssdGb)|$($b.gpu)|$($b.anydesk)|$($b.ip)" }

$lastFull = if ($prev.'__fullAt') { [datetime]$prev.'__fullAt' } else { [datetime]'2000-01-01' }
$full = (($now - $lastFull).TotalMinutes -ge $FULL_MIN)

$send = @()
$snap = @{}
foreach ($b in $list) {
  $fp = & $fingerprint $b
  $snap[$b.pn] = $fp
  if ($full -or $prev[$b.pn] -ne $fp) { $send += $b }
}
if ($full) { $snap['__fullAt'] = $now.ToString('o') } else { $snap['__fullAt'] = $lastFull.ToString('o') }

if (-not $send.Count) {
  if ($Once) { Write-Host "달라진 PC 가 없습니다. (전체 $($list.Count)대 정상)" -ForegroundColor DarkGray }
  exit 0
}

# ── 3. 서버로 올리기 ──────────────────────────────────────────────
$body = @{ room = $cfg.room; full = $full; pcs = $send } | ConvertTo-Json -Depth 5 -Compress
try {
  $r = Invoke-RestMethod -Uri "$($cfg.api)/api/heartbeat" -Method Post `
        -Headers @{ 'x-kvc-key' = $cfg.key } -ContentType 'application/json; charset=utf-8' `
        -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 30

  # 성공했을 때만 스냅샷을 갱신합니다.
  # (실패했는데 갱신해버리면 그 변경분을 영영 못 보냅니다)
  $snap | ConvertTo-Json -Compress | Set-Content -Path $SnapFile -Encoding UTF8 -Force

  $tag = if ($full) { '전체' } else { '변경분' }
  Write-Host ("{0}  {1} {2}대 전송  저장 {3}  미등록 {4}" -f `
    $now.ToString('HH:mm:ss'), $tag, $send.Count, $r.saved, $r.unregistered) -ForegroundColor Green
} catch {
  Write-Host ("{0}  전송 실패 : {1}" -f $now.ToString('HH:mm:ss'), $_.Exception.Message) -ForegroundColor Red
  exit 1
}
