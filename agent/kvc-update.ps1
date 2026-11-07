# ═══════════════════════════════════════════════════════════════
#  한국 가상컴 — 랙PC 프로그램 갱신
#
#  이미 등록이 끝난 PC 의 프로그램만 최신으로 바꿉니다.
#  품번과 열쇠(pc.json)는 건드리지 않습니다. 다시 등록할 필요 없습니다.
#
#  ★ USB 에 있는 파일을 먼저 씁니다. USB 가 없으면 사이트에서 받습니다.
#    (인터넷이 느리거나 막혀 있어도 USB 만 꽂혀 있으면 됩니다)
# ═══════════════════════════════════════════════════════════════
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Url  = 'https://idckorea-dusky.vercel.app/agent/kvc-agent.ps1'
$Dir  = 'C:KVC'
$Self = Join-Path $Dir 'kvc-agent.ps1'
$Mark = 'KVC-AGENT-FILE-OK'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

# 전자서명 확인용 공개키입니다. 서명은 회사 PC의 비밀키로만 만들 수 있습니다.
# 사이트나 USB의 파일이 바뀌어도 서명이 맞지 않으면 설치하지 않습니다.
$KvcSignKey = '<RSAKeyValue><Modulus>tl4okd7+6NImhkzB+jqcvEGGyvh18LjRa+zxuIYu6t1mwf1sF4PbrfENQPGi/mRy1Nt85r4FsOi2ouIGoIKXH/ZkDkFzWLu5Cmy9eXXl9x/qP+B2VSnIJ3jVJ+cYg7hwCWdxf33RAB6fOsJKDgqpGgY3eB4NpCTCGTr+KdHXiMLVb93cyf+7erBv34/bs+ZCYV/IH0CWpjRwW/G5WljGOsRnRMqOtHQVhVMxAR4EyNDiDEkNotO2qHAQ9u0uB/DfUlcpaMuwMsxICOfWpb4ZECW5f5kMM1sNP0T6UnQr53+7jkLd/szMLpknKdcuT0Fb7cPhlafd3GZrOhWcCEYVWq/czNxhKlFiWPA+BbcNhTbnJyte7EeqZ29ymAcMHGoKktznKX7tUN3IHyDwqm5Om4UFDxGEf9gkOp2Bs8R3bqN+4cvlAqaQSYWJOwCWdeC8wnRiolQL3TQ083JoVcirmdOVrY6KdPPo83eEkwX61tFB4o1jX6eKxbL0z4LWc3pp</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>'
function Test-KvcSig([byte[]]$Data, [string]$SigText) {
  try {
    if (-not $Data -or [string]::IsNullOrWhiteSpace($SigText)) { return $false }
    $rsa = New-Object Security.Cryptography.RSACryptoServiceProvider
    $rsa.PersistKeyInCsp = $false
    $rsa.FromXmlString($KvcSignKey)
    $sha = New-Object Security.Cryptography.SHA256CryptoServiceProvider
    return $rsa.VerifyData($Data, $sha, [Convert]::FromBase64String($SigText.Trim()))
  } catch { return $false }
}

Write-Host ''
Write-Host '  한국 가상컴 — 랙PC 프로그램 갱신' -ForegroundColor Cyan
Write-Host '  ─────────────────────────────────────────' -ForegroundColor DarkGray
Write-Host ''

if (-not (Test-Path $Dir)) {
  Write-Host '  이 PC 는 아직 등록되지 않았습니다.' -ForegroundColor Yellow
  Write-Host '  PC등록.bat 을 먼저 실행해 주세요.' -ForegroundColor Yellow
  Write-Host ''; Read-Host '  엔터를 누르면 닫힙니다'; exit 1
}

# ── 지금 버전 ──
$before = '옛날 버전 (재부팅 못 받음)'
if (Test-Path $Self) {
  $cur = Get-Content $Self -Raw -Encoding UTF8
  if ($cur -like '*CMD:*') { $before = '최신 계열' }
}
Write-Host "  지금 상태 : $before"

