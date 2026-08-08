[CmdletBinding()]
param(
  [string[]]$DestinationRoots = @(
    'F:\NuviloView-Backups',
    'G:\NuviloView-Backups'
  ),
  [ValidateRange(1, 3650)]
  [int]$RetentionDays = 90,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$localBackupRoot = Join-Path $projectRoot 'backups'
$stagingRoot = Join-Path $localBackupRoot 'server-staging'
$databaseBackupScript = Join-Path $PSScriptRoot 'backup-neon.ps1'
$verifyScript = Join-Path $PSScriptRoot 'verify-server-backup.ps1'
$tarPath = (Get-Command tar.exe -ErrorAction Stop).Source
$backupId = Get-Date -Format 'yyyyMMdd-HHmmss'
$stagingPath = Join-Path $stagingRoot $backupId

function Resolve-SafeBackupRoot {
  param([Parameter(Mandatory = $true)][string]$Path)

  $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  $volumeRoot = [System.IO.Path]::GetPathRoot($fullPath).TrimEnd('\')
  if (-not $volumeRoot -or $fullPath -eq $volumeRoot) {
    throw "A volume root cannot be used directly as a backup root: $Path"
  }
  if (-not (Test-Path -LiteralPath $volumeRoot)) {
    throw "Backup volume is not mounted: $volumeRoot"
  }
  return $fullPath
}

function Remove-ExpiredBackupSets {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][int]$Days
  )

  $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
  $rootPrefix = $fullRoot + '\'
  $cutoff = (Get-Date).AddDays(-$Days)
  foreach ($directory in Get-ChildItem -LiteralPath $fullRoot -Directory -ErrorAction SilentlyContinue) {
    if ($directory.Name -notmatch '^\d{8}-\d{6}$' -or $directory.LastWriteTime -ge $cutoff) {
      continue
    }
    $candidate = [System.IO.Path]::GetFullPath($directory.FullName)
    if (-not $candidate.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove a backup outside its root: $candidate"
    }
    Remove-Item -LiteralPath $candidate -Recurse -Force
    Write-Output "Expired backup removed: $candidate"
  }
}

$resolvedDestinations = @($DestinationRoots | ForEach-Object {
  Resolve-SafeBackupRoot -Path $_
})

if ($DryRun) {
  [pscustomobject]@{
    Mode = 'dry-run'
    BackupId = $backupId
    ProjectRoot = $projectRoot
    Destinations = $resolvedDestinations
    RetentionDays = $RetentionDays
    Includes = @('NeonDB custom-format dump', 'server source and configuration', '.env.local', 'restore instructions', 'SHA-256 checksums')
    Excludes = @('node_modules', '.next', 'backups', 'logs')
  }
  exit 0
}

New-Item -ItemType Directory -Force $localBackupRoot, $stagingRoot | Out-Null
if (Test-Path -LiteralPath $stagingPath) {
  throw "Staging directory already exists: $stagingPath"
}
New-Item -ItemType Directory -Path $stagingPath | Out-Null

$successfulDestinations = [System.Collections.Generic.List[string]]::new()
$failedDestinations = [System.Collections.Generic.List[object]]::new()

try {
  $databaseOutput = @(
    & $databaseBackupScript -BackupDirectory $localBackupRoot -RetentionDays 14 -PassThru
  )
  $databaseResult = $databaseOutput |
    Where-Object { $_ -is [psobject] -and $_.PSObject.Properties.Name -contains 'Path' } |
    Select-Object -Last 1
  if (-not $databaseResult -or -not (Test-Path -LiteralPath $databaseResult.Path -PathType Leaf)) {
    throw 'The verified Neon backup file could not be identified.'
  }
  $stagedDatabase = Join-Path $stagingPath $databaseResult.Name
  Copy-Item -LiteralPath $databaseResult.Path -Destination $stagedDatabase

  $archiveName = "nuviloview-server-files-$backupId.tar.gz"
  $archivePath = Join-Path $stagingPath $archiveName
  $tarArguments = @(
    '-czf', $archivePath,
    '--exclude=./node_modules',
    '--exclude=./.next',
    '--exclude=./backups',
    '--exclude=./logs',
    '--exclude=./companion/node_modules',
    '--exclude=./companion/.next',
    '-C', $projectRoot,
    '.'
  )
  & $tarPath @tarArguments
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
    throw 'Server file archive creation failed.'
  }

  $archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $databaseHash = (Get-FileHash -LiteralPath $stagedDatabase -Algorithm SHA256).Hash.ToLowerInvariant()
  $gitCommit = (& git -C $projectRoot rev-parse HEAD 2>$null)
  $gitDirty = [bool](& git -C $projectRoot status --porcelain 2>$null)
  $manifest = [ordered]@{
    schemaVersion = 1
    backupId = $backupId
    createdAt = (Get-Date).ToString('o')
    computerName = $env:COMPUTERNAME
    projectName = 'NuviloView'
    sourcePath = $projectRoot
    retentionDays = $RetentionDays
    containsSecrets = $true
    secretWarning = '.env.local contains credentials. Protect both backup drives with BitLocker and restrict physical access.'
    git = [ordered]@{
      commit = if ($LASTEXITCODE -eq 0) { [string]$gitCommit } else { $null }
      dirty = $gitDirty
    }
    excluded = @('node_modules', '.next', 'backups', 'logs')
    files = @(
      [ordered]@{
        name = $archiveName
        type = 'server-files'
        bytes = (Get-Item -LiteralPath $archivePath).Length
        sha256 = $archiveHash
      },
      [ordered]@{
        name = $databaseResult.Name
        type = 'neon-postgresql-custom-dump'
        bytes = (Get-Item -LiteralPath $stagedDatabase).Length
        sha256 = $databaseHash
      }
    )
  }
  $manifestPath = Join-Path $stagingPath 'manifest.json'
  $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

  $restoreInstructions = @"
