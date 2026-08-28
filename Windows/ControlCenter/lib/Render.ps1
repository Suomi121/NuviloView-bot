function Get-NvAnsi {
  param([string]$Code, [bool]$Enabled)
  if (-not $Enabled) { return '' }
  return "$([char]27)[$Code" + 'm'
}

function Get-NvStateColorCode {
  param([string]$State)
  switch ($State.ToUpperInvariant()) {
    'HEALTHY' { return '38;2;126;255;190' }
    'RUNNING' { return '38;2;126;255;190' }
    'CONNECTED' { return '38;2;126;255;190' }
    'CLOSED' { return '38;2;126;255;190' }
    'OPTIONAL' { return '38;2;205;170;255' }
    'DISABLED' { return '38;2;155;155;170' }
    'DEGRADED' { return '38;2;255;105;180' }
    'STALE' { return '38;2;255;105;180' }
    'HALF_OPEN' { return '38;2;255;105;180' }
    'CRITICAL' { return '38;2;255;65;85' }
    'OFFLINE' { return '38;2;255;65;85' }
    'OPEN' { return '38;2;255;65;85' }
    default { return '38;2;175;175;190' }
  }
}

function Add-NvColor {
  param([string]$Text, [string]$Code, [bool]$Enabled)
  if (-not $Enabled) { return $Text }
  return "$(Get-NvAnsi $Code $true)$Text$(Get-NvAnsi '0' $true)"
}

function Format-NvState {
  param([string]$State, [bool]$ColorEnabled)
  $safeState = if ([string]::IsNullOrWhiteSpace($State)) { 'UNKNOWN' } else { $State.ToUpperInvariant() }
  $bullet = [char]0x25CF
  return Add-NvColor "$bullet $safeState" (Get-NvStateColorCode $safeState) $ColorEnabled
}

function Format-NvBytes {
  param($Bytes)
  $value = ConvertTo-NvNullableDouble $Bytes
  if ($null -eq $value) { return 'N/A' }
  $units = @('B', 'KiB', 'MiB', 'GiB', 'TiB')
  $index = 0
  while ($value -ge 1024 -and $index -lt $units.Count - 1) {
    $value /= 1024
    $index++
  }
  if ($index -eq 0) { return "{0:N0} {1}" -f $value, $units[$index] }
  return "{0:N2} {1}" -f $value, $units[$index]
}

function Format-NvTimestamp {
  param($Milliseconds)
  $value = ConvertTo-NvNullableInt64 $Milliseconds
  if ($null -eq $value) { return 'Never' }
  try {
    return [DateTimeOffset]::FromUnixTimeMilliseconds($value).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss')
  } catch {
    return 'Invalid'
  }
}

function Format-NvUsageBar {
  param(
    $Current,
    $Maximum,
    [int]$Width,
    [bool]$ColorEnabled,
    [bool]$GoodWhenHigh = $false
  )
  $percent = Get-NvPercent $Current $Maximum
  $shade = [char]0x2591
  $block = [char]0x2588
  if ($null -eq $percent) {
    return "[$(''.PadLeft($Width, $shade))] N/A"
  }
  $filled = [int][math]::Round($Width * $percent / 100)
  $filled = [math]::Min($Width, [math]::Max(0, $filled))
  $empty = $Width - $filled
  $riskPercent = if ($GoodWhenHigh) { 100 - $percent } else { $percent }
  $code = if ($riskPercent -ge 90) {
    '38;2;255;55;75'
  } elseif ($riskPercent -ge 70) {
    '38;2;255;0;153'
  } else { '38;2;255;170;205' }
  $bar = "$(''.PadLeft($filled, $block))$(''.PadLeft($empty, $shade))"
  return "[$(Add-NvColor $bar $code $ColorEnabled)] $($percent.ToString('0.0'))%"
}

function Get-NvTerminalWidth {
  try {
    $width = [Console]::WindowWidth
    if ($width -lt 60) { return 60 }
    if ($width -gt 140) { return 140 }
    return $width
  } catch { return 100 }
}

