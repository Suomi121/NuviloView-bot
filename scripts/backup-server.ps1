[CmdletBinding()]
param(
  [string[]]$DestinationRoots = @('F:\NuviloView-Backups', 'G:\NuviloView-Backups'),
  [ValidateRange(1, 3650)][int]$RetentionDays = 90,
  [ValidateRange(1, 30)][int]$FailedStagingRetentionDays = 2,
  [ValidateRange(1, 10)][int]$FailedStagingMaxSets = 3,
  [ValidateRange(1, 5)][int]$DestinationCopyAttempts = 3,
  [ValidateRange(1, 300)][int]$RetryBaseSeconds = 5,
  [switch]$Encrypt,
  [ValidatePattern('^\d{8}-\d{6}-[a-f0-9]{8}$')][string]$ResumeBackupId,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$localBackupRoot = Join-Path $projectRoot 'backups'
$stagingRoot = Join-Path $localBackupRoot 'server-staging'
$failedStagingRoot = Join-Path $localBackupRoot 'failed-staging-v2'
$databaseBackupScript = Join-Path $PSScriptRoot 'backup-neon.ps1'
$inventoryScript = Join-Path $PSScriptRoot 'backup-source-inventory.mjs'
$verifyScript = Join-Path $PSScriptRoot 'verify-server-backup.ps1'
$statusPath = Join-Path $projectRoot 'logs\backup-status.json'
$backupId = if ($ResumeBackupId) { $ResumeBackupId } else { "$(Get-Date -Format 'yyyyMMdd-HHmmss')-$(([guid]::NewGuid().ToString('N')).Substring(0, 8))" }
$stagingPath = if ($ResumeBackupId) { Join-Path $failedStagingRoot $backupId } else { Join-Path $stagingRoot $backupId }
$stage = 'preflight'
$artifactsVerified = $false
$pipelineStartedAt = Get-Date
$mutex = $null
$hasMutex = $false

function ConvertTo-SafeErrorMessage {
  param([string]$Message)
  if (-not $Message) { return 'Unknown backup error.' }
  $safe = $Message
  $safe = $safe -replace '(?i)postgres(?:ql)?://[^\s]+', '[REDACTED_DATABASE_URL]'
  $safe = $safe -replace '(?i)https://(?:canary\.)?discord(?:app)?\.com/api/webhooks/[^\s]+', '[REDACTED_WEBHOOK]'
  $safe = $safe -replace '(?i)(?:password|passphrase|token|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+', '$1=[REDACTED]'
  if ($safe.Length -gt 500) { $safe = $safe.Substring(0, 500) }
  return $safe
}

function Write-BackupStatus {
  param(
    [Parameter(Mandatory = $true)][string]$Status,
    [string]$BackupIdValue,
    [string]$StageValue,
    [string]$ErrorCode,
    [int]$SuccessfulDestinationCount = 0,
    [int]$FailedDestinationCount = 0,
    [bool]$RestoreVerified = $false
  )
  $directory = Split-Path -Parent $statusPath
  New-Item -ItemType Directory -Force $directory | Out-Null
  $payload = [ordered]@{
    schemaVersion = 1
    status = $Status
    backupId = $BackupIdValue
    stage = $StageValue
    attemptedAt = $pipelineStartedAt.ToString('o')
    updatedAt = (Get-Date).ToString('o')
    successfulDestinationCount = $SuccessfulDestinationCount
    failedDestinationCount = $FailedDestinationCount
    restoreVerified = $RestoreVerified
    errorCode = $ErrorCode
  }
  $temporary = "$statusPath.$PID.tmp"
  $payload | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $statusPath -Force
}

function Assert-SafeChildPath {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Candidate
  )
  $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $fullCandidate = [System.IO.Path]::GetFullPath($Candidate)
  if (-not $fullCandidate.StartsWith($fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use a path outside its expected root: $fullCandidate"
  }
  return $fullCandidate
}

function Remove-SafeDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Candidate
  )
  $safePath = Assert-SafeChildPath -Root $Root -Candidate $Candidate
  if (Test-Path -LiteralPath $safePath) { Remove-Item -LiteralPath $safePath -Recurse -Force }
}

