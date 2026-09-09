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
if (Get-ChildItem -LiteralPath $secrets -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) {
    throw 'Secrets cannot contain reparse points.'
}
foreach ($name in @('postgres_password', 'db_password', 'worker_1_token', 'worker_2_token', 'worker_3_token', 'worker_4_token', 'worker_5_token')) {
    $path = Join-Path $secrets $name
    if (-not (Test-Path -LiteralPath $path)) { Write-Utf8 $path ([Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()) }
}
$envFile = Join-Path $root '.env'
if (Test-Path -LiteralPath $envFile) {
    if ((Get-Content -LiteralPath $envFile -Raw) -notmatch ('(?m)^' + [regex]::Escape("BROWSERSKILLS_BIND_IP=$ServerIp") + '\r?$')) { throw 'Existing .env targets a different address; do not overwrite an established deployment.' }
    if((Get-DeploymentOrigin) -ne "http://${ServerIp}:8080"){throw 'Existing origin differs; migrate that deployment explicitly.'}
} else {
    Write-Utf8 $envFile "BROWSERSKILLS_BIND_IP=$ServerIp`nBROWSERSKILLS_PUBLIC_ORIGIN=http://${ServerIp}:8080`nBROWSERSKILLS_RELEASE=0.1.0`n"
}
if ($ConfigureFirewall) {
    if ($ClientAddress.Count -eq 0 -or @($ClientAddress | Where-Object { $_ -in @('Any', '0.0.0.0/0', '::/0') }).Count) { throw 'Specify finite trusted client addresses/subnet.' }
    if (Get-NetFirewallRule -Name BrowserSkillsHttp -ErrorAction SilentlyContinue) { throw 'BrowserSkillsHttp firewall rule already exists; inspect before changing its scope.' }
    New-NetFirewallRule -Name BrowserSkillsHttp -DisplayName 'BrowserSkills HTTP (trusted LAN clients)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8080 -LocalAddress $ServerIp -RemoteAddress $ClientAddress -Profile Private,Domain | Out-Null
}
Write-Output 'LAN HTTP deployment credentials are ready. Existing secrets were preserved; no certificate is required.'
