$ErrorActionPreference = 'Continue'

$projectRoot = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $projectRoot 'logs'
$logFile = Join-Path $logDirectory 'backup.log'
$markerFile = Join-Path $logDirectory 'backup-last-run.txt'
$backupScript = Join-Path $PSScriptRoot 'backup-neon.ps1'
$targetHour = 0 # 00:00 (midnight), local PC time

New-Item -ItemType Directory -Force $logDirectory | Out-Null
Set-Location $projectRoot

function Invoke-DailyBackup {
  $now = Get-Date
  $today = $now.ToString('yyyy-MM-dd')
  $alreadyBackedUp = (Test-Path $markerFile) -and ((Get-Content $markerFile -Raw).Trim() -eq $today)

  # Run exactly once each calendar day. If the PC starts later in the day,
  # catch up immediately instead of silently missing that day's backup.
  if ($now.Hour -lt $targetHour -or $alreadyBackedUp) { return }

  "[$($now.ToString('s'))] Starting daily Neon backup" | Add-Content -Path $logFile
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $backupScript 2>&1 |
    Out-File -FilePath $logFile -Append -Encoding utf8

  if ($LASTEXITCODE -eq 0) {
    Set-Content -Path $markerFile -Value $today -NoNewline
    "[$((Get-Date).ToString('s'))] Daily Neon backup completed" | Add-Content -Path $logFile
  } else {
    "[$((Get-Date).ToString('s'))] Daily Neon backup failed; it will retry in 5 minutes" | Add-Content -Path $logFile
  }
}

while ($true) {
  Invoke-DailyBackup
  Start-Sleep -Seconds 300
}
