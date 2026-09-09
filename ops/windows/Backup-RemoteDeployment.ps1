#Requires -Version 7.4
[CmdletBinding()]
param([Parameter(Mandatory)][string]$DockerHost,[Parameter(Mandatory)][string]$DeploymentDirectory,
    [Parameter(Mandatory)][string[]]$ComposeFile,[Parameter(Mandatory)][string]$Destination,
    [ValidateRange(16,4096)][int]$MaximumArchiveMiB=2048)
. "$PSScriptRoot/Remote-Archive.ps1"
$script:RemoteEndpoint=$DockerHost
$directory=[IO.Path]::GetFullPath($DeploymentDirectory)
$destinationPath=[IO.Path]::GetFullPath($Destination)
if(Test-Path -LiteralPath $destinationPath){throw 'Choose a new backup directory; no overwrite.'}
$plan=Get-Content -LiteralPath (Join-Path $directory deployment.json) -Raw|ConvertFrom-Json -AsHashtable
Assert-RemoteArchiveProject $plan.project
if($plan.installId -notmatch '^[a-f0-9]{32}$' -or $plan.endpoint -ne $DockerHost){throw 'Deployment identity/endpoint mismatch.'}
$compose=Get-ArchiveCompose $plan.project $ComposeFile
$config=Invoke-RemoteDocker ($compose+@('config','--format','json'))|ConvertFrom-Json -AsHashtable
$hashes=Invoke-RemoteDocker ($compose+@('config','--hash','*'))
$serviceHashes=@{}
foreach($line in $hashes -split '\r?\n'){
    if($line -match '^([a-z0-9-]+)\s+([a-f0-9]{64})$'){$serviceHashes[$Matches[1]]=$Matches[2]}else{throw 'Could not validate effective Compose service hashes.'}
}
$services=@('api','postgres','browser-1','browser-2','browser-3','browser-4','browser-5')
$containers=@{};$images=@{}
foreach($service in $services){
    $id=Invoke-RemoteDocker ($compose+@('ps','--all','--quiet',$service))
    if(-not $id -or $id.Contains("`n")){throw "Expected one container for $service."}
    Assert-ArchiveOwner container $id $plan.installId
    $container=Get-ArchiveContainer $id
    if($container.Config.Labels['com.docker.compose.project'] -ne $plan.project){throw 'Container project mismatch.'}
    if($container.Config.Labels['com.docker.compose.config-hash'] -ne $serviceHashes[$service]){throw "Effective source Compose differs from live $service configuration; backup was not started."}
    if($container.Mounts|Where-Object Type -EQ bind){throw 'Remote recovery requires named volumes, not host binds.'}
    $containers[$service]=$container;$images[$service]=$container.Image
    $config.services[$service].image=$container.Image;$config.services[$service].Remove('build')
}
if(-not $containers.postgres.State.Running){throw 'PostgreSQL must be running for a consistent pg_dump.'}
$model=@{archived=$false;present=$false;apiModelSha256=(@($containers.api.Config.Env|Where-Object{$_ -like 'API_MODEL_SHA256=*'}) -join '') -replace '^API_MODEL_SHA256=',''}
if($config.services.Contains('inference')){
    $id=Invoke-RemoteDocker ($compose+@('ps','--all','--quiet','inference'))
    if($id){$inference=Get-ArchiveContainer $id;if($inference.Config.Labels['com.docker.compose.config-hash'] -ne $serviceHashes.inference){throw 'Effective source inference configuration differs from the running container.'};$model.present=$true;$model.containerId=$id;$model.image=$inference.Image;$config.services.inference.image=$inference.Image;$config.services.inference.Remove('build')}
}
$volumes=@()
foreach($service in $services){
    foreach($mount in $containers[$service].Mounts){
        if($mount.Destination -eq '/var/lib/postgresql/data'){Assert-ArchiveOwner volume $mount.Name $plan.installId;continue}
        if($mount.Destination -notin @('/data/profile','/run/secrets','/docker-entrypoint-initdb.d')){throw 'Unexpected persistent mount in the source deployment.'}
        Assert-ArchiveOwner volume $mount.Name $plan.installId
        $profile=$mount.Destination -eq '/data/profile'
        $uid=if($service -eq 'api'){10001}elseif($service -eq 'postgres'){999}else{1001}
        $kind=if($profile){'profile'}elseif($mount.Destination -eq '/docker-entrypoint-initdb.d'){'init'}else{'secret'}
        $key=@($config.services[$service].volumes|Where-Object target -EQ $mount.Destination)[0].source
        if($config.volumes[$key].name -ne $mount.Name){throw 'Rendered configuration does not match the mounted volume.'}
        $volumes+=@{service=$service;sourceKey=$key;name=$mount.Name;target=$mount.Destination;kind=$kind;uid=$uid;archive=($service+'-'+$kind+'.tar.gz')}
    }
}
if(@($volumes|Where-Object kind -EQ profile).Count -ne 5 -or @($volumes|Where-Object kind -NE profile).Count -ne 8){throw 'Expected five profiles and eight isolated secret/init volumes.'}
$operation=[Guid]::NewGuid().ToString('N')
$helperImage=$containers.postgres.Image
Set-ProtectedDirectory $destinationPath
$files=@{}
function Record([string]$Name){$files[$Name]=(Get-FileHash -LiteralPath (Join-Path $destinationPath $Name)).Hash.ToLowerInvariant()}
Write-Utf8 (Join-Path $destinationPath source-compose.json) ($config|ConvertTo-Json -Depth 100);Record source-compose.json
Copy-Item -LiteralPath (Join-Path $directory deployment.json) -Destination (Join-Path $destinationPath deployment.json);Record deployment.json
Copy-Item -LiteralPath (Join-Path $directory seccomp-profile.json) -Destination (Join-Path $destinationPath seccomp-profile.json);Record seccomp-profile.json
Copy-Item -LiteralPath (Join-Path $directory operator-credentials.json) -Destination (Join-Path $destinationPath operator-credentials.json);Record operator-credentials.json
# Optional historical CA material is local-only rollback data. Never generate or upload it.
foreach($name in @('ca_cert.pem','secrets/ca_private.key')){
    $source=Join-Path $directory $name
    if(Test-Path -LiteralPath $source -PathType Leaf){$target=Join-Path $destinationPath $name;[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))|Out-Null;Copy-Item -LiteralPath $source -Destination $target;Record $name}
}
Write-Output 'Stopping only the selected API and five workers for a consistent remote backup.'
Invoke-RemoteDocker ($compose+@('stop','-t','45','api','browser-1','browser-2','browser-3','browser-4','browser-5')) '' 90|Out-Null
Copy-ArchiveProcess @('exec',$containers.postgres.Id,'pg_dump','--username=postgres','--dbname=browserskills','--format=custom') (Join-Path $destinationPath database.dump) Receive ($MaximumArchiveMiB*1MB)|Out-Null
Record database.dump
foreach($volume in $volumes){
    $helper=$null
    try{
        Assert-ArchiveOwner volume $volume.name $plan.installId
        $helper=Start-ArchiveHelper $helperImage $volume.name $operation
        if($volume.kind -eq 'profile'){
            $current=Get-ArchiveContainer $containers[$volume.service].Id
            Assert-CleanArchiveProfile $current $helper
        }else{
            $payload=@($plan.payloads|Where-Object volume -EQ $volume.name)
            if($payload.Count -ne 1){throw 'Missing source secret payload identity.'}
            $names=Invoke-RemoteDocker @('exec',$helper,'find','/data','-mindepth','1','-maxdepth','1','-printf','%f\n')
            $actual=@($names -split '\r?\n'|Where-Object{$_})
            if($actual.Count -ne $payload[0].files.Keys.Count){throw 'Remote payload contains an unexpected file set.'}
            foreach($name in $actual){
                if($name -notmatch '^[a-z0-9_.-]+$' -or -not $payload[0].files.Contains($name)){throw 'Unexpected payload file.'}
                $hash=(Invoke-RemoteDocker @('exec',$helper,'sha256sum',"/data/$name")).Split(' ')[0]
                if($hash -ne $payload[0].files[$name]){throw 'Remote secret/init bytes differ from the protected deployment mirror.'}
            }
            $volume.files=$payload[0].files
        }
        $maximum=if($volume.kind -eq 'profile'){$MaximumArchiveMiB*1MB}else{16MB}
        $path=Join-Path $destinationPath $volume.archive
        Copy-ArchiveProcess @('exec',$helper,'tar','--format=pax','-czf','-','-C','/data','.') $path Receive $maximum|Out-Null
        Assert-RemoteTar $path ($maximum*4)
        Record $volume.archive
    }finally{if($helper){Stop-ArchiveHelper $helper $operation}}
}
$manifest=@{schemaVersion=1;transport='docker-api';createdAtUtc=[DateTime]::UtcNow.ToString('o');sourceEndpoint=$DockerHost;sourceEngineId=(Invoke-RemoteDocker @('info','--format','{{.ID}}'));sourceProject=$plan.project;installId=$plan.installId;profilesStopped=$true;profilesVerifiedClean=$true;files=$files;volumes=$volumes;images=$images;model=$model;maximumArchiveMiB=$MaximumArchiveMiB}
# Final manifest is the commit marker. Every error leaves an explicitly incomplete backup.
Write-Utf8 (Join-Path $destinationPath backup.json) ($manifest|ConvertTo-Json -Depth 15)
Write-Output "Remote backup complete: $destinationPath"
Write-Output 'API/workers remain stopped. Database and model were not stopped; model weights were not archived.'