NuviloView server backup: $backupId

IMPORTANT
- This backup contains .env.local and therefore contains credentials.
- Keep F: and G: physically secure and enable BitLocker.
- Restore into a new directory and a new/empty PostgreSQL database first.

FILES
- $archiveName : server source, configuration, tools and runtime scripts
- $($databaseResult.Name) : Neon/PostgreSQL custom-format dump
- manifest.json : backup metadata
- SHA256SUMS.txt : integrity hashes

VERIFY
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\verify-server-backup.ps1 -BackupPath "<BACKUP_SET_PATH>"

RESTORE SERVER FILES
1. Create an empty restore directory.
2. Run:
   tar.exe -xzf "$archiveName" -C "<RESTORE_DIRECTORY>"
3. Review .env.local and rotate credentials if the drive may have been exposed.
4. Run pnpm install, pnpm test, and pnpm build.

RESTORE DATABASE TO A NEW DATABASE
1. Create a new empty PostgreSQL/Neon database.
2. Run:
   tools\postgresql17\bin\pg_restore.exe --dbname="<NEW_DATABASE_URL>" --no-owner --no-privileges "$($databaseResult.Name)"
3. Point the restored .env.local at the new database only after validation.

Do not restore over production until the new environment has been verified.
"@
  $restorePath = Join-Path $stagingPath 'README-RESTORE.txt'
  Set-Content -LiteralPath $restorePath -Value $restoreInstructions -Encoding UTF8

  $checksumFiles = @(
    Get-Item -LiteralPath $archivePath
    Get-Item -LiteralPath $stagedDatabase
    Get-Item -LiteralPath $manifestPath
    Get-Item -LiteralPath $restorePath
  )
  $checksumLines = $checksumFiles | ForEach-Object {
    $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash *$($_.Name)"
  }
  Set-Content -LiteralPath (Join-Path $stagingPath 'SHA256SUMS.txt') -Value $checksumLines -Encoding ASCII

  & $verifyScript -BackupPath $stagingPath | Out-Null

  foreach ($destinationRoot in $resolvedDestinations) {
    try {
      New-Item -ItemType Directory -Force $destinationRoot | Out-Null
      $partialPath = Join-Path $destinationRoot ".partial-$backupId"
      $finalPath = Join-Path $destinationRoot $backupId
      if (
        (Test-Path -LiteralPath $partialPath) -or
        (Test-Path -LiteralPath $finalPath)
      ) {
        throw "Backup destination already exists for $backupId"
      }
      Copy-Item -LiteralPath $stagingPath -Destination $partialPath -Recurse
      & $verifyScript -BackupPath $partialPath | Out-Null
      Move-Item -LiteralPath $partialPath -Destination $finalPath
      Set-Content -LiteralPath (Join-Path $destinationRoot 'latest.txt') -Value $backupId -Encoding ASCII
      Remove-ExpiredBackupSets -Root $destinationRoot -Days $RetentionDays
      $successfulDestinations.Add($finalPath)
      Write-Output "Verified server backup created: $finalPath"
    } catch {
      $failedDestinations.Add([pscustomobject]@{
        Destination = $destinationRoot
        Error = $_.Exception.Message
      })
      Write-Warning "Backup failed for $destinationRoot`: $($_.Exception.Message)"
    }
  }

  if ($successfulDestinations.Count -eq 0) {
    throw 'No external backup destination completed successfully. Staging files were retained.'
  }

  $fullStagingRoot = [System.IO.Path]::GetFullPath($stagingRoot).TrimEnd('\') + '\'
  $fullStagingPath = [System.IO.Path]::GetFullPath($stagingPath)
  if (-not $fullStagingPath.StartsWith($fullStagingRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove an unsafe staging path: $fullStagingPath"
  }
  Remove-Item -LiteralPath $fullStagingPath -Recurse -Force

  [pscustomobject]@{
    BackupId = $backupId
    Status = if ($failedDestinations.Count -eq 0) { 'complete' } else { 'degraded' }
    SuccessfulDestinations = @($successfulDestinations)
    FailedDestinations = @($failedDestinations)
    RetentionDays = $RetentionDays
    ContainsSecrets = $true
  }
} catch {
  Write-Error $_
  exit 1
}
