#Requires -Version 7.4
[CmdletBinding()]
param()
. "$PSScriptRoot/Common.ps1"
Assert-Administrator
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$pwshPath = (Get-Process -Id $PID).Path
$scriptPath = Join-Path $PSScriptRoot 'Start-AfterLogon.ps1'
$action = New-ScheduledTaskAction -Execute $pwshPath -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -File `"$scriptPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $account
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -StartWhenAvailable
Register-ScheduledTask -TaskName BrowserSkillsAfterLogon -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Start BrowserSkills after Docker Desktop becomes available at Windows sign-in.' | Out-Null
Write-Output 'Registered current-user sign-in startup. It does not run before Windows sign-in and stores no Windows password.'
