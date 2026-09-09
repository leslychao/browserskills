#Requires -Version 7.4
[CmdletBinding()]
param([switch]$WithoutInference)
. "$PSScriptRoot/Common.ps1"
Assert-Docker
$origin=Get-DeploymentOrigin
Invoke-Compose @('ps', '--all')
# Explicit LAN HTTP deployment; no certificate bootstrap.
$healthy = $false
foreach ($attempt in 1..12) {
    & curl.exe --fail --silent --max-time 5 "$origin/health/live"
    if ($LASTEXITCODE -eq 0) { $healthy = $true; break }
    Start-Sleep -Seconds 5
}
if (-not $healthy) { throw 'HTTP API did not become live within the startup window.' }
# Readiness is intentionally available only from API container loopback.
$required = @('database', 'browser-1', 'browser-2', 'browser-3', 'browser-4', 'browser-5')
if (-not $WithoutInference) { $required += 'inference' }
$componentsReady = $false
$readinessClock = [Diagnostics.Stopwatch]::StartNew()
foreach ($attempt in 1..36) {
    if ($readinessClock.Elapsed.TotalSeconds -ge 180) { break }
    $readinessJson = Invoke-Compose @('exec', '-T', 'api', 'curl', '--fail', '--silent', '--show-error', '--max-time', '10',
        'http://127.0.0.1:8080/health/ready')
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
Write-Output 'LAN HTTP, API liveness and component readiness checked. A live task still requires profile and model acceptance checks.'
