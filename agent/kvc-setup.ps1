<#
═══════════════════════════════════════════════════════════════
  한국 가상컴 — 현장 PC 등록 화면

  현장에서 세팅하시는 분이 쓰는 프로그램입니다.
  PC등록.bat 을 두 번 누르면 이 화면이 뜹니다.

  하는 일은 세 가지입니다.
    1) 어느 서버실인지 큰 버튼으로 고릅니다
    2) 애니데스크 비밀번호를 칩니다
    3) [등록하기] 를 누릅니다

  품번(Y-001, Y-002 …)은 서버가 알아서 순서대로 붙여 줍니다.
  사양과 애니데스크 번호도 프로그램이 알아서 읽어옵니다.

  설정(서버 주소·등록 암호)은 옆에 있는 kvc-config.json 에 들어 있습니다.
  세팅하시는 분은 그 파일을 건드리지 않으셔도 됩니다.
═══════════════════════════════════════════════════════════════
#>
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

# ── 관리자 권한으로 스스로 다시 뜨기 ──────────────────────────────
#    작업 스케줄러에 등록하려면 관리자 권한이 필요합니다.
#    bat 파일에서 권한을 올리면 한글 경로에서 문제가 생겨 여기서 처리합니다.
$me = $PSCommandPath
$isAdmin = ([Security.Principal.WindowsPrincipal] `
            [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  try {
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$me`"")
  } catch {
    [Windows.Forms.MessageBox]::Show(
      "관리자 권한이 필요합니다.`n`n다시 실행하시고 '이 앱이 변경할 수 있도록 허용하시겠어요?' 창에서 [예] 를 눌러 주세요.",
      '한국 가상컴', 'OK', 'Warning') | Out-Null
  }
  exit 0
}

# 다른 컴퓨터에서 가져온 파일에 붙는 '차단' 딱지를 떼어냅니다
try { Get-ChildItem -Path $PSScriptRoot -File | Unblock-File -ErrorAction SilentlyContinue } catch {}

$here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$CfgDir  = 'C:\KVC'
$CfgFile = Join-Path $CfgDir 'pc.json'

# ── 설정 읽기 ─────────────────────────────────────────────────────
$confPath = Join-Path $here 'kvc-config.json'
if (-not (Test-Path $confPath)) {
  [Windows.Forms.MessageBox]::Show(
    "설정 파일(kvc-config.json)이 없습니다.`n`nUSB 안의 파일을 모두 같은 폴더에 두고 다시 실행해 주세요.",
    '한국 가상컴', 'OK', 'Error') | Out-Null
  exit 1
}
$conf = Get-Content $confPath -Raw -Encoding UTF8 | ConvertFrom-Json

# ── 글씨 크기 (보기 편하게 크게) ──────────────────────────────────
$fTitle = New-Object Drawing.Font('맑은 고딕', 26, [Drawing.FontStyle]::Bold)
$fBig   = New-Object Drawing.Font('맑은 고딕', 19, [Drawing.FontStyle]::Bold)
$fMid   = New-Object Drawing.Font('맑은 고딕', 15)
$fSmall = New-Object Drawing.Font('맑은 고딕', 12)
$cRed   = [Drawing.Color]::FromArgb(226, 35, 60)
$cBlue  = [Drawing.Color]::FromArgb(11, 47, 232)
$cGray  = [Drawing.Color]::FromArgb(110, 118, 132)
$cInk   = [Drawing.Color]::FromArgb(20, 24, 32)

# ── 창 ────────────────────────────────────────────────────────────
$f = New-Object Windows.Forms.Form
$f.Text = '한국 가상컴 - PC 등록'
$f.Size = New-Object Drawing.Size(760, 720)
$f.StartPosition = 'CenterScreen'
$f.BackColor = [Drawing.Color]::White
$f.FormBorderStyle = 'FixedSingle'
$f.MaximizeBox = $false
$f.TopMost = $true

