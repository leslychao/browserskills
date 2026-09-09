#Requires -Version 7.4
[CmdletBinding()]
param(
    [ValidateSet('tcp://192.168.0.107:2375')][string]$RemoteEndpoint = 'tcp://192.168.0.107:2375',
    [ValidateSet('desktop-linux')][string]$SourceContext = 'desktop-linux',
    [ValidateRange(2,120)][int]$BudgetMinutes = 30
)
. "$PSScriptRoot/Remote-Common.ps1"

if (-not ('BrowserSkills.ModelTransferStream' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
namespace BrowserSkills {
    public static class ModelTransferStream {
        public static async Task<long> CopyAsync(Stream source, Stream target, long maximum, TimeSpan timeout) {
            if (maximum < 0 || timeout <= TimeSpan.Zero) throw new ArgumentOutOfRangeException();
            using var cancellation = new CancellationTokenSource(timeout);
            byte[] buffer = new byte[1024 * 1024];
            long total = 0;
            while (true) {
                int count = await source.ReadAsync(buffer.AsMemory(), cancellation.Token);
                if (count == 0) break;
                total = checked(total + count);
                if (total > maximum) throw new IOException("Model archive exceeded its verified byte bound.");
                await target.WriteAsync(buffer.AsMemory(0, count), cancellation.Token);
            }
            await target.FlushAsync(cancellation.Token);
            return total;
        }
    }
}
'@
}

function Read-ModelInventory([string]$Text) {
    $result = [ordered]@{}
    foreach ($line in $Text.Trim() -split "`n") {
        $parts = $line.TrimEnd("`r") -split "`t"
        if ($parts.Count -ne 3 -or $parts[0] -notin @('language-Q4_K_M.gguf', 'mmproj-Q8_0.gguf', 'provenance.json') -or
            $result.Contains($parts[0]) -or $parts[1] -notmatch '^[1-9][0-9]{0,10}$' -or $parts[2] -notmatch '^[a-f0-9]{64}$') {
            throw 'Model inventory is invalid.'
        }
        $result[$parts[0]] = @{bytes=[long]$parts[1]; sha256=$parts[2]}
    }
    if ($result.Count -ne 3) { throw 'Exactly three model files are required.' }
    $total = ($result.Values | ForEach-Object { $_.bytes } | Measure-Object -Sum).Sum
    if ($total -gt 16GB -or $result['provenance.json'].bytes -gt 65536) { throw 'Model files exceed the transfer bounds.' }
    return $result
}

function Assert-ModelProvenance([string]$Text, [System.Collections.IDictionary]$Inventory) {
    if ([Text.Encoding]::UTF8.GetByteCount($Text) -gt 65536) { throw 'Model provenance is too large.' }
    $provenance = $Text | ConvertFrom-Json -AsHashtable
    if ($provenance.schemaVersion -ne 1 -or $provenance.recipeHashEncoding -ne 'canonical-json-v1' -or
        $provenance.recipeLockSha256 -notmatch '^[a-f0-9]{64}$' -or $provenance.outputs.Count -ne 2) {
        throw 'Unsupported model provenance.'
    }
    foreach ($name in @('language-Q4_K_M.gguf', 'mmproj-Q8_0.gguf')) {
        if ($provenance.outputs[$name] -cne $Inventory[$name].sha256) { throw "Source checksum differs from provenance: $name" }
    }
    return $provenance
}

function Assert-MatchingModels([System.Collections.IDictionary]$Expected, [System.Collections.IDictionary]$Actual) {
    foreach ($name in @('language-Q4_K_M.gguf', 'mmproj-Q8_0.gguf', 'provenance.json')) {
        if ($Expected[$name].bytes -ne $Actual[$name].bytes -or $Expected[$name].sha256 -cne $Actual[$name].sha256) {
            throw "Target contains different model data; nothing will be overwritten: $name"
        }
    }
}

function Invoke-ModelTransfer {
    $root = Get-ProjectRoot
    $volume = 'browserskills_models'
    $helper = 'postgres:17.9-bookworm@sha256:47f917f7409eacd22fc5dfb1dee634e1b55cf0c01d1a7eb701be2227a03e0641'
    if ((Get-Content -LiteralPath (Join-Path $root compose.yaml) -Raw) -notmatch [regex]::Escape($helper)) {
        throw 'The transfer helper must match the pinned PostgreSQL image in compose.yaml.'
    }
    $source = @('--context', $SourceContext)
    $target = @('--host', $RemoteEndpoint)
    $id = [guid]::NewGuid().ToString('N')
    $sender = "browserskills-model-send-$id"
    $receiver = "browserskills-model-receive-$id"
    $stage = "/models/.browserskills-model-transfer-$id"
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $budget = $BudgetMinutes * 60
    $report = [ordered]@{schemaVersion=1; transferId=$id; startedAt=[DateTimeOffset]::UtcNow.ToString('o'); sourceContext=$SourceContext;
        remoteEndpoint=$RemoteEndpoint; volume=$volume; helperImage=$helper; status='FAILED'; transferredBytes=0}
    $runtime = Join-Path $root runtime
    New-Item -ItemType Directory -Path $runtime -Force | Out-Null
    $reportPath = Join-Path $runtime ("remote-107-model-transfer-{0}-{1}.json" -f [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'), $id.Substring(0,8))
    $stagingStarted = $false
    $sourceProcess = $null; $targetProcess = $null
    function Remaining { return [Math]::Max(1, [int][Math]::Floor($budget - $clock.Elapsed.TotalSeconds)) }
    function Docker([string[]]$Prefix, [string[]]$Arguments, [switch]$AllowFailure) {
        if ($clock.Elapsed.TotalSeconds -ge $budget) { throw 'Model transfer time budget exhausted.' }
        return Invoke-BoundedProcess docker ($Prefix + $Arguments) '' (Remaining) -AllowFailure:$AllowFailure
    }
    $run = @('run', '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true', '--memory', '96m', '--pids-limit', '32', '--entrypoint', 'sh')
    $inventoryScript = @'
set -eu
for name in language-Q4_K_M.gguf mmproj-Q8_0.gguf provenance.json; do
  test -f "/models/$name" && test ! -L "/models/$name" || exit 42
  printf '%s\t%s\t%s\n' "$name" "$(stat -c '%s' "/models/$name")" "$(sha256sum "/models/$name" | cut -d ' ' -f 1)"
done
'@
    $targetStateScript = @'
set -eu
if test -z "$(find /models -mindepth 1 -maxdepth 1 -print -quit)"; then printf 'EMPTY\n'; exit 0; fi
test "$(find /models -mindepth 1 -maxdepth 1 | wc -l)" -eq 3 || { printf 'Target is nonempty and not an exact serving-model set.\n' >&2; exit 43; }
'@ + "`n" + $inventoryScript
    $cleanupScript = @'
set -eu
stage="$1"
case "$stage" in /models/.browserskills-model-transfer-*) ;; *) exit 44;; esac
if test -d "$stage" && test ! -L "$stage"; then
  if test ! -f "$stage/committed"; then
    for name in language-Q4_K_M.gguf mmproj-Q8_0.gguf provenance.json; do
      if test "/models/$name" -ef "$stage/$name"; then rm -- "/models/$name"; fi
    done
  fi
  rm -rf -- "$stage"
fi
'@
    try {
        foreach ($entry in @(@{prefix=$source; key='sourceEngineId'}, @{prefix=$target; key='targetEngineId'})) {
            $identity = (Docker $entry.prefix @('info', '--format', '{{.ID}}|{{.OSType}}')).Out.Trim() -split '\|'
            if ($identity.Count -ne 2 -or $identity[1] -ne 'linux' -or $identity[0] -notmatch '^[a-zA-Z0-9:_.-]{5,120}$') { throw 'Expected an identified Linux Docker engine.' }
            $report[$entry.key] = $identity[0]
        }
        if ($report.sourceEngineId -eq $report.targetEngineId) { throw 'Source and target Docker engines must differ.' }
        foreach ($prefix in @($source, $target)) { Docker $prefix @('image', 'inspect', $helper, '--format', '{{.Id}}') | Out-Null }
        Docker $source @('volume', 'inspect', $volume, '--format', '{{.Name}}') | Out-Null
        $readMount = @('--mount', "type=volume,source=$volume,target=/models,readonly,volume-nocopy")
        $inventory = Read-ModelInventory ((Docker $source ($run + $readMount + @($helper, '-c', $inventoryScript))).Out)
        $provenanceText = (Docker $source ($run + $readMount + @($helper, '-c', 'test -f /models/provenance.json && test ! -L /models/provenance.json && test "$(stat -c %s /models/provenance.json)" -le 65536 && cat /models/provenance.json'))).Out
        $provenance = Assert-ModelProvenance $provenanceText $inventory
        $report['recipeLockSha256'] = $provenance.recipeLockSha256
        $report['files'] = $inventory
        $existing = Docker $target @('volume', 'inspect', $volume, '--format', '{{.Name}}') -AllowFailure
        if ($existing.Code -eq 0) {
            $state = (Docker $target ($run + $readMount + @($helper, '-c', $targetStateScript))).Out.Trim()
            if ($state -ne 'EMPTY') {
                Assert-MatchingModels $inventory (Read-ModelInventory $state)
                $report.status = 'ALREADY_MATCHING'
                return
            }
        } else {
            # Only the specifically authorized named volume is created. No host bind mounts.
            Docker $target @('volume', 'create', '--label', 'com.browserskills.purpose=models', $volume) | Out-Null
        }
        $checksums = ($inventory.Keys | ForEach-Object { "$($inventory[$_].sha256)  $_" }) -join "`n"
        $total = [long](($inventory.Values | ForEach-Object { $_.bytes } | Measure-Object -Sum).Sum)
        $receiveScript = @'
set -eu
stage="$1"
test -z "$(find /models -mindepth 1 -maxdepth 1 -print -quit)" || { printf 'Target changed before transfer.\n' >&2; exit 43; }
test "$(df -PB1 /models | awk 'NR==2 {print $4}')" -ge "$2" || { printf 'Insufficient remote model volume space.\n' >&2; exit 45; }
mkdir -m 700 -- "$stage"
cleanup() {
  if test ! -f "$stage/committed"; then
    for name in language-Q4_K_M.gguf mmproj-Q8_0.gguf provenance.json; do
      if test "/models/$name" -ef "$stage/$name"; then rm -- "/models/$name"; fi
    done
  fi
  rm -rf -- "$stage"
}
trap cleanup EXIT HUP INT TERM
tar --extract --file=- --directory="$stage" --no-same-owner --no-same-permissions --keep-old-files -- language-Q4_K_M.gguf mmproj-Q8_0.gguf provenance.json
for name in language-Q4_K_M.gguf mmproj-Q8_0.gguf provenance.json; do test -f "$stage/$name" && test ! -L "$stage/$name" || exit 42; done
cd "$stage"
printf '%s\n' "$3" | sha256sum --check --status
test "$(find /models -mindepth 1 -maxdepth 1 | wc -l)" -eq 1 || { printf 'Target changed during transfer.\n' >&2; exit 43; }
chmod 644 -- language-Q4_K_M.gguf mmproj-Q8_0.gguf provenance.json
# Hard links fail on an existing destination; the serving manifest is published last.
for name in language-Q4_K_M.gguf mmproj-Q8_0.gguf provenance.json; do ln -T -- "$stage/$name" "/models/$name"; done
sync -f /models/provenance.json
touch "$stage/committed"
printf 'Verified model files published.\n'
'@
        $sourceArgs = $source + $run + @('--name', $sender) + $readMount + @($helper, '-c',
            'exec tar --format=ustar --create --file=- --directory=/models -- language-Q4_K_M.gguf mmproj-Q8_0.gguf provenance.json')
        $targetArgs = $target + $run + @('--name', $receiver, '-i', '--mount', "type=volume,source=$volume,target=/models,volume-nocopy",
            $helper, '-c', $receiveScript, 'model-receive', $stage, [string]($total + 64MB), $checksums)
        function Start-Transport([string[]]$Arguments, [bool]$InputStream) {
            $info = [Diagnostics.ProcessStartInfo]::new('docker')
            $info.UseShellExecute=$false; $info.CreateNoWindow=$true
            $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true; $info.RedirectStandardInput=$InputStream
            foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
            return [Diagnostics.Process]::Start($info)
        }
        $stagingStarted = $true
        $targetProcess = Start-Transport $targetArgs $true
        $sourceProcess = Start-Transport $sourceArgs $false
        $sourceError = $sourceProcess.StandardError.ReadToEndAsync()
        $targetError = $targetProcess.StandardError.ReadToEndAsync()
        $targetOutput = $targetProcess.StandardOutput.ReadToEndAsync()
        $copy = [BrowserSkills.ModelTransferStream]::CopyAsync($sourceProcess.StandardOutput.BaseStream,
            $targetProcess.StandardInput.BaseStream, $total + 1MB, [TimeSpan]::FromSeconds((Remaining)))
        $report.transferredBytes = $copy.GetAwaiter().GetResult()
        $targetProcess.StandardInput.Close()
        foreach ($process in @($sourceProcess, $targetProcess)) {
            if (-not $process.WaitForExit((Remaining) * 1000)) { throw 'Model transport process did not finish within its budget.' }
        }
        if ($sourceProcess.ExitCode -ne 0 -or $targetProcess.ExitCode -ne 0) {
            throw ('Model transport failed: ' + $sourceError.GetAwaiter().GetResult() + $targetError.GetAwaiter().GetResult())
        }
        $verified = Read-ModelInventory ((Docker $target ($run + $readMount + @($helper, '-c', $targetStateScript))).Out)
        Assert-MatchingModels $inventory $verified
        $report.status = 'TRANSFERRED'
    } catch {
        $report['error'] = $_.Exception.Message
        throw
    } finally {
        foreach ($process in @($sourceProcess, $targetProcess)) {
            if ($null -ne $process) { if (-not $process.HasExited) { $process.Kill($true) }; $process.Dispose() }
        }
        if ($stagingStarted) {
            $cleanupWarnings = [Collections.Generic.List[string]]::new()
            foreach ($arguments in @(
                ($source + @('rm', '-f', $sender)),
                ($target + @('rm', '-f', $receiver)),
                ($target + $run + @('--mount', "type=volume,source=$volume,target=/models,volume-nocopy",
                    $helper, '-c', $cleanupScript, 'model-cleanup', $stage))
            )) {
                try { Invoke-BoundedProcess docker $arguments '' 30 -AllowFailure | Out-Null }
                catch { $cleanupWarnings.Add($_.Exception.Message) }
            }
            if ($cleanupWarnings.Count -gt 0) { $report['cleanupWarnings'] = @($cleanupWarnings) }
        }
        $report['finishedAt'] = [DateTimeOffset]::UtcNow.ToString('o')
        $report['elapsedSeconds'] = [Math]::Round($clock.Elapsed.TotalSeconds, 2)
        $file = [IO.File]::Open($reportPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        try { $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($report | ConvertTo-Json -Depth 8)); $file.Write($bytes) } finally { $file.Dispose() }
        Write-Output "Model transfer $($report.status). Report: $reportPath"
    }
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-ModelTransfer }
