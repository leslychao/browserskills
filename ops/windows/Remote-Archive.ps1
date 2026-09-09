#Requires -Version 7.4
. "$PSScriptRoot/Remote-Common.ps1"

if(-not ('BrowserSkills.ArchiveStream' -as [type])){
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
namespace BrowserSkills {
  public static class ArchiveStream {
    public static async Task<long> CopyAsync(Stream source, Stream target, long maximum, int seconds) {
      using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(seconds));
      byte[] buffer = new byte[1024 * 1024]; long total = 0;
      while (true) {
        int count = await source.ReadAsync(buffer.AsMemory(), cancellation.Token);
        if (count == 0) break;
        total = checked(total + count);
        if (total > maximum) throw new IOException("Archive exceeded its configured byte limit.");
        await target.WriteAsync(buffer.AsMemory(0, count), cancellation.Token);
      }
      await target.FlushAsync(cancellation.Token); return total;
    }
  }
}
'@
}

function Assert-RemoteArchiveProject([string]$Project){
    if($Project -notmatch '^browserskills(?:-[a-z0-9][a-z0-9-]{0,54})?$'){throw 'Expected an explicit BrowserSkills project name.'}
}
function Get-ArchiveContainer([string]$Id){
    return @(Invoke-RemoteDocker @('inspect',$Id)|ConvertFrom-Json -AsHashtable)[0]
}
function Get-ArchiveCompose([string]$Project,[string[]]$Files){
    $arguments=@('compose','--project-directory',(Get-ProjectRoot),'--project-name',$Project)
    foreach($file in $Files){$arguments+=@('-f',[IO.Path]::GetFullPath($file))}
    return $arguments
}
function Get-EphemeralArchiveMounts([System.Collections.IDictionary]$Config){
    $seen=[Collections.Generic.HashSet[string]]::new()
    foreach($service in $Config.services.Keys){
        foreach($mount in @($Config.services[$service].volumes)){
            if($mount.target -notin @('/data/materials','/data/media')){continue}
            $expected=if($service -eq 'api'){'/data/materials'}elseif($service -match '^browser-[1-5]$'){'/data/media'}else{throw 'Unexpected service with ephemeral application storage.'}
            if($mount.type -ne 'volume' -or $mount.target -ne $expected -or -not $Config.volumes.Contains($mount.source) -or -not $seen.Add($mount.source)){throw 'Invalid or shared ephemeral volume.'}
            $references=@($Config.services.Values|ForEach-Object{$_.volumes}|Where-Object source -EQ $mount.source)
            if($references.Count -ne 1){throw 'Ephemeral volume is shared with another mount.'}
            $uid=if($service -eq 'api'){10001}else{1001}
            [pscustomobject]@{service=$service;sourceKey=$mount.source;name=$Config.volumes[$mount.source].name;target=$mount.target;uid=$uid}
        }
    }
}
function Assert-ArchiveOwner([string]$Kind,[string]$Name,[string]$InstallId){
    $format=if($Kind -eq 'container'){'{{index .Config.Labels "browserskills.install-id"}}'}else{'{{index .Labels "browserskills.install-id"}}'}
    $args=if($Kind -eq 'container'){@('inspect',$Name,'--format',$format)}else{@($Kind,'inspect',$Name,'--format',$format)}
    if((Invoke-RemoteDocker $args) -ne $InstallId){throw "Unexpected ownership: $Kind $Name."}
}
function Start-ArchiveHelper([string]$Image,[string]$Volume,[string]$OperationId,[switch]$Writable){
    if($Volume -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,120}$'){throw 'Invalid named volume.'}
    $name='browserskills-archive-'+[Guid]::NewGuid().ToString('N')
    $mount="type=volume,src=$Volume,dst=/data,volume-nocopy"+$(if(-not $Writable){',readonly'}else{''})
    $args=@('run','-d','--rm','--pull','never','--name',$name,'--label',"browserskills.archive-operation=$OperationId",'--network','none','--read-only','--user','0:0','--cap-drop','ALL','--cap-add','DAC_OVERRIDE','--security-opt','no-new-privileges:true','--memory','128m','--cpus','0.5','--pids-limit','32','--mount',$mount,'--entrypoint','sleep')
    if($Writable){$args=$args[0..($args.Count-3)]+@('--cap-add','CHOWN','--cap-add','FOWNER')+$args[($args.Count-2)..($args.Count-1)]}
    Invoke-RemoteDocker ($args+@($Image,'1800'))|Out-Null
    return $name
}
function Stop-ArchiveHelper([string]$Name,[string]$OperationId){
    $r=Invoke-BoundedProcess docker @('--host',$script:RemoteEndpoint,'inspect',$Name,'--format','{{index .Config.Labels "browserskills.archive-operation"}}') -AllowFailure
    if($r.Code -eq 0){if($r.Out.Trim() -ne $OperationId){throw 'Refusing cleanup of an unrelated helper.'};Invoke-RemoteDocker @('rm','-f',$Name)|Out-Null}
}
function Copy-ArchiveProcess([string[]]$Arguments,[string]$Path,[ValidateSet('Receive','Send')][string]$Direction,[long]$MaximumBytes,[int]$TimeoutSeconds=300){
    if($Direction -eq 'Send' -and (Get-Item -LiteralPath $Path).Length -gt $MaximumBytes){throw 'Archive input exceeds its configured byte limit.'}
    $info=[Diagnostics.ProcessStartInfo]::new('docker')
    $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardError=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardInput=$true
    foreach($arg in @('--host',$script:RemoteEndpoint)+$Arguments){$info.ArgumentList.Add($arg)}
    $file=$null;$process=$null
    try{
        $file=if($Direction -eq 'Receive'){[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)}else{[IO.File]::OpenRead($Path)}
        $process=[Diagnostics.Process]::Start($info)
        $stderr=[BrowserSkills.ArchiveStream]::CopyAsync($process.StandardError.BaseStream,[IO.Stream]::Null,[long]::MaxValue,$TimeoutSeconds)
        if($Direction -eq 'Receive'){
            $process.StandardInput.Close()
            $bytes=[BrowserSkills.ArchiveStream]::CopyAsync($process.StandardOutput.BaseStream,$file,$MaximumBytes,$TimeoutSeconds).GetAwaiter().GetResult()
        }else{
            $stdout=[BrowserSkills.ArchiveStream]::CopyAsync($process.StandardOutput.BaseStream,[IO.Stream]::Null,[long]::MaxValue,$TimeoutSeconds)
            $bytes=[BrowserSkills.ArchiveStream]::CopyAsync($file,$process.StandardInput.BaseStream,$MaximumBytes,$TimeoutSeconds).GetAwaiter().GetResult()
            $process.StandardInput.Close()
        }
        if(-not $process.WaitForExit(30000)){throw 'Archive command did not finish within its bounded timeout.'}
        $stderr.GetAwaiter().GetResult()|Out-Null
        if($Direction -eq 'Send'){$stdout.GetAwaiter().GetResult()|Out-Null}
        # pg_restore errors may contain SQL values. Never emit stdout/stderr from a data transport.
        if($process.ExitCode -ne 0){throw "Archive command failed (exit $($process.ExitCode)); sensitive command output suppressed."}
        return $bytes
    }finally{if($process){if(-not $process.HasExited){$process.Kill($true)};$process.Dispose()};if($file){$file.Dispose()}}
}
function Assert-CleanArchiveProfile([System.Collections.IDictionary]$Container,[string]$Helper){
    $state=$Container.State
    if($state.Running -or $state.OOMKilled -or $state.Status -notin @('created','exited') -or ($state.Status -eq 'exited' -and $state.ExitCode -ne 0)){throw 'Browser did not stop cleanly; backup is incomplete.'}
    if($state.Status -eq 'created'){
        Invoke-RemoteDocker @('exec',$Helper,'sh','-ec','test -z "$(find /data -mindepth 1 -maxdepth 1 -print -quit)"')|Out-Null
    }
    $r=Invoke-BoundedProcess docker @('--host',$script:RemoteEndpoint,'exec',$Helper,'sh','-ec','for name in SingletonLock SingletonCookie SingletonSocket; do if [ -e "/data/$name" ] || [ -L "/data/$name" ]; then exit 42; fi; done') -AllowFailure
    if($r.Code -ne 0){throw 'Chromium singleton locks remain or profile inspection failed; backup is incomplete.'}
}
function Assert-RemoteTar([string]$Path,[long]$MaximumExpandedBytes,[int]$MaximumEntries=200000){
    $file=[IO.File]::OpenRead($Path);$gzip=$null;$reader=$null
    try{
        $gzip=[IO.Compression.GZipStream]::new($file,[IO.Compression.CompressionMode]::Decompress,$true)
        $reader=[System.Formats.Tar.TarReader]::new($gzip,$true)
        $count=0;$bytes=0L
        while($null -ne ($entry=$reader.GetNextEntry($false))){
            $count++;$bytes+=$entry.Length
            if($count -gt $MaximumEntries -or $bytes -gt $MaximumExpandedBytes){throw 'Expanded archive exceeds its configured limit.'}
            if($entry.Name.StartsWith('/') -or $entry.Name.Contains('\') -or $entry.Name.Contains(':') -or @($entry.Name.Split('/')|Where-Object{$_ -eq '..'}).Count){throw 'Unsafe archive entry path.'}
            if($entry.EntryType.ToString() -notin @('RegularFile','V7RegularFile','Directory')){throw 'Archive links/devices are unsupported; preserve and inspect this backup.'}
        }
    }finally{if($reader){$reader.Dispose()};if($gzip){$gzip.Dispose()};$file.Dispose()}
}