function New-Label($text, $font, $color, $x, $y, $w, $h) {
  $l = New-Object Windows.Forms.Label
  $l.Text = $text; $l.Font = $font; $l.ForeColor = $color
  $l.Location = New-Object Drawing.Point($x, $y)
  $l.Size = New-Object Drawing.Size($w, $h)
  $f.Controls.Add($l); return $l
}

New-Label '한국 가상컴' $fTitle $cInk 40 26 400 46 | Out-Null
New-Label 'PC 등록' $fBig $cRed 40 74 300 34 | Out-Null

# ── 1단계 : 서버실 고르기 ─────────────────────────────────────────
New-Label '1. 어느 서버실인가요?' $fBig $cInk 40 140 500 34 | Out-Null

$script:room = $null
$roomBtns = @()
$rooms = @(
  @{ k = 'K'; name = '금촌' },
  @{ k = 'Y'; name = '영태리' },
  @{ k = 'D'; name = '등원리' }
)
$x = 40
foreach ($r in $rooms) {
  $b = New-Object Windows.Forms.Button
  $b.Text = $r.name
  $b.Font = $fBig
  $b.Size = New-Object Drawing.Size(210, 84)
  $b.Location = New-Object Drawing.Point($x, 186)
  $b.FlatStyle = 'Flat'
  $b.FlatAppearance.BorderSize = 2
  $b.FlatAppearance.BorderColor = [Drawing.Color]::FromArgb(220, 224, 232)
  $b.BackColor = [Drawing.Color]::White
  $b.ForeColor = $cInk
  $b.Cursor = 'Hand'
  $b.Tag = $r.k
  $f.Controls.Add($b)
  $roomBtns += $b
  $x += 226
}
# ※ 여기에 .GetNewClosure() 를 붙이면 안 됩니다.
#    별도 영역이 만들어져서 $script:room 에 넣은 값이 밖으로 나오지 않습니다.
#    (버튼 색만 바뀌고 선택은 안 된 것처럼 동작합니다 — 실제로 겪은 버그입니다)
foreach ($b in $roomBtns) {
  $b.Add_Click({
    $script:room = $this.Tag
    foreach ($o in $roomBtns) {
      $sel = ($o.Tag -eq $script:room)
      $o.BackColor = if ($sel) { $cBlue } else { [Drawing.Color]::White }
      $o.ForeColor = if ($sel) { [Drawing.Color]::White } else { $cInk }
      $o.FlatAppearance.BorderColor = if ($sel) { $cBlue } else { [Drawing.Color]::FromArgb(220,224,232) }
    }
  })
}

# ── 2단계 : 애니데스크 비밀번호 ───────────────────────────────────
New-Label '2. 애니데스크 비밀번호를 적어 주세요' $fBig $cInk 40 302 620 34 | Out-Null
New-Label '조금 전 이 컴퓨터 애니데스크에 설정하신 그 비밀번호입니다.' $fSmall $cGray 40 342 620 26 | Out-Null

$pwBox = New-Object Windows.Forms.TextBox
$pwBox.Font = New-Object Drawing.Font('맑은 고딕', 22)
$pwBox.Location = New-Object Drawing.Point(40, 376)
$pwBox.Size = New-Object Drawing.Size(662, 52)
$pwBox.BorderStyle = 'FixedSingle'
$f.Controls.Add($pwBox)

# ── 등록 버튼 ─────────────────────────────────────────────────────
$go = New-Object Windows.Forms.Button
$go.Text = '등록하기'
$go.Font = New-Object Drawing.Font('맑은 고딕', 22, [Drawing.FontStyle]::Bold)
$go.Size = New-Object Drawing.Size(662, 84)
$go.Location = New-Object Drawing.Point(40, 456)
$go.FlatStyle = 'Flat'
$go.FlatAppearance.BorderSize = 0
$go.BackColor = $cRed
$go.ForeColor = [Drawing.Color]::White
$go.Cursor = 'Hand'
$f.Controls.Add($go)

