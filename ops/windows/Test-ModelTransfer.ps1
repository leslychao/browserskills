#Requires -Version 7.4
[CmdletBinding()]
param()
. "$PSScriptRoot/Copy-ModelToRemote.ps1"

function Assert-True([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Assert-Throws([scriptblock]$Action, [string]$Message) {
    $failed = $false
    try { & $Action | Out-Null } catch { $failed = $true }
    Assert-True $failed $Message
}

$errors = $null; $tokens = $null
[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot Copy-ModelToRemote.ps1), [ref]$tokens, [ref]$errors) | Out-Null
Assert-True ($errors.Count -eq 0) 'Transfer script must parse.'

$a = 'a' * 64; $b = 'b' * 64; $c = 'c' * 64
$text = "language-Q4_K_M.gguf`t1048576`t$a`nmmproj-Q8_0.gguf`t1024`t$b`nprovenance.json`t123`t$c"
$inventory = Read-ModelInventory $text
$provenance = @{schemaVersion=1; recipeHashEncoding='canonical-json-v1'; recipeLockSha256=$c;
    outputs=@{'language-Q4_K_M.gguf'=$a; 'mmproj-Q8_0.gguf'=$b}} | ConvertTo-Json
Assert-ModelProvenance $provenance $inventory | Out-Null
Assert-MatchingModels $inventory (Read-ModelInventory $text)
Assert-Throws { Assert-ModelProvenance $provenance.Replace($a,$b) $inventory } 'A provenance/output mismatch must fail.'
Assert-Throws { Read-ModelInventory ($text + "`nprovenance.json`t123`t$c") } 'Duplicate paths must fail.'
Assert-Throws { Read-ModelInventory $text.Replace('mmproj-Q8_0.gguf','../../other') } 'Only the three fixed basenames are allowed.'
Assert-Throws { Read-ModelInventory $text.Replace('1048576','20000000000') } 'Oversized archives must fail before transfer.'
Assert-Throws { Read-ModelInventory $text.Replace("123`t$c", "65537`t$c") } 'Oversized provenance must fail.'
Assert-Throws { Assert-MatchingModels $inventory (Read-ModelInventory $text.Replace($a,$b)) } 'Different existing target data must fail.'

$bytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(3MB + 17)
$source = [IO.MemoryStream]::new($bytes, $false); $target = [IO.MemoryStream]::new()
try {
    $copied = [BrowserSkills.ModelTransferStream]::CopyAsync($source, $target, $bytes.Length, [TimeSpan]::FromSeconds(3)).GetAwaiter().GetResult()
    Assert-True ($copied -eq $bytes.Length) 'Binary stream byte count must match.'
    Assert-True ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($target.ToArray())) -eq
        [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))) 'Binary bytes must survive without text conversion.'
} finally { $source.Dispose(); $target.Dispose() }
$source = [IO.MemoryStream]::new($bytes, $false); $target = [IO.MemoryStream]::new()
try {
    Assert-Throws { [BrowserSkills.ModelTransferStream]::CopyAsync($source, $target, 1MB, [TimeSpan]::FromSeconds(3)).GetAwaiter().GetResult() } 'Stream overflow must fail.'
    Assert-True ($target.Length -le 1MB) 'Overflow bytes must not be written.'
} finally { $source.Dispose(); $target.Dispose() }

Add-Type -TypeDefinition @'
using System; using System.IO; using System.Threading; using System.Threading.Tasks;
public sealed class ModelTransferBlockedStream : MemoryStream {
    public override async ValueTask<int> ReadAsync(Memory<byte> memory, CancellationToken token = default) {
        await Task.Delay(Timeout.Infinite, token); return 0;
    }
}
'@
$source = [ModelTransferBlockedStream]::new(); $target = [IO.MemoryStream]::new(); $watch = [Diagnostics.Stopwatch]::StartNew()
try {
    Assert-Throws { [BrowserSkills.ModelTransferStream]::CopyAsync($source, $target, 1MB, [TimeSpan]::FromMilliseconds(100)).GetAwaiter().GetResult() } 'Stalled stream must be cancelled.'
    Assert-True ($watch.Elapsed.TotalSeconds -lt 2) 'Stream cancellation must remain bounded.'
} finally { $source.Dispose(); $target.Dispose() }
Write-Output 'Model transfer checks passed: fixed paths, provenance, no-overwrite comparison, binary bytes, size limit, deadline.'
