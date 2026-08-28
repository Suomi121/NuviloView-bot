function Get-NvMemberValue {
  param(
    $InputObject,
    [Parameter(Mandatory = $true)][string]$Name,
    $Default = $null
  )

  if ($null -eq $InputObject) { return $Default }
  if ($InputObject -is [System.Collections.IDictionary]) {
    if ($InputObject.Contains($Name)) { return $InputObject[$Name] }
    return $Default
  }
  $property = $InputObject.PSObject.Properties[$Name]
  if ($null -eq $property) { return $Default }
  if ($null -eq $property.Value) { return $Default }
  return $property.Value
}

function ConvertTo-NvNullableInt64 {
  param($Value)
  if ($null -eq $Value -or ($Value -is [string] -and $Value.Length -eq 0)) { return $null }
  $number = 0L
  if ([long]::TryParse($Value.ToString(), [ref]$number)) { return $number }
  return $null
}

function ConvertTo-NvNullableDouble {
  param($Value)
  if ($null -eq $Value -or ($Value -is [string] -and $Value.Length -eq 0)) { return $null }
  $number = 0.0
  if ([double]::TryParse(
    $Value.ToString(),
    [Globalization.NumberStyles]::Float,
    [Globalization.CultureInfo]::InvariantCulture,
    [ref]$number
  )) { return $number }
  return $null
}

function Get-NvNowMilliseconds {
  return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

function Read-NvJsonSnapshot {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [int64]$MaximumBytes = 2097152
  )

  $result = [ordered]@{
    path = $Path
    found = $false
    valid = $false
    data = $null
    length = $null
    lastWriteAt = $null
    error = $null
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    $result.error = 'missing'
    return $result
  }

  try {
    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
    $result.found = $true
    $result.length = [int64]$item.Length
    $result.lastWriteAt = [DateTimeOffset]$item.LastWriteTimeUtc
    if ($item.Length -gt $MaximumBytes) {
      $result.error = 'too_large'
      return $result
    }
    $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
    $result.data = $raw | ConvertFrom-Json -ErrorAction Stop
    $result.valid = $true
  } catch {
    $result.error = 'invalid_json'
  }
  return $result
}

function Read-NvAllowedEnvironment {
  param([Parameter(Mandatory = $true)][string]$ProjectRoot)

  $allowed = @{
    'SYNC_METRICS_PATH' = $true
    'NUVILOVIEW_RUNTIME_STATUS_PATH' = $true
    'LOCAL_STORAGE_PATH' = $true
    'SYNC_WORKER_ENABLED' = $true
    'MULTI_DB_SYNC_ENABLED' = $true
    'SYNC_PROVIDER_BATCH_MIN' = $true
    'SYNC_PROVIDER_BATCH_MAX' = $true
    'NUVILOCTL_STALE_AFTER_SECONDS' = $true
    'NUVILOCTL_SQLITE_BUDGET_BYTES' = $true
    'NUVILOCTL_QUEUE_CAPACITY' = $true
    'NUVILOCTL_SUPABASE_DAILY_WRITE_BUDGET' = $true
    'NUVILOCTL_TURSO_DAILY_WRITE_BUDGET' = $true
  }
  $values = @{}
  foreach ($name in @('.env.local', '.env')) {
    $path = Join-Path $ProjectRoot $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
    foreach ($line in Get-Content -LiteralPath $path -ErrorAction SilentlyContinue) {
      if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') { continue }
      $key = $Matches[1]
      if (-not $allowed.ContainsKey($key) -or $values.ContainsKey($key)) { continue }
      $value = $Matches[2].Trim()
      if (
        $value.Length -ge 2 -and
        (($value.StartsWith('"') -and $value.EndsWith('"')) -or
          ($value.StartsWith("'") -and $value.EndsWith("'")))
      ) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      $values[$key] = $value
    }
  }
  return $values
}

function Resolve-NvProjectPath {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [string]$ConfiguredPath,
    [Parameter(Mandatory = $true)][string]$Fallback
  )

  $candidate = if ([string]::IsNullOrWhiteSpace($ConfiguredPath)) { $Fallback } else { $ConfiguredPath }
  if ([System.IO.Path]::IsPathRooted($candidate)) { return $candidate }
  $candidate = $candidate -replace '^[.][\\/]', ''
  return [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $candidate))
}

function Test-NvBooleanText {
  param([string]$Value, [bool]$Default = $false)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $Default }
  return @('1', 'true', 'yes', 'on', 'enabled') -contains $Value.Trim().ToLowerInvariant()
}

function Test-NvPidFileProcess {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  try {
    $raw = Get-Content -LiteralPath $Path -TotalCount 1 -ErrorAction Stop
    $processId = 0
    if (-not [int]::TryParse($raw, [ref]$processId) -or $processId -le 0) { return $false }
    return $null -ne (Get-Process -Id $processId -ErrorAction SilentlyContinue)
  } catch {
    return $false
  }
}

function Get-NvSnapshotFreshness {
  param(
    $Snapshot,
    [string[]]$TimestampFields,
    [int]$StaleAfterSeconds,
    [int64]$NowMilliseconds
  )

  if (-not $Snapshot.valid) {
    return [ordered]@{ fresh = $false; ageSeconds = $null; timestamp = $null }
  }
  $timestamp = $null
  foreach ($field in $TimestampFields) {
    $candidate = ConvertTo-NvNullableInt64 (Get-NvMemberValue $Snapshot.data $field)
    if ($null -ne $candidate) { $timestamp = $candidate; break }
  }
  if ($null -eq $timestamp -and $null -ne $Snapshot.lastWriteAt) {
    $timestamp = ([DateTimeOffset]$Snapshot.lastWriteAt).ToUnixTimeMilliseconds()
  }
  if ($null -eq $timestamp) {
    return [ordered]@{ fresh = $false; ageSeconds = $null; timestamp = $null }
  }
  $age = [math]::Max(0, ($NowMilliseconds - $timestamp) / 1000.0)
  return [ordered]@{
    fresh = $age -le $StaleAfterSeconds
    ageSeconds = [math]::Round($age, 1)
    timestamp = $timestamp
  }
}

function Get-NvDriveUsage {
  param([Parameter(Mandatory = $true)][string]$Path)

  try {
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $root = [System.IO.Path]::GetPathRoot($fullPath)
    if ([string]::IsNullOrWhiteSpace($root)) { return $null }
    $drive = New-Object System.IO.DriveInfo($root)
    if (-not $drive.IsReady) { return $null }
    return [ordered]@{
      totalBytes = [int64]$drive.TotalSize
      freeBytes = [int64]$drive.AvailableFreeSpace
      usedBytes = [int64]($drive.TotalSize - $drive.AvailableFreeSpace)
    }
  } catch {
    return $null
  }
}
