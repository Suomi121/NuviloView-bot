[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BackupPath
)

$ErrorActionPreference = 'Stop'

function Assert-SafeArchiveEntries {
  param([Parameter(Mandatory = $true)][string[]]$Entries)

  $excludedDirectories = @('.git', '.next', '.cache', '.vercel', 'backups', 'coverage', 'credentials', 'logs', 'node_modules', 'output', 'secrets', 'temp', 'tmp', 'tokens')
  $publicTemplates = @('.env.example', '.env.sample', '.env.template')
  foreach ($entry in $Entries) {
    $rawEntry = $entry.Replace('\', '/')
    if ($rawEntry.StartsWith('/') -or $rawEntry -match '(?:^|/)\.\.(?:/|$)') {
      throw 'Archive contains a path traversal entry.'
    }
    $normalized = $rawEntry -replace '^(?:\./)+', ''
    if (-not $normalized) { continue }
    $segments = @($normalized.Split('/') | Where-Object { $_ })
    $lowerSegments = @($segments | ForEach-Object { $_.ToLowerInvariant() })
    $baseName = if ($lowerSegments.Count) { $lowerSegments[-1] } else { '' }
    if (@($lowerSegments | Where-Object { $_ -in $excludedDirectories }).Count -gt 0) {
      throw "Archive contains an excluded directory entry: $normalized"
    }
    if ($baseName -eq '.env' -or ($baseName.StartsWith('.env.') -and $baseName -notin $publicTemplates)) {
      throw "Archive contains a private environment file: $normalized"
    }
    if ($baseName -match '\.(?:pem|key|pfx|p12)$' -or $baseName -in @('credentials.json', 'tokens.json', 'secrets.json', 'token-cache.json')) {
      throw "Archive contains secret-like key material: $normalized"
    }
  }
}

function Invoke-GpgDecrypt {
  param(
    [Parameter(Mandatory = $true)][string]$InputPath,
    [Parameter(Mandatory = $true)][string]$OutputPath
  )

  $passphrase = [Environment]::GetEnvironmentVariable('NUVILOVIEW_BACKUP_ENCRYPTION_PASSPHRASE', 'Process')
  if (-not $passphrase) { throw 'Encrypted backup verification requires NUVILOVIEW_BACKUP_ENCRYPTION_PASSPHRASE.' }
  $gpgCommand = Get-Command gpg.exe -ErrorAction SilentlyContinue
  if (-not $gpgCommand) { $gpgCommand = Get-Command gpg -ErrorAction SilentlyContinue }
  if (-not $gpgCommand) { throw 'gpg is required to verify an encrypted backup.' }
  if ($InputPath.Contains('"') -or $OutputPath.Contains('"')) { throw 'Unsupported quote character in backup path.' }

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $gpgCommand.Source
  $startInfo.Arguments = "--batch --yes --pinentry-mode loopback --passphrase-fd 0 --decrypt --output `"$OutputPath`" `"$InputPath`""
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
      throw 'Encrypted backup decryption failed during verification.'
    }
  } finally {
    $passphrase = $null
    $process.Dispose()
  }
}

$resolvedBackup = (Resolve-Path -LiteralPath $BackupPath).Path
if (-not (Test-Path -LiteralPath $resolvedBackup -PathType Container)) {
  throw "Backup directory was not found: $BackupPath"
}

$manifestPath = Join-Path $resolvedBackup 'manifest.json'
$checksumPath = Join-Path $resolvedBackup 'SHA256SUMS.txt'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'manifest.json is missing.' }
if (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) { throw 'SHA256SUMS.txt is missing.' }

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 2 -or $manifest.backupId -notmatch '^\d{8}-\d{6}-[a-f0-9]{8}$') {
  throw 'Backup manifest is invalid or unsupported.'
}
if ($manifest.containsSecrets -ne $false -or $manifest.secretScan.passed -ne $true) {
  throw 'Backup manifest does not prove that secret screening passed.'
}
if ($manifest.status -notin @('verification_pending', 'verified', 'complete', 'degraded')) {
  throw 'Backup manifest status is not restorable.'
}