$msg = New-Label '' $fMid $cGray 40 552 662 100
$msg.TextAlign = 'TopLeft'

# ── 이 컴퓨터 정보 읽기 ───────────────────────────────────────────
function Get-Spec {
  $cpu  = Get-CimInstance Win32_Processor | Select-Object -First 1
  $ramB = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
  $gpu  = Get-CimInstance Win32_VideoController |
          Where-Object { $_.Name -notmatch 'Basic|Remote|Meta|Virtual|DameWare' } | Select-Object -First 1
  $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
  $ip   = (Get-NetIPAddress -AddressFamily IPv4 |
           Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } | Select-Object -First 1).IPAddress
  [pscustomobject]@{
    cpu = $cpu.Name.Trim(); core = "$($cpu.NumberOfCores)코어"
    ramGb = [int][Math]::Round($ramB/1GB); ssdGb = [int][Math]::Round($disk.Size/1GB)
    gpu = if ($gpu) { $gpu.Name.Trim() } else { $null }
    ip = $ip; hwId = (Get-CimInstance Win32_BaseBoard).SerialNumber
  }
}
function Get-AnydeskId {
  foreach ($p in @("$env:ProgramData\AnyDesk\service.conf","$env:APPDATA\AnyDesk\service.conf","$env:APPDATA\AnyDesk\system.conf")) {
    if (Test-Path $p) {
      $line = Select-String -Path $p -Pattern '^ad\.anynet\.id=' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($line) { return ($line.Line -split '=',2)[1].Trim() }
    }
  }
  $exe = @("${env:ProgramFiles(x86)}\AnyDesk\AnyDesk.exe","$env:ProgramFiles\AnyDesk\AnyDesk.exe") |
         Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($exe) { try { $id = (& $exe --get-id 2>$null | Out-String).Trim(); if ($id -match '^\d{6,12}$') { return $id } } catch {} }
  return $null
}

