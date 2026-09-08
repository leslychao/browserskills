#Requires -Version 7.4
[CmdletBinding()]
param()
. "$PSScriptRoot/Common.ps1"
$desktop = Join-Path $env:ProgramFiles 'Docker/Docker/Docker Desktop.exe'
if (-not (Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath $desktop -WindowStyle Hidden
}
foreach ($attempt in 1..36) {
    & docker info --format '{{.OSType}}' *> $null
    if ($LASTEXITCODE -eq 0) { & "$PSScriptRoot/Start-Deployment.ps1"; exit }
    Start-Sleep -Seconds 5
}
throw 'Docker Desktop did not become ready in 180 seconds after Windows sign-in.'
