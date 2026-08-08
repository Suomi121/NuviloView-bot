param(
  [ValidateSet('Status', 'Start', 'Stop', 'Restart')]
  [string]$Action = 'Status',
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$projectRoot = Split-Path -Parent $PSScriptRoot
$runnerScript = Join-Path $PSScriptRoot 'run-bot-forever.ps1'
$logDirectory = Join-Path $projectRoot 'logs'
$runnerLog = Join-Path $logDirectory 'bot-runner.log'
$runnerPidFile = Join-Path $logDirectory 'bot-runner.pid'
$stopRequestFile = Join-Path $logDirectory 'bot-runner.stop'

New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null

function Get-LastRunnerEvent {
  if (-not (Test-Path -LiteralPath $runnerLog)) { return $null }
  $line = Get-Content -LiteralPath $runnerLog -Tail 1 -ErrorAction SilentlyContinue
  if (-not $line) { return $null }
  $safeLine = $line.ToString().Replace("`r", ' ').Replace("`n", ' ').Trim()
  if ($safeLine.Length -gt 300) { return $safeLine.Substring(0, 300) }
  return $safeLine
}

function Test-IsRunnerProcess {
  param([Parameter(Mandatory = $true)]$ProcessInfo)

  if ($ProcessInfo.Name -notmatch '^(powershell|pwsh)(\.exe)?$') { return $false }
  $commandLine = if ($ProcessInfo.CommandLine) { $ProcessInfo.CommandLine.ToString() } else { '' }
  return $commandLine.IndexOf($runnerScript, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Get-RunnerProcessInfo {
  $candidatePid = 0
  if (Test-Path -LiteralPath $runnerPidFile) {
    [void][int]::TryParse(
      (Get-Content -LiteralPath $runnerPidFile -ErrorAction SilentlyContinue | Select-Object -First 1),
      [ref]$candidatePid
    )
  }

  if ($candidatePid -gt 0) {
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $candidatePid" -ErrorAction SilentlyContinue
    if ($candidate -and (Test-IsRunnerProcess -ProcessInfo $candidate)) { return $candidate }
  }

  $fallback = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { Test-IsRunnerProcess -ProcessInfo $_ } |
    Select-Object -First 1
  if ($fallback) {
    Set-Content -LiteralPath $runnerPidFile -Value $fallback.ProcessId -Encoding ASCII
    return $fallback
  }

  Remove-Item -LiteralPath $runnerPidFile -Force -ErrorAction SilentlyContinue
  return $null
}

function Get-ControlStatus {
  $runner = Get-RunnerProcessInfo
  $startedAt = $null
  if ($runner -and $runner.CreationDate) {
    try {
      $startedAt = if ($runner.CreationDate -is [datetime]) {
        $runner.CreationDate.ToString('o')
      } else {
        ([Management.ManagementDateTimeConverter]::ToDateTime($runner.CreationDate.ToString())).ToString('o')
      }
    } catch {
      $startedAt = $null
    }
  }

  return [ordered]@{
    ok = $true
    state = if ($runner) { 'running' } else { 'stopped' }
    running = [bool]$runner
    pid = if ($runner) { [int]$runner.ProcessId } else { $null }
    startedAt = $startedAt
    autoRestart = [bool]$runner
    lastEvent = Get-LastRunnerEvent
  }
}

function Get-PowerShellExecutable {
  $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (Test-Path -LiteralPath $windowsPowerShell) { return $windowsPowerShell }
  $command = Get-Command 'pwsh.exe' -ErrorAction SilentlyContinue
  if (-not $command) { $command = Get-Command 'powershell.exe' -ErrorAction SilentlyContinue }
  if (-not $command) { throw 'PowerShellを見つけられません。' }
  return $command.Source
}

function Start-BotRunner {
  $current = Get-RunnerProcessInfo
  if ($current) {
    $status = Get-ControlStatus
    $status.message = 'Botはすでに起動しています。'
    return $status
  }
  if (-not (Test-Path -LiteralPath $runnerScript)) { throw 'Botランナーが見つかりません。' }

  Remove-Item -LiteralPath $stopRequestFile -Force -ErrorAction SilentlyContinue
  $powerShellPath = Get-PowerShellExecutable
  $arguments = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', ('"{0}"' -f $runnerScript)
  )
  Start-Process -FilePath $powerShellPath -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden | Out-Null

  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 125
    $runner = Get-RunnerProcessInfo
    if ($runner) {
      Start-Sleep -Milliseconds 500
      $status = Get-ControlStatus
      if ($status.running) {
        $status.message = 'Botを起動しました。異常終了時は自動再起動します。'
        return $status
      }
    }
  }

  $status = Get-ControlStatus
  $status.ok = $false
  $status.message = if ($status.lastEvent) {
    'Botを起動できませんでした。最後のランナーログを確認してください。'
  } else {
    'Botランナーを起動できませんでした。'
  }
  return $status
}

function Get-DescendantProcessIds {
  param([Parameter(Mandatory = $true)][int]$ParentProcessId)

  $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $queue = New-Object System.Collections.Generic.Queue[int]
  $descendants = New-Object System.Collections.Generic.List[int]
  $queue.Enqueue($ParentProcessId)
  while ($queue.Count -gt 0) {
    $parentId = $queue.Dequeue()
    foreach ($child in $allProcesses | Where-Object { [int]$_.ParentProcessId -eq $parentId }) {
      $childId = [int]$child.ProcessId
      $descendants.Add($childId)
      $queue.Enqueue($childId)
    }
  }
  return @($descendants)
}

function Stop-BotRunner {
  $runner = Get-RunnerProcessInfo
  if (-not $runner) {
    Remove-Item -LiteralPath $stopRequestFile -Force -ErrorAction SilentlyContinue
    $status = Get-ControlStatus
    $status.message = 'Botはすでに停止しています。'
    return $status
  }

  $runnerPid = [int]$runner.ProcessId
  Set-Content -LiteralPath $stopRequestFile -Value (Get-Date).ToString('o') -Encoding ASCII

  for ($attempt = 0; $attempt -lt 80; $attempt++) {
    Start-Sleep -Milliseconds 250
    if (-not (Get-RunnerProcessInfo)) {
      $status = Get-ControlStatus
      $status.message = 'Botを安全に停止しました。'
      return $status
    }
  }

  $descendants = @(Get-DescendantProcessIds -ParentProcessId $runnerPid)
  [array]::Reverse($descendants)
  foreach ($processId in $descendants) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }
  Stop-Process -Id $runnerPid -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  Remove-Item -LiteralPath $runnerPidFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $stopRequestFile -Force -ErrorAction SilentlyContinue

  $status = Get-ControlStatus
  $status.message = '通常停止が完了しなかったため、NuviloView Botのプロセスだけを終了しました。'
  return $status
}

function Invoke-ControlAction {
  switch ($Action) {
    'Start' { return Start-BotRunner }
    'Stop' { return Stop-BotRunner }
    'Restart' {
      [void](Stop-BotRunner)
      Start-Sleep -Milliseconds 500
      return Start-BotRunner
    }
    default { return Get-ControlStatus }
  }
}

try {
  $result = Invoke-ControlAction
} catch {
  $result = [ordered]@{
    ok = $false
    state = 'error'
    running = $false
    pid = $null
    startedAt = $null
    autoRestart = $false
    lastEvent = Get-LastRunnerEvent
    message = $_.Exception.Message
  }
}

if ($Json) {
  $result | ConvertTo-Json -Compress -Depth 4
} else {
  [PSCustomObject]$result | Format-List
}