function Resolve-BackupDestination {
  param([Parameter(Mandatory = $true)][string]$Path)
  try {
    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    $volumeRoot = [System.IO.Path]::GetPathRoot($fullPath).TrimEnd('\')
    if (-not $volumeRoot -or $fullPath -eq $volumeRoot) { throw 'A volume root cannot be used directly.' }
    if (-not (Test-Path -LiteralPath $volumeRoot)) { throw 'The backup volume is not mounted.' }
    return [pscustomobject]@{ Root = $fullPath; Available = $true; ErrorCode = $null }
  } catch {
    return [pscustomobject]@{ Root = $Path; Available = $false; ErrorCode = 'DESTINATION_UNAVAILABLE' }
  }
}

function Remove-ExpiredBackupSets {
  param([string]$Root, [int]$Days)
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return }
  $cutoff = (Get-Date).AddDays(-$Days)
  foreach ($directory in Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue) {
    if ($directory.Name -notmatch '^\d{8}-\d{6}(?:-[a-f0-9]{8})?$' -or $directory.LastWriteTime -ge $cutoff) { continue }
    Remove-SafeDirectory -Root $Root -Candidate $directory.FullName
    Write-Output "Expired verified backup removed by retention policy: $($directory.Name)"
  }
}

function Remove-ExpiredFailedStaging {
  if (-not (Test-Path -LiteralPath $failedStagingRoot -PathType Container)) { return }
  $directories = @(Get-ChildItem -LiteralPath $failedStagingRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d{8}-\d{6}-[a-f0-9]{8}$' } |
    Sort-Object LastWriteTime -Descending)
  $cutoff = (Get-Date).AddDays(-$FailedStagingRetentionDays)
  for ($index = 0; $index -lt $directories.Count; $index += 1) {
    if ($directories[$index].LastWriteTime -lt $cutoff -or $index -ge $FailedStagingMaxSets) {
      Remove-SafeDirectory -Root $failedStagingRoot -Candidate $directories[$index].FullName
    }
  }
}

function Test-RetryableDestinationError {
  param([System.Exception]$Exception)
  if ($Exception -is [System.UnauthorizedAccessException]) { return $false }
  if ($Exception.Message -match '(?i)checksum|manifest|secret|escapes|unsupported|refusing') { return $false }
  return $Exception -is [System.IO.IOException] -or $Exception.Message -match '(?i)temporar|unavailable|not ready|network|device|being used|locked'
}

function Invoke-GpgEncryptFile {
  param([string]$InputPath, [string]$OutputPath)
  $passphrase = [Environment]::GetEnvironmentVariable('NUVILOVIEW_BACKUP_ENCRYPTION_PASSPHRASE', 'Process')
  if (-not $passphrase) { throw 'Backup encryption was requested but its passphrase is not configured.' }
  $gpgCommand = Get-Command gpg.exe -ErrorAction SilentlyContinue
  if (-not $gpgCommand) { $gpgCommand = Get-Command gpg -ErrorAction SilentlyContinue }
  if (-not $gpgCommand) { throw 'gpg is required when backup encryption is enabled.' }
  if ($InputPath.Contains('"') -or $OutputPath.Contains('"')) { throw 'Unsupported quote character in backup path.' }
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $gpgCommand.Source
  $startInfo.Arguments = "--batch --yes --pinentry-mode loopback --passphrase-fd 0 --symmetric --cipher-algo AES256 --output `"$OutputPath`" `"$InputPath`""
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.CreateNoWindow = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) { throw 'gpg could not start.' }
    $process.StandardInput.WriteLine($passphrase)
    $process.StandardInput.Close()
    $null = $process.StandardOutput.ReadToEnd()
    $null = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $OutputPath -PathType Leaf)) {
      throw 'Backup encryption failed.'
    }
  } finally {
    $passphrase = $null
    $process.Dispose()
  }
}

