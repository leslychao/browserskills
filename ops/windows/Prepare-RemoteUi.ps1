#Requires -Version 7.4
[CmdletBinding()]
param([string]$ServerIp='192.168.0.107', [string]$Endpoint='tcp://192.168.0.107:2375', [string]$ApiImage='browserskills-api:lan-http', [string]$BrowserImage='browserskills-browser:local', [string]$Login='vitalii')
. "$PSScriptRoot/Remote-Common.ps1"
if ($Login -notmatch '^[a-zA-Z0-9_.-]{3,64}$') { throw 'Invalid operator login.' }
$ip=[Net.IPAddress]::Parse($ServerIp)
if ($ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw 'IPv4 is required.' }
$repository=Get-ProjectRoot
$installId=[Guid]::NewGuid().ToString('N')
$directory=Join-Path $repository ('runtime/remote-107/' + $installId)
Set-ProtectedDirectory $directory
$secretDirectory=Join-Path $directory secrets
Set-ProtectedDirectory $secretDirectory
foreach($name in @('postgres_password','db_password','worker_1_token','worker_2_token','worker_3_token','worker_4_token','worker_5_token')) {
    Write-Utf8 (Join-Path $secretDirectory $name) ([Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant())
}
$origin="http://${ServerIp}:8080"
$credentials=@{login=$Login;password=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24));origin=$origin}
Write-Utf8 (Join-Path $directory operator-credentials.json) ($credentials|ConvertTo-Json)
$credentials=$null
Write-Utf8 (Join-Path $directory .env) "BROWSERSKILLS_BIND_IP=$ServerIp`nBROWSERSKILLS_PUBLIC_ORIGIN=$origin`nBROWSERSKILLS_RELEASE=local`n"
$config=(Invoke-BoundedProcess docker @('compose','--project-directory',$repository,'-f',(Join-Path $repository compose.yaml),'config','--format','json')).Out|ConvertFrom-Json -AsHashtable
$config.name='browserskills'
$config.services.Remove('inference');$config.services.Remove('model-prepare');$config.volumes.Remove('models');$config.networks.Remove('download');$config.Remove('secrets')
$images=@{}
foreach($image in @($ApiImage,$BrowserImage)) { $images[$image]=(Invoke-BoundedProcess docker @('image','inspect',$image,'--format','{{.Id}}')).Out.Trim() }
$config.services.api.image=$images[$ApiImage]
$config.services.api.environment.BROWSERSKILLS_PUBLIC_ORIGIN=$origin
$config.services.api.environment.SERVER_PORT='8080'
$config.services.api.environment.SERVER_SSL_ENABLED='false'
$config.services.api.environment.SERVER_SERVLET_SESSION_COOKIE_SECURE='false'
$config.services.api.ports=@(@{target=8080;published='8080';host_ip=$ServerIp;protocol='tcp';mode='ingress'})
foreach($service in $config.services.Values) { $service.Remove('build');$service.Remove('secrets');$service.pull_policy='never';$service.labels=@{'browserskills.install-id'=$installId;'browserskills.managed'='remote-ui'} }
$seccompPath=Join-Path $directory seccomp-profile.json
Copy-Item -LiteralPath (Join-Path $repository ops/seccomp-profile.json) -Destination $seccompPath
$payloads=@()
function Add-Payload([string]$Volume,[int]$Uid,[hashtable]$Files,[bool]$Executable=$false) {
    $folder=Join-Path $directory "payload/$Volume"
    New-Item -ItemType Directory -Path $folder -Force|Out-Null
    $hashes=@{}
    foreach($name in $Files.Keys) {
        Copy-Item -LiteralPath $Files[$name] -Destination (Join-Path $folder $name)
        $hashes[$name]=(Get-FileHash -LiteralPath (Join-Path $folder $name)).Hash.ToLowerInvariant()
    }
    $script:payloads+=@{volume=$Volume;uid=$Uid;files=$hashes;executable=$Executable}
    $config.volumes[$Volume]=@{name=$Volume;external=$true}
}
$apiFiles=@{}
foreach($name in @('db_password','worker_1_token','worker_2_token','worker_3_token','worker_4_token','worker_5_token')) { $apiFiles[$name]=Join-Path $secretDirectory $name }
Add-Payload browserskills_api_secrets 10001 $apiFiles
$config.services.api.volumes=@(@{type='volume';source='browserskills_api_secrets';target='/run/secrets';read_only=$true;volume=@{nocopy=$true}})
Add-Payload browserskills_postgres_secrets 999 @{postgres_password=(Join-Path $secretDirectory postgres_password);db_password=(Join-Path $secretDirectory db_password)}
$initFile=Join-Path $directory init.sh
Write-Utf8 $initFile ((Get-Content -LiteralPath (Join-Path $repository ops/postgres/init.sh) -Raw).Replace("`r`n","`n"))
Add-Payload browserskills_postgres_init 999 @{'10-browserskills.sh'=$initFile} $true
$config.services.postgres.volumes=@(@{type='volume';source='postgres';target='/var/lib/postgresql/data'},@{type='volume';source='browserskills_postgres_secrets';target='/run/secrets';read_only=$true;volume=@{nocopy=$true}},@{type='volume';source='browserskills_postgres_init';target='/docker-entrypoint-initdb.d';read_only=$true;volume=@{nocopy=$true}})
foreach($number in 1..5) {
    $service=$config.services["browser-$number"]
    $service.image=$images[$BrowserImage]
    # Compose reads this client-side file and sends compact JSON to the daemon.
    # It is not a bind mount and needs no corresponding path on the remote host.
    $service.security_opt=@('no-new-privileges:true',('seccomp='+$seccompPath))
    $volume="browserskills_worker_${number}_secrets"
    Add-Payload $volume 1001 @{worker_token=(Join-Path $secretDirectory "worker_${number}_token")}
    $service.volumes+=@{type='volume';source=$volume;target='/run/secrets';read_only=$true;volume=@{nocopy=$true}}
}
foreach($key in @($config.volumes.Keys)) {
    if (-not $config.volumes[$key].Contains('external')) {$config.volumes[$key]=@{name="browserskills_$key";labels=@{'browserskills.install-id'=$installId;'browserskills.managed'='remote-ui'}}}
}
foreach($key in @($config.networks.Keys)) {$config.networks[$key].name="browserskills_$key";$config.networks[$key].labels=@{'browserskills.install-id'=$installId;'browserskills.managed'='remote-ui'}}
Write-Utf8 (Join-Path $directory compose.remote.json) ($config|ConvertTo-Json -Depth 100)
$plan=@{schemaVersion=1;installId=$installId;endpoint=$Endpoint;origin=$origin;login=$Login;project='browserskills';images=$images;payloads=$payloads;postgresImage=$config.services.postgres.image;composeSha256=(Get-FileHash -LiteralPath (Join-Path $directory compose.remote.json)).Hash.ToLowerInvariant();createdAtUtc=[DateTime]::UtcNow.ToString('o')}
Write-Utf8 (Join-Path $directory deployment.json) ($plan|ConvertTo-Json -Depth 12)
# The root was protected before any secrets were written; verify inherited ACLs
# without needlessly reapplying a security descriptor to a populated directory.
$allowed=@('S-1-5-18','S-1-5-32-544',[Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
foreach($item in @((Get-Item -LiteralPath $directory))+@(Get-ChildItem -LiteralPath $directory -Recurse -Force)) {
    foreach($rule in (Get-Acl -LiteralPath $item.FullName).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
        if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowed) { throw 'Deployment files have an unexpected ACL grant.' }
    }
}
Write-Output "Prepared local deployment: $directory"
Write-Output "Operator credentials: $(Join-Path $directory operator-credentials.json)"
Write-Output 'No remote resources were changed. Publish-RemoteUi.ps1 performs the reviewed deployment.'
