#Requires -Version 7.4
[CmdletBinding()]
param([switch]$Build, [switch]$WithoutInference)
. "$PSScriptRoot/Common.ps1"
Assert-Docker
Get-DeploymentOrigin | Out-Null
Invoke-Compose @('config', '--quiet')
if ($Build) { Invoke-Compose @('build', 'api', 'browser-1', 'inference') }
$services = @('postgres', 'browser-1', 'browser-2', 'browser-3', 'browser-4', 'browser-5', 'api')
if (-not $WithoutInference) { $services += 'inference' }
Invoke-Compose (@('up', '-d', '--no-build') + $services)
& "$PSScriptRoot/Test-Deployment.ps1" -WithoutInference:$WithoutInference
