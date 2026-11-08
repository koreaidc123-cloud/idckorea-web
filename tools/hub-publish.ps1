param(
  # 올릴 브리핑 파일 (마크다운 · UTF-8). 첫 줄이 "# 제목" 이면 그것을 제목으로 씁니다.
  [string]$File = '',
  # 날짜 (YYYY-MM-DD). 비우면 오늘(한국 날짜).
  [string]$Day = '',
  # 제목을 따로 주고 싶을 때만.
  [string]$Title = '',
  [string]$Url = 'https://idckorea-dusky.vercel.app/api/hub?do=brief',
  # 처음 한 번: HUB_TOKEN 을 이 PC 에 암호화해 저장합니다 (화면에 보이지 않게 입력).
  [switch]$SaveToken,
  [string]$TokenFile = 'C:\AI_HQ\state\hub_token.dpapi'
)
# ═══════════════════════════════════════════════════════════════
#  AI 허브 — 오늘의 브리핑 "초안" 올리기 (한국 가상컴 · 2026-11-08)
#
#  ★ 이 스크립트는 게시하지 않습니다. 초안으로만 들어갑니다.
#    고객 화면(/hub)에 보이려면 관리자 화면 [AI 허브 관리] 에서 사람이 [게시] 를 눌러야 합니다.
#  ★ 열쇠(HUB_TOKEN)는 화면·기록에 절대 출력하지 않습니다.
#    찾는 순서: 환경변수 HUB_TOKEN → $TokenFile (이 Windows 사용자만 풀 수 있는 DPAPI 암호화 파일)
#
#  쓰는 법 (Windows PowerShell 5.1)
#    처음 한 번   powershell -ExecutionPolicy Bypass -File tools\hub-publish.ps1 -SaveToken
#    매일         powershell -ExecutionPolicy Bypass -File tools\hub-publish.ps1 -File C:\경로\브리핑.md
# ═══════════════════════════════════════════════════════════════
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if ($SaveToken) {
  $s = Read-Host 'HUB_TOKEN 을 붙여 넣으세요 (화면에 보이지 않습니다)' -AsSecureString
  if ($s.Length -lt 16) { throw '16글자보다 짧습니다. 저장하지 않았습니다.' }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $TokenFile) | Out-Null
  [IO.File]::WriteAllText($TokenFile, (ConvertFrom-SecureString $s))
  '저장했습니다. 열쇠는 화면이나 파일에 그대로 남지 않습니다.'
  return
}

if (-not $File) { throw '-File 로 올릴 브리핑 파일을 알려 주세요.' }
if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { throw "파일이 없습니다: $File" }

# ── 열쇠 꺼내기 (출력하지 않음) ──
$token = $env:HUB_TOKEN
if (-not $token) {
  if (-not (Test-Path -LiteralPath $TokenFile)) { throw '열쇠가 없습니다. 먼저 -SaveToken 으로 저장하거나 환경변수 HUB_TOKEN 을 넣어 주세요.' }
  # 다른 Windows 사용자·다른 PC 에서 만든 파일이면 풀리지 않습니다 — 그때는 -SaveToken 으로 다시 저장
  try { $sec = ConvertTo-SecureString ([IO.File]::ReadAllText($TokenFile).Trim()) }
  catch { throw '저장된 열쇠를 풀 수 없습니다 (다른 사용자나 PC 에서 저장한 파일). -SaveToken 으로 다시 저장해 주세요.' }
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# ── 본문 · 제목 · 날짜 ──
$body = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $File).Path, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
if (-not $body.Trim()) { throw '파일이 비어 있습니다.' }
if (-not $Title) {
  $first = ($body -split '\r?\n' | Where-Object { $_.Trim() } | Select-Object -First 1)
  if ($first -match '^\s*#{1,6}\s+(.+)$') {
    $Title = $Matches[1].Trim()
    # 첫 줄 제목은 본문에서 뺍니다 (화면에 제목이 두 번 나오지 않게)
    $lines = New-Object System.Collections.ArrayList
    $lines.AddRange(@($body -split '\r?\n'))
    $idx = [array]::IndexOf(@($lines), $first)
    if ($idx -ge 0) { $lines.RemoveAt($idx) }
    $body = ($lines -join "`n").Trim()
  } else { $Title = '오늘의 AI 브리핑' }
}
if (-not $Day) { $Day = [DateTime]::UtcNow.AddHours(9).ToString('yyyy-MM-dd') }
if ($Day -notmatch '^\d{4}-\d{2}-\d{2}$') { throw '날짜는 YYYY-MM-DD 모양이어야 합니다.' }
if ($body.Length -gt 20000) { throw '본문이 20,000자를 넘습니다. 줄여 주세요.' }

$json = @{ day = $Day; title = $Title; body = $body } | ConvertTo-Json -Compress
$bytes = [Text.Encoding]::UTF8.GetBytes($json)
try {
  $r = Invoke-RestMethod -Method Post -Uri $Url -ContentType 'application/json; charset=utf-8' -Body $bytes `
    -Headers @{ Authorization = 'Bearer ' + $token } -TimeoutSec 30
  "올렸습니다 (초안) · 날짜 $($r.day) · 관리자 화면 [AI 허브 관리] 에서 확인 후 [게시] 를 눌러 주세요."
} catch {
  $code = $null
  try { $code = [int]$_.Exception.Response.StatusCode } catch {}
  if ($code -eq 401) { throw '열쇠가 맞지 않습니다 (401). Vercel 의 HUB_TOKEN 과 같은지 확인해 주세요.' }
  if ($code -eq 409) { throw '그 날짜 브리핑은 이미 게시되어 있습니다 (409). 관리자 화면에서 [내리기] 한 뒤 다시 올려 주세요.' }
  if ($code -eq 503) { throw '서버 준비 전입니다 (503). db/11-AI허브.sql 실행과 Supabase 연결을 확인해 주세요.' }
  throw ('올리지 못했습니다' + $(if ($code) { " ($code)" } else { '' }) + ' — ' + $_.Exception.Message)
} finally { $token = $null }
