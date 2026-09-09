#Requires -Version 7.4
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Directory,[Parameter(Mandatory)][string]$ComposeFile,
    [Parameter(Mandatory)][string]$ApiImage,[Parameter(Mandatory)][string]$BrowserImage,
    [Parameter(Mandatory)][string]$InferenceImage)
. "$PSScriptRoot/Remote-Archive.ps1"
$directory=[IO.Path]::GetFullPath($Directory)
$source=[IO.Path]::GetFullPath($ComposeFile)
$plan=Get-Content -LiteralPath (Join-Path $directory deployment.json) -Raw|ConvertFrom-Json -AsHashtable
if($plan.project -ne 'browserskills' -or $plan.installId -notmatch '^[a-f0-9]{32}$'){throw 'Unexpected deployment identity.'}
$script:RemoteEndpoint=$plan.endpoint
$compose=Get-ArchiveCompose $plan.project @($source)
$config=Invoke-RemoteDocker ($compose+@('config','--format','json'))|ConvertFrom-Json -AsHashtable
$origin=$config.services.api.environment.BROWSERSKILLS_PUBLIC_ORIGIN
if($origin -ne 'http://192.168.0.107:8080'){throw 'This update is scoped to the approved LAN HTTP deployment.'}
$stamp=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,8)
$release=Join-Path $directory ('yang-'+$stamp)
Set-ProtectedDirectory $release
$output=Join-Path $release compose.yang.json
$backup=Join-Path $release backup
$before=@{};$services=@('api','browser-1','browser-2','browser-3','browser-4','browser-5','postgres','inference')
foreach($service in $services){
    $id=Invoke-RemoteDocker ($compose+@('ps','--all','--quiet',$service))
    Assert-ArchiveOwner container $id $plan.installId
    $item=Get-ArchiveContainer $id
    if(-not $item.State.Running){throw "Expected running $service before update."}
    $before[$service]=@{id=$item.Id;image=$item.Image;mounts=@($item.Mounts|ForEach-Object{@{name=$_.Name;target=$_.Destination;type=$_.Type}})}
}
$apiId=(Invoke-BoundedProcess docker @('image','inspect',$ApiImage,'--format','{{.Id}}')).Out.Trim()
$browserId=(Invoke-BoundedProcess docker @('image','inspect',$BrowserImage,'--format','{{.Id}}')).Out.Trim()
$inferenceId=(Invoke-BoundedProcess docker @('image','inspect',$InferenceImage,'--format','{{.Id}}')).Out.Trim()
foreach($id in @($apiId,$browserId,$inferenceId)){
    if($id -notmatch '^sha256:[a-f0-9]{64}$'){throw 'Expected immutable built images.'}
    $exists=Invoke-BoundedProcess docker @('--host',$script:RemoteEndpoint,'image','inspect',$id,'--format','{{.Id}}') -AllowFailure
    if($exists.Code -ne 0){Send-DockerImages @($id)|Out-Null}
    if((Invoke-RemoteDocker @('image','inspect',$id,'--format','{{.Id}}')) -ne $id){throw 'Transferred image identity mismatch.'}
}
$config.services.api.image=$apiId
$config.services.inference.image=$inferenceId
$config.services.api.environment.API_MATERIALS_DIR='/data/materials'
$config.services.api.environment.API_QUALITY_EVIDENCE_PATH='/app/config/quality-evidence.json'
foreach($service in $services){$config.services[$service].Remove('build')}
function AddScratch([string]$Service,[string]$Key,[string]$Target){
    if(@($config.services[$Service].volumes|Where-Object target -EQ $Target).Count){return}
    if($config.volumes.Contains($Key)){throw 'Unexpected existing scratch volume key.'}
    $config.volumes[$Key]=@{name=$plan.project+'_'+$Key;external=$true}
    $config.services[$Service].volumes+=@{type='volume';source=$Key;target=$Target}
}
AddScratch api materials /data/materials
foreach($n in 1..5){$service="browser-$n";$config.services[$service].image=$browserId;$config.services[$service].environment.MEDIA_DIR='/data/media';AddScratch $service "browserMedia$n" /data/media}
Write-Utf8 $output ($config|ConvertTo-Json -Depth 100)
$newCompose=Get-ArchiveCompose $plan.project @($output)
Invoke-RemoteDocker ($newCompose+@('config','--quiet'))|Out-Null
$record=@{startedAtUtc=[DateTime]::UtcNow.ToString('o');origin=$origin;sourceCompose=$source;composeFile=$output;composeSha256=(Get-FileHash -LiteralPath $output).Hash.ToLowerInvariant();apiImage=$apiId;browserImage=$browserId;inferenceImage=$inferenceId;modelSha256=$config.services.api.environment.API_MODEL_SHA256;before=$before;backup=$backup;completed=$false}
Write-Utf8 (Join-Path $release update.json) ($record|ConvertTo-Json -Depth 16)
# The real backup verifies live Compose hashes before stopping API/workers, then
# preserves the pre-V2 database and clean Chromium profiles. Model weights and PostgreSQL are retained.
& "$PSScriptRoot/Backup-RemoteDeployment.ps1" -DockerHost $script:RemoteEndpoint -DeploymentDirectory $directory -ComposeFile $source -Destination $backup
if(-not (Test-Path -LiteralPath (Join-Path $backup backup.json))){throw 'Backup is incomplete; update aborted.'}
foreach($entry in @(Get-EphemeralArchiveMounts $config)){
    $existing=Invoke-BoundedProcess docker @('--host',$script:RemoteEndpoint,'volume','inspect',$entry.name) -AllowFailure
    if($existing.Code -eq 0){Assert-ArchiveOwner volume $entry.name $plan.installId;continue}
    Invoke-RemoteDocker @('volume','create','--label',"browserskills.install-id=$($plan.installId)",$entry.name)|Out-Null
    $helper=Start-ArchiveHelper $before.postgres.image $entry.name $plan.installId -Writable
    try{Invoke-RemoteDocker @('exec',$helper,'chown',"$($entry.uid):$($entry.uid)",'/data')|Out-Null;Invoke-RemoteDocker @('exec',$helper,'chmod','0700','/data')|Out-Null}finally{Stop-ArchiveHelper $helper $plan.installId}
}
Invoke-RemoteDocker ($newCompose+@('up','-d','--no-deps','--no-build','--pull','never','browser-1','browser-2','browser-3','browser-4','browser-5','inference','api')) '' 300|Out-Null
$healthy=$false
foreach($attempt in 1..45){
    try{if((Invoke-WebRequest -Uri ($origin+'/health/live') -TimeoutSec 3 -MaximumRedirection 0).StatusCode -eq 200){$healthy=$true;break}}catch{}
    Start-Sleep -Seconds 2
}
if(-not $healthy){throw "HTTP liveness failed. Preserve $release; rollback after V2 requires its database backup in fresh volumes."}
$ready=$null
foreach($attempt in 1..60){
    try{
        $ready=Invoke-RemoteDocker ($newCompose+@('exec','-T','api','curl','--fail','--silent','--max-time','10','http://127.0.0.1:8080/health/ready'))|ConvertFrom-Json -AsHashtable
        if(@(@('database','browser-1','browser-2','browser-3','browser-4','browser-5','inference')|Where-Object{$ready.components[$_] -ne 'UP'}).Count -eq 0){break}
    }catch{}
    Start-Sleep -Seconds 3
}
foreach($component in @('database','browser-1','browser-2','browser-3','browser-4','browser-5','inference')){if(-not $ready -or $ready.components[$component] -ne 'UP'){throw "Component $component is not ready; preserve update evidence."}}
$after=@{}
foreach($service in $services){
    $id=Invoke-RemoteDocker ($newCompose+@('ps','--all','--quiet',$service));$item=Get-ArchiveContainer $id
    Assert-ArchiveOwner container $id $plan.installId
    if($service -eq 'postgres' -and $id -ne $before[$service].id){throw 'Database container was replaced.'}
    $expected=if($service -eq 'api'){$apiId}elseif($service -like 'browser-*'){$browserId}elseif($service -eq 'inference'){$inferenceId}else{$before[$service].image}
    if($item.Image -ne $expected){throw 'Actual runtime image mismatch.'}
    foreach($mount in $before[$service].mounts){if(@($item.Mounts|Where-Object{ $_.Destination -eq $mount.target -and $_.Name -eq $mount.name -and $_.Type -eq $mount.type }).Count -ne 1){throw 'Existing persistent mount changed.'}}
    $after[$service]=@{id=$id;image=$item.Image;running=$item.State.Running}
}
$record.after=$after;$record.readiness=$ready;$record.completed=$true;$record.completedAtUtc=[DateTime]::UtcNow.ToString('o')
Write-Utf8 (Join-Path $release update.json) ($record|ConvertTo-Json -Depth 16)
Write-Output "Updated Yang application: $origin"
Write-Output "Active standalone Compose: $output"
Write-Output 'Database container, model weights and existing credentials/profiles preserved; model categories still require measured admission.'
