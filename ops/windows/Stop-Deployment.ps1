#Requires -Version 7.4
[CmdletBinding()]
param()
. "$PSScriptRoot/Common.ps1"
Assert-Docker
Invoke-Compose @('stop', '-t', '45')
Write-Output 'Containers stopped. Database, models, secrets and browser profiles remain intact.'
