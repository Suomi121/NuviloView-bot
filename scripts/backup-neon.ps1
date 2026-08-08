[CmdletBinding()]
param(
  [string]$BackupDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'backups'),
  [ValidateRange(1, 3650)]
  [int]$RetentionDays = 14,
  [switch]$PassThru
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot '.env.local'
if (-not (Test-Path $envFile)) { throw '.env.local was not found.' }
$databaseUrl = (Get-Content $envFile | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1) -replace '^DATABASE_URL=', ''
if (-not $databaseUrl) { throw 'DATABASE_URL was not found.' }
$pgDump = Get-Command pg_dump -ErrorAction SilentlyContinue
$bundledPgDump = Join-Path $projectRoot 'tools\postgresql17\bin\pg_dump.exe'
$pgDumpPath = if ($pgDump) { $pgDump.Source } elseif (Test-Path $bundledPgDump) { $bundledPgDump } else { $null }
if (-not $pgDumpPath) { throw 'pg_dump is required. Install PostgreSQL client tools before running this backup.' }
$pgRestore = Get-Command pg_restore -ErrorAction SilentlyContinue
$bundledPgRestore = Join-Path $projectRoot 'tools\postgresql17\bin\pg_restore.exe'
$pgRestorePath = if ($pgRestore) { $pgRestore.Source } elseif (Test-Path $bundledPgRestore) { $bundledPgRestore } else { $null }
if (-not $pgRestorePath) { throw 'pg_restore is required to verify the backup.' }

New-Item -ItemType Directory -Force $BackupDirectory | Out-Null
$target = Join-Path $BackupDirectory ("nuviloview-{0}.dump" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
& $pgDumpPath "--dbname=$databaseUrl" --format=custom --file=$target --no-owner --no-privileges
if ($LASTEXITCODE -ne 0) { throw 'Neon backup failed.' }
& $pgRestorePath --list $target | Out-Null
if ($LASTEXITCODE -ne 0) {
  Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
  throw 'Neon backup verification failed.'
}
$file = Get-Item -LiteralPath $target
$hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
Get-ChildItem -LiteralPath $BackupDirectory -Filter 'nuviloview-*.dump' -File |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$RetentionDays) } |
  Remove-Item -Force
Write-Output "Backup created and verified: $target"
if ($PassThru) {
  [pscustomobject]@{
    Path = $file.FullName
    Name = $file.Name
    Length = $file.Length
    Sha256 = $hash
    CreatedAt = $file.LastWriteTime
  }
}
