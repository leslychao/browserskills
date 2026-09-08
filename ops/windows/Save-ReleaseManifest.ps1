#Requires -Version 7.4
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Destination)
. "$PSScriptRoot/Common.ps1"
Assert-Docker
if (Test-Path -LiteralPath $Destination) { throw 'Release manifest is immutable; choose a new output file.' }
$root = Get-ProjectRoot
$configRaw = & docker compose --project-directory $root -f (Join-Path $root compose.yaml) config --format json
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve Compose configuration.' }
$config = ($configRaw -join "`n") | ConvertFrom-Json
$images = @{}
foreach ($service in @('api', 'browser-1', 'inference', 'postgres')) {
    $tag = $config.services.$service.image
    $inspection = & docker image inspect $tag --format '{{json .}}'
    if ($LASTEXITCODE -ne 0) { throw "Missing prepared image: $service" }
    $detail = ($inspection -join "`n") | ConvertFrom-Json
    $images[$service] = @{tag=$tag; id=$detail.Id; repoDigests=$detail.RepoDigests}
}
$commit = & git -C $root rev-parse HEAD 2>$null
if ($LASTEXITCODE -ne 0) { $commit = $null }
$dirty = [bool](& git -C $root status --porcelain)
$manifest = @{createdAtUtc=[DateTime]::UtcNow.ToString('o'); gitCommit=$commit; dirtyWorktree=$dirty; images=$images;
    modelRecipeSha256=(Get-FileHash -LiteralPath (Join-Path $root ops/inference/model.lock.json)).Hash.ToLowerInvariant();
    packageLockSha256=(Get-FileHash -LiteralPath (Join-Path $root package-lock.json)).Hash.ToLowerInvariant()}
Write-Utf8 $Destination ($manifest | ConvertTo-Json -Depth 8)
Write-Output 'Actual local image IDs recorded. Dirty/uncommitted source is explicitly marked in the release manifest.'
