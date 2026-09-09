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
$uri = [Uri]$origin
if ($uri.Scheme -ne 'https' -or $uri.Port -ne 8443) { throw 'Expected HTTPS public origin on port 8443.' }
# Connect to loopback inside the API container while retaining public IP SAN verification.
$connectTo = '{0}:8443:127.0.0.1:8443' -f $uri.Host
$required = @('database', 'browser-1', 'browser-2', 'browser-3', 'browser-4', 'browser-5')
if (-not $WithoutInference) { $required += 'inference' }
$componentsReady = $false
$readinessClock = [Diagnostics.Stopwatch]::StartNew()
foreach ($attempt in 1..36) {
    if ($readinessClock.Elapsed.TotalSeconds -ge 180) { break }
    $readinessJson = Invoke-Compose @('exec', '-T', 'api', 'curl', '--fail', '--silent', '--show-error', '--max-time', '10',
        '--connect-to', $connectTo, '--cacert', '/run/secrets/api_cert', "$origin/health/ready")
    $readiness = ($readinessJson -join "`n") | ConvertFrom-Json
    $down = @($required | Where-Object { $readiness.components.$_ -ne 'UP' })
    if (-not $down.Count) { $componentsReady = $true; break }
    Start-Sleep -Seconds 5
}
$readiness | ConvertTo-Json -Depth 4 | Write-Output
if (-not $componentsReady) { throw ('Required components are not ready: ' + ($down -join ', ')) }
if (-not $WithoutInference) {
    Invoke-Compose @('exec', '-T', 'inference', 'curl', '--fail', '--silent', '--max-time', '5', 'http://127.0.0.1:8080/health')
    Invoke-Compose @('exec', '-T', 'inference', 'nvidia-smi', '--query-gpu=name,driver_version,memory.total,memory.used,memory.free', '--format=csv')
}
Write-Output 'TLS, API liveness and component readiness checked. A live task still requires profile and model acceptance checks.'
