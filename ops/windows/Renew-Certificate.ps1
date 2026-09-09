#Requires -Version 7.4
[CmdletBinding()]
param([string]$ServerIp = '192.168.0.107')
. "$PSScriptRoot/Common.ps1"
Assert-Administrator
$root = Get-ProjectRoot
$secrets = Join-Path $root secrets
$ip = [Net.IPAddress]::Parse($ServerIp)
if ($ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
    -not (Get-NetIPAddress -AddressFamily IPv4 | Where-Object IPAddress -EQ $ServerIp)) {
    throw 'Renew TLS locally for the specific IPv4 address assigned to this server.'
}
if ((Get-Content -LiteralPath (Join-Path $root '.env') -Raw) -notmatch
    ('(?m)^' + [regex]::Escape("BROWSERSKILLS_PUBLIC_ORIGIN=https://${ServerIp}:8443") + '\r?$')) {
    throw 'Certificate IP must match the configured public origin; do not break an existing deployment.'
}
Set-ProtectedDirectory $secrets
$ca = [Security.Cryptography.X509Certificates.X509Certificate2]::CreateFromPemFile((Join-Path $secrets ca_cert.pem), (Join-Path $secrets ca_private.key))
$key = [Security.Cryptography.RSA]::Create()
try {
    $key.ImportFromPem((Get-Content -LiteralPath (Join-Path $secrets api_key) -Raw))
    $expiry = [DateTimeOffset]::UtcNow.AddDays(365)
    if ($expiry -gt [DateTimeOffset]$ca.NotAfter) { $expiry = ([DateTimeOffset]$ca.NotAfter).AddMinutes(-1) }
    if ($expiry -lt [DateTimeOffset]::UtcNow.AddDays(14)) { throw 'CA expires in under two weeks; plan CA rotation and client trust distribution.' }
    $cert = New-ServerCertificate $key $ca $ip $expiry
    $pending = Join-Path $secrets api_cert.pending
    Write-Utf8 $pending ($cert.ExportCertificatePem() + "`n" + $ca.ExportCertificatePem())
    Invoke-Compose @('stop', '-t', '45', 'api')
    Copy-Item -LiteralPath (Join-Path $secrets api_cert) -Destination (Join-Path $secrets api_cert.previous)
    [IO.File]::Move($pending, (Join-Path $secrets api_cert), $true)
    Invoke-Compose @('up', '-d', '--no-build', 'api')
    Write-Output 'API certificate renewed with the existing CA/key. Previous certificate retained for rollback; client trust is unchanged.'
} finally { $key.Dispose(); $ca.Dispose() }
