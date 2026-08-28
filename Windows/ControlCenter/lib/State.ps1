function Get-NvMaximumValue {
  param([object[]]$Values)
  $numbers = @($Values | Where-Object { $null -ne $_ } | ForEach-Object { [int64]$_ })
  if ($numbers.Count -eq 0) { return 0L }
  return [int64](($numbers | Measure-Object -Maximum).Maximum)
}

function Get-NvTimestampBoundary {
  param([object[]]$Values, [ValidateSet('Minimum', 'Maximum')][string]$Mode)
  $numbers = @($Values | Where-Object { $null -ne $_ } | ForEach-Object { [int64]$_ })
  if ($numbers.Count -eq 0) { return $null }
  $measure = $numbers | Measure-Object -Minimum -Maximum
  if ($Mode -eq 'Minimum') { return [int64]$measure.Minimum }
  return [int64]$measure.Maximum
}

function Get-NvPercent {
  param($Current, $Maximum)
  $currentNumber = ConvertTo-NvNullableDouble $Current
  $maximumNumber = ConvertTo-NvNullableDouble $Maximum
  if ($null -eq $currentNumber -or $null -eq $maximumNumber -or $maximumNumber -le 0) {
    return $null
  }
  return [math]::Round([math]::Min(100, [math]::Max(0, 100 * $currentNumber / $maximumNumber)), 1)
}

function New-NvProviderStatus {
  param(
    [Parameter(Mandatory = $true)][string]$ProviderId,
    $ProviderData,
    $RuntimeData
  )

  $available = $null -ne $ProviderData
  $required = if ($available) { [bool](Get-NvMemberValue $ProviderData 'required' $false) } else { $false }
  $enabled = if ($available) { [bool](Get-NvMemberValue $ProviderData 'enabled' $false) } else { $false }
  $health = if ($available) {
    (Get-NvMemberValue $ProviderData 'healthStatus' 'OFFLINE').ToString().ToUpperInvariant()
  } else { 'OFFLINE' }
  $state = if (-not $available) {
    'OFFLINE'
  } elseif (-not $enabled -and -not $required) {
    'OPTIONAL'
  } elseif (-not $enabled) {
    'DISABLED'
  } else {
    $health
  }

  $lastSuccess = ConvertTo-NvNullableInt64 (Get-NvMemberValue $ProviderData 'lastSuccessAt')
  $lastFailure = ConvertTo-NvNullableInt64 (Get-NvMemberValue $ProviderData 'lastFailureAt')
  $circuit = (Get-NvMemberValue $ProviderData 'circuitState' 'UNKNOWN').ToString().ToUpperInvariant()

  if ($ProviderId -eq 'neon' -and $null -ne $RuntimeData) {
    $runtimeNeon = (Get-NvMemberValue $RuntimeData 'neon' '').ToString().ToUpperInvariant()
    if (-not [string]::IsNullOrWhiteSpace($runtimeNeon)) { $health = $runtimeNeon }
    if ($null -eq $lastSuccess) {
      $lastSuccess = ConvertTo-NvNullableInt64 (Get-NvMemberValue $RuntimeData 'lastSuccessfulQueryAt')
    }
    if ($null -eq $lastFailure) {
      $lastFailure = ConvertTo-NvNullableInt64 (Get-NvMemberValue $RuntimeData 'lastFailureAt')
    }
  }

  return [ordered]@{
    id = $ProviderId
    state = $state
    health = $health
    required = $required
    enabled = $enabled
    circuit = $circuit
    pending = [int64](Get-NvMemberValue $ProviderData 'pending' 0)
    retry = [int64](Get-NvMemberValue $ProviderData 'retry' 0)
    processing = [int64](Get-NvMemberValue $ProviderData 'processing' 0)
    deadLetter = [int64](Get-NvMemberValue $ProviderData 'deadLetter' 0)
    lastSuccessAt = $lastSuccess
    lastFailureAt = $lastFailure
    writesToday = $null
    readsToday = $null
    writesTotal = ConvertTo-NvNullableInt64 (Get-NvMemberValue $ProviderData 'syncedTotal')
    queriesTotal = ConvertTo-NvNullableInt64 (Get-NvMemberValue $ProviderData 'queryCount')
  }
}