# ── 등록 실행 ─────────────────────────────────────────────────────
$go.Add_Click({
  if (-not $script:room) {
    $msg.ForeColor = $cRed
    $msg.Text = "먼저 서버실을 골라 주세요.`n위에 있는 큰 버튼 세 개 중 하나입니다."
    return
  }
  if (-not $pwBox.Text.Trim()) {
    $msg.ForeColor = $cRed
    $msg.Text = "애니데스크 비밀번호를 적어 주세요."
    $pwBox.Focus(); return
  }

  $go.Enabled = $false
  $go.Text = '등록하는 중...'
  $msg.ForeColor = $cGray
  $msg.Text = '이 컴퓨터 정보를 읽고 있습니다. 잠시만 기다려 주세요.'
  $f.Refresh()

  try {
    $spec = Get-Spec
    $ad   = Get-AnydeskId

    if (-not $ad) {
      $msg.ForeColor = $cRed
      $msg.Text = "애니데스크 번호를 찾지 못했습니다.`n애니데스크를 한 번 켜신 뒤 다시 [등록하기] 를 눌러 주세요."
      $go.Enabled = $true; $go.Text = '등록하기'; return
    }

    $body = @{
      room = $script:room; hwId = $spec.hwId; cpu = $spec.cpu; core = $spec.core
      ramGb = $spec.ramGb; ssdGb = $spec.ssdGb; gpu = $spec.gpu
      ip = $spec.ip; anydesk = $ad; adPw = $pwBox.Text.Trim()
    } | ConvertTo-Json -Compress

    $r = Invoke-RestMethod -Uri "$($conf.server)/api/pc-register" -Method Post `
          -Headers @{ 'x-kvc-key' = $conf.setupKey } `
          -ContentType 'application/json; charset=utf-8' `
          -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 40

    # 비밀번호는 보냈으니 화면과 메모리에서 바로 지웁니다
    $pwBox.Text = ''
    $body = $null

    if (-not (Test-Path $CfgDir)) { New-Item -ItemType Directory -Path $CfgDir -Force | Out-Null }
    [pscustomobject]@{ pn=$r.pn; token=$r.token; url=$r.supabaseUrl; key=$r.publicKey; beatSec=$r.beatSec } |
      ConvertTo-Json | Set-Content -Path $CfgFile -Encoding UTF8
    try { icacls $CfgFile /inheritance:r /grant:r "SYSTEM:(R)" "Administrators:(F)" 2>&1 | Out-Null } catch {}

    # 하트비트 프로그램을 이 컴퓨터에 복사하고 2분마다 돌게 등록합니다
    Copy-Item (Join-Path $here 'kvc-agent.ps1') (Join-Path $CfgDir 'kvc-agent.ps1') -Force
    $act = New-ScheduledTaskAction -Execute 'powershell.exe' `
           -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$CfgDir\kvc-agent.ps1`""
    $t1 = New-ScheduledTaskTrigger -AtStartup; $t1.Delay = 'PT40S'
    $t2 = New-ScheduledTaskTrigger -Once -At (Get-Date) `
          -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration ([TimeSpan]::MaxValue)
    $prn = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
    $set = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 3)
    Register-ScheduledTask -TaskName 'KVC-Agent' -Action $act -Trigger @($t1,$t2) `
      -Principal $prn -Settings $set -Force | Out-Null

    # ── 결과 화면 ──
    foreach ($c in @($go, $pwBox)) { $c.Visible = $false }
    foreach ($b in $roomBtns) { $b.Visible = $false }
    foreach ($c in $f.Controls) { if ($c -is [Windows.Forms.Label]) { $c.Visible = $false } }

    $ok = New-Label '등록 완료' (New-Object Drawing.Font('맑은 고딕',34,[Drawing.FontStyle]::Bold)) `
          ([Drawing.Color]::FromArgb(22,150,88)) 40 150 620 56
    $ok.Visible = $true

    $big = New-Label $r.pn (New-Object Drawing.Font('맑은 고딕',72,[Drawing.FontStyle]::Bold)) $cInk 40 220 620 110
    $big.Visible = $true

    $d = New-Label ("이 컴퓨터의 품번입니다.`n랙에 붙이는 이름표에 이대로 적어 주세요.`n`n애니데스크 번호 : $ad`n$($spec.cpu)`n램 $($spec.ramGb)GB · 저장장치 $($spec.ssdGb)GB") `
         $fMid $cGray 40 340 640 200
    $d.Visible = $true

    $done = New-Object Windows.Forms.Button
    $done.Text = '다음 컴퓨터 하기'
    $done.Font = New-Object Drawing.Font('맑은 고딕',20,[Drawing.FontStyle]::Bold)
    $done.Size = New-Object Drawing.Size(662, 76)
    $done.Location = New-Object Drawing.Point(40, 556)
    $done.FlatStyle = 'Flat'; $done.FlatAppearance.BorderSize = 0
    $done.BackColor = $cRed; $done.ForeColor = [Drawing.Color]::White; $done.Cursor = 'Hand'
    $done.Add_Click({ $f.Close() })
    $f.Controls.Add($done)
    $done.BringToFront()
  }
  catch {
    $emsg = $_.Exception.Message
    try {
      $sr = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
      $emsg = ($sr.ReadToEnd() | ConvertFrom-Json).error
    } catch {}
    $msg.ForeColor = $cRed
    $msg.Text = "등록하지 못했습니다.`n$emsg`n`n인터넷이 연결돼 있는지 확인하시고,`n계속 안 되면 이 화면을 사진 찍어 보내 주세요."
    $go.Enabled = $true; $go.Text = '등록하기'
  }
})

$pwBox.Add_KeyDown({ if ($_.KeyCode -eq 'Enter') { $go.PerformClick() } })
[void]$f.ShowDialog()
