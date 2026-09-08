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
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544', [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
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

function New-ServerCertificate([Security.Cryptography.RSA]$Key, [Security.Cryptography.X509Certificates.X509Certificate2]$Ca,
    [Net.IPAddress]$Ip, [DateTimeOffset]$Expiry) {
    $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new("CN=$Ip", $Key,
        [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    $san.AddIpAddress($Ip)
    $request.CertificateExtensions.Add($san.Build())
    $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
    $oids = [Security.Cryptography.OidCollection]::new()
    $oids.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1')) | Out-Null
    $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids, $true))
    return $request.Create($Ca, [DateTimeOffset]::UtcNow.AddMinutes(-5), $Expiry, [Security.Cryptography.RandomNumberGenerator]::GetBytes(16))
}