function Format-NvControlCenter {
  param(
    [Parameter(Mandatory = $true)]$Snapshot,
    [switch]$NoColor
  )

  $colorEnabled = -not $NoColor -and [string]::IsNullOrWhiteSpace($env:NO_COLOR) -and -not [Console]::IsOutputRedirected
  $width = Get-NvTerminalWidth
  $compact = $width -lt 88
  $barWidth = if ($compact) { 12 } else { 20 }
  $lineWidth = [math]::Max(58, $width - 2)
  $lines = New-Object System.Collections.Generic.List[string]
  $magenta = '38;2;255;0;153'
  $pink = '38;2;255;130;190'
  $dim = '38;2;155;155;175'
  $topLeft = [char]0x256D
  $topRight = [char]0x256E
  $bottomLeft = [char]0x2570
  $bottomRight = [char]0x256F
  $sectionCorner = [char]0x250C
  $horizontal = [char]0x2500
  $vertical = [char]0x2502

  $title = ' NuviloView Control Center '
  $titleFill = [math]::Max(0, $lineWidth - $title.Length - 2)
  $lines.Add((Add-NvColor ("$topLeft$horizontal$title$(''.PadLeft($titleFill, $horizontal))$topRight") $magenta $colorEnabled))
  $lines.Add("$vertical v$($Snapshot.controlCenterVersion)  Host: $($Snapshot.hostname)  Overall: $(Format-NvState $Snapshot.overall $colorEnabled)")
  $lines.Add("$vertical Time: $([DateTimeOffset]::Now.ToString('yyyy-MM-dd HH:mm:ss zzz'))  Last refresh: $($Snapshot.generatedAt)")
  $lines.Add((Add-NvColor ("$bottomLeft$(''.PadLeft(($lineWidth - 1), $horizontal))$bottomRight") $magenta $colorEnabled))

  $lines.Add('')
  $lines.Add((Add-NvColor "$sectionCorner$horizontal Runtime Overview" $pink $colorEnabled))
  $lines.Add("$vertical Bot      $(Format-NvState $Snapshot.runtime.bot $colorEnabled)    Worker  $(Format-NvState $Snapshot.runtime.worker $colorEnabled)")
  $lines.Add("$vertical Discord  $(Format-NvState $Snapshot.runtime.discord $colorEnabled)    SQLite  $(Format-NvState $Snapshot.runtime.sqlite $colorEnabled)")
  $cloudText = if ($Snapshot.runtime.cloudComplete.total -gt 0) {
    "$($Snapshot.runtime.cloudComplete.complete) / $($Snapshot.runtime.cloudComplete.total) ($($Snapshot.runtime.cloudComplete.percent)%)"
  } else { 'N/A' }
  $guildText = if ($null -eq $Snapshot.runtime.guildCount) { 'N/A' } else { $Snapshot.runtime.guildCount }
  $lines.Add("$vertical Cloud Complete: $cloudText    Mode: $($Snapshot.runtime.mode)    Guilds: $guildText")

  $lines.Add('')
  $lines.Add((Add-NvColor "$sectionCorner$horizontal Provider Status" $pink $colorEnabled))
  foreach ($provider in $Snapshot.providers) {
    $name = $provider.id.Substring(0, 1).ToUpperInvariant() + $provider.id.Substring(1)
    $lines.Add("$vertical $($name.PadRight(9)) $(Format-NvState $provider.state $colorEnabled)  Health $(Format-NvState $provider.health $colorEnabled)  Circuit $(Format-NvState $provider.circuit $colorEnabled)")
    $writesToday = if ($null -eq $provider.writesToday) { 'N/A' } else { $provider.writesToday }
    $readsToday = if ($null -eq $provider.readsToday) { 'N/A' } else { $provider.readsToday }
    $lines.Add("$vertical   Last OK: $(Format-NvTimestamp $provider.lastSuccessAt)  Last failure: $(Format-NvTimestamp $provider.lastFailureAt)")
    $writesTotal = if ($null -eq $provider.writesTotal) { 'N/A' } else { $provider.writesTotal }
    $queriesTotal = if ($null -eq $provider.queriesTotal) { 'N/A' } else { $provider.queriesTotal }
    $lines.Add("$vertical   Today W/R: $writesToday / $readsToday  Total writes/queries: $writesTotal / $queriesTotal")
  }

  $lines.Add('')
  $lines.Add((Add-NvColor "$sectionCorner$horizontal Queue / Sync" $pink $colorEnabled))
  $lines.Add("$vertical Pending $($Snapshot.queue.pending)  Retry $($Snapshot.queue.retry)  Processing $($Snapshot.queue.processing)  DLQ $($Snapshot.queue.deadLetter)")
  $batchText = if ($null -eq $Snapshot.queue.currentBatchSize) { 'N/A (snapshot does not expose it)' } else { $Snapshot.queue.currentBatchSize }
  $lines.Add("$vertical Batch: $batchText  Activity: $($Snapshot.queue.activity)")
  $lines.Add("$vertical Last complete sync: $(Format-NvTimestamp $Snapshot.queue.lastSuccessfulSync)")
  $lines.Add("$vertical Last failure:       $(Format-NvTimestamp $Snapshot.queue.lastFailedSync)")

  $lines.Add('')
  $lines.Add((Add-NvColor "$sectionCorner$horizontal Usage / Quota" $pink $colorEnabled))
  $sqliteBar = Format-NvUsageBar $Snapshot.usage.sqlite.totalBytes $Snapshot.usage.sqlite.softBudgetBytes $barWidth $colorEnabled
  $lines.Add("$vertical SQLite Storage  $sqliteBar  $(Format-NvBytes $Snapshot.usage.sqlite.totalBytes) / $(Format-NvBytes $Snapshot.usage.sqlite.softBudgetBytes) soft budget")
  $lines.Add("$vertical SQLite remaining: $(Format-NvBytes $Snapshot.usage.sqlite.remainingBytes)")
  $lines.Add("$vertical SQLite DB: $(Format-NvBytes $Snapshot.usage.sqlite.databaseBytes)  WAL: $(Format-NvBytes $Snapshot.usage.sqlite.walBytes)")
  if ($null -ne $Snapshot.usage.disk) {
    $diskBar = Format-NvUsageBar $Snapshot.usage.disk.freeBytes $Snapshot.usage.disk.totalBytes $barWidth $colorEnabled $true
    $lines.Add("$vertical Free Disk       $diskBar  $(Format-NvBytes $Snapshot.usage.disk.freeBytes) / $(Format-NvBytes $Snapshot.usage.disk.totalBytes)")
  } else {
    $lines.Add("$vertical Free Disk       $(Format-NvUsageBar $null $null $barWidth $colorEnabled)  unavailable for snapshot path")
  }
  $queueBar = Format-NvUsageBar $Snapshot.queue.current $Snapshot.queue.capacity $barWidth $colorEnabled
  $lines.Add("$vertical Queue Capacity  $queueBar  $($Snapshot.queue.current) / $($Snapshot.queue.capacity)  Remaining: $($Snapshot.queue.remaining)")
  foreach ($providerId in @('supabase', 'turso')) {
    $usage = $Snapshot.usage.providers[$providerId]
    $label = $providerId.Substring(0, 1).ToUpperInvariant() + $providerId.Substring(1)
    $bar = Format-NvUsageBar $usage.writesToday $usage.dailyWriteBudget $barWidth $colorEnabled
    $currentMax = if ($usage.available) {
      "$($usage.writesToday) / $($usage.dailyWriteBudget)"
    } else { 'N/A (not exposed by snapshot)' }
    $lines.Add("$vertical $($label.PadRight(9)) Daily Writes $bar  current/max: $currentMax")
  }

  $lines.Add('')
  $lines.Add((Add-NvColor "$sectionCorner$horizontal Current Activity" $pink $colorEnabled))
  $lines.Add("$vertical $($Snapshot.queue.activity)")

  $lines.Add('')
  $lines.Add((Add-NvColor "$sectionCorner$horizontal Analytics Summary (worker session)" $pink $colorEnabled))
  $ratio = if ($null -eq $Snapshot.analytics.reductionRatio) { 'N/A' } else { "$($Snapshot.analytics.reductionRatio)%" }
  $lines.Add("$vertical Raw events: $($Snapshot.analytics.rawEventsSeen)  Cloud writes: $($Snapshot.analytics.cloudWrites)  Reduction: $ratio")
  $lines.Add("$vertical Projections updated: $($Snapshot.analytics.projectionsUpdated)  Skipped by checksum: $($Snapshot.analytics.skippedByChecksum)")

  if ($Snapshot.warnings.Count -gt 0) {
    $lines.Add('')
    $lines.Add((Add-NvColor "$sectionCorner$horizontal Data Warnings" '38;2;255;65;85' $colorEnabled))
    foreach ($warning in @($Snapshot.warnings | Select-Object -First 5)) {
      $lines.Add("$vertical $warning")
    }
  }
  $lines.Add('')
  $lines.Add((Add-NvColor 'Read-only dashboard | no cloud polling | Ctrl+C to exit watch mode' $dim $colorEnabled))
  return $lines -join [Environment]::NewLine
}

function Write-NvDashboard {
  param(
    [Parameter(Mandatory = $true)][string]$Text,
    [int]$RefreshIndex,
    [switch]$Watch
  )
  if ($Watch -and -not [Console]::IsOutputRedirected) {
    $prefix = if ($RefreshIndex -eq 0) { "$([char]27)[2J$([char]27)[H" } else { "$([char]27)[H" }
    [Console]::Write("$prefix$Text$([char]27)[J")
    return
  }
  if ($Watch -and $RefreshIndex -gt 0) { [Console]::WriteLine('--- refresh ---') }
  [Console]::WriteLine($Text)
}
