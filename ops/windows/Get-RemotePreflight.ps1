#Requires -Version 7.4
[CmdletBinding()]
param([string]$Endpoint = 'tcp://192.168.0.107:2375', [string]$OutputPath)
. "$PSScriptRoot/Remote-Common.ps1"
$script:RemoteEndpoint = $Endpoint
$report = [ordered]@{measuredAtUtc=[DateTime]::UtcNow.ToString('o'); endpoint=$Endpoint}
$info = (Invoke-RemoteDocker @('info', '--format', '{{json .}}')) | ConvertFrom-Json
if ($info.OSType -ne 'linux') { throw 'A Linux Docker engine is required.' }
$report.engine = @{name=$info.Name; serverVersion=$info.ServerVersion; operatingSystem=$info.OperatingSystem; cpuCount=$info.NCPU; guestMemoryTotalBytes=$info.MemTotal; nvidiaRuntimeAvailable=($null -ne $info.Runtimes.nvidia)}
$report.browserSkillsImages = @(Invoke-RemoteDocker @('image', 'ls', '--filter', 'reference=browserskills*', '--format', '{{.Repository}}:{{.Tag}} {{.ID}}') | Where-Object { $_ })
$report.browserSkillsContainers = @(Invoke-RemoteDocker @('ps', '-a', '--filter', 'name=browserskills', '--format', '{{.Names}} {{.Status}} {{.Ports}}') | Where-Object { $_ })
$report.browserSkillsVolumes = @(Invoke-RemoteDocker @('volume', 'ls', '--filter', 'name=browserskills', '--format', '{{.Name}}') | Where-Object { $_ })
$report.publishedPorts = @((Invoke-RemoteDocker @('ps', '--format', '{{.Names}} {{.Ports}}')) -split '\r?\n' | Where-Object { $_ -match '->' })
$report.containerMemory = @((Invoke-RemoteDocker @('stats', '--no-stream', '--format', '{{.Name}} {{.MemUsage}} {{.CPUPerc}}')) -split '\r?\n')
$image = 'nvidia/cuda:12.8.1-runtime-ubuntu24.04@sha256:ebef3c171eeef0298e4eb2e4be843105edf3b8b0ac45e0b43acee358e8046867'
$name = 'browserskills-preflight-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
try {
    $report.cudaImage = $image
    $report.probe = Invoke-RemoteDocker @('run', '--rm', '--name', $name, '--label', "browserskills.preflight=$name", '--gpus', 'all', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '128m', '--cpus', '0.5', '--pids-limit', '32', '--entrypoint', 'sh', $image, '-c',
        'set -e; nvidia-smi --query-gpu=name,driver_version,memory.total,memory.free --format=csv,noheader,nounits; awk ''/^(MemTotal|MemAvailable):/ { print }'' /proc/meminfo; df -B1 /') -TimeoutSeconds 600
} finally {
    $probe = Invoke-BoundedProcess docker @('--host', $Endpoint, 'inspect', $name, '--format', '{{index .Config.Labels "browserskills.preflight"}}') -AllowFailure
    if ($probe.Code -eq 0 -and $probe.Out.Trim() -eq $name) { Invoke-RemoteDocker @('rm', '-f', $name) | Out-Null }
}
$report.scope = 'Guest memory and Linux filesystem availability are measured inside Docker Desktop WSL2; these are not Windows physical RAM or host-drive free space. Existing application containers are only listed, never stopped or modified.'
$json = $report | ConvertTo-Json -Depth 8
if ($OutputPath) { Write-Utf8 $OutputPath $json }
$json
