param(
  [switch]$ValidateOnly,
  [switch]$Once
)

$ErrorActionPreference = 'Continue'
Set-StrictMode -Version 2.0

$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot '.env.local'
$botFile = Join-Path $projectRoot 'discord-bot.mjs'
$tokenCheckFile = Join-Path $PSScriptRoot 'token-leak-check.mjs'
$logDirectory = Join-Path $projectRoot 'logs'
$runnerLog = Join-Path $logDirectory 'bot-runner.log'
$botOutputLog = Join-Path $logDirectory 'bot-output.log'
$tokenCheckLog = Join-Path $logDirectory 'token-leak-check.log'
$mutexName = 'Global\NuviloViewDiscordBotRunner'
$maxLogSizeBytes = 10MB
$logRetentionDays = 14
$stableRunSeconds = 300
$maximumRestartDelaySeconds = 900

$nodeCommand = Get-Command 'node.exe' -ErrorAction SilentlyContinue
$nodePath = if (Test-Path -LiteralPath 'C:\Program Files\nodejs\node.exe') {
  'C:\Program Files\nodejs\node.exe'
} elseif ($nodeCommand) {
  $nodeCommand.Source
} else {
  $null
}

New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
Set-Location $projectRoot

function Write-RunnerLog {
  param([Parameter(Mandatory = $true)][string]$Message)

  "[$(Get-Date -Format s)] $Message" |
    Add-Content -LiteralPath $runnerLog -Encoding UTF8
}

function Rotate-Log {
  param([Parameter(Mandatory = $true)][string]$Path)

  $baseName = [System.IO.Path]::GetFileNameWithoutExtension($Path)
  $extension = [System.IO.Path]::GetExtension($Path)

  if (Test-Path -LiteralPath $Path) {
    $current = Get-Item -LiteralPath $Path
    if ($current.Length -ge $maxLogSizeBytes) {
      $archive = Join-Path $logDirectory (
        '{0}-{1}{2}' -f $baseName, (Get-Date -Format 'yyyyMMdd-HHmmss'), $extension
      )
      Move-Item -LiteralPath $Path -Destination $archive
    }
  }

  $archivePattern = '^' + [regex]::Escape($baseName) + '-\d{8}-\d{6}$'
  Get-ChildItem -LiteralPath $logDirectory -Filter "$baseName-*$extension" -File -ErrorAction SilentlyContinue |
    Where-Object {
      $_.BaseName -match $archivePattern -and
      $_.LastWriteTime -lt (Get-Date).AddDays(-$logRetentionDays)
    } |
    Remove-Item -Force
}

function Get-EnvFileValue {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Name
  )

  if (-not (Test-Path -LiteralPath $Path)) { return '' }
  $escapedName = [regex]::Escape($Name)
  $line = Get-Content -LiteralPath $Path |
    Where-Object { $_ -match "^\s*$escapedName\s*=" } |
    Select-Object -First 1
  if (-not $line) { return '' }

  $value = ($line -split '=', 2)[1].Trim()
  if ($value.Length -ge 2) {
    $first = $value.Substring(0, 1)
    $last = $value.Substring($value.Length - 1, 1)
    if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
      $value = $value.Substring(1, $value.Length - 2)
    }
  }
  return $value.Trim()
}

function Test-BotConfiguration {
  $errors = New-Object System.Collections.Generic.List[string]

  if (-not $nodePath -or -not (Test-Path -LiteralPath $nodePath)) {
    $errors.Add('Node.js was not found.')
  }
  if (-not (Test-Path -LiteralPath $envFile)) {
    $errors.Add('.env.local was not found.')
  }
  if (-not (Test-Path -LiteralPath $botFile)) {
    $errors.Add('discord-bot.mjs was not found.')
  }
  if (-not (Test-Path -LiteralPath $tokenCheckFile)) {
    $errors.Add('scripts/token-leak-check.mjs was not found.')
  }

  $requiredNames = @(
    'DATABASE_URL',
    'NUVILOVIEW_CLIENT_ID',
    'NUVILOVIEW_BOT_TOKEN'
  )
  foreach ($name in $requiredNames) {
    if ([string]::IsNullOrWhiteSpace((Get-EnvFileValue -Path $envFile -Name $name))) {
      $errors.Add("$name is missing or empty in .env.local.")
    }
  }

  return $errors
}

function Protect-BotLogLine {
  param(
    [Parameter(Mandatory = $true)]$Line,
    [string[]]$Secrets
  )

  $safeLine = $Line.ToString()
  foreach ($secret in $Secrets) {
    if ($secret -and $secret.Trim().Length -ge 12) {
      $safeLine = $safeLine -replace [regex]::Escape($secret.Trim()), '[REDACTED]'
    }
  }
  return $safeLine
}

function Get-RestartDelaySeconds {
  param([int]$FailureCount)

  $power = [Math]::Min([Math]::Max($FailureCount - 1, 0), 5)
  return [Math]::Min(30 * [Math]::Pow(2, $power), $maximumRestartDelaySeconds)
}

$mutex = $null
$hasMutex = $false

