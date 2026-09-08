#Requires -Version 7.4
. "$PSScriptRoot/../windows/Common.ps1"
$tokens = $null
$parseErrors = $null
Get-ChildItem "$PSScriptRoot/../windows/*.ps1" | ForEach-Object {
    [void][Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
}
$caKey = [Security.Cryptography.RSA]::Create(3072)
$serverKey = [Security.Cryptography.RSA]::Create(3072)
try {
    $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=Test CA', $caKey,
        [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $false, 0, $true))
    $ca = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5), [DateTimeOffset]::UtcNow.AddYears(2))
    $cert = New-ServerCertificate $serverKey $ca ([Net.IPAddress]::Parse('192.168.0.107')) ([DateTimeOffset]::UtcNow.AddYears(1))
    $chain = [Security.Cryptography.X509Certificates.X509Chain]::new()
    $chain.ChainPolicy.TrustMode = [Security.Cryptography.X509Certificates.X509ChainTrustMode]::CustomRootTrust
    $chain.ChainPolicy.CustomTrustStore.Add($ca) | Out-Null
    $chain.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
    $chain.ChainPolicy.ApplicationPolicy.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1')) | Out-Null
    if (-not $chain.Build($cert)) { throw 'Issued server certificate did not validate against its CA/serverAuth policy.' }
    $san = $cert.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' }
    if ([Convert]::ToHexString($san.RawData) -ne '30068704C0A8006B') { throw 'Certificate does not contain the exact IPv4 SAN.' }
    $importedKey = [Security.Cryptography.RSA]::Create()
    $importedKey.ImportFromPem($serverKey.ExportPkcs8PrivateKeyPem())
    $message = [Text.Encoding]::UTF8.GetBytes('certificate key roundtrip')
    $signature = $importedKey.SignData($message, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $publicKey = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($cert)
    if (-not $publicKey.VerifyData($message, $signature, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)) { throw 'Certificate/private key mismatch.' }
    $publicKey.Dispose(); $importedKey.Dispose(); $chain.Dispose(); $cert.Dispose(); $ca.Dispose()
} finally { $serverKey.Dispose(); $caKey.Dispose() }
Write-Output 'PowerShell parsed; generated TLS chain, serverAuth EKU, exact IP SAN and PKCS8 key roundtrip verified. No certificate store, service or firewall was changed.'