# ── 새 파일 구하기 : USB 먼저, 없으면 사이트 ──
$new = $null
$from = $null
$usb = Join-Path $Here 'kvc-agent.ps1'
$newBytes = $null
if ((Test-Path $usb) -and (Test-Path "$usb.sig")) {
  try {
    $b = [IO.File]::ReadAllBytes($usb)
    if (Test-KvcSig $b (Get-Content "$usb.sig" -Raw)) {
      $newBytes = $b; $new = [Text.Encoding]::UTF8.GetString($b).TrimStart([char]0xFEFF); $from = 'USB'
    } else { Write-Host '  USB 파일의 전자서명이 맞지 않아 쓰지 않습니다.' -ForegroundColor Yellow }
  } catch {}
}
if (-not $new) {
  try {
    Write-Host '  사이트에서 받는 중...'
    $tmp = Join-Path $Dir 'kvc-agent.new'
    Invoke-WebRequest -Uri $Url -OutFile $tmp -TimeoutSec 40 -UseBasicParsing
    $sig = (Invoke-WebRequest -Uri "$Url.sig" -TimeoutSec 40 -UseBasicParsing).Content
    if ($sig -is [byte[]]) { $sig = [Text.Encoding]::ASCII.GetString($sig) }
    $b = [IO.File]::ReadAllBytes($tmp)
    if (-not (Test-KvcSig $b $sig)) { throw '전자서명이 맞지 않습니다' }
    $newBytes = $b; $new = [Text.Encoding]::UTF8.GetString($b).TrimStart([char]0xFEFF)
    $from = '사이트'
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  } catch {
    Write-Host "  [X] 받지 못했습니다 : $($_.Exception.Message)" -ForegroundColor Red
    Write-Host '      USB 를 꽂으시거나 인터넷을 확인해 주세요.' -ForegroundColor Red
    Write-Host ''; Read-Host '  엔터를 누르면 닫힙니다'; exit 1
  }
}
Write-Host "  가져온 곳 : $from"

# ── 검사 — 하나라도 어긋나면 바꾸지 않습니다 ──
$bad = $null
if ([string]::IsNullOrWhiteSpace($new) -or $new.Length -lt 5000) { $bad = '파일이 너무 짧습니다' }
elseif ($new -notlike "*$Mark*")                                { $bad = '우리 프로그램이 아닙니다' }
else { try { $null = [ScriptBlock]::Create($new) } catch { $bad = '파일이 깨졌습니다' } }

if ($bad) {
  Write-Host "  [X] $bad — 바꾸지 않았습니다." -ForegroundColor Red
  Write-Host '      기존 프로그램은 그대로 돌아갑니다.' -ForegroundColor Yellow
  Write-Host ''; Read-Host '  엔터를 누르면 닫힙니다'; exit 1
}

if ((Test-Path $Self) -and ([Convert]::ToBase64String([IO.File]::ReadAllBytes($Self)) -eq [Convert]::ToBase64String($newBytes))) {
  Write-Host '  [OK] 이미 최신입니다. 바꿀 것이 없습니다.' -ForegroundColor Green
} else {
  if (Test-Path $Self) { Copy-Item $Self (Join-Path $Dir 'kvc-agent.bak') -Force }
  [IO.File]::WriteAllBytes($Self, $newBytes)
  Write-Host '  [OK] 최신본으로 바꿨습니다.' -ForegroundColor Green
}

# ── 바로 한 번 보내 확인 ──
Write-Host ''
Write-Host '  지금 한 번 신호를 보내 확인합니다...'
Write-Host '  ─────────────────────────────────────────' -ForegroundColor DarkGray
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Self -Once
Write-Host '  ─────────────────────────────────────────' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  끝났습니다. 이제 이 PC 는 하루 한 번 스스로 최신을 확인합니다.' -ForegroundColor Cyan
Write-Host '  다시 찾아오지 않으셔도 됩니다.' -ForegroundColor Cyan
Write-Host ''
Read-Host '  엔터를 누르면 닫힙니다'