$rootPrefix = $resolvedBackup.TrimEnd('\') + '\'
$verifiedFiles = 0
foreach ($line in Get-Content -LiteralPath $checksumPath) {
  if ($line -notmatch '^([0-9a-fA-F]{64}) \*(.+)$') { throw 'Invalid checksum entry.' }
  $expectedHash = $Matches[1].ToLowerInvariant()
  $relativeName = $Matches[2]
  if ($relativeName.Contains('/') -or $relativeName.Contains('\')) { throw 'Checksum entries must reference top-level files only.' }
  $candidate = [System.IO.Path]::GetFullPath((Join-Path $resolvedBackup $relativeName))
  if (-not $candidate.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Checksum entry escapes the backup directory.'
  }
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "Backup file is missing: $relativeName" }
  $actualHash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) { throw "Checksum mismatch: $relativeName" }
  $verifiedFiles += 1
}

$sourceRecord = @($manifest.files | Where-Object { $_.type -eq 'server-source' })
$databaseRecord = @($manifest.files | Where-Object { $_.type -eq 'postgresql-custom-dump' })
if ($sourceRecord.Count -ne 1 -or $databaseRecord.Count -ne 1) {
  throw 'Manifest must contain exactly one source archive and one database dump.'
}
foreach ($record in @($sourceRecord[0], $databaseRecord[0])) {
  if (-not $record.name -or $record.name.Contains('/') -or $record.name.Contains('\') -or $record.name.Contains('..')) {
    throw 'Manifest artifact names must be safe top-level file names.'
  }
}

$verificationRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("nuviloview-backup-verify-" + [guid]::NewGuid().ToString('N'))
$extractPath = Join-Path $verificationRoot 'source'
New-Item -ItemType Directory -Path $extractPath -Force | Out-Null
try {
  $sourcePath = Join-Path $resolvedBackup $sourceRecord[0].name
  $databasePath = Join-Path $resolvedBackup $databaseRecord[0].name
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf) -or -not (Test-Path -LiteralPath $databasePath -PathType Leaf)) {
    throw 'A manifest artifact is missing.'
  }
  if ($manifest.encrypted -eq $true) {
    $decryptedSource = Join-Path $verificationRoot 'source.tar.gz'
    $decryptedDatabase = Join-Path $verificationRoot 'database.dump'
    Invoke-GpgDecrypt -InputPath $sourcePath -OutputPath $decryptedSource
    Invoke-GpgDecrypt -InputPath $databasePath -OutputPath $decryptedDatabase
    $sourcePath = $decryptedSource
    $databasePath = $decryptedDatabase
  }

  $tarPath = (Get-Command tar.exe -ErrorAction SilentlyContinue).Source
  if (-not $tarPath) { $tarPath = (Get-Command tar -ErrorAction Stop).Source }
  $archiveEntries = @(& $tarPath -tzf $sourcePath)
  if ($LASTEXITCODE -ne 0) { throw 'Server source archive could not be listed.' }
  Assert-SafeArchiveEntries -Entries $archiveEntries
  & $tarPath -xzf $sourcePath -C $extractPath
  if ($LASTEXITCODE -ne 0) { throw 'Server source archive extraction validation failed.' }
  foreach ($requiredFile in @('discord-bot.mjs', 'package.json', 'scripts\run-bot-forever.ps1')) {
    if (-not (Test-Path -LiteralPath (Join-Path $extractPath $requiredFile) -PathType Leaf)) {
      throw "Server source archive is missing a required public file: $requiredFile"
    }
  }

  $projectRoot = Split-Path -Parent $PSScriptRoot
  $pgRestoreCommand = Get-Command pg_restore -ErrorAction SilentlyContinue
  $bundledPgRestore = Join-Path $projectRoot 'tools\postgresql17\bin\pg_restore.exe'
  $pgRestorePath = if ($pgRestoreCommand) { $pgRestoreCommand.Source } elseif (Test-Path -LiteralPath $bundledPgRestore) { $bundledPgRestore } else { $null }
  if (-not $pgRestorePath) { throw 'pg_restore is required to verify the database dump.' }
  & $pgRestorePath --list $databasePath | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Database dump could not be read by pg_restore.' }
} finally {
  $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  $fullVerificationRoot = [System.IO.Path]::GetFullPath($verificationRoot)
  if ($fullVerificationRoot.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and $fullVerificationRoot -match 'nuviloview-backup-verify-[a-f0-9]{32}$') {
    Remove-Item -LiteralPath $fullVerificationRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

[pscustomobject]@{
  BackupId = $manifest.backupId
  BackupPath = $resolvedBackup
  VerifiedFiles = $verifiedFiles
  ArchiveEntries = $archiveEntries.Count
  DatabaseBytes = (Get-Item -LiteralPath (Join-Path $resolvedBackup $databaseRecord[0].name)).Length
  Encrypted = [bool]$manifest.encrypted
  RestoreVerified = $true
  VerifiedAt = (Get-Date).ToString('o')
  Status = 'verified'
}
