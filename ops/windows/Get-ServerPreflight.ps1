#Requires -Version 7.4
[CmdletBinding()]
param([string]$ServerIp = '192.168.0.107', [string]$OutputPath, [switch]$CheckContainerGpu)
. "$PSScriptRoot/Common.ps1"
if (-not $IsWindows) { throw 'Run locally on the Windows server.' }
$os = Get-CimInstance Win32_OperatingSystem
$computer = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$nvidia = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
$gpu = @(if ($nvidia) {
    $rows = & $nvidia.Source '--query-gpu=name,driver_version,memory.total,memory.free' '--format=csv,noheader,nounits'
    if ($LASTEXITCODE -ne 0) { throw 'nvidia-smi failed; GPU/driver readiness is unverified.' }
    @($rows | ConvertFrom-Csv -Header Name,DriverVersion,TotalVramMiB,FreeVramMiB)
} else { @() })
$dockerVersion = (& docker version --format '{{json .Server}}' 2>&1 | Out-String).Trim()
$dockerReady = $LASTEXITCODE -eq 0
$wslProcess = [Diagnostics.Process]::new()
$wslProcess.StartInfo = [Diagnostics.ProcessStartInfo]::new('wsl.exe', '--status')
$wslProcess.StartInfo.UseShellExecute = $false
$wslProcess.StartInfo.RedirectStandardOutput = $true
$wslProcess.StartInfo.RedirectStandardError = $true
$wslProcess.StartInfo.StandardOutputEncoding = [Text.Encoding]::Unicode
$wslProcess.StartInfo.CreateNoWindow = $true
$wslProcess.Start() | Out-Null
$wslOutput = $wslProcess.StandardOutput.ReadToEndAsync()
$wslError = $wslProcess.StandardError.ReadToEndAsync()
if (-not $wslProcess.WaitForExit(10000)) { $wslProcess.Kill(); throw 'WSL status timed out.' }
$wsl = $wslOutput.GetAwaiter().GetResult().Trim()
$wslProcess.Dispose()
$containerGpu = 'not measured'
if ($CheckContainerGpu) {
    if (-not $dockerReady) { throw 'Docker engine is unavailable.' }
    $containerGpu = (& docker run --rm --gpus all --network none --entrypoint nvidia-smi nvidia/cuda:12.8.1-runtime-ubuntu24.04@sha256:ebef3c171eeef0298e4eb2e4be843105edf3b8b0ac45e0b43acee358e8046867 --query-gpu=name,driver_version,memory.total,memory.free --format=csv,noheader | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Docker CUDA GPU check failed; driver/WSL/container support is not ready.' }
}
$report = [ordered]@{
    measuredAtUtc = [DateTime]::UtcNow.ToString('o')
    os = $os.Caption; architecture = $os.OSArchitecture; cpu = $cpu.Name
    ramGiB = [math]::Round($computer.TotalPhysicalMemory / 1GB, 2)
    freeRamGiB = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
    gpu = $gpu
    localIpMatches = [bool](Get-NetIPAddress -AddressFamily IPv4 | Where-Object IPAddress -EQ $ServerIp)
    networkCategories = @(Get-NetConnectionProfile | Select-Object InterfaceIndex,NetworkCategory)
    freeDiskGiB = @(Get-Volume | Where-Object DriveLetter | ForEach-Object { @{ drive = $_.DriveLetter; freeGiB = [math]::Round($_.SizeRemaining / 1GB, 2) } })
    dockerReady = $dockerReady; docker = $dockerVersion; wsl = $wsl; containerGpu = $containerGpu
    listeningPorts = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object LocalPort -In @(8443, 8080, 3000, 5432, 5900) | Select-Object LocalAddress,LocalPort,OwningProcess)
    requirements = @{ engine = 'Docker Desktop Linux WSL2'; freeDiskGiB = 100; gpuBenchmarkRequired = $true }
}
$json = $report | ConvertTo-Json -Depth 6
if ($OutputPath) { Write-Utf8 $OutputPath $json }
$json
if (-not $gpu.Count) { Write-Warning 'No NVIDIA telemetry. Do not claim GPU readiness from the screenshot.' }
