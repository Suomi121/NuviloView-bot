$entryPoint = Join-Path $PSScriptRoot 'Windows\ControlCenter\nuviloctl.ps1'

if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
  Write-Error 'NuviloView Control Center entry point was not found.'
  exit 2
}

& $entryPoint @args
exit $LASTEXITCODE
