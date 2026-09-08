#Requires -Version 7.4
[CmdletBinding()]
param([Parameter(Mandatory)][ValidateSet('Create', 'Disable')][string]$Action, [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9._-]{3,64}$')][string]$Login)
. "$PSScriptRoot/Common.ps1"
Assert-Docker
$operation = if ($Action -eq 'Create') { '--create-user=' } else { '--disable-user=' }
# Interactive stdin stays attached; the Java console reads the password without echo.
Invoke-Compose @('exec', 'api', 'java', '-jar', '/app/api.jar', '--spring.main.web-application-type=none', '--spring.profiles.active=admin', "$operation$Login")