try {
  $mutex = New-Object System.Threading.Mutex($false, $mutexName)
  try {
    $hasMutex = $mutex.WaitOne(0, $false)
  } catch [System.Threading.AbandonedMutexException] {
    $hasMutex = $true
  }

  if (-not $hasMutex) {
    Write-RunnerLog 'Another Bot runner is already active. This duplicate launch will exit.'
    exit 0
  }

  $configurationErrors = @(Test-BotConfiguration)
  if ($configurationErrors.Count -gt 0) {
    foreach ($configurationError in $configurationErrors) {
      Write-RunnerLog "Configuration error: $configurationError"
    }
    exit 1
  }

  & $nodePath $tokenCheckFile 2>&1 |
    Out-File -LiteralPath $tokenCheckLog -Append -Encoding UTF8
  if ($LASTEXITCODE -ne 0) {
    Write-RunnerLog "Token leak check failed with exit code $LASTEXITCODE. Bot start was blocked."
    exit 1
  }

  if ($ValidateOnly) {
    Write-RunnerLog 'Runner validation passed with NUVILOVIEW_BOT_TOKEN configured.'
    exit 0
  }

  $secretsForRedaction = @(
    (Get-EnvFileValue -Path $envFile -Name 'NUVILOVIEW_BOT_TOKEN'),
    (Get-EnvFileValue -Path $envFile -Name 'NUVILOVIEW_CLIENT_SECRET')
  )
  $consecutiveQuickFailures = 0

  while ($true) {
    foreach ($logPath in @($runnerLog, $botOutputLog, $tokenCheckLog)) {
      Rotate-Log -Path $logPath
    }

    $configurationErrors = @(Test-BotConfiguration)
    if ($configurationErrors.Count -gt 0) {
      foreach ($configurationError in $configurationErrors) {
        Write-RunnerLog "Configuration error: $configurationError"
      }
      if ($Once) { exit 1 }
      Start-Sleep -Seconds 60
      continue
    }

    & $nodePath $tokenCheckFile 2>&1 |
      Out-File -LiteralPath $tokenCheckLog -Append -Encoding UTF8
    $tokenCheckExitCode = $LASTEXITCODE
    if ($tokenCheckExitCode -ne 0) {
      Write-RunnerLog "Token leak check failed with exit code $tokenCheckExitCode. Bot start was blocked."
      if ($Once) { exit $tokenCheckExitCode }
      Start-Sleep -Seconds 60
      continue
    }

    $runStartedAt = Get-Date
    $script:sawSessionStartLimit = $false
    $script:sessionLimitResetAt = $null
    Write-RunnerLog 'Starting NuviloView Bot with NUVILOVIEW_BOT_TOKEN.'

    & $nodePath '--env-file=.env.local' $botFile 2>&1 |
      ForEach-Object {
        $safeLine = Protect-BotLogLine -Line $_ -Secrets $secretsForRedaction
        if ($safeLine -match 'Not enough sessions remaining') {
          $script:sawSessionStartLimit = $true
        }
        if ($safeLine -match 'resets at\s+([^\s]+)') {
          $parsedResetAt = [DateTimeOffset]::MinValue
          if ([DateTimeOffset]::TryParse($Matches[1], [ref]$parsedResetAt)) {
            $script:sessionLimitResetAt = $parsedResetAt
          }
        }
        $safeLine
      } |
      Out-File -LiteralPath $botOutputLog -Append -Encoding UTF8
    $botExitCode = $LASTEXITCODE
    $runSeconds = [Math]::Max(0, [int]((Get-Date) - $runStartedAt).TotalSeconds)

    if ($Once) {
      Write-RunnerLog "Bot stopped with exit code $botExitCode after $runSeconds seconds. Once mode will exit."
      exit $botExitCode
    }

    if ($script:sawSessionStartLimit) {
      $delaySeconds = 900
      if ($script:sessionLimitResetAt) {
        $secondsUntilReset = [Math]::Ceiling(($script:sessionLimitResetAt - [DateTimeOffset]::Now).TotalSeconds) + 60
        if ($secondsUntilReset -gt 0) {
          $delaySeconds = [Math]::Min([int]$secondsUntilReset, 86400)
        }
      }
      Write-RunnerLog "Discord session-start limit reached. Bot exited with code $botExitCode; retrying in $delaySeconds seconds."
      Start-Sleep -Seconds $delaySeconds
      continue
    }

    if ($runSeconds -ge $stableRunSeconds) {
      $consecutiveQuickFailures = 0
      $delaySeconds = 10
    } else {
      $consecutiveQuickFailures++
      $delaySeconds = [int](Get-RestartDelaySeconds -FailureCount $consecutiveQuickFailures)
    }

    Write-RunnerLog "Bot stopped with exit code $botExitCode after $runSeconds seconds. Restarting in $delaySeconds seconds."
    Start-Sleep -Seconds $delaySeconds
  }
} finally {
  if ($hasMutex -and $mutex) {
    $mutex.ReleaseMutex()
  }
  if ($mutex) {
    $mutex.Dispose()
  }
}
