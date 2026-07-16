$ErrorActionPreference = 'Continue'

$projectRoot = Split-Path -Parent $PSScriptRoot
$nodePath = 'C:\Program Files\nodejs\node.exe'
$logDirectory = Join-Path $projectRoot 'logs'
$logFile = Join-Path $logDirectory 'bot.log'
$envFile = Join-Path $projectRoot '.env.local'
$maxLogSizeBytes = 10MB
$logRetentionDays = 14

New-Item -ItemType Directory -Force $logDirectory | Out-Null
Set-Location $projectRoot

function Rotate-BotLog {
  if (Test-Path $logFile) {
    $current = Get-Item -LiteralPath $logFile
    if ($current.Length -ge $maxLogSizeBytes) {
      $archive = Join-Path $logDirectory ("bot-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
      Move-Item -LiteralPath $logFile -Destination $archive
    }
  }
  Get-ChildItem -LiteralPath $logDirectory -Filter 'bot-*.log' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$logRetentionDays) } |
    Remove-Item -Force
}

while ($true) {
  Rotate-BotLog
  "[$(Get-Date -Format s)] Starting NuviloView:OEM Bot" | Add-Content -Path $logFile
  & $nodePath 'scripts/token-leak-check.mjs' 2>&1 | Out-File -FilePath $logFile -Append -Encoding utf8
  if ($LASTEXITCODE -ne 0) { "[$(Get-Date -Format s)] Token leak check failed. Bot start was blocked." | Add-Content -Path $logFile; Start-Sleep -Seconds 60; continue }
  $botTokenForRedaction = if (Test-Path $envFile) { ((Get-Content $envFile | Where-Object { $_ -match '^DISCORD_BOT_TOKEN=' } | Select-Object -First 1) -replace '^DISCORD_BOT_TOKEN=', '') } else { '' }
  & $nodePath '--env-file=.env.local' 'discord-bot.mjs' 2>&1 | ForEach-Object {
    # Never use an empty replacement pattern: it would insert [REDACTED]
    # between every character of an otherwise harmless log line.
    if ($botTokenForRedaction -and $botTokenForRedaction.Trim().Length -ge 20) {
      $_.ToString() -replace [regex]::Escape($botTokenForRedaction.Trim()), '[REDACTED]'
    } else {
      $_.ToString()
    }
  } | Out-File -FilePath $logFile -Append -Encoding utf8
  "[$(Get-Date -Format s)] Bot stopped. Restarting in 10 seconds." | Add-Content -Path $logFile
  Start-Sleep -Seconds 10
}
