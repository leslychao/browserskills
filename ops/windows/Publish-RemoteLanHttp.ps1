#Requires -Version 7.4
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Directory)
. "$PSScriptRoot/Remote-Common.ps1"
$directory=[IO.Path]::GetFullPath($Directory)
$migration=Get-Content -LiteralPath (Join-Path $directory lan-http-migration.json) -Raw|ConvertFrom-Json -AsHashtable
$script:RemoteEndpoint=$migration.endpoint
if($migration.project -ne 'browserskills' -or $migration.installId -notmatch '^[a-f0-9]{32}$'){throw 'Unexpected migration identity.'}
if((Get-FileHash -LiteralPath $migration.composeFile).Hash.ToLowerInvariant() -ne $migration.composeSha256){throw 'Reviewed migration config changed.'}
foreach($service in $migration.priorContainers.Keys){
    $item=@(Invoke-RemoteDocker @('inspect',"browserskills-$service-1")|ConvertFrom-Json -AsHashtable)[0]
    if($item.Id -ne $migration.priorContainers[$service].id -or $item.Config.Labels['browserskills.install-id'] -ne $migration.installId){throw "Service $service changed after preparation; review again."}
}
if(Invoke-RemoteDocker @('ps','--filter','publish=8080','--format','{{.ID}}')){throw 'Port 8080 became occupied.'}
$image=Invoke-BoundedProcess docker @('--host',$script:RemoteEndpoint,'image','inspect',$migration.apiImage,'--format','{{.Id}}') -AllowFailure
if($image.Code -ne 0){Write-Output 'Transferring the reviewed API image.';Send-DockerImages @($migration.apiImage)|Out-Null}
if((Invoke-RemoteDocker @('image','inspect',$migration.apiImage,'--format','{{.Id}}')) -ne $migration.apiImage){throw 'API image identity mismatch.'}
$compose=@('compose','--project-directory',(Get-ProjectRoot),'--project-name',$migration.project,'-f',$migration.composeFile)
Invoke-RemoteDocker ($compose+@('up','-d','--no-deps','--no-build','--pull','never','api')) '' 300|Out-Null
$healthy=$false
foreach($attempt in 1..40){
    try{$response=Invoke-WebRequest -Uri ($migration.origin+'/health/live') -TimeoutSec 3 -MaximumRedirection 0;if($response.StatusCode -eq 200){$healthy=$true;break}}catch{Start-Sleep -Seconds 2}
}
if(-not $healthy){throw 'HTTP API liveness failed; previous config artifacts remain available for rollback.'}
$readiness=Invoke-RemoteDocker ($compose+@('exec','-T','api','curl','--fail','--silent','--max-time','10','http://127.0.0.1:8080/health/ready'))|ConvertFrom-Json -AsHashtable
foreach($component in @('database','browser-1','browser-2','browser-3','browser-4','browser-5','inference')){if($readiness.components[$component] -ne 'UP'){throw "Component $component is not ready after API migration."}}
$after=@{}
foreach($service in $migration.priorContainers.Keys){
    $item=@(Invoke-RemoteDocker @('inspect',"browserskills-$service-1")|ConvertFrom-Json -AsHashtable)[0]
    if($service -ne 'api' -and $item.Id -ne $migration.priorContainers[$service].id){throw "Unexpected recreation of $service."}
    if($service -eq 'api'){
        if($item.Image -ne $migration.apiImage -or $item.HostConfig.PortBindings.Keys.Count -ne 1 -or -not $item.HostConfig.PortBindings.Contains('8080/tcp')){throw 'Actual API image/ports do not match the migration.'}
        if($item.Config.Env -notcontains ('API_MODEL_SHA256='+$migration.modelSha256)){throw 'Model identity changed.'}
        if($item.Mounts|Where-Object Type -EQ 'bind'){throw 'Unexpected host bind.'}
    }
    $after[$service]=@{id=$item.Id;image=$item.Image;state=$item.State.Status;portBindings=$item.HostConfig.PortBindings}
}
$credentialPath=Join-Path $directory operator-credentials.json
$credentials=Get-Content -LiteralPath $credentialPath -Raw|ConvertFrom-Json -AsHashtable
$credentials.origin=$migration.origin
Write-Utf8 $credentialPath ($credentials|ConvertTo-Json)
$credentials=$null
Write-Utf8 (Join-Path $directory lan-http-result.json) (@{completedAtUtc=[DateTime]::UtcNow.ToString('o');origin=$migration.origin;composeFile=$migration.composeFile;apiImage=$migration.apiImage;modelSha256=$migration.modelSha256;readiness=$readiness;containers=$after;preservedOtherContainers=7;credentialsPasswordUnchanged=$true}|ConvertTo-Json -Depth 12)
Write-Output "HTTP UI ready: $($migration.origin)"
Write-Output "Standalone config: $($migration.composeFile)"
Write-Output 'Seven other containers, model hash and operator password preserved.'
