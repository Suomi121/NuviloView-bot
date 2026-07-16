$ErrorActionPreference = 'Continue'

$projectRoot = Split-Path -Parent $PSScriptRoot
$nodePath = 'C:\Program Files\nodejs\node.exe'
$logDirectory = Join-Path $projectRoot 'logs'
$logFile = Join-Path $logDirectory 'bot.log'
$backupMarkerFile = Join-Path $logDirectory 'backup-last-run.txt'
$envFile = Join-Path $projectRoot '.env.local'
$databaseUrlForRedaction = if (Test-Path $envFile) { ((Get-Content $envFile | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1) -replace '^DATABASE_URL=', '') } else { '' }
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

function Invoke-DailyNeonBackup {
  # Run once after 03:00 local time. The marker keeps restarts from creating
  # several dumps on the same day.
  $today = Get-Date -Format 'yyyy-MM-dd'
  $alreadyBackedUp = (Test-Path $backupMarkerFile) -and ((Get-Content $backupMarkerFile -Raw).Trim() -eq $today)
  if ((Get-Date).Hour -lt 3 -or $alreadyBackedUp) { return }
  "[$(Get-Date -Format s)] Starting daily Neon backup" | Add-Content -Path $logFile
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $projectRoot 'scripts\backup-neon.ps1') 2>&1 |
    ForEach-Object { if ($databaseUrlForRedaction) { $_.ToString() -replace [regex]::Escape($databaseUrlForRedaction), '[REDACTED]' } else { $_.ToString() } } |
    Out-File -FilePath $logFile -Append -Encoding utf8
  if ($LASTEXITCODE -eq 0) { Set-Content -Path $backupMarkerFile -Value $today -NoNewline }
}

while ($true) {
  Rotate-BotLog
  Invoke-DailyNeonBackup
  "[$(Get-Date -Format s)] Starting NuviloView:OEM Bot" | Add-Content -Path $logFile
  & $nodePath 'scripts/token-leak-check.mjs' 2>&1 | Out-File -FilePath $logFile -Append -Encoding utf8
  if ($LASTEXITCODE -ne 0) { "[$(Get-Date -Format s)] Token leak check failed. Bot start was blocked." | Add-Content -Path $logFile; Start-Sleep -Seconds 60; continue }
  $botTokenForRedaction = if (Test-Path $envFile) { ((Get-Content $envFile | Where-Object { $_ -match '^DISCORD_BOT_TOKEN=' } | Select-Object -First 1) -replace '^DISCORD_BOT_TOKEN=', '') } else { '' }
  & $nodePath '--env-file=.env.local' 'discord-bot.mjs' 2>&1 | ForEach-Object { if ($botTokenForRedaction) { $_.ToString() -replace [regex]::Escape($botTokenForRedaction), '[REDACTED]' } else { $_.ToString() } } | Out-File -FilePath $logFile -Append -Encoding utf8
  "[$(Get-Date -Format s)] Bot stopped. Restarting in 10 seconds." | Add-Content -Path $logFile
  Start-Sleep -Seconds 10
}
