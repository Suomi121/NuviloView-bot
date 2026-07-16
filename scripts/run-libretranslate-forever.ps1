$ErrorActionPreference = 'Continue'

$projectRoot = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $env:APPDATA 'Python\Python314\Scripts\libretranslate.exe'
$logDirectory = Join-Path $projectRoot 'logs'
$logFile = Join-Path $logDirectory 'libretranslate.log'

if (-not (Test-Path -LiteralPath $scriptPath)) {
  throw "LibreTranslate was not found at $scriptPath"
}

New-Item -ItemType Directory -Force $logDirectory | Out-Null
Set-Location $projectRoot

while ($true) {
  "[$(Get-Date -Format s)] Starting LibreTranslate" | Add-Content -Path $logFile
  & $scriptPath --host 127.0.0.1 --port 5000 --disable-web-ui --disable-files-translation --char-limit 2000 --threads 4 2>&1 | Out-File -FilePath $logFile -Append -Encoding utf8
  "[$(Get-Date -Format s)] LibreTranslate stopped. Restarting in 10 seconds." | Add-Content -Path $logFile
  Start-Sleep -Seconds 10
}
