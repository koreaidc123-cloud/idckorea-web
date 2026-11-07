# 랙PC 프로그램(agent\kvc-agent.ps1)에 전자서명을 만듭니다.
# kvc-agent.ps1 을 고칠 때마다 이 파일을 실행하고, 생긴 .sig 를 함께 올립니다.
# 비밀키는 저장소 밖 C:\KVC_SIGN 에만 둡니다. 절대 저장소나 USB에 넣지 않습니다.
param([string]$KeyFile = 'C:\KVC_SIGN\agent-sign-private.xml')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$file = Join-Path $root 'agent\kvc-agent.ps1'
$rsa = New-Object Security.Cryptography.RSACryptoServiceProvider
$rsa.PersistKeyInCsp = $false
$rsa.FromXmlString([IO.File]::ReadAllText($KeyFile))
$sha = New-Object Security.Cryptography.SHA256CryptoServiceProvider
$sig = [Convert]::ToBase64String($rsa.SignData([IO.File]::ReadAllBytes($file), $sha))
[IO.File]::WriteAllText("$file.sig", $sig)
Write-Host "서명 완료: $file.sig"
