#Requires -Version 7.4
. "$PSScriptRoot/Common.ps1"

function Invoke-BoundedProcess([string]$File, [string[]]$Arguments, [string]$InputText = '', [int]$TimeoutSeconds = 180, [switch]$AllowFailure) {
    $info = [Diagnostics.ProcessStartInfo]::new($File)
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::Start($info)
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
        $process.StandardInput.Write($InputText); $process.StandardInput.Close()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) { $process.Kill($true); throw "$File exceeded its bounded timeout." }
        $result = @{Code=$process.ExitCode; Out=$stdout.GetAwaiter().GetResult(); Err=$stderr.GetAwaiter().GetResult()}
        if ($result.Code -ne 0 -and -not $AllowFailure) { throw "$File failed ($($result.Code)): $($result.Out)$($result.Err)" }
        return $result
    } finally { $process.Dispose() }
}

function Invoke-RemoteDocker([string[]]$Arguments, [string]$InputText = '', [int]$TimeoutSeconds = 180) {
    return (Invoke-BoundedProcess docker (@('--host', $script:RemoteEndpoint) + $Arguments) $InputText $TimeoutSeconds).Out.Trim()
}

function Invoke-PrivateCaHttps([string]$Uri,[string]$CaFile,[int]$TimeoutSeconds=10) {
    if(([Uri]$Uri).Scheme -ne 'https') {throw 'HTTPS is required.'}
    $pem=[IO.File]::ReadAllText([IO.Path]::GetFullPath($CaFile))
    $ca=[Security.Cryptography.X509Certificates.X509Certificate2]::new([Convert]::FromBase64String(($pem -replace '-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s','')))
    $handler=[Net.Http.SocketsHttpHandler]::new()
    $policy=[Security.Cryptography.X509Certificates.X509ChainPolicy]::new()
    $policy.TrustMode=[Security.Cryptography.X509Certificates.X509ChainTrustMode]::CustomRootTrust
    $policy.CustomTrustStore.Add($ca)|Out-Null
    # This private CA issues no CRL/OCSP endpoint. Trust-chain, serverAuth and host/IP
    # validation remain enabled; no certificate callback or Windows-store change is used.
    $policy.RevocationMode=[Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
    $policy.ApplicationPolicy.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))|Out-Null
    $handler.SslOptions.CertificateChainPolicy=$policy
    $client=[Net.Http.HttpClient]::new($handler)
    $client.Timeout=[TimeSpan]::FromSeconds($TimeoutSeconds)
    $client.MaxResponseContentBufferSize=65536
    try {
        $response=$client.GetAsync($Uri).GetAwaiter().GetResult()
        try {$response.EnsureSuccessStatusCode()|Out-Null;return $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()}
        finally {$response.Dispose()}
    } finally {$client.Dispose();$ca.Dispose()}
}

function Send-DockerImages([string[]]$Images, [int]$TimeoutSeconds = 900) {
    # Use byte streams, not a PowerShell text pipeline or a plaintext secret-bearing image.
    $saveInfo = [Diagnostics.ProcessStartInfo]::new('docker')
    $loadInfo = [Diagnostics.ProcessStartInfo]::new('docker')
    foreach ($info in @($saveInfo, $loadInfo)) {
        $info.UseShellExecute = $false; $info.CreateNoWindow = $true
        $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    }
    foreach ($argument in @('image', 'save') + $Images) { $saveInfo.ArgumentList.Add($argument) }
    foreach ($argument in @('--host', $script:RemoteEndpoint, 'image', 'load')) { $loadInfo.ArgumentList.Add($argument) }
    $loadInfo.RedirectStandardInput = $true
    $save = [Diagnostics.Process]::Start($saveInfo); $load = [Diagnostics.Process]::Start($loadInfo)
    try {
        $saveError = $save.StandardError.ReadToEndAsync(); $loadError = $load.StandardError.ReadToEndAsync(); $loadOutput = $load.StandardOutput.ReadToEndAsync()
        $copy = $save.StandardOutput.BaseStream.CopyToAsync($load.StandardInput.BaseStream)
        if (-not $copy.Wait($TimeoutSeconds * 1000)) { throw 'Image transport exceeded its bounded timeout.' }
        $load.StandardInput.Close()
        if (-not $save.WaitForExit(30000) -or -not $load.WaitForExit(120000)) { throw 'Docker image transport did not finish.' }
        if ($save.ExitCode -ne 0 -or $load.ExitCode -ne 0) { throw ('Image transport failed: ' + $saveError.GetAwaiter().GetResult() + $loadError.GetAwaiter().GetResult()) }
        return $loadOutput.GetAwaiter().GetResult().Trim()
    } finally {
        foreach ($process in @($save, $load)) { if (-not $process.HasExited) { $process.Kill($true) }; $process.Dispose() }
    }
}
