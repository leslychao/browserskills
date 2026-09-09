#Requires -Version 7.4
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Directory, [Parameter(Mandatory)][string[]]$ComposeFile, [Parameter(Mandatory)][string]$ApiImage)
. "$PSScriptRoot/Remote-Common.ps1"
$directory=[IO.Path]::GetFullPath($Directory)
$plan=Get-Content -LiteralPath (Join-Path $directory deployment.json) -Raw|ConvertFrom-Json -AsHashtable
if($plan.project -ne 'browserskills' -or $plan.installId -notmatch '^[a-f0-9]{32}$'){throw 'Unexpected deployment identity.'}
$script:RemoteEndpoint=$plan.endpoint
$arguments=@('compose','--project-directory',(Get-ProjectRoot),'--project-name',$plan.project)
foreach($file in $ComposeFile){$arguments+=@('-f',[IO.Path]::GetFullPath($file))}
$config=Invoke-RemoteDocker ($arguments+@('config','--format','json'))|ConvertFrom-Json -AsHashtable
$image=(Invoke-BoundedProcess docker @('image','inspect',$ApiImage,'--format','{{.Id}}')).Out.Trim()
if($image -notmatch '^sha256:[a-f0-9]{64}$'){throw 'An immutable local API image is required.'}
$existing=@{}
foreach($service in @('api','postgres','browser-1','browser-2','browser-3','browser-4','browser-5','inference')){
    $item=@(Invoke-RemoteDocker @('inspect',"browserskills-$service-1")|ConvertFrom-Json -AsHashtable)[0]
    if($item.Config.Labels['browserskills.install-id'] -ne $plan.installId){throw "Unexpected ownership for $service."}
    if(-not $item.State.Running){throw "Expected running service $service."}
    $existing[$service]=@{id=$item.Id;image=$item.Image}
}
if(Invoke-RemoteDocker @('ps','--filter','publish=8080','--format','{{.ID}}')){throw 'Port 8080 is already published; no mutation performed.'}
$origin='http://'+([Uri]$plan.origin).Host+':8080'
$config.services.api.image=$image
$config.services.api.environment.SERVER_PORT='8080'
$config.services.api.environment.SERVER_SSL_ENABLED='false'
$config.services.api.environment.SERVER_SERVLET_SESSION_COOKIE_SECURE='false'
$config.services.api.environment.BROWSERSKILLS_PUBLIC_ORIGIN=$origin
$config.services.api.ports=@(@{target=8080;published='8080';host_ip=([Uri]$origin).Host;protocol='tcp';mode='ingress'})
$output=Join-Path $directory compose.lan-http.json
$manifest=Join-Path $directory lan-http-migration.json
if((Test-Path -LiteralPath $output) -or (Test-Path -LiteralPath $manifest)){throw 'Migration artifacts already exist; do not overwrite reviewed state.'}
Write-Utf8 $output ($config|ConvertTo-Json -Depth 100)
$migration=@{schemaVersion=1;installId=$plan.installId;endpoint=$plan.endpoint;origin=$origin;project=$plan.project;apiImage=$image;priorOrigin=$plan.origin;priorComposeFiles=@($ComposeFile|ForEach-Object{[IO.Path]::GetFullPath($_)});priorContainers=$existing;composeFile=$output;composeSha256=(Get-FileHash -LiteralPath $output).Hash.ToLowerInvariant();modelSha256=$config.services.api.environment.API_MODEL_SHA256;createdAtUtc=[DateTime]::UtcNow.ToString('o')}
# The rendered config is standalone; changing ports cannot leave the former HTTPS publication behind.
Write-Utf8 $manifest ($migration|ConvertTo-Json -Depth 12)
Invoke-RemoteDocker @('compose','--project-directory',(Get-ProjectRoot),'--project-name',$plan.project,'-f',$output,'config','--quiet')|Out-Null
Write-Output "Prepared API-only migration: $manifest"
Write-Output "New origin: $origin; seven other containers must retain their IDs."