function Write-BackupChecksums {
  param([string]$Directory, [string[]]$FileNames)
  $lines = foreach ($name in $FileNames) {
    $path = Join-Path $Directory $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Checksum source is missing: $name" }
    $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash *$name"
  }
  Set-Content -LiteralPath (Join-Path $Directory 'SHA256SUMS.txt') -Value $lines -Encoding ASCII
}

function Copy-BackupToDestination {
  param([string]$DestinationRoot, [string]$SourcePath)
  New-Item -ItemType Directory -Force $DestinationRoot | Out-Null
  $partialPath = Join-Path $DestinationRoot ".partial-$backupId"
  $finalPath = Join-Path $DestinationRoot $backupId
  if (Test-Path -LiteralPath $finalPath -PathType Container) {
    & $verifyScript -BackupPath $finalPath | Out-Null
    return [pscustomobject]@{ Success = $true; Existing = $true; Attempts = 0; ErrorCode = $null }
  }

  $lastError = $null
  for ($attempt = 1; $attempt -le $DestinationCopyAttempts; $attempt += 1) {
    try {
      if (Test-Path -LiteralPath $partialPath) { Remove-SafeDirectory -Root $DestinationRoot -Candidate $partialPath }
      Copy-Item -LiteralPath $SourcePath -Destination $partialPath -Recurse
      & $verifyScript -BackupPath $partialPath | Out-Null
      Move-Item -LiteralPath $partialPath -Destination $finalPath
      Set-Content -LiteralPath (Join-Path $DestinationRoot 'latest.txt') -Value $backupId -Encoding ASCII
      return [pscustomobject]@{ Success = $true; Existing = $false; Attempts = $attempt; ErrorCode = $null }
    } catch {
      $lastError = $_.Exception
      if (Test-Path -LiteralPath $partialPath) {
        try { Remove-SafeDirectory -Root $DestinationRoot -Candidate $partialPath } catch { }
      }
      if ($attempt -ge $DestinationCopyAttempts -or -not (Test-RetryableDestinationError -Exception $lastError)) { break }
      $delay = [math]::Min(300, $RetryBaseSeconds * [math]::Pow(2, $attempt - 1))
      Start-Sleep -Seconds ([int]$delay)
    }
  }
  return [pscustomobject]@{ Success = $false; Existing = $false; Attempts = $DestinationCopyAttempts; ErrorCode = if ($lastError -is [System.UnauthorizedAccessException]) { 'DESTINATION_ACCESS_DENIED' } else { 'DESTINATION_COPY_FAILED' } }
}

function Write-FailureRecord {
  param([string]$Directory, [string]$Code, [string]$SafeMessage)
  New-Item -ItemType Directory -Force $Directory | Out-Null
  [ordered]@{
    schemaVersion = 1
    backupId = $backupId
    status = 'failed'
    stage = $stage
    failedAt = (Get-Date).ToString('o')
    errorCode = $Code
    message = $SafeMessage
    artifactsVerified = $artifactsVerified
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Directory 'failure.json') -Encoding UTF8
}