function Get-NvControlCenterStatus {
  param([Parameter(Mandatory = $true)][string]$ProjectRoot)

  $projectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
  $environment = Read-NvAllowedEnvironment -ProjectRoot $projectRoot
  $nowMs = Get-NvNowMilliseconds
  $staleAfter = ConvertTo-NvNullableInt64 $environment['NUVILOCTL_STALE_AFTER_SECONDS']
  if ($null -eq $staleAfter -or $staleAfter -lt 15) { $staleAfter = 120 }

  $syncPath = Resolve-NvProjectPath -ProjectRoot $projectRoot `
    -ConfiguredPath $environment['SYNC_METRICS_PATH'] `
    -Fallback 'data\runtime\sync-worker-health.json'
  $runtimePath = Resolve-NvProjectPath -ProjectRoot $projectRoot `
    -ConfiguredPath $environment['NUVILOVIEW_RUNTIME_STATUS_PATH'] `
    -Fallback 'data\runtime\neon-runtime-health.json'
  $storagePath = Join-Path $projectRoot 'Android\runtime\storage-health.json'

  $syncSnapshot = Read-NvJsonSnapshot -Path $syncPath
  $runtimeSnapshot = Read-NvJsonSnapshot -Path $runtimePath
  $storageSnapshot = Read-NvJsonSnapshot -Path $storagePath
  $syncFreshness = Get-NvSnapshotFreshness $syncSnapshot @('generatedAt', 'updatedAt') $staleAfter $nowMs
  $runtimeFreshness = Get-NvSnapshotFreshness $runtimeSnapshot @('updatedAt', 'generatedAt') $staleAfter $nowMs
  $storageFreshness = Get-NvSnapshotFreshness $storageSnapshot @('checkedAt', 'updatedAt') $staleAfter $nowMs

  $warnings = New-Object System.Collections.Generic.List[string]
  foreach ($source in @(
    [ordered]@{ name = 'sync-worker-health'; snapshot = $syncSnapshot; freshness = $syncFreshness },
    [ordered]@{ name = 'runtime-health'; snapshot = $runtimeSnapshot; freshness = $runtimeFreshness }
  )) {
    if (-not $source.snapshot.valid) {
      $warnings.Add("$($source.name): $($source.snapshot.error)")
    } elseif (-not $source.freshness.fresh) {
      $warnings.Add("$($source.name): stale")
    }
  }

  $runtimeData = if ($runtimeSnapshot.valid) { $runtimeSnapshot.data } else { $null }
  $syncData = if ($syncSnapshot.valid) { $syncSnapshot.data } else { $null }
  $storageData = if ($storageSnapshot.valid) { $storageSnapshot.data } else { $null }
  $syncSqliteCandidate = Get-NvMemberValue $syncData 'sqlite'
  if ($null -eq $syncSqliteCandidate) {
    if (-not $storageSnapshot.valid) {
      $warnings.Add("storage-health: $($storageSnapshot.error)")
    } elseif (-not $storageFreshness.fresh) {
      $warnings.Add('storage-health: stale')
    }
  }
  $providersData = Get-NvMemberValue $syncData 'providers'
  $providers = @()
  foreach ($providerId in @('supabase', 'turso', 'neon')) {
    $providerData = Get-NvMemberValue $providersData $providerId
    $providers += ,(New-NvProviderStatus -ProviderId $providerId -ProviderData $providerData -RuntimeData $runtimeData)
  }

  $windowsRunnerRunning = Test-NvPidFileProcess (Join-Path $projectRoot 'logs\bot-runner.pid')
  $discordReady = [bool](Get-NvMemberValue $runtimeData 'discordReady' $false)
  $botState = if (($runtimeFreshness.fresh -and $discordReady) -or $windowsRunnerRunning) {
    'RUNNING'
  } elseif ($runtimeSnapshot.valid -and -not $runtimeFreshness.fresh) {
    'STALE'
  } else { 'OFFLINE' }
  $discordState = if ($runtimeFreshness.fresh -and $discordReady) {
    'CONNECTED'
  } elseif ($runtimeSnapshot.valid -and -not $runtimeFreshness.fresh) {
    'STALE'
  } else { 'OFFLINE' }

  $configuredWorkerEnabled = Test-NvBooleanText $environment['SYNC_WORKER_ENABLED'] $false
  $workerSnapshotState = (Get-NvMemberValue $syncData 'workerStatus' '').ToString().ToUpperInvariant()
  $workerState = if ($syncFreshness.fresh -and $workerSnapshotState -eq 'RUNNING') {
    'RUNNING'
  } elseif (-not $configuredWorkerEnabled -and -not $syncSnapshot.valid) {
    'DISABLED'
  } elseif ($syncSnapshot.valid -and -not $syncFreshness.fresh) {
    'STALE'
  } else { 'OFFLINE' }

  $syncSqlite = $syncSqliteCandidate
  $sqliteHealth = if ($syncFreshness.fresh -and $null -ne $syncSqlite) {
    (Get-NvMemberValue $syncSqlite 'status' 'UNKNOWN').ToString().ToUpperInvariant()
  } elseif ($storageSnapshot.valid) {
    (Get-NvMemberValue $storageData 'status' 'UNKNOWN').ToString().ToUpperInvariant()
  } else { 'UNKNOWN' }
  $sqliteStorage = Get-NvMemberValue $syncSqlite 'storage'
  $sqliteTotal = ConvertTo-NvNullableInt64 (Get-NvMemberValue $sqliteStorage 'totalBytes')
  $sqliteDatabase = ConvertTo-NvNullableInt64 (Get-NvMemberValue $sqliteStorage 'databaseBytes')
  $sqliteWal = ConvertTo-NvNullableInt64 (Get-NvMemberValue $sqliteStorage 'walBytes')
  if ($null -eq $sqliteTotal) { $sqliteTotal = ConvertTo-NvNullableInt64 (Get-NvMemberValue $storageData 'totalBytes') }
  if ($null -eq $sqliteDatabase) { $sqliteDatabase = ConvertTo-NvNullableInt64 (Get-NvMemberValue $storageData 'databaseBytes') }
  if ($null -eq $sqliteWal) { $sqliteWal = ConvertTo-NvNullableInt64 (Get-NvMemberValue $storageData 'walBytes') }

  $localStoragePath = Resolve-NvProjectPath -ProjectRoot $projectRoot `
    -ConfiguredPath $environment['LOCAL_STORAGE_PATH'] `
    -Fallback 'data\nuviloview.sqlite'
  if (Test-Path -LiteralPath $localStoragePath -PathType Leaf) {
    $sqliteDatabase = [int64](Get-Item -LiteralPath $localStoragePath).Length
    $walPath = "$localStoragePath-wal"
    $sqliteWal = if (Test-Path -LiteralPath $walPath -PathType Leaf) {
      [int64](Get-Item -LiteralPath $walPath).Length
    } else { 0L }
    $sqliteTotal = $sqliteDatabase + $sqliteWal
  }
  $drive = Get-NvDriveUsage -Path $localStoragePath

  $declaredRequiredProviders = @($providers | Where-Object { $_.required })
  $requiredProviders = @($declaredRequiredProviders | Where-Object { $_.enabled })
  $pending = Get-NvMaximumValue @($requiredProviders | ForEach-Object { $_.pending })
  $retry = Get-NvMaximumValue @($requiredProviders | ForEach-Object { $_.retry })
  $processing = Get-NvMaximumValue @($requiredProviders | ForEach-Object { $_.processing })
  $deadLetter = Get-NvMaximumValue @($requiredProviders | ForEach-Object { $_.deadLetter })
  $lastSuccessValues = @($requiredProviders | ForEach-Object { $_.lastSuccessAt })
  $lastSuccess = if ($requiredProviders.Count -gt 0 -and @($lastSuccessValues | Where-Object { $null -ne $_ }).Count -eq $requiredProviders.Count) {
    Get-NvTimestampBoundary $lastSuccessValues 'Minimum'
  } else { $null }
  $lastFailure = Get-NvTimestampBoundary @($requiredProviders | ForEach-Object { $_.lastFailureAt }) 'Maximum'

  $activity = if (@($requiredProviders | Where-Object { $_.circuit -eq 'HALF_OPEN' }).Count -gt 0) {
    'circuit half-open probe'
  } elseif (@($requiredProviders | Where-Object { $_.circuit -eq 'OPEN' }).Count -gt 0) {
    'recovery / circuit open'
  } elseif ($processing -gt 0) {
    'syncing provider deliveries'
  } elseif ($retry -gt 0) {
    'recovery'
  } elseif ($pending -gt 0) {
    'checkpoint / pending sync'
  } elseif ($workerState -eq 'RUNNING') {
    'idle'
  } elseif ($workerState -eq 'DISABLED') {
    'worker disabled'
  } else { 'offline' }

  $cloudCompleteData = Get-NvMemberValue $syncData 'cloudComplete'
  $cloudComplete = [ordered]@{
    complete = [int64](Get-NvMemberValue $cloudCompleteData 'complete' 0)
    total = [int64](Get-NvMemberValue $cloudCompleteData 'total' 0)
  }
  $cloudComplete.percent = Get-NvPercent $cloudComplete.complete $cloudComplete.total

  $analyticsData = Get-NvMemberValue $syncData 'analyticsCompaction'
  $analytics = [ordered]@{
    scope = 'worker_session'
    enabled = [bool](Get-NvMemberValue $analyticsData 'enabled' $false)
    guildCount = [int64](Get-NvMemberValue $analyticsData 'guildCount' 0)
    rawEventsSeen = [int64](Get-NvMemberValue $analyticsData 'rawEventsSeen' 0)
    cloudWrites = [int64](Get-NvMemberValue $analyticsData 'providerWrites' 0)
    reductionRatio = ConvertTo-NvNullableDouble (Get-NvMemberValue $analyticsData 'providerWriteReductionRatio')
    projectionsUpdated = [int64](Get-NvMemberValue $analyticsData 'snapshotsChanged' 0)
    skippedByChecksum = [int64](Get-NvMemberValue $analyticsData 'snapshotsSkipped' 0)
    lastBuiltAt = ConvertTo-NvNullableInt64 (Get-NvMemberValue $analyticsData 'lastBuiltAt')
  }

  $sqliteBudget = ConvertTo-NvNullableInt64 $environment['NUVILOCTL_SQLITE_BUDGET_BYTES']
  if ($null -eq $sqliteBudget -or $sqliteBudget -le 0) { $sqliteBudget = 1073741824L }
  $queueCapacity = ConvertTo-NvNullableInt64 $environment['NUVILOCTL_QUEUE_CAPACITY']
  if ($null -eq $queueCapacity -or $queueCapacity -le 0) { $queueCapacity = 10000L }
  $queueCurrent = $pending + $retry + $processing

  $providerUsage = [ordered]@{}
  foreach ($providerId in @('supabase', 'turso')) {
    $budgetKey = "NUVILOCTL_$($providerId.ToUpperInvariant())_DAILY_WRITE_BUDGET"
    $budget = ConvertTo-NvNullableInt64 $environment[$budgetKey]
    $provider = @($providers | Where-Object { $_.id -eq $providerId })[0]
    $providerUsage[$providerId] = [ordered]@{
      writesToday = $provider.writesToday
      readsToday = $provider.readsToday
      dailyWriteBudget = $budget
      percent = Get-NvPercent $provider.writesToday $budget
      remainingWrites = if ($null -eq $provider.writesToday -or $null -eq $budget) {
        $null
      } else { [math]::Max(0, $budget - $provider.writesToday) }
      available = $null -ne $provider.writesToday -and $null -ne $budget
    }
  }

  $runtimeMode = (Get-NvMemberValue $runtimeData 'runtimeMode' (Get-NvMemberValue $syncData 'mode' 'UNKNOWN')).ToString().ToUpperInvariant()
  $requiredUnhealthy = @($declaredRequiredProviders | Where-Object {
    -not $_.enabled -or $_.health -ne 'HEALTHY' -or $_.circuit -ne 'CLOSED'
  }).Count -gt 0
  $overall = if ($sqliteHealth -eq 'UNHEALTHY' -or $sqliteHealth -eq 'CRITICAL' -or $deadLetter -gt 0) {
    'CRITICAL'
  } elseif ($botState -eq 'OFFLINE' -and @('OFFLINE', 'DISABLED') -contains $workerState) {
    'OFFLINE'
  } elseif (
    $botState -ne 'RUNNING' -or
    $discordState -ne 'CONNECTED' -or
    $workerState -ne 'RUNNING' -or
    $requiredUnhealthy -or
    $pending -gt 0 -or $retry -gt 0 -or
    $runtimeMode -eq 'DEGRADED' -or
    $warnings.Count -gt 0
  ) { 'DEGRADED' } else { 'HEALTHY' }

  return [ordered]@{
    schemaVersion = 1
    controlCenterVersion = $script:ControlCenterVersion
    generatedAt = [DateTimeOffset]::Now.ToString('o')
    generatedAtMs = $nowMs
    hostname = [Environment]::MachineName
    overall = $overall
    runtime = [ordered]@{
      bot = $botState
      worker = $workerState
      discord = $discordState
      sqlite = $sqliteHealth
      cloudComplete = $cloudComplete
      mode = $runtimeMode
      guildCount = ConvertTo-NvNullableInt64 (Get-NvMemberValue $runtimeData 'guildCount')
    }
    providers = $providers
    queue = [ordered]@{
      pending = $pending
      retry = $retry
      processing = $processing
      deadLetter = $deadLetter
      current = $queueCurrent
      capacity = $queueCapacity
      percent = Get-NvPercent $queueCurrent $queueCapacity
      remaining = [math]::Max(0, $queueCapacity - $queueCurrent)
      currentBatchSize = $null
      lastSuccessfulSync = $lastSuccess
      lastFailedSync = $lastFailure
      activity = $activity
      aggregation = 'maximum_across_required_providers'
    }
    usage = [ordered]@{
      sqlite = [ordered]@{
        totalBytes = $sqliteTotal
        databaseBytes = $sqliteDatabase
        walBytes = $sqliteWal
        softBudgetBytes = $sqliteBudget
        percent = Get-NvPercent $sqliteTotal $sqliteBudget
        remainingBytes = if ($null -eq $sqliteTotal) { $null } else { [math]::Max(0, $sqliteBudget - $sqliteTotal) }
      }
      disk = $drive
      providers = $providerUsage
    }
    analytics = $analytics
    sources = [ordered]@{
      sync = [ordered]@{ valid = $syncSnapshot.valid; fresh = $syncFreshness.fresh; ageSeconds = $syncFreshness.ageSeconds; error = $syncSnapshot.error }
      runtime = [ordered]@{ valid = $runtimeSnapshot.valid; fresh = $runtimeFreshness.fresh; ageSeconds = $runtimeFreshness.ageSeconds; error = $runtimeSnapshot.error }
      storage = [ordered]@{ valid = $storageSnapshot.valid; fresh = $storageFreshness.fresh; ageSeconds = $storageFreshness.ageSeconds; error = $storageSnapshot.error }
    }
    warnings = @($warnings)
    readOnly = $true
  }
}
