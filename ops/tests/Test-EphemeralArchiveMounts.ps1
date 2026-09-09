#Requires -Version 7.4
. "$PSScriptRoot/../windows/Remote-Archive.ps1"
$config=@{services=@{api=@{volumes=@(@{source='materials';target='/data/materials';type='volume'})};'browser-1'=@{volumes=@(@{source='media1';target='/data/media';type='volume'})}};volumes=@{materials=@{name='browserskills_materials'};media1=@{name='browserskills_media1'}}}
$items=@(Get-EphemeralArchiveMounts $config)
if($items.Count -ne 2 -or @($items|Where-Object uid -EQ 10001).Count -ne 1){throw 'Expected exactly the two typed ephemeral mounts.'}
$bad=@{services=@{postgres=@{volumes=@(@{source='materials';target='/data/materials';type='volume'})}};volumes=$config.volumes}
$rejected=$false
try{Get-EphemeralArchiveMounts $bad|Out-Null}catch{$rejected=$true}
if(-not $rejected){throw 'PostgreSQL must not acquire an application scratch mount.'}
$bad=@{services=@{api=@{volumes=@(@{source='materials';target='/data/materials';type='bind'})}};volumes=$config.volumes}
$rejected=$false
try{Get-EphemeralArchiveMounts $bad|Out-Null}catch{$rejected=$true}
if(-not $rejected){throw 'Host paths cannot be treated as disposable named volumes.'}
Write-Output 'Ephemeral archive mount boundaries passed.'
