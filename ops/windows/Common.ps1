#Requires -Version 7.4
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-Administrator {
    if (-not $IsWindows) { throw 'Windows is required.' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run PowerShell 7.4+ as Administrator on the server.'
    }
}

function Write-Utf8([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

function Set-ProtectedDirectory([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Protected directories cannot be created through reparse points.'
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    $children = @(Get-ChildItem -LiteralPath $Path -Recurse -Force)
    if ($children | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) {
        throw 'Protected directories cannot contain reparse points.'
    }
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544', [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
    foreach ($child in $children) {
        # Existing files may have explicit grants that do not disappear when the parent is protected.
        $childAcl = Get-Acl -LiteralPath $child.FullName
        $childAcl.SetAccessRuleProtection($false, $false)
        foreach ($rule in @($childAcl.Access | Where-Object { -not $_.IsInherited })) { $childAcl.RemoveAccessRuleAll($rule) }
        Set-Acl -LiteralPath $child.FullName -AclObject $childAcl
    }
}

function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw ('Native command failed: {0} (exit {1}).' -f [IO.Path]::GetFileName($Executable), $LASTEXITCODE) }
}

function Get-ProjectRoot {
    return [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
}

function Invoke-Compose([string[]]$Arguments) {
    $projectRoot = Get-ProjectRoot
    Invoke-Checked docker (@('compose', '--project-directory', $projectRoot, '-f', (Join-Path $projectRoot 'compose.yaml')) + $Arguments)
}

function Assert-Docker {
    $info = & docker info --format '{{.OSType}}'
    if ($LASTEXITCODE -ne 0 -or $info -ne 'linux') { throw 'Docker Desktop must be running with the WSL2 Linux engine.' }
}

function Get-DeploymentOrigin {
    $root=Get-ProjectRoot
    $entries=@(Get-Content -LiteralPath (Join-Path $root '.env') | Where-Object { $_ -match '^BROWSERSKILLS_PUBLIC_ORIGIN=' })
    if($entries.Count -ne 1){throw 'Exactly one BROWSERSKILLS_PUBLIC_ORIGIN is required in .env.'}
    $origin=$entries[0] -replace '^BROWSERSKILLS_PUBLIC_ORIGIN=',''
    $uri=[Uri]$origin
    if($uri.Scheme -ne 'http' -or $uri.Port -ne 8080 -or $uri.UserInfo -or $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment){
        throw 'Expected LAN HTTP origin on port 8080. Review migration of an existing deployment before starting it.'
    }
    return $origin
}
