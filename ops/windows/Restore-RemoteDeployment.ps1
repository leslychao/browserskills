#Requires -Version 7.4
[CmdletBinding()]
param([Parameter(Mandatory)][string]$DockerHost,[Parameter(Mandatory)][string]$Project,
    [Parameter(Mandatory)][string]$BackupDirectory,[Parameter(Mandatory)][string]$OutputDirectory)
. "$PSScriptRoot/Remote-Archive.ps1"
$script:RemoteEndpoint=$DockerHost
Assert-RemoteArchiveProject $Project
$backup=[IO.Path]::GetFullPath($BackupDirectory)
$output=[IO.Path]::GetFullPath($OutputDirectory)
if(Test-Path -LiteralPath $output){throw 'Choose a new output directory; no overwrite.'}
$manifest=Get-Content -LiteralPath (Join-Path $backup backup.json) -Raw|ConvertFrom-Json -AsHashtable
if(($manifest['schemaVersion'] -isnot [int] -and $manifest['schemaVersion'] -isnot [long]) -or $manifest['schemaVersion'] -ne 1 -or $manifest['transport'] -ne 'docker-api' -or
    $manifest['profilesStopped'] -isnot [bool] -or $manifest['profilesStopped'] -ne $true -or
    $manifest['profilesVerifiedClean'] -isnot [bool] -or $manifest['profilesVerifiedClean'] -ne $true){throw 'Unsupported or unverified remote backup manifest.'}
