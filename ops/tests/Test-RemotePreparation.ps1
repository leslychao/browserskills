#Requires -Version 7.4
[CmdletBinding()]
param([string]$ApiImage='browserskills-api:lan-http',[string]$BrowserImage='browserskills-browser:local')
. "$PSScriptRoot/../windows/Remote-Common.ps1"
# Prepare writes protected local files only; this test never contacts the target daemon.
$lines=@(& "$PSScriptRoot/../windows/Prepare-RemoteUi.ps1" -ApiImage $ApiImage -BrowserImage $BrowserImage)
$pathLine=@($lines|Where-Object{$_ -like 'Prepared local deployment: *'})
if($pathLine.Count -ne 1){throw 'Preparation did not produce one reviewable deployment directory.'}
$directory=$pathLine[0].Substring('Prepared local deployment: '.Length)
$config=Get-Content -LiteralPath (Join-Path $directory compose.remote.json) -Raw|ConvertFrom-Json -AsHashtable
$plan=Get-Content -LiteralPath (Join-Path $directory deployment.json) -Raw|ConvertFrom-Json -AsHashtable
if($plan.origin -ne 'http://192.168.0.107:8080'){throw 'Wrong LAN origin.'}
if($config.services.api.environment.SERVER_PORT -ne '8080' -or $config.services.api.environment.SERVER_SSL_ENABLED -ne 'false' -or $config.services.api.environment.SERVER_SERVLET_SESSION_COOKIE_SECURE -ne 'false'){throw 'HTTP listener/session configuration mismatch.'}
$ports=@($config.services.Values|ForEach-Object{if($_.Contains('ports')){$_.ports}})
if($ports.Count -ne 1 -or $ports[0].published -ne '8080' -or $ports[0].target -ne 8080 -or $ports[0].host_ip -ne '192.168.0.107'){throw 'Only the selected API LAN port may be published.'}
foreach($service in $config.services.Values){
    if($service.Contains('secrets')){throw 'Remote daemon cannot consume client file secrets.'}
    if($service.Contains('volumes') -and @($service.volumes|Where-Object type -EQ bind).Count){throw 'Remote deployment contains a host bind path.'}
}
if(Get-ChildItem -LiteralPath $directory -Recurse -File|Where-Object{$_.Name -match '^(api_cert|api_key|ca_cert\.pem|ca_private\.key)$'}){throw 'LAN bootstrap must not generate certificates.'}
foreach($number in 1..5){
    $payload=@($plan.payloads|Where-Object volume -EQ "browserskills_worker_${number}_secrets")
    if($payload.Count -ne 1 -or $payload[0].uid -ne 1001 -or $payload[0].files.Keys.Count -ne 1 -or -not $payload[0].files.Contains('worker_token')){throw 'Worker secret scope differs from its isolated identity.'}
}
foreach($payload in $plan.payloads){foreach($file in $payload.files.Keys){if((Get-FileHash -LiteralPath (Join-Path $directory "payload/$($payload.volume)/$file")).Hash.ToLowerInvariant() -ne $payload.files[$file]){throw 'Prepared upload checksum mismatch.'}}}
$credentials=Get-Content -LiteralPath (Join-Path $directory operator-credentials.json) -Raw|ConvertFrom-Json
if($credentials.origin -ne $plan.origin -or $credentials.password.Length -lt 32){throw 'Prepared account contract is incomplete.'}
$credentials=$null
$report=@{passed=$true;preparedAtUtc=[DateTime]::UtcNow.ToString('o');origin=$plan.origin;checks=@('HTTP-only API publication','no remote host binds','no file secrets','no generated certificates','five isolated token payloads','actual payload SHA256','protected account origin');directory=$directory;images=$plan.images}
Write-Utf8 (Join-Path $directory preparation-test-result.json) ($report|ConvertTo-Json -Depth 6)
Write-Output "Remote HTTP preparation test passed; protected evidence: $directory"
