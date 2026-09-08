#Requires -Version 7.4
[CmdletBinding()]
param([string]$ServerIp = '192.168.0.107', [string[]]$ClientAddress = @('192.168.0.0/24'), [switch]$ConfigureFirewall)
. "$PSScriptRoot/Common.ps1"
Assert-Administrator
$ip = [Net.IPAddress]::Parse($ServerIp)
if ($ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $ip.Equals([Net.IPAddress]::Any)) { throw 'A specific local IPv4 address is required.' }
if (-not (Get-NetIPAddress -AddressFamily IPv4 | Where-Object IPAddress -EQ $ServerIp)) { throw 'ServerIp is not assigned to this machine. Run this script locally on the intended server.' }
$root = Get-ProjectRoot
$secrets = Join-Path $root secrets
Set-ProtectedDirectory $secrets
foreach ($name in @('postgres_password', 'db_password', 'worker_1_token', 'worker_2_token', 'worker_3_token', 'worker_4_token', 'worker_5_token')) {
    $path = Join-Path $secrets $name
    if (-not (Test-Path -LiteralPath $path)) { Write-Utf8 $path ([Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()) }
}
$certPath = Join-Path $secrets api_cert
$keyPath = Join-Path $secrets api_key
if ((Test-Path -LiteralPath $certPath) -xor (Test-Path -LiteralPath $keyPath)) { throw 'Partial TLS setup: preserve existing files and repair before proceeding.' }
if (-not (Test-Path -LiteralPath $certPath)) {
    $caKey = [Security.Cryptography.RSA]::Create(3072)
    $serverKey = [Security.Cryptography.RSA]::Create(3072)
    try {
        $caRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=BrowserSkills private CA', $caKey, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $caRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $false, 0, $true))
        $caRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign, $true))
        $ca = $caRequest.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5), [DateTimeOffset]::UtcNow.AddYears(5))
        $cert = New-ServerCertificate $serverKey $ca $ip ([DateTimeOffset]::UtcNow.AddDays(365))
        Write-Utf8 (Join-Path $secrets ca_cert.pem) $ca.ExportCertificatePem()
        Write-Utf8 (Join-Path $secrets ca_private.key) $caKey.ExportPkcs8PrivateKeyPem()
        Write-Utf8 $certPath ($cert.ExportCertificatePem() + "`n" + $ca.ExportCertificatePem())
        Write-Utf8 $keyPath $serverKey.ExportPkcs8PrivateKeyPem()
    } finally { $caKey.Dispose(); $serverKey.Dispose() }
}
$envFile = Join-Path $root '.env'
if (Test-Path -LiteralPath $envFile) {
    if ((Get-Content -LiteralPath $envFile -Raw) -notmatch [regex]::Escape("BROWSERSKILLS_BIND_IP=$ServerIp")) { throw 'Existing .env targets a different address; do not overwrite an established deployment.' }
} else {
    Write-Utf8 $envFile "BROWSERSKILLS_BIND_IP=$ServerIp`nBROWSERSKILLS_PUBLIC_ORIGIN=https://${ServerIp}:8443`nBROWSERSKILLS_RELEASE=0.1.0`n"
}
if ($ConfigureFirewall) {
    if ($ClientAddress.Count -eq 0 -or @($ClientAddress | Where-Object { $_ -in @('Any', '0.0.0.0/0', '::/0') }).Count) { throw 'Specify finite trusted client addresses/subnet.' }
    if (Get-NetFirewallRule -Name BrowserSkillsHttps -ErrorAction SilentlyContinue) { throw 'BrowserSkillsHttps firewall rule already exists; inspect before changing its scope.' }
    New-NetFirewallRule -Name BrowserSkillsHttps -DisplayName 'BrowserSkills HTTPS (trusted LAN clients)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8443 -LocalAddress $ServerIp -RemoteAddress $ClientAddress -Profile Private,Domain | Out-Null
}
Write-Output 'Deployment secrets and TLS are ready. Only ca_cert.pem is distributed to clients. Existing secrets were preserved.'
