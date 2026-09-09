#Requires -Version 7.4
. "$PSScriptRoot/../windows/Common.ps1"
if (-not $IsWindows) { throw 'This test exercises actual Windows ACLs.' }
$root = Get-ProjectRoot
$testParent = Join-Path $root runtime
New-Item -ItemType Directory -Path $testParent -Force | Out-Null
$testDir = [IO.Path]::GetFullPath((Join-Path $testParent ('acl-test-' + [Guid]::NewGuid().ToString('N'))))
$expectedPrefix = [IO.Path]::GetFullPath($testParent) + [IO.Path]::DirectorySeparatorChar + 'acl-test-'
if (-not $testDir.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Test path escaped its workspace.' }
try {
    $child = Join-Path $testDir nested
    New-Item -ItemType Directory -Path $child -Force | Out-Null
    $file = Join-Path $child dummy.txt
    Write-Utf8 $file 'Dummy fixture; not a secret.'
    foreach ($path in @($child, $file)) {
        $acl = Get-Acl -LiteralPath $path
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new('S-1-1-0'), 'Read', 'Allow'))
        Set-Acl -LiteralPath $path -AclObject $acl
    }
    Set-ProtectedDirectory $testDir
    $approved = @('S-1-5-18', 'S-1-5-32-544', [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
    foreach ($path in @($testDir, $child, $file)) {
        $acl = Get-Acl -LiteralPath $path
        foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $approved) {
                throw 'An unapproved identity retained access.'
            }
        }
    }
    if (-not (Get-Acl -LiteralPath $testDir).AreAccessRulesProtected) { throw 'Parent inheritance was not disabled.' }
    if ((Get-Content -LiteralPath $file -Raw) -ne 'Dummy fixture; not a secret.') { throw 'ACL update changed file contents.' }
    Write-Output 'Actual Windows ACL check passed: inherited and explicit broad grants removed; fixture bytes preserved.'
}
finally {
    if ($testDir.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $testDir)) {
        Remove-Item -LiteralPath $testDir -Recurse -Force
    }
}
