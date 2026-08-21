[CmdletBinding()]
param(
  [ValidateSet('schedule', 'once', 'status')][string]$Mode = 'schedule',
  [ValidateRange(0, 23)][int]$TargetHour = 0,
  [ValidateRange(30, 3600)][int]$PollSeconds = 60,
  [ValidateRange(1, 3650)][int]$RetentionDays = 90,
  [ValidateRange(1, 5)][int]$DestinationCopyAttempts = 3
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $projectRoot 'logs'
$logFile = Join-Path $logDirectory 'backup.log'
$successMarker = Join-Path $logDirectory 'backup-last-success.json'
$attemptMarker = Join-Path $logDirectory 'backup-last-attempt.json'
$statusFile = Join-Path $logDirectory 'backup-status.json'
$backupScript = Join-Path $PSScriptRoot 'backup-server.ps1'
$mutex = $null
$hasMutex = $false

function Rotate-BackupLog {
  if (-not (Test-Path -LiteralPath $logFile -PathType Leaf)) { return }
  if ((Get-Item -LiteralPath $logFile).Length -lt 5MB) { return }
  for ($index = 4; $index -ge 1; $index -= 1) {
    $source = "$logFile.$index"
    $destination = "$logFile.$($index + 1)"
    if (Test-Path -LiteralPath $source) { Move-Item -LiteralPath $source -Destination $destination -Force }
  }
  Move-Item -LiteralPath $logFile -Destination "$logFile.1" -Force
}

function Write-RunnerLog {
  param([string]$Level, [string]$Message)
  Rotate-BackupLog
  $safeMessage = $Message -replace '(?i)postgres(?:ql)?://[^\s]+', '[REDACTED_DATABASE_URL]'
  $safeMessage = $safeMessage -replace '(?i)https://(?:canary\.)?discord(?:app)?\.com/api/webhooks/[^\s]+', '[REDACTED_WEBHOOK]'
  "[$((Get-Date).ToString('o'))] [$Level] $safeMessage" | Add-Content -LiteralPath $logFile -Encoding UTF8
}

function Read-MarkerDate {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try { return [string](Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json).date } catch { return $null }
}

function Write-Marker {
  param([string]$Path, [string]$Date, [string]$Status)
  [ordered]@{ date = $Date; status = $Status; updatedAt = (Get-Date).ToString('o') } |
    ConvertTo-Json | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Invoke-OneBackup {
  $today = (Get-Date).ToString('yyyy-MM-dd')
  Write-Marker -Path $attemptMarker -Date $today -Status 'started'
  Write-RunnerLog -Level 'INFO' -Message 'Starting the single daily backup pipeline attempt.'
  $arguments = @(
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', $backupScript,
    '-RetentionDays', [string]$RetentionDays,
    '-DestinationCopyAttempts', [string]$DestinationCopyAttempts
  )
  $encryptEnabled = [Environment]::GetEnvironmentVariable('NUVILOVIEW_BACKUP_ENCRYPTION_ENABLED', 'Process') -eq 'true'
  if ($encryptEnabled) { $arguments += '-Encrypt' }
  & powershell.exe @arguments 2>&1 | ForEach-Object { Write-RunnerLog -Level 'PIPELINE' -Message ([string]$_) }
  $exitCode = $LASTEXITCODE
  if ($exitCode -eq 0) {
    Write-Marker -Path $attemptMarker -Date $today -Status 'completed'
    Write-Marker -Path $successMarker -Date $today -Status 'complete'
    Write-RunnerLog -Level 'INFO' -Message 'Daily backup completed and restore verification passed.'
  } else {
    Write-Marker -Path $attemptMarker -Date $today -Status 'failed'
    Write-RunnerLog -Level 'ERROR' -Message 'Daily backup failed. The full pipeline will not be regenerated automatically again today.'
  }
  return $exitCode
}

New-Item -ItemType Directory -Force $logDirectory | Out-Null
Set-Location $projectRoot

if ($Mode -eq 'status') {
  if (Test-Path -LiteralPath $statusFile -PathType Leaf) { Get-Content -LiteralPath $statusFile -Raw }
  else { [ordered]@{ status = 'never_run'; updatedAt = $null } | ConvertTo-Json }
  exit 0
}

try {
  try { $mutex = New-Object System.Threading.Mutex($false, 'Global\NuviloViewBackupRunnerV2') }
  catch [System.UnauthorizedAccessException] { $mutex = New-Object System.Threading.Mutex($false, 'Local\NuviloViewBackupRunnerV2') }
  try { $hasMutex = $mutex.WaitOne(0, $false) } catch [System.Threading.AbandonedMutexException] { $hasMutex = $true }
  if (-not $hasMutex) {
    Write-RunnerLog -Level 'INFO' -Message 'Another backup runner is already active; duplicate process is exiting.'
    exit 0
  }

  if ($Mode -eq 'once') { exit (Invoke-OneBackup) }

  Write-RunnerLog -Level 'INFO' -Message "Backup scheduler started. One full pipeline attempt is allowed per calendar day at or after hour $TargetHour."
  while ($true) {
    $now = Get-Date
    $today = $now.ToString('yyyy-MM-dd')
    $attemptedDate = Read-MarkerDate -Path $attemptMarker
    if ($now.Hour -ge $TargetHour -and $attemptedDate -ne $today) {
      $null = Invoke-OneBackup
    }
    Start-Sleep -Seconds $PollSeconds
  }
} finally {
  if ($hasMutex -and $mutex) { try { $mutex.ReleaseMutex() } catch { } }
  if ($mutex) { $mutex.Dispose() }
}
