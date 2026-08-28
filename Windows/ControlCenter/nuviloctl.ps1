$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$script:ControlCenterVersion = '1.0.0'
$script:ControlCenterRoot = $PSScriptRoot
$script:DefaultProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

. (Join-Path $PSScriptRoot 'lib\Data.ps1')
. (Join-Path $PSScriptRoot 'lib\State.ps1')
. (Join-Path $PSScriptRoot 'lib\Render.ps1')

function Show-NvHelp {
  @"
NuviloView Control Center v$script:ControlCenterVersion

Usage:
  .\nuviloctl.ps1 status
  .\nuviloctl.ps1 status --once
  .\nuviloctl.ps1 status --watch [--interval 5]
  .\nuviloctl.ps1 status --json
  .\nuviloctl.ps1 help
  .\nuviloctl.ps1 version

Read-only options:
  --project-root <path>  Read snapshots from another NuviloView checkout.
  --interval <seconds>  Watch refresh interval (minimum 1, default 5).
  --no-color            Disable ANSI colors.

The status command never starts, stops, repairs, or changes NuviloView.
"@
}

function ConvertTo-NvCliOptions {
  param([string[]]$Values)

  $result = [ordered]@{
    Command = 'status'
    Watch = $false
    Json = $false
    Once = $false
    NoColor = $false
    ProjectRoot = $script:DefaultProjectRoot
    IntervalSeconds = 5.0
    Iterations = 0
  }

  $index = 0
  if ($Values.Count -gt 0 -and -not $Values[0].StartsWith('-')) {
    $result.Command = $Values[0].ToLowerInvariant()
    $index = 1
  }

  while ($index -lt $Values.Count) {
    $option = $Values[$index].ToLowerInvariant()
    switch ($option) {
      '--watch' { $result.Watch = $true; $index++; continue }
      '--json' { $result.Json = $true; $index++; continue }
      '--once' { $result.Once = $true; $index++; continue }
      '--no-color' { $result.NoColor = $true; $index++; continue }
      '--project-root' {
        if ($index + 1 -ge $Values.Count) { throw '--project-root requires a path.' }
        $result.ProjectRoot = [System.IO.Path]::GetFullPath($Values[$index + 1])
        $index += 2
        continue
      }
      '--interval' {
        if ($index + 1 -ge $Values.Count) { throw '--interval requires seconds.' }
        $interval = 0.0
        if (-not [double]::TryParse(
          $Values[$index + 1],
          [Globalization.NumberStyles]::Float,
          [Globalization.CultureInfo]::InvariantCulture,
          [ref]$interval
        )) { throw '--interval must be a number.' }
        if ($interval -lt 1 -or $interval -gt 300) {
          throw '--interval must be between 1 and 300 seconds.'
        }
        $result.IntervalSeconds = $interval
        $index += 2
        continue
      }
      '--iterations' {
        if ($index + 1 -ge $Values.Count) { throw '--iterations requires a count.' }
        $iterations = 0
        if (-not [int]::TryParse($Values[$index + 1], [ref]$iterations) -or $iterations -lt 1) {
          throw '--iterations must be a positive integer.'
        }
        $result.Iterations = $iterations
        $index += 2
        continue
      }
      default { throw "Unknown option: $($Values[$index])" }
    }
  }

  if ($result.Json -and $result.Watch) {
    throw '--json and --watch cannot be used together in v1.'
  }
  return $result
}

try {
  $options = ConvertTo-NvCliOptions -Values @($args)
  switch ($options.Command) {
    'help' {
      Show-NvHelp
      exit 0
    }
    'version' {
      "NuviloView Control Center v$script:ControlCenterVersion"
      exit 0
    }
    'status' { }
    default {
      throw "Unknown command: $($options.Command)"
    }
  }

  if ($options.Json) {
    $snapshot = Get-NvControlCenterStatus -ProjectRoot $options.ProjectRoot
    $snapshot | ConvertTo-Json -Depth 14
    exit 0
  }

  $refresh = 0
  do {
    $snapshot = Get-NvControlCenterStatus -ProjectRoot $options.ProjectRoot
    $view = Format-NvControlCenter -Snapshot $snapshot -NoColor:$options.NoColor
    Write-NvDashboard -Text $view -RefreshIndex $refresh -Watch:$options.Watch
    $refresh++

    if (-not $options.Watch) { break }
    if ($options.Iterations -gt 0 -and $refresh -ge $options.Iterations) { break }
    Start-Sleep -Milliseconds ([int]($options.IntervalSeconds * 1000))
  } while ($true)
  exit 0
} catch {
  $safeMessage = $_.Exception.Message.Replace("`r", ' ').Replace("`n", ' ').Trim()
  if ($safeMessage.Length -gt 240) { $safeMessage = $safeMessage.Substring(0, 240) }
  [Console]::Error.WriteLine("nuviloctl: $safeMessage")
  exit 2
}
