[CmdletBinding()]
param(
  [string]$BackupDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'backups'),
  [string]$OutputPath,
  [ValidateRange(1, 3650)]
  [int]$RetentionDays = 14,
  [switch]$PassThru
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot '.env.local'

function Get-DotEnvValue {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Name
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw 'The local environment file required for database access was not found.'
  }
  $line = Get-Content -LiteralPath $Path |
    Where-Object { $_ -match ("^\s*" + [regex]::Escape($Name) + "\s*=") } |
    Select-Object -First 1
  if (-not $line) { return $null }
  $value = ($line -replace ("^\s*" + [regex]::Escape($Name) + "\s*=\s*"), '').Trim()
  if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  return $value
}

function Get-PostgresConnectionEnvironment {
  param([Parameter(Mandatory = $true)][string]$ConnectionString)

  try { $uri = [System.Uri]$ConnectionString } catch { throw 'DATABASE_URL is not a valid PostgreSQL connection URL.' }
  if ($uri.Scheme -notin @('postgres', 'postgresql') -or -not $uri.Host) {
    throw 'DATABASE_URL is not a valid PostgreSQL connection URL.'
  }
  $userParts = $uri.UserInfo.Split(':', 2)
  if ($userParts.Count -lt 2) { throw 'DATABASE_URL must include a username and password.' }
  $sslMode = 'require'
  $channelBinding = 'prefer'
  if ($uri.Query -match '(?:^|[?&])sslmode=([^&]+)') {
    $sslMode = [System.Uri]::UnescapeDataString($Matches[1])
  }
  if ($uri.Query -match '(?:^|[?&])channel_binding=([^&]+)') {
    $channelBinding = [System.Uri]::UnescapeDataString($Matches[1])
  }
  return [ordered]@{
    PGHOST = $uri.Host
    PGPORT = if ($uri.Port -gt 0) { [string]$uri.Port } else { '5432' }
    PGDATABASE = [System.Uri]::UnescapeDataString($uri.AbsolutePath.TrimStart('/'))
    PGUSER = [System.Uri]::UnescapeDataString($userParts[0])
    PGPASSWORD = [System.Uri]::UnescapeDataString($userParts[1])
    PGSSLMODE = $sslMode
    PGCHANNELBINDING = $channelBinding
  }
}

$databaseUrl = Get-DotEnvValue -Path $envFile -Name 'DATABASE_URL'
if (-not $databaseUrl) { throw 'DATABASE_URL is not configured.' }
$connectionEnvironment = Get-PostgresConnectionEnvironment -ConnectionString $databaseUrl

$pgDumpCommand = Get-Command pg_dump -ErrorAction SilentlyContinue
$bundledPgDump = Join-Path $projectRoot 'tools\postgresql17\bin\pg_dump.exe'
$pgDumpPath = if ($pgDumpCommand) { $pgDumpCommand.Source } elseif (Test-Path -LiteralPath $bundledPgDump) { $bundledPgDump } else { $null }
if (-not $pgDumpPath) { throw 'pg_dump is required. Install PostgreSQL client tools before running this backup.' }
$pgRestoreCommand = Get-Command pg_restore -ErrorAction SilentlyContinue
$bundledPgRestore = Join-Path $projectRoot 'tools\postgresql17\bin\pg_restore.exe'
$pgRestorePath = if ($pgRestoreCommand) { $pgRestoreCommand.Source } elseif (Test-Path -LiteralPath $bundledPgRestore) { $bundledPgRestore } else { $null }
if (-not $pgRestorePath) { throw 'pg_restore is required to verify the backup.' }

if ($OutputPath) {
  $target = [System.IO.Path]::GetFullPath($OutputPath)
  $targetDirectory = Split-Path -Parent $target
} else {
  $targetDirectory = [System.IO.Path]::GetFullPath($BackupDirectory)
  $target = Join-Path $targetDirectory ("nuviloview-{0}.dump" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
New-Item -ItemType Directory -Force $targetDirectory | Out-Null
if (Test-Path -LiteralPath $target) { throw 'The requested database backup output already exists.' }

$previousEnvironment = @{}
foreach ($name in $connectionEnvironment.Keys) {
  $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  [Environment]::SetEnvironmentVariable($name, [string]$connectionEnvironment[$name], 'Process')
}

try {
  & $pgDumpPath --format=custom --file=$target --no-owner --no-privileges --no-password
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $target -PathType Leaf)) {
    throw 'Neon backup failed.'
  }
  & $pgRestorePath --list $target | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Neon backup verification failed.' }
} catch {
  Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
  throw
} finally {
  foreach ($name in $connectionEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
  }
  $databaseUrl = $null
  $connectionEnvironment = $null
}

$file = Get-Item -LiteralPath $target
$hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
if (-not $OutputPath) {
  $safeRoot = [System.IO.Path]::GetFullPath($targetDirectory).TrimEnd('\') + '\'
  Get-ChildItem -LiteralPath $targetDirectory -Filter 'nuviloview-*.dump' -File |
    Where-Object { $_.FullName.StartsWith($safeRoot, [System.StringComparison]::OrdinalIgnoreCase) -and $_.LastWriteTime -lt (Get-Date).AddDays(-$RetentionDays) } |
    Remove-Item -Force
}
Write-Output "Database backup created and format-verified: $($file.Name)"
if ($PassThru) {
  [pscustomobject]@{
    Path = $file.FullName
    Name = $file.Name
    Length = $file.Length
    Sha256 = $hash
    CreatedAt = $file.LastWriteTime
  }
}
