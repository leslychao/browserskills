#Requires -Version 7.4
[CmdletBinding()]
param([switch]$WithoutInference)
. "$PSScriptRoot/Common.ps1"
Assert-Docker
Invoke-Compose @('ps', '--all')
$root = Get-ProjectRoot
$config = Get-Content -LiteralPath (Join-Path $root '.env') | Where-Object { $_ -match '^BROWSERSKILLS_PUBLIC_ORIGIN=' }
$origin = $config -replace '^BROWSERSKILLS_PUBLIC_ORIGIN=', ''
if (-not $origin) { throw 'Missing public origin.' }
# curl checks both chain and IP SAN; no insecure TLS switch.
$healthy = $false
foreach ($attempt in 1..12) {
    & curl.exe --fail --silent --max-time 5 --cacert (Join-Path $root 'secrets/ca_cert.pem') "$origin/health/live"
    if ($LASTEXITCODE -eq 0) { $healthy = $true; break }
    Start-Sleep -Seconds 5
}
if (-not $healthy) { throw 'API did not become live with valid TLS within the startup window.' }
if (-not $WithoutInference) {
    Invoke-Compose @('exec', '-T', 'inference', 'curl', '--fail', '--silent', '--max-time', '5', 'http://127.0.0.1:8080/health')
    Invoke-Compose @('exec', '-T', 'inference', 'nvidia-smi', '--query-gpu=name,driver_version,memory.total,memory.used,memory.free', '--format=csv')
}
Write-Output 'API liveness, TLS and inference checked. Worker health and actual task readiness are displayed separately in the app.'
