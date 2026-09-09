#Requires -Version 7.4
[CmdletBinding()]
param([ValidateSet('npipe:////./pipe/dockerDesktopLinuxEngine')][string]$DockerHost='npipe:////./pipe/dockerDesktopLinuxEngine',
    [string]$ApiImage='browserskills-api:lan-http',[string]$BrowserImage='browserskills-browser:local')
. "$PSScriptRoot/../windows/Remote-Archive.ps1"
$script:RemoteEndpoint=$DockerHost
$repository=Get-ProjectRoot
$id='browserskills-remote-rt-'+[Guid]::NewGuid().ToString('N').Substring(0,10)
$testRoot=Join-Path $repository "runtime/$id"
Set-ProtectedDirectory $testRoot
$sourceProject=$id+'-source';$targetProject=$id+'-restored';$blockedProject=$id+'-nonempty'
$source=Join-Path $testRoot source;$target=Join-Path $testRoot restored;$backup=Join-Path $testRoot backup
Set-ProtectedDirectory $source
$installId=[Guid]::NewGuid().ToString('N')
$cleanup=@(@{project=$sourceProject;installId=$installId})
$report=[ordered]@{passed=$false;startedAtUtc=[DateTime]::UtcNow.ToString('o');endpoint=$DockerHost;testId=$id;checks=@{}}
$helperImage='postgres:17.9-bookworm@sha256:47f917f7409eacd22fc5dfb1dee634e1b55cf0c01d1a7eb701be2227a03e0641'
$baseTag=$id+':base';$fixtureTag=$id+':fixture'
function D([string[]]$Arguments){return Invoke-RemoteDocker $Arguments}
function Dc([string]$Directory,[string]$Project,[string[]]$Arguments,[string]$InputText=''){
    return Invoke-RemoteDocker ((Get-ArchiveCompose $Project @((Join-Path $Directory compose.remote.json)))+$Arguments) $InputText 300
}
function Sql([string]$Directory,[string]$Project,[string]$Query){return Dc $Directory $Project @('exec','-T','postgres','psql','-U','postgres','-d','browserskills','-v','ON_ERROR_STOP=1','-Atc',$Query)}
function DbEvidence([string]$Directory,[string]$Project){
    $result=[ordered]@{}
    foreach($table in @('flyway_schema_history','users','browser_assignments','runs','run_items','ai_usage','selection_settings')){
        $result[$table]=(Sql $Directory $Project "SELECT json_build_object('count',count(*),'digest',md5(COALESCE(string_agg(row_to_json(t)::text,E'\n' ORDER BY row_to_json(t)::text),''))) FROM $table t")|ConvertFrom-Json -AsHashtable
    };return $result
}
function Wait-Api([string]$Directory,[string]$Project){
    $args=(Get-ArchiveCompose $Project @((Join-Path $Directory compose.remote.json)))+@('exec','-T','api','curl','--fail','--silent','--max-time','2','http://127.0.0.1:8080/health/live')
    foreach($n in 1..60){$r=Invoke-BoundedProcess docker (@('--host',$DockerHost)+$args) -AllowFailure;if($r.Code -eq 0){return};Start-Sleep -Seconds 1};throw 'Fixture API did not become live.'
}
function Profiles([string]$Directory,[string]$Project,[string]$Mode){
    $result=@()
    foreach($n in 1..5){
        $args=(Get-ArchiveCompose $Project @((Join-Path $Directory compose.remote.json)))+@('exec','-T',"browser-$n",'cat','/tmp/profile-evidence.json')
        $evidence=$null
        foreach($attempt in 1..45){$r=Invoke-BoundedProcess docker (@('--host',$DockerHost)+$args) -AllowFailure;if($r.Code -eq 0){$evidence=$r.Out|ConvertFrom-Json -AsHashtable;break};Start-Sleep -Seconds 1}
        if(-not $evidence -or $evidence.mode -ne $Mode -or $evidence.workerId -ne "browser-$n" -or -not $evidence.match -or $evidence.stored -ne "$id-worker-$n" -or $evidence.cookie -ne "$id-worker-$n"){throw "Real $Mode profile readback failed for worker $n."}
        $result+=$evidence
    };return $result
}
function Run-Backup([string]$Destination,[switch]$AllowFailure){
    return Invoke-BoundedProcess pwsh @('-NoProfile','-File',(Join-Path $repository ops/windows/Backup-RemoteDeployment.ps1),'-DockerHost',$DockerHost,'-DeploymentDirectory',$source,'-ComposeFile',(Join-Path $source compose.remote.json),'-Destination',$Destination) '' 420 -AllowFailure:$AllowFailure
}
function Run-Restore([string]$Backup,[string]$Project,[string]$Output,[switch]$AllowFailure){
    return Invoke-BoundedProcess pwsh @('-NoProfile','-File',(Join-Path $repository ops/windows/Restore-RemoteDeployment.ps1),'-DockerHost',$DockerHost,'-Project',$Project,'-BackupDirectory',$Backup,'-OutputDirectory',$Output) '' 420 -AllowFailure:$AllowFailure
}
try{
    $report.engineId=D @('info','--format','{{.ID}}')
    $apiId=D @('image','inspect',$ApiImage,'--format','{{.Id}}');$browserId=D @('image','inspect',$BrowserImage,'--format','{{.Id}}')
    D @('image','inspect',$helperImage,'--format','{{.Id}}')|Out-Null
    # Freeze the actual production entrypoint/Owner in the image. Only the owned
    # fixture main module differs; it launches genuine headed Chromium and the worker.
    $fixtureContext=Join-Path $testRoot fixture;New-Item -ItemType Directory -Path $fixtureContext|Out-Null
    Copy-Item -LiteralPath (Join-Path $repository .cache/profile-lifecycle.mjs) -Destination (Join-Path $fixtureContext fixture.mjs)
    D @('image','tag',$browserId,$baseTag)|Out-Null
    Write-Utf8 (Join-Path $fixtureContext Dockerfile) "FROM $baseTag`nCOPY --chown=pwuser:pwuser fixture.mjs /app/apps/browser/dist/main.js`n"
    Invoke-RemoteDocker @('build','--network','none','--pull=false','-t',$fixtureTag,$fixtureContext) '' 180|Out-Null
    $fixtureId=D @('image','inspect',$fixtureTag,'--format','{{.Id}}')
    $report.images=@{api=$apiId;productionBrowser=$browserId;fixtureBrowser=$fixtureId}
    $report.fixtureSha256=(Get-FileHash -LiteralPath (Join-Path $fixtureContext fixture.mjs)).Hash.ToLowerInvariant()
    $config=D ((Get-ArchiveCompose $sourceProject @((Join-Path $repository compose.yaml)))+@('config','--format','json'))|ConvertFrom-Json -AsHashtable
    $config.services.Remove('inference');$config.services.Remove('model-prepare');$config.volumes.Remove('models');$config.networks.Remove('download');$config.Remove('secrets')
    $config.services.api.image=$apiId;$config.services.api.Remove('ports')
    $config.services.api.environment.BROWSERSKILLS_PUBLIC_ORIGIN='http://127.0.0.1:8080'
    Copy-Item -LiteralPath (Join-Path $repository ops/seccomp-profile.json) -Destination (Join-Path $source seccomp-profile.json)
    foreach($service in $config.services.Values){$service.Remove('build');$service.Remove('secrets');$service.pull_policy='never';$service.restart='no';$service.labels=@{'browserskills.install-id'=$installId;'browserskills.test'=$id}}
    foreach($key in @($config.volumes.Keys)){$config.volumes[$key]=@{name=$sourceProject+'_'+$key;external=$true}}
    foreach($key in @($config.networks.Keys)){$config.networks[$key].name=$sourceProject+'_'+$key;$config.networks[$key].labels=@{'browserskills.install-id'=$installId}}
    $secrets=Join-Path $source secrets;Set-ProtectedDirectory $secrets
    foreach($name in @('postgres_password','db_password','worker_1_token','worker_2_token','worker_3_token','worker_4_token','worker_5_token')){Write-Utf8 (Join-Path $secrets $name) ([Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)))}
    $payloads=@()
    function AddPayload([string]$Key,[int]$Uid,[hashtable]$Files,[bool]$Executable=$false){
        $volume=$sourceProject+'_'+$Key;$folder=Join-Path $source "payload/$volume";New-Item -ItemType Directory -Path $folder -Force|Out-Null
        $hashes=@{};foreach($name in $Files.Keys){Copy-Item -LiteralPath $Files[$name] -Destination (Join-Path $folder $name);$hashes[$name]=(Get-FileHash -LiteralPath (Join-Path $folder $name)).Hash.ToLowerInvariant()}
        $script:payloads+=@{volume=$volume;uid=$Uid;files=$hashes;executable=$Executable};$config.volumes[$Key]=@{name=$volume;external=$true}
    }
    $apiFiles=@{};foreach($name in @('db_password','worker_1_token','worker_2_token','worker_3_token','worker_4_token','worker_5_token')){$apiFiles[$name]=Join-Path $secrets $name}
    AddPayload api_secrets 10001 $apiFiles
    AddPayload postgres_secrets 999 @{postgres_password=(Join-Path $secrets postgres_password);db_password=(Join-Path $secrets db_password)}
    $init=Join-Path $source init.sh;Write-Utf8 $init ((Get-Content -LiteralPath (Join-Path $repository ops/postgres/init.sh) -Raw).Replace("`r`n","`n"))
    AddPayload postgres_init 999 @{'10-browserskills.sh'=$init} $true
    $config.services.api.volumes+=@{type='volume';source='api_secrets';target='/run/secrets';read_only=$true;volume=@{nocopy=$true}}
    $config.services.postgres.volumes=@(@{type='volume';source='postgres';target='/var/lib/postgresql/data'},@{type='volume';source='postgres_secrets';target='/run/secrets';read_only=$true;volume=@{nocopy=$true}},@{type='volume';source='postgres_init';target='/docker-entrypoint-initdb.d';read_only=$true;volume=@{nocopy=$true}})
    foreach($n in 1..5){
        AddPayload "worker_${n}_secrets" 1001 @{worker_token=(Join-Path $secrets "worker_${n}_token")}
        $service=$config.services["browser-$n"];$service.image=$fixtureId;$service.security_opt=@('no-new-privileges:true',('seccomp='+(Join-Path $source seccomp-profile.json)))
        $service.environment.PROFILE_TEST_MODE='seed';$service.environment.PROFILE_TEST_MARKER="$id-worker-$n"
        $service.volumes+=@{type='volume';source="worker_${n}_secrets";target='/run/secrets';read_only=$true;volume=@{nocopy=$true}}
    }
    Write-Utf8 (Join-Path $source compose.remote.json) ($config|ConvertTo-Json -Depth 100)
    $password=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
    Write-Utf8 (Join-Path $source operator-credentials.json) (@{login='remotert1';password=$password;origin='http://127.0.0.1:8080'}|ConvertTo-Json)
    Write-Utf8 (Join-Path $source deployment.json) (@{schemaVersion=1;installId=$installId;endpoint=$DockerHost;project=$sourceProject;origin='http://127.0.0.1:8080';login='remotert1';payloads=$payloads}|ConvertTo-Json -Depth 10)
    foreach($volume in $config.volumes.Values){D @('volume','create','--label',"browserskills.install-id=$installId",$volume.name)|Out-Null}
    foreach($payload in $payloads){
        $helper=Start-ArchiveHelper $helperImage $payload.volume $id -Writable
        try{foreach($file in $payload.files.Keys){D @('cp',(Join-Path $source "payload/$($payload.volume)/$file"),"${helper}:/data/$file")|Out-Null;D @('exec',$helper,'chmod',$(if($payload.executable){'0500'}else{'0400'}),"/data/$file")|Out-Null};D @('exec',$helper,'chmod','0500','/data')|Out-Null;D @('exec',$helper,'chown','-R',"$($payload.uid):$($payload.uid)",'/data')|Out-Null}finally{Stop-ArchiveHelper $helper $id}
    }
    Write-Output 'Remote API transport fixture: starting PostgreSQL/Flyway and seeding five accounts.'
    Dc $source $sourceProject @('up','-d','--no-build','postgres','api')|Out-Null;Wait-Api $source $sourceProject
    foreach($n in 1..5){
        Dc $source $sourceProject @('exec','-T','api','java','-jar','/app/api.jar','--spring.main.web-application-type=none','--spring.profiles.active=admin',"--create-user=remotert$n") ($password+"`n")|Out-Null
        $run=[Guid]::NewGuid();$request=[Guid]::NewGuid();$item=[Guid]::NewGuid();$usage=[Guid]::NewGuid();$hash='a'*64
        Sql $source $sourceProject @"
SET ROLE browserskills;
INSERT INTO runs(id,user_id,request_id,max_tasks,processed,status,generation,created_at,updated_at) SELECT '$run',id,'$request',1,1,'COMPLETED','fixture-$n',now(),now() FROM users WHERE login='remotert$n';
INSERT INTO run_items(id,run_id,ordinal,pool_id,suite_id,snapshot_hash,instruction_hash,status,answer_json,created_at) VALUES('$item','$run',1,'owned-fixture','task-$n','$hash','$hash','SUBMITTED','{"decision":"ANSWER","reason":null,"answers":[{"partId":"part-1","fieldId":"field-1","value":"option-$n"}]}',now());
INSERT INTO ai_usage(id,user_id,request_id,snapshot_hash,instruction_hash,model_hash,status,result_json,created_at,completed_at) SELECT '$usage',id,'$request','$hash','$hash','fixture-no-inference','COMPLETED','{"decision":"ANSWER","answers":[{"partId":"part-1","fieldId":"field-1","value":"option-$n"}],"reason":null}',now(),now() FROM users WHERE login='remotert$n';
INSERT INTO selection_settings(user_id,settings_json) SELECT id,'{"mode":"AUTO","poolId":null,"includePoolIds":[],"excludePoolIds":[],"minReward":"1.00","modalities":["text"],"includeTraining":false,"includeExams":false}' FROM users WHERE login='remotert$n';
"@|Out-Null
    };$password=$null
    $report.databaseBefore=DbEvidence $source $sourceProject
    Dc $source $sourceProject @('up','-d','--no-build','browser-1','browser-2','browser-3','browser-4','browser-5')|Out-Null
    $report.profilesBefore=@(Profiles $source $sourceProject seed)
    $ephemeral=@(Get-EphemeralArchiveMounts $config)
    if($ephemeral.Count -ne 6){throw 'Expected API scratch and five worker material volumes.'}
    foreach($entry in $ephemeral){
        $helper=Start-ArchiveHelper $helperImage $entry.name $id -Writable
        try{D @('exec',$helper,'sh','-ec','printf disposable > /data/raw-material-marker')|Out-Null}finally{Stop-ArchiveHelper $helper $id}
    }
    Write-Output 'Running the actual binary-stream remote backup.'
    Run-Backup $backup|Out-Null
    $manifest=Get-Content -LiteralPath (Join-Path $backup backup.json) -Raw|ConvertFrom-Json
    if(-not $manifest.profilesVerifiedClean -or $manifest.model.archived){throw 'Incorrect backup completeness/model attestation.'}
    if(@($manifest.ephemeralVolumes).Count -ne 6 -or @($manifest.volumes|Where-Object sourceKey -In @($ephemeral.sourceKey)).Count){throw 'Temporary raw materials must be described but never archived.'}
    $report.backupSha256=(Get-FileHash -LiteralPath (Join-Path $backup backup.json)).Hash.ToLowerInvariant()
    $report.checks.backupCompleted=$true
    # Each refusal uses disposable data; no source/target application data is replaced.
    $helper=Start-ArchiveHelper $helperImage ($sourceProject+'_profile3') $id -Writable
    try{D @('exec',$helper,'ln','-s','old-container-123','/data/SingletonLock')|Out-Null}finally{Stop-ArchiveHelper $helper $id}
    $bad=Join-Path $testRoot unclean-backup;$r=Run-Backup $bad -AllowFailure
    if($r.Code -eq 0 -or $r.Err -notmatch 'singleton locks' -or (Test-Path -LiteralPath (Join-Path $bad backup.json))){throw 'Stale lock was not rejected by actual remote backup.'}
    $report.checks.staleLockRejected=$true
    Dc $source $sourceProject @('down','--timeout','45')|Out-Null
    Write-Output 'Restoring the actual streamed backup into fresh named volumes through the same API.'
    Run-Restore $backup $targetProject $target|Out-Null
    $targetPlan=Get-Content -LiteralPath (Join-Path $target deployment.json) -Raw|ConvertFrom-Json
    $cleanup+=@{project=$targetProject;installId=$targetPlan.installId}
    $report.databaseAfter=DbEvidence $target $targetProject
    if(($report.databaseBefore|ConvertTo-Json -Depth 8 -Compress) -cne ($report.databaseAfter|ConvertTo-Json -Depth 8 -Compress)){throw 'Restored DB row digests differ.'}
    $targetConfig=Get-Content -LiteralPath (Join-Path $target compose.remote.json) -Raw|ConvertFrom-Json -AsHashtable
    foreach($entry in @(Get-EphemeralArchiveMounts $targetConfig)){
        $helper=Start-ArchiveHelper $helperImage $entry.name $id
        try{
            D @('exec',$helper,'sh','-ec','test ! -e /data/raw-material-marker')|Out-Null
            if((D @('exec',$helper,'stat','-c','%u','/data')) -ne [string]$entry.uid){throw 'Restored scratch volume has the wrong runtime owner.'}
        }finally{Stop-ArchiveHelper $helper $id}
    }
    $report.checks.temporaryMaterialsExcludedAndFresh=$true
    foreach($n in 1..5){$targetConfig.services["browser-$n"].environment.PROFILE_TEST_MODE='read'}
    Write-Utf8 (Join-Path $target compose.remote.json) ($targetConfig|ConvertTo-Json -Depth 100)
    Dc $target $targetProject @('up','-d','--no-build','browser-1','browser-2','browser-3','browser-4','browser-5')|Out-Null
    $report.profilesAfter=@(Profiles $target $targetProject read)
    $report.checks.databaseAndFiveProfilesMatched=$true
    Dc $target $targetProject @('stop','-t','45','browser-1','browser-2','browser-3','browser-4','browser-5')|Out-Null
    $r=Run-Restore $backup $targetProject (Join-Path $testRoot rejected-existing-db) -AllowFailure
    if($r.Code -eq 0 -or $r.Err -notmatch 'fresh project'){throw 'Nonempty target deployment was not rejected.'}
    if(($report.databaseAfter|ConvertTo-Json -Depth 8 -Compress) -cne ((DbEvidence $target $targetProject)|ConvertTo-Json -Depth 8 -Compress)){throw 'Rejected restore changed existing database rows.'}
    $report.checks.nonemptyDatabasePreserved=$true
    $corrupt=Join-Path $testRoot corrupt;Copy-Item -LiteralPath $backup -Destination $corrupt -Recurse
    [IO.File]::AppendAllText((Join-Path $corrupt browser-3-profile.tar.gz),'fixture corruption')
    $r=Run-Restore $corrupt $blockedProject (Join-Path $testRoot rejected-checksum) -AllowFailure
    if($r.Code -eq 0 -or $r.Err -notmatch 'Backup checksum mismatch'){throw 'Archive checksum corruption was not rejected.'}
    $report.checks.checksumRejected=$true
    $unverified=Join-Path $testRoot unverified;New-Item -ItemType Directory -Path $unverified|Out-Null
    $invalid=Get-Content -LiteralPath (Join-Path $backup backup.json) -Raw|ConvertFrom-Json -AsHashtable;$invalid.Remove('profilesVerifiedClean')
    Write-Utf8 (Join-Path $unverified backup.json) ($invalid|ConvertTo-Json -Depth 15)
    $r=Run-Restore $unverified $blockedProject (Join-Path $testRoot rejected-unverified) -AllowFailure
    if($r.Code -eq 0 -or $r.Err -notmatch 'unverified remote backup'){throw 'Unverified manifest was not rejected.'}
    $report.checks.unverifiedManifestRejected=$true
    $blockedInstall=[Guid]::NewGuid().ToString('N');$cleanup+=@{project=$blockedProject;installId=$blockedInstall}
    $blockedVolume=$blockedProject+'_profile3';D @('volume','create','--label',"browserskills.install-id=$blockedInstall",$blockedVolume)|Out-Null
    $helper=Start-ArchiveHelper $helperImage $blockedVolume $id -Writable
    try{D @('exec',$helper,'sh','-ec','printf preserved > /data/marker')|Out-Null}finally{Stop-ArchiveHelper $helper $id}
    $r=Run-Restore $backup $blockedProject (Join-Path $testRoot rejected-profile) -AllowFailure
    if($r.Code -eq 0 -or $r.Err -notmatch 'fresh resources'){throw 'Existing profile volume was not rejected.'}
    $helper=Start-ArchiveHelper $helperImage $blockedVolume $id
    try{if((D @('exec',$helper,'cat','/data/marker')) -ne 'preserved'){throw 'Rejected restore changed existing profile data.'}}finally{Stop-ArchiveHelper $helper $id}
    $report.checks.nonemptyProfilePreserved=$true
    $allowed=@('S-1-5-18','S-1-5-32-544',[Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
    foreach($file in @((Get-Item -LiteralPath $backup))+@(Get-ChildItem -LiteralPath $backup -Recurse -Force)){foreach($rule in (Get-Acl -LiteralPath $file.FullName).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowed){throw 'Backup ACL has a broad grant.'}}}
    $report.checks.backupAclProtected=$true;$report.passed=$true
}catch{$report.error=$_.Exception.Message;throw}
finally{
    # Include a partially created restore project only when its scoped config carries
    # the expected project name and the generated install ID.
    if((Test-Path -LiteralPath (Join-Path $target compose.remote.json)) -and $targetProject -notin @($cleanup|ForEach-Object{$_.project})){
        $partial=Get-Content -LiteralPath (Join-Path $target compose.remote.json) -Raw|ConvertFrom-Json -AsHashtable
        if($partial.name -eq $targetProject){$cleanup+=@{project=$targetProject;installId=$partial.services.api.labels['browserskills.install-id']}}
    }
    foreach($scope in $cleanup){
        if(-not $scope.project.StartsWith($id+'-') -or $scope.installId -notmatch '^[a-f0-9]{32}$'){throw 'Refusing unrelated test cleanup.'}
        $containers=D @('ps','-aq','--filter',"label=browserskills.install-id=$($scope.installId)")
        foreach($container in @($containers -split '\r?\n'|Where-Object{$_})){Assert-ArchiveOwner container $container $scope.installId;D @('rm','-f',$container)|Out-Null}
        foreach($kind in @('volume','network')){
            $names=D @($kind,'ls','-q','--filter',"label=browserskills.install-id=$($scope.installId)")
            foreach($name in @($names -split '\r?\n'|Where-Object{$_})){Assert-ArchiveOwner $kind $name $scope.installId;D @($kind,'rm',$name)|Out-Null}
        }
    }
    foreach($tag in @($fixtureTag,$baseTag)){Invoke-BoundedProcess docker @('--host',$DockerHost,'image','rm',$tag) -AllowFailure|Out-Null}
    $report.cleanedProjects=@($cleanup|ForEach-Object{$_.project});$report.finishedAtUtc=[DateTime]::UtcNow.ToString('o')
    Write-Utf8 (Join-Path $testRoot report.json) ($report|ConvertTo-Json -Depth 16)
    Write-Output "Remote roundtrip evidence: $testRoot"
}
Write-Output 'Remote Docker API roundtrip passed: actual DB and five Chromium profiles, scoped refusal and cleanup checks.'
