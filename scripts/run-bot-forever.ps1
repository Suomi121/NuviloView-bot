$ErrorActionPreference = 'Continue'

$projectRoot = Split-Path -Parent $PSScriptRoot
$nodePath = 'C:\Program Files\nodejs\node.exe'
$logDirectory = Join-Path $projectRoot 'logs'
$logFile = Join-Path $logDirectory 'bot.log'

New-Item -ItemType Directory -Force $logDirectory | Out-Null
Set-Location $projectRoot

while ($true) {
  "[$(Get-Date -Format s)] Starting NuviloView:OEM Bot" | Add-Content -Path $logFile
  & $nodePath '--env-file=.env.local' 'discord-bot.mjs' 2>&1 | Out-File -FilePath $logFile -Append -Encoding utf8
  "[$(Get-Date -Format s)] Bot stopped. Restarting in 10 seconds." | Add-Content -Path $logFile
  Start-Sleep -Seconds 10
}
