param([switch]$ConfigureVercel)

$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot '.env.local'
if (-not (Test-Path $envFile)) { throw '.env.local was not found.' }

$lines = [System.Collections.Generic.List[string]](Get-Content -LiteralPath $envFile)
$existing = $lines | Where-Object { $_ -match '^AUDIT_LOG_SIGNING_SECRET=' } | Select-Object -First 1
if ($existing -and $existing.Substring('AUDIT_LOG_SIGNING_SECRET='.Length)) {
  $secret = $existing.Substring('AUDIT_LOG_SIGNING_SECRET='.Length)
} else {
  $bytes = New-Object byte[] 48
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $rng.Dispose()
  $secret = [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
  if ($existing) {
    $lines = $lines | ForEach-Object { if ($_ -match '^AUDIT_LOG_SIGNING_SECRET=') { "AUDIT_LOG_SIGNING_SECRET=$secret" } else { $_ } }
    [System.IO.File]::WriteAllLines($envFile, $lines)
  } else {
    [System.IO.File]::AppendAllText($envFile, [Environment]::NewLine + "AUDIT_LOG_SIGNING_SECRET=$secret" + [Environment]::NewLine)
  }
}

if ($ConfigureVercel) {
  npx --yes vercel env add AUDIT_LOG_SIGNING_SECRET production --value $secret --yes
  if ($LASTEXITCODE -ne 0) { throw 'Vercel environment variable setup failed.' }
}

Write-Output 'Audit signing secret is configured without displaying its value.'
