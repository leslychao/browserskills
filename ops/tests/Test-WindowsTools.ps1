#Requires -Version 7.4
. "$PSScriptRoot/../windows/Common.ps1"
$tokens = $null
$parseErrors = $null
Get-ChildItem "$PSScriptRoot/../windows/*.ps1" | ForEach-Object {
    [void][Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
}
Write-Output 'All Windows PowerShell scripts parsed. No service or firewall was changed.'
