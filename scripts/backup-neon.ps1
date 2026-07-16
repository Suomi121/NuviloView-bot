param(
  [string]$BackupDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'backups'),
  [int]$RetentionDays = 14
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot '.env.local'
if (-not (Test-Path $envFile)) { throw '.env.local was not found.' }
$databaseUrl = (Get-Content $envFile | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1) -replace '^DATABASE_URL=', ''
if (-not $databaseUrl) { throw 'DATABASE_URL was not found.' }
$pgDump = Get-Command pg_dump -ErrorAction SilentlyContinue
if (-not $pgDump) { throw 'pg_dump is required. Install PostgreSQL client tools before running this backup.' }

New-Item -ItemType Directory -Force $BackupDirectory | Out-Null
$target = Join-Path $BackupDirectory ("nuviloview-{0}.dump" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
& $pgDump.Source "--dbname=$databaseUrl" --format=custom --file=$target --no-owner --no-privileges
if ($LASTEXITCODE -ne 0) { throw 'Neon backup failed.' }
Get-ChildItem -LiteralPath $BackupDirectory -Filter 'nuviloview-*.dump' -File |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$RetentionDays) } |
  Remove-Item -Force
Write-Output "Backup created: $target"