if($Project -eq $manifest.sourceProject){throw 'Restore requires a fresh project name distinct from the source.'}
if($manifest.maximumArchiveMiB -lt 16 -or $manifest.maximumArchiveMiB -gt 4096){throw 'Unsupported archive byte limit.'}
if(Get-ChildItem -LiteralPath $backup -Recurse -Force|Where-Object{$_.Attributes -band [IO.FileAttributes]::ReparsePoint}){throw 'Backup may not contain reparse points.'}
$required=@('source-compose.json','deployment.json','operator-credentials.json','seccomp-profile.json','database.dump')
foreach($file in $required){if(-not $manifest.files.Contains($file)){throw "Missing backup file: $file"}}
foreach($file in $manifest.files.Keys){
    if($file -notmatch '^(?:[a-zA-Z0-9_.-]+|secrets/ca_private\.key)$' -or $manifest.files[$file] -notmatch '^[a-f0-9]{64}$'){throw 'Unsupported backup file entry.'}
    if((Get-FileHash -LiteralPath (Join-Path $backup $file)).Hash.ToLowerInvariant() -ne $manifest.files[$file]){throw "Backup checksum mismatch: $file"}
}
$config=Get-Content -LiteralPath (Join-Path $backup source-compose.json) -Raw|ConvertFrom-Json -AsHashtable
$ephemeral=@(Get-EphemeralArchiveMounts $config)
$oldPlan=Get-Content -LiteralPath (Join-Path $backup deployment.json) -Raw|ConvertFrom-Json -AsHashtable
if($oldPlan.installId -ne $manifest.installId -or $oldPlan.project -ne $manifest.sourceProject){throw 'Backup deployment identity mismatch.'}
if(@($manifest.volumes|Where-Object kind -EQ profile).Count -ne 5 -or @($manifest.volumes|Where-Object kind -NE profile).Count -ne 8){throw 'Expected five profiles and eight secret/init archives.'}
$seen=[Collections.Generic.HashSet[string]]::new()
foreach($volume in $manifest.volumes){
    if($volume.service -notin @('api','postgres','browser-1','browser-2','browser-3','browser-4','browser-5') -or $volume.kind -notin @('profile','secret','init') -or
        $volume.archive -ne ($volume.service+'-'+$volume.kind+'.tar.gz') -or -not $seen.Add($volume.archive) -or -not $manifest.files.Contains($volume.archive)){throw 'Invalid volume archive identity.'}
    $expectedUid=if($volume.service -eq 'api'){10001}elseif($volume.service -eq 'postgres'){999}else{1001}
    $expectedTarget=if($volume.kind -eq 'profile'){'/data/profile'}elseif($volume.kind -eq 'init'){'/docker-entrypoint-initdb.d'}else{'/run/secrets'}
    if($volume.uid -ne $expectedUid -or $volume.target -ne $expectedTarget){throw 'Volume UID/target mismatch.'}
    $mount=@($config.services[$volume.service].volumes|Where-Object target -EQ $volume.target)
    if($mount.Count -ne 1 -or $mount[0].source -ne $volume.sourceKey -or $config.volumes[$volume.sourceKey].name -ne $volume.name){throw 'Archive does not match its source mount.'}
    $maximum=if($volume.kind -eq 'profile'){$manifest.maximumArchiveMiB*1MB}else{16MB}
    if((Get-Item -LiteralPath (Join-Path $backup $volume.archive)).Length -gt $maximum){throw 'Archive file exceeds its configured byte limit.'}
    Assert-RemoteTar (Join-Path $backup $volume.archive) ($maximum*4)
}
if((Get-Item -LiteralPath (Join-Path $backup database.dump)).Length -gt $manifest.maximumArchiveMiB*1MB){throw 'Database dump exceeds its configured byte limit.'}
# All input validation above precedes any Docker mutation.
$installId=[Guid]::NewGuid().ToString('N')
$operation=[Guid]::NewGuid().ToString('N')
$config.name=$Project
foreach($service in $config.services.Values){
    if($service.Contains('volumes') -and @($service.volumes|Where-Object type -EQ bind).Count){throw 'Remote restore cannot use source-host bind paths.'}
    $service.Remove('build');$service.pull_policy='never'
    $service.labels=@{'browserskills.install-id'=$installId;'browserskills.managed'='remote-restore'}
}
foreach($name in @($config.services.Keys)){
    if($name -like 'browser-*'){$config.services[$name].security_opt=@('no-new-privileges:true',('seccomp='+(Join-Path $output seccomp-profile.json)))}
}
foreach($key in @($config.volumes.Keys)){
    $name=$Project+'_'+$key
    $config.volumes[$key]=@{name=$name;external=$true}
}
foreach($key in @($config.networks.Keys)){$config.networks[$key].name=$Project+'_'+$key;$config.networks[$key].labels=@{'browserskills.install-id'=$installId;'browserskills.managed'='remote-restore'}}
foreach($image in @($manifest.images.Values|Select-Object -Unique)){Invoke-RemoteDocker @('image','inspect',$image,'--format','{{.Id}}')|Out-Null}
if(Invoke-RemoteDocker @('ps','-aq','--filter',"label=com.docker.compose.project=$Project")){throw 'Restore requires a fresh project; existing containers are preserved.'}
foreach($entry in @(@{kind='volume';names=@($config.volumes.Values|ForEach-Object{$_.name})},@{kind='network';names=@($config.networks.Values|ForEach-Object{$_.name})},@{kind='container';names=@($config.services.Keys|ForEach-Object{"$Project-$_-1"})})){
    foreach($name in $entry.names){
        $args=if($entry.kind -eq 'container'){@('inspect',$name)}else{@($entry.kind,'inspect',$name)}
        $r=Invoke-BoundedProcess docker (@('--host',$DockerHost)+$args) -AllowFailure
        if($r.Code -eq 0){throw "Restore requires empty fresh resources; existing $($entry.kind) $name is preserved."}
    }
}
Set-ProtectedDirectory $output
Copy-Item -LiteralPath (Join-Path $backup seccomp-profile.json) -Destination (Join-Path $output seccomp-profile.json)
Copy-Item -LiteralPath (Join-Path $backup operator-credentials.json) -Destination (Join-Path $output operator-credentials.json)
foreach($name in @('ca_cert.pem','secrets/ca_private.key')){if($manifest.files.Contains($name)){$target=Join-Path $output $name;[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))|Out-Null;Copy-Item -LiteralPath (Join-Path $backup $name) -Destination $target}}
$composeFile=Join-Path $output compose.remote.json
Write-Utf8 $composeFile ($config|ConvertTo-Json -Depth 100)
$compose=Get-ArchiveCompose $Project @($composeFile)
Invoke-RemoteDocker ($compose+@('config','--quiet'))|Out-Null
$helperImage=$manifest.images.postgres
$created=@()
$dataKeys=@($manifest.volumes|ForEach-Object{$_.sourceKey})+@(@($config.services.postgres.volumes|Where-Object target -EQ '/var/lib/postgresql/data')[0].source)+@($ephemeral|ForEach-Object{$_.sourceKey})
foreach($key in $dataKeys|Select-Object -Unique){
    $name=$config.volumes[$key].name
    Invoke-RemoteDocker @('volume','create','--label',"browserskills.install-id=$installId",'--label','browserskills.managed=remote-restore',$name)|Out-Null
    $created+=$name
}
$payloads=@()
foreach($volume in $ephemeral){
    $helper=$null
    try{
        $name=$config.volumes[$volume.sourceKey].name
        Assert-ArchiveOwner volume $name $installId
        $helper=Start-ArchiveHelper $helperImage $name $operation -Writable
        Invoke-RemoteDocker @('exec',$helper,'chown',"$($volume.uid):$($volume.uid)",'/data')|Out-Null
        Invoke-RemoteDocker @('exec',$helper,'chmod','0700','/data')|Out-Null
    }finally{if($helper){Stop-ArchiveHelper $helper $operation}}
}
foreach($volume in $manifest.volumes){
    $name=$config.volumes[$volume.sourceKey].name
    $helper=$null
    try{
        Assert-ArchiveOwner volume $name $installId
        $helper=Start-ArchiveHelper $helperImage $name $operation -Writable
        Invoke-RemoteDocker @('exec',$helper,'sh','-ec','test -z "$(find /data -mindepth 1 -maxdepth 1 -print -quit)"')|Out-Null
        $maximum=if($volume.kind -eq 'profile'){$manifest.maximumArchiveMiB*1MB}else{16MB}
        Copy-ArchiveProcess @('exec','-i',$helper,'tar','--extract','--gzip','--file=-','--directory=/data','--no-same-owner','--no-same-permissions','--keep-old-files') (Join-Path $backup $volume.archive) Send $maximum|Out-Null
        Invoke-RemoteDocker @('exec',$helper,'chown','-R',"$($volume.uid):$($volume.uid)",'/data')|Out-Null
        if($volume.kind -ne 'profile'){
            $mode=if($volume.kind -eq 'init'){'0500'}else{'0400'}
            Invoke-RemoteDocker @('exec',$helper,'chmod','0500','/data')|Out-Null
            foreach($file in $volume.files.Keys){
                if($file -notmatch '^[a-z0-9_.-]+$'){throw 'Unexpected secret filename.'}
                Invoke-RemoteDocker @('exec',$helper,'chmod',$mode,"/data/$file")|Out-Null
                if((Invoke-RemoteDocker @('exec','--user',"$($volume.uid)",$helper,'sha256sum',"/data/$file")).Split(' ')[0] -ne $volume.files[$file]){throw 'Restored secret/init checksum or runtime UID access failed.'}
            }
            $payloads+=@{volume=$name;uid=$volume.uid;files=$volume.files;executable=($volume.kind -eq 'init')}
        }
    }finally{if($helper){Stop-ArchiveHelper $helper $operation}}
}
Write-Output 'Starting only fresh PostgreSQL with the preserved role/password initialization.'
Invoke-RemoteDocker ($compose+@('up','-d','--no-build','--pull','never','postgres')) '' 180|Out-Null
$postgres=Invoke-RemoteDocker ($compose+@('ps','--quiet','postgres'))
$ready=$false
foreach($attempt in 1..30){$r=Invoke-BoundedProcess docker @('--host',$DockerHost,'exec',$postgres,'pg_isready','-h','127.0.0.1','-U','postgres','-d','browserskills') -AllowFailure;if($r.Code -eq 0){$ready=$true;break};Start-Sleep -Seconds 2}
if(-not $ready){throw 'Fresh PostgreSQL did not become ready.'}
$count=Invoke-RemoteDocker @('exec',$postgres,'psql','-U','postgres','-d','browserskills','-Atc',"SELECT count(*) FROM pg_tables WHERE schemaname='public'")
if($count -ne '0'){throw 'Restore requires an empty application database.'}
$role=Invoke-RemoteDocker @('exec',$postgres,'sh','-ec','PGPASSWORD=$(cat /run/secrets/db_password); export PGPASSWORD; exec psql -h 127.0.0.1 -U browserskills -d browserskills -Atc "SELECT current_user"')
if($role -ne 'browserskills'){throw 'Preserved database role/password compatibility check failed.'}
Copy-ArchiveProcess @('exec','-i',$postgres,'pg_restore','--exit-on-error','--single-transaction','--username=postgres','--dbname=browserskills') (Join-Path $backup database.dump) Send ($manifest.maximumArchiveMiB*1MB)|Out-Null
Invoke-RemoteDocker ($compose+@('up','--no-start','--no-build','--no-deps','--pull','never','api','browser-1','browser-2','browser-3','browser-4','browser-5')) '' 180|Out-Null
$newPlan=@{schemaVersion=1;installId=$installId;endpoint=$DockerHost;origin=$config.services.api.environment.BROWSERSKILLS_PUBLIC_ORIGIN;login=$oldPlan.login;project=$Project;payloads=$payloads;postgresImage=$helperImage;composeSha256=(Get-FileHash -LiteralPath $composeFile).Hash.ToLowerInvariant();restoredFrom=$manifest.sourceProject;createdAtUtc=[DateTime]::UtcNow.ToString('o')}
Write-Utf8 (Join-Path $output deployment.json) ($newPlan|ConvertTo-Json -Depth 12)
Write-Utf8 (Join-Path $output restore-result.json) (@{completedAtUtc=[DateTime]::UtcNow.ToString('o');project=$Project;installId=$installId;endpoint=$DockerHost;composeFile=$composeFile;createdVolumes=$created;images=$manifest.images;model=$manifest.model;apiAndWorkersStarted=$false;databasePasswordVerified=$true;sourceBackupSha256=(Get-FileHash -LiteralPath (Join-Path $backup backup.json)).Hash.ToLowerInvariant()}|ConvertTo-Json -Depth 10)
Write-Output "Remote restore complete: $output"
Write-Output 'Only PostgreSQL is running. API/workers remain stopped. Review the preserved origin/bind address and prepare model weights before starting this fresh deployment.'