try {
  try {
    $mutex = New-Object System.Threading.Mutex($false, 'Global\NuviloViewBackupPipelineV2')
  } catch [System.UnauthorizedAccessException] {
    $mutex = New-Object System.Threading.Mutex($false, 'Local\NuviloViewBackupPipelineV2')
  }
  try { $hasMutex = $mutex.WaitOne(0, $false) } catch [System.Threading.AbandonedMutexException] { $hasMutex = $true }
  if (-not $hasMutex) { throw 'Another backup pipeline is already running.' }

  $resolvedDestinations = @($DestinationRoots | ForEach-Object { Resolve-BackupDestination -Path $_ })
  $availableDestinations = @($resolvedDestinations | Where-Object { $_.Available })
  if ($availableDestinations.Count -eq 0) { throw 'No configured backup destination is currently available.' }
  foreach ($requiredPath in @($databaseBackupScript, $inventoryScript, $verifyScript, (Join-Path $projectRoot 'package.json'), (Join-Path $projectRoot '.env.local'))) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) { throw 'Backup preflight failed because a required local file is unavailable.' }
  }
  $tarCommand = Get-Command tar.exe -ErrorAction SilentlyContinue
  if (-not $tarCommand) { $tarCommand = Get-Command tar -ErrorAction Stop }
  $nodeCommand = Get-Command node -ErrorAction Stop
  if ($Encrypt -and -not [Environment]::GetEnvironmentVariable('NUVILOVIEW_BACKUP_ENCRYPTION_PASSPHRASE', 'Process')) {
    throw 'Backup encryption was requested but its passphrase is not configured.'
  }

  if ($DryRun) {
    [pscustomobject]@{
      Mode = 'dry-run'
      SchemaVersion = 2
      BackupId = $backupId
      Destinations = @($resolvedDestinations | ForEach-Object { [pscustomobject]@{ Root = $_.Root; Available = $_.Available } })
      RetentionDays = $RetentionDays
      FailedStagingRetentionDays = $FailedStagingRetentionDays
      DestinationCopyAttempts = $DestinationCopyAttempts
      Encrypted = [bool]$Encrypt
      ContainsSecrets = $false
      FullArtifactGenerationAttempts = 1
      SourcePolicy = 'inventory allow-list with secret candidate scan'
    }
    exit 0
  }

  New-Item -ItemType Directory -Force $localBackupRoot, $stagingRoot, $failedStagingRoot | Out-Null
  Remove-ExpiredFailedStaging

  if ($ResumeBackupId) {
    $stage = 'resume_verification'
    if (-not (Test-Path -LiteralPath $stagingPath -PathType Container)) { throw 'The requested verified failed-staging backup was not found.' }
    & $verifyScript -BackupPath $stagingPath | Out-Null
    $artifactsVerified = $true
  } else {
    if (Test-Path -LiteralPath $stagingPath) { throw 'A staging directory already exists for this backup ID.' }
    New-Item -ItemType Directory -Path $stagingPath | Out-Null

    $stage = 'source_inventory'
    $sourceListPath = Join-Path $stagingPath 'source-files.txt'
    $inventoryOutput = @(& $nodeCommand.Source $inventoryScript --root $projectRoot --output $sourceListPath)
    $inventoryExitCode = $LASTEXITCODE
    if (-not $inventoryOutput) { throw 'Source inventory did not return a result.' }
    $inventory = $inventoryOutput[-1] | ConvertFrom-Json
    if ($inventoryExitCode -eq 3 -or @($inventory.secretFindings).Count -gt 0) {
      throw "Source secret screening rejected $(@($inventory.secretFindings).Count) file(s)."
    }
    if ($inventoryExitCode -ne 0 -or $inventory.includedFileCount -lt 1) { throw 'Source inventory failed.' }

    $stage = 'database_dump'
    $databasePlainName = "nuviloview-$backupId.dump"
    $databasePlainPath = Join-Path $stagingPath $databasePlainName
    $databaseResult = @(& $databaseBackupScript -OutputPath $databasePlainPath -PassThru) |
      Where-Object { $_ -is [psobject] -and $_.PSObject.Properties.Name -contains 'Path' } |
      Select-Object -Last 1
    if (-not $databaseResult -or -not (Test-Path -LiteralPath $databasePlainPath -PathType Leaf)) { throw 'Verified database dump was not produced.' }

    $stage = 'source_archive'
    $sourcePlainName = "nuviloview-source-$backupId.tar.gz"
    $sourcePlainPath = Join-Path $stagingPath $sourcePlainName
    & $tarCommand.Source -czf $sourcePlainPath -C $projectRoot -T $sourceListPath
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $sourcePlainPath -PathType Leaf)) { throw 'Source archive creation failed.' }
    Remove-Item -LiteralPath $sourceListPath -Force

    $databasePlainHash = (Get-FileHash -LiteralPath $databasePlainPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $sourcePlainHash = (Get-FileHash -LiteralPath $sourcePlainPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $storedDatabasePath = $databasePlainPath
    $storedSourcePath = $sourcePlainPath

    if ($Encrypt) {
      $stage = 'encryption'
      $storedDatabasePath = "$databasePlainPath.gpg"
      $storedSourcePath = "$sourcePlainPath.gpg"
      Invoke-GpgEncryptFile -InputPath $databasePlainPath -OutputPath $storedDatabasePath
      Invoke-GpgEncryptFile -InputPath $sourcePlainPath -OutputPath $storedSourcePath
      Remove-Item -LiteralPath $databasePlainPath, $sourcePlainPath -Force
    }

    $package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
    $gitCommit = (& git -C $projectRoot rev-parse HEAD 2>$null | Select-Object -First 1)
    $gitDirty = [bool](& git -C $projectRoot status --porcelain 2>$null)
    $databaseStoredName = Split-Path -Leaf $storedDatabasePath
    $sourceStoredName = Split-Path -Leaf $storedSourcePath
    $manifest = [ordered]@{
      schemaVersion = 2
      backupId = $backupId
      createdAt = (Get-Date).ToUniversalTime().ToString('o')
      appVersion = [string]$package.version
      gitCommit = if ($gitCommit) { [string]$gitCommit } else { $null }
      gitDirty = $gitDirty
      dbDumpSha256 = $databasePlainHash
      sourceArchiveSha256 = $sourcePlainHash
      encrypted = [bool]$Encrypt
      restoreVerified = $false
      status = 'verification_pending'
      containsSecrets = $false
      retentionDays = $RetentionDays
      secretScan = [ordered]@{ performed = $true; passed = $true; findings = 0 }
      sourceInventory = [ordered]@{ includedFiles = [int]$inventory.includedFileCount; excludedFiles = [int]$inventory.excludedFileCount }
      retryPolicy = [ordered]@{ fullArtifactGenerationAttempts = 1; destinationCopyAttempts = $DestinationCopyAttempts; strategy = 'exponential_backoff'; baseSeconds = $RetryBaseSeconds }
      files = @(
        [ordered]@{ name = $sourceStoredName; originalName = $sourcePlainName; type = 'server-source'; bytes = (Get-Item -LiteralPath $storedSourcePath).Length; sha256 = (Get-FileHash -LiteralPath $storedSourcePath -Algorithm SHA256).Hash.ToLowerInvariant() },
        [ordered]@{ name = $databaseStoredName; originalName = $databasePlainName; type = 'postgresql-custom-dump'; bytes = (Get-Item -LiteralPath $storedDatabasePath).Length; sha256 = (Get-FileHash -LiteralPath $storedDatabasePath -Algorithm SHA256).Hash.ToLowerInvariant() }
      )
    }
    $manifestPath = Join-Path $stagingPath 'manifest.json'
    $manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
    $restoreText = @"
NuviloView backup $backupId

This set contains a PostgreSQL custom-format dump and a Secret-screened source archive.
It does not contain .env, .env.local, private keys, token caches, logs, node_modules, .next, Git metadata, or temporary output.

Verify before restore:
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\verify-server-backup.ps1 -BackupPath "<BACKUP_SET_PATH>"

Restore only into an isolated directory and a new, non-production database. Configure fresh secrets separately after verification.
"@
    Set-Content -LiteralPath (Join-Path $stagingPath 'README-RESTORE.txt') -Value $restoreText -Encoding UTF8
    Write-BackupChecksums -Directory $stagingPath -FileNames @($sourceStoredName, $databaseStoredName, 'manifest.json', 'README-RESTORE.txt')

    $stage = 'restore_verification'
    & $verifyScript -BackupPath $stagingPath | Out-Null
    $manifest.restoreVerified = $true
    $manifest.status = 'verified'
    $manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
    Write-BackupChecksums -Directory $stagingPath -FileNames @($sourceStoredName, $databaseStoredName, 'manifest.json', 'README-RESTORE.txt')
    $artifactsVerified = $true
  }

  $stage = 'destination_delivery'
  $successfulDestinations = [System.Collections.Generic.List[object]]::new()
  $failedDestinations = [System.Collections.Generic.List[object]]::new()
  foreach ($destination in $resolvedDestinations) {
    if (-not $destination.Available) {
      $failedDestinations.Add([pscustomobject]@{ Root = $destination.Root; ErrorCode = $destination.ErrorCode; Attempts = 0 })
      continue
    }
    $result = Copy-BackupToDestination -DestinationRoot $destination.Root -SourcePath $stagingPath
    if ($result.Success) {
      $successfulDestinations.Add([pscustomobject]@{ Root = $destination.Root; Existing = $result.Existing; Attempts = $result.Attempts })
      Remove-ExpiredBackupSets -Root $destination.Root -Days $RetentionDays
    } else {
      $failedDestinations.Add([pscustomobject]@{ Root = $destination.Root; ErrorCode = $result.ErrorCode; Attempts = $result.Attempts })
    }
  }
  if ($successfulDestinations.Count -eq 0) { throw 'No backup destination accepted the verified backup set.' }

  $stage = 'cleanup'
  $cleanupRoot = if ($ResumeBackupId) { $failedStagingRoot } else { $stagingRoot }
  Remove-SafeDirectory -Root $cleanupRoot -Candidate $stagingPath
  $status = if ($failedDestinations.Count -eq 0) { 'complete' } else { 'degraded' }
  Write-BackupStatus -Status $status -BackupIdValue $backupId -StageValue 'complete' -SuccessfulDestinationCount $successfulDestinations.Count -FailedDestinationCount $failedDestinations.Count -RestoreVerified $true
  [pscustomobject]@{
    BackupId = $backupId
    Status = $status
    SuccessfulDestinations = @($successfulDestinations)
    FailedDestinations = @($failedDestinations)
    RetentionDays = $RetentionDays
    ContainsSecrets = $false
    Encrypted = [bool]$Encrypt
    RestoreVerified = $true
    FullArtifactGenerationAttempts = if ($ResumeBackupId) { 0 } else { 1 }
  }
} catch {
  $safeMessage = ConvertTo-SafeErrorMessage -Message $_.Exception.Message
  $errorCode = switch -Regex ($safeMessage) {
    'already running' { 'BACKUP_LOCKED'; break }
    'secret screening' { 'SECRET_SCAN_FAILED'; break }
    'destination' { 'DESTINATION_FAILED'; break }
    'encryption' { 'ENCRYPTION_FAILED'; break }
    'database' { 'DATABASE_BACKUP_FAILED'; break }
    default { 'BACKUP_FAILED' }
  }
  try {
    New-Item -ItemType Directory -Force $failedStagingRoot | Out-Null
    $failedPath = Join-Path $failedStagingRoot $backupId
    if ($artifactsVerified) {
      if (-not $ResumeBackupId -and (Test-Path -LiteralPath $stagingPath)) {
        if (Test-Path -LiteralPath $failedPath) { Remove-SafeDirectory -Root $failedStagingRoot -Candidate $failedPath }
        Move-Item -LiteralPath $stagingPath -Destination $failedPath
      }
      Write-FailureRecord -Directory $failedPath -Code $errorCode -SafeMessage $safeMessage
    } else {
      if (-not $ResumeBackupId -and (Test-Path -LiteralPath $stagingPath)) { Remove-SafeDirectory -Root $stagingRoot -Candidate $stagingPath }
      if (-not (Test-Path -LiteralPath $failedPath)) { New-Item -ItemType Directory -Path $failedPath | Out-Null }
      Write-FailureRecord -Directory $failedPath -Code $errorCode -SafeMessage $safeMessage
    }
    Remove-ExpiredFailedStaging
  } catch { }
  try { Write-BackupStatus -Status 'failed' -BackupIdValue $backupId -StageValue $stage -ErrorCode $errorCode -RestoreVerified $artifactsVerified } catch { }
  Write-Error $safeMessage
  exit 1
} finally {
  if ($hasMutex -and $mutex) { try { $mutex.ReleaseMutex() } catch { } }
  if ($mutex) { $mutex.Dispose() }
}
