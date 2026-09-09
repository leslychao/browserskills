#Requires -Version 7.4
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Directory)
. "$PSScriptRoot/Remote-Common.ps1"
$directory=[IO.Path]::GetFullPath($Directory)
$plan=Get-Content -LiteralPath (Join-Path $directory deployment.json) -Raw|ConvertFrom-Json -AsHashtable
if($plan.project -ne 'browserskills' -or $plan.installId -notmatch '^[a-f0-9]{32}$') {throw 'Unexpected deployment identity.'}
if(([Uri]$plan.origin).Scheme -ne 'http' -or ([Uri]$plan.origin).Port -ne 8080){throw 'This bootstrap requires the current LAN HTTP plan. Preserve an older deployment and migrate it explicitly.'}
$script:RemoteEndpoint=$plan.endpoint
$compose=Join-Path $directory compose.remote.json
if((Get-FileHash -LiteralPath $compose).Hash.ToLowerInvariant() -ne $plan.composeSha256) {throw 'Prepared Compose hash changed; review and prepare again.'}
$config=Get-Content -LiteralPath $compose -Raw|ConvertFrom-Json -AsHashtable
foreach($payload in $plan.payloads) {
    if($payload.volume -notmatch '^browserskills_(api_secrets|postgres_secrets|postgres_init|worker_[1-5]_secrets)$') {throw 'Unexpected payload volume.'}
    foreach($file in $payload.files.Keys) {
        if($file -notmatch '^[a-z0-9_.-]+$' -or $file -eq 'ca_private.key') {throw 'Unexpected upload filename.'}
        if((Get-FileHash -LiteralPath (Join-Path $directory "payload/$($payload.volume)/$file")).Hash.ToLowerInvariant() -ne $payload.files[$file]) {throw 'Prepared payload changed.'}
    }
}
function Remote-Compose([string[]]$Arguments,[string]$InputText='') {return Invoke-RemoteDocker (@('compose','--project-directory',$directory,'-f',$compose)+$Arguments) $InputText 300}
function Assert-Owned([string]$Kind,[string]$Name) {
    $format=if($Kind -eq 'container') {'{{index .Config.Labels "browserskills.install-id"}}'} else {'{{index .Labels "browserskills.install-id"}}'}
    $arguments=if($Kind -eq 'container') {@('inspect',$Name,'--format',$format)} else {@($Kind,'inspect',$Name,'--format',$format)}
    $result=Invoke-BoundedProcess docker (@('--host',$script:RemoteEndpoint)+$arguments) -AllowFailure
    if($result.Code -eq 0 -and $result.Out.Trim() -ne $plan.installId) {throw "Existing $Kind $Name belongs to another deployment; it will not be changed."}
    return $result.Code -eq 0
}
# Validate only the exact resources this plan can create. Other projects/models are untouched.
foreach($service in $config.services.Keys) {Assert-Owned container "browserskills-$service-1"|Out-Null}
foreach($volume in $config.volumes.Values) {Assert-Owned volume $volume.name|Out-Null}
foreach($network in $config.networks.Values) {Assert-Owned network $network.name|Out-Null}
$published=Invoke-RemoteDocker @('ps','--filter','publish=8080','--format','{{.ID}}')
foreach($container in @($published -split '\r?\n'|Where-Object{$_})) {Assert-Owned container $container|Out-Null}
Remote-Compose @('config','--quiet')|Out-Null
$missing=@()
foreach($image in @($plan.images.Values)+@($plan.postgresImage)) {
    $result=Invoke-BoundedProcess docker @('--host',$script:RemoteEndpoint,'image','inspect',$image,'--format','{{.Id}}') -AllowFailure
    if($result.Code -ne 0) {$missing+=$image}
}
if($missing.Count) {Write-Output 'Transferring prepared immutable images to the selected daemon.';Send-DockerImages $missing|Out-Null}
foreach($image in $plan.images.Values) {
    if((Invoke-RemoteDocker @('image','inspect',$image,'--format','{{.Id}}')) -ne $image) {throw 'Remote image identity does not match the reviewed build.'}
}
foreach($payload in $plan.payloads) {
    $volume=$payload.volume
    if(-not (Assert-Owned volume $volume)) {Invoke-RemoteDocker @('volume','create','--label',"browserskills.install-id=$($plan.installId)",'--label','browserskills.managed=remote-ui',$volume)|Out-Null}
    $helper='browserskills-upload-'+$plan.installId.Substring(0,12)+'-'+($volume -replace '^browserskills_','')
    Write-Output "Preparing scoped volume $volume."
    try {
        Invoke-RemoteDocker @('run','-d','--rm','--name',$helper,'--label',"browserskills.install-id=$($plan.installId)",'--network','none','--user','0','--cap-drop','ALL','--cap-add','CHOWN','--cap-add','DAC_OVERRIDE','--security-opt','no-new-privileges','--memory','128m','--cpus','0.5','--pids-limit','32','--mount',"type=volume,src=$volume,dst=/payload",'--entrypoint','sleep',$plan.postgresImage,'600')|Out-Null
        $existing=Invoke-RemoteDocker @('exec',$helper,'find','/payload','-mindepth','1','-maxdepth','1','-printf','%f\n')
        foreach($file in @($existing -split '\r?\n'|Where-Object{$_})) {
            if(-not $payload.files.Contains($file)) {throw "Unexpected existing file in $volume; no overwrite."}
            $hash=(Invoke-RemoteDocker @('exec',$helper,'sha256sum',"/payload/$file")).Split(' ')[0]
            if($hash -ne $payload.files[$file]) {throw "Existing payload differs in $volume; no overwrite."}
        }
        $existingNames=@($existing -split '\r?\n'|Where-Object{$_})
        foreach($file in $payload.files.Keys) {
            if($file -notin $existingNames) {Invoke-RemoteDocker @('cp',(Join-Path $directory "payload/$volume/$file"),"${helper}:/payload/$file")|Out-Null}
            $hash=(Invoke-RemoteDocker @('exec',$helper,'sha256sum',"/payload/$file")).Split(' ')[0]
            if($hash -ne $payload.files[$file]) {throw 'Transferred file SHA256 mismatch.'}
        }
        # New volumes are root-owned here. Existing fully provisioned volumes need no rewrites.
        if($existingNames.Count -ne $payload.files.Count) {
            $mode=if($payload.executable){'0500'}else{'0400'}
            foreach($file in $payload.files.Keys) {Invoke-RemoteDocker @('exec',$helper,'chmod',$mode,"/payload/$file")|Out-Null}
            Invoke-RemoteDocker @('exec',$helper,'chmod','0500','/payload')|Out-Null
            Invoke-RemoteDocker @('exec',$helper,'chown','-R',"$($payload.uid):$($payload.uid)",'/payload')|Out-Null
        }
        foreach($file in $payload.files.Keys) {
            $hash=(Invoke-RemoteDocker @('exec','--user',"$($payload.uid)",$helper,'sha256sum',"/payload/$file")).Split(' ')[0]
            if($hash -ne $payload.files[$file]) {throw 'Runtime UID cannot read its verified payload.'}
            $mode=if($payload.executable){'500'}else{'400'}
            if((Invoke-RemoteDocker @('exec',$helper,'stat','-c','%u:%a',"/payload/$file")) -ne "$($payload.uid):$mode") {throw 'Payload ownership or permissions do not match the runtime identity.'}
        }
    } finally {
        if(Assert-Owned container $helper) {Invoke-RemoteDocker @('rm','-f',$helper)|Out-Null}
    }
}
Write-Output 'Starting PostgreSQL, API and five isolated browser workers.'
Remote-Compose @('up','-d','--no-build','postgres','api','browser-1','browser-2','browser-3','browser-4','browser-5')|Out-Null
$healthy=$false
foreach($attempt in 1..40) {
    try {Invoke-WebRequest -Uri "$($plan.origin)/health/live" -TimeoutSec 3 -MaximumRedirection 0|Out-Null;$healthy=$true;break} catch {Start-Sleep -Seconds 2}
}
if(-not $healthy){throw 'Remote API has not passed HTTP liveness; containers are preserved for diagnosis.'}
$credentials=Get-Content -LiteralPath (Join-Path $directory operator-credentials.json) -Raw|ConvertFrom-Json
$existing=Remote-Compose @('exec','-T','postgres','psql','-U','postgres','-d','browserskills','-Atc',"SELECT count(*) FROM users WHERE login='$($plan.login)'")
if($existing.Trim() -eq '0') {Remote-Compose @('exec','-T','api','java','-jar','/app/api.jar','--spring.main.web-application-type=none','--spring.profiles.active=admin',"--create-user=$($plan.login)") ($credentials.password+"`n")|Out-Null}
$credentials=$null
$readiness=Remote-Compose @('exec','-T','api','curl','--fail','--silent','--max-time','10','http://127.0.0.1:8080/health/ready')|ConvertFrom-Json -AsHashtable
foreach($component in @('database','browser-1','browser-2','browser-3','browser-4','browser-5')) {if($readiness.components[$component] -ne 'UP'){throw "UI component $component is not ready."}}
$evidence=[ordered]@{completedAtUtc=[DateTime]::UtcNow.ToString('o');endpoint=$plan.endpoint;origin=$plan.origin;installId=$plan.installId;images=$plan.images;readiness=$readiness;containers=@()}
foreach($service in $config.services.Keys) {
    $name="browserskills-$service-1"
    $detail=@((Invoke-RemoteDocker @('inspect',$name))|ConvertFrom-Json -AsHashtable)
    $container=$detail[0]
    if($container.Mounts|Where-Object Type -EQ 'bind'){throw 'Unexpected host bind in the remote deployment.'}
    if($service -like 'browser-*') {
        if(-not $container.HostConfig.ReadonlyRootfs -or $container.HostConfig.Privileged -or 'ALL' -notin $container.HostConfig.CapDrop -or -not ($container.HostConfig.SecurityOpt|Where-Object{$_ -like 'seccomp={*'})){throw 'Actual worker security differs from the prepared configuration.'}
    }
    $evidence.containers+=@{name=$name;image=$container.Image;state=$container.State.Status;user=$container.Config.User;readonlyRootfs=$container.HostConfig.ReadonlyRootfs;privileged=$container.HostConfig.Privileged;capDrop=$container.HostConfig.CapDrop;networks=@($container.NetworkSettings.Networks.Keys);portBindings=$container.HostConfig.PortBindings;mounts=@($container.Mounts|ForEach-Object{@{type=$_.Type;name=$_.Name;destination=$_.Destination;readWrite=$_.RW}});seccompJsonPresent=[bool]($container.HostConfig.SecurityOpt|Where-Object{$_ -like 'seccomp={*'})}
}
Write-Utf8 (Join-Path $directory deployment-result.json) ($evidence|ConvertTo-Json -Depth 15)
Write-Output "UI deployment ready: $($plan.origin)"
Write-Output "Operator credentials remain protected: $(Join-Path $directory operator-credentials.json)"
Write-Output 'Inference is intentionally absent at this stage; manual browser UI components were verified.'
