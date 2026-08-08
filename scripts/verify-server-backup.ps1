[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BackupPath
)

$ErrorActionPreference = 'Stop'

$resolvedBackup = (Resolve-Path -LiteralPath $BackupPath).Path
if (-not (Test-Path -LiteralPath $resolvedBackup -PathType Container)) {
  throw "Backup directory was not found: $BackupPath"
}

$manifestPath = Join-Path $resolvedBackup 'manifest.json'
$checksumPath = Join-Path $resolvedBackup 'SHA256SUMS.txt'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw 'manifest.json is missing.'
}
if (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) {
  throw 'SHA256SUMS.txt is missing.'
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1 -or -not $manifest.backupId) {
  throw 'Backup manifest is invalid or unsupported.'
}

$rootPrefix = $resolvedBackup.TrimEnd('\') + '\'
$verifiedFiles = 0
foreach ($line in Get-Content -LiteralPath $checksumPath) {
  if ($line -notmatch '^([0-9a-fA-F]{64}) \*(.+)$') {
    throw "Invalid checksum entry: $line"
  }
  $expectedHash = $Matches[1].ToLowerInvariant()
  $relativeName = $Matches[2]
  $candidate = [System.IO.Path]::GetFullPath((Join-Path $resolvedBackup $relativeName))
  if (-not $candidate.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Checksum entry escapes the backup directory: $relativeName"
  }
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
    throw "Backup file is missing: $relativeName"
  }
  $actualHash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) {
    throw "Checksum mismatch: $relativeName"
  }
  $verifiedFiles += 1
}

$archive = Get-ChildItem -LiteralPath $resolvedBackup -Filter 'nuviloview-server-files-*.tar.gz' -File
if (@($archive).Count -ne 1) {
  throw 'Exactly one server file archive is required.'
}
$tarPath = (Get-Command tar.exe -ErrorAction Stop).Source
$archiveEntries = @(& $tarPath -tzf $archive.FullName)
if ($LASTEXITCODE -ne 0) {
  throw 'Server file archive could not be read.'
}
foreach ($requiredEntry in @('./discord-bot.mjs', './.env.local', './scripts/run-bot-forever.ps1')) {
  if ($archiveEntries -notcontains $requiredEntry) {
    throw "Server file archive is missing: $requiredEntry"
  }
}

$databaseDump = Get-ChildItem -LiteralPath $resolvedBackup -Filter 'nuviloview-*.dump' -File
if (@($databaseDump).Count -ne 1) {
  throw 'Exactly one Neon database dump is required.'
}
$projectRoot = Split-Path -Parent $PSScriptRoot
$pgRestoreCommand = Get-Command pg_restore -ErrorAction SilentlyContinue
$bundledPgRestore = Join-Path $projectRoot 'tools\postgresql17\bin\pg_restore.exe'
$pgRestorePath =
  if ($pgRestoreCommand) { $pgRestoreCommand.Source }
  elseif (Test-Path -LiteralPath $bundledPgRestore) { $bundledPgRestore }
  else { $null }
if (-not $pgRestorePath) {
  throw 'pg_restore is required to verify the Neon database dump.'
}
& $pgRestorePath --list $databaseDump.FullName | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw 'Neon database dump could not be read by pg_restore.'
}

[pscustomobject]@{
  BackupId = $manifest.backupId
  BackupPath = $resolvedBackup
  VerifiedFiles = $verifiedFiles
  ArchiveEntries = $archiveEntries.Count
  DatabaseBytes = $databaseDump.Length
  VerifiedAt = (Get-Date).ToString('o')
  Status = 'verified'
}
