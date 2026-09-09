#Requires -Version 7.4
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$CorpusDirectory,
    [Parameter(Mandatory)][string]$OutputPath,
    [ValidateRange(1,360)][int]$BudgetMinutes = 180
)
. "$PSScriptRoot/Common.ps1"
Assert-Docker
$corpus = (Resolve-Path -LiteralPath $CorpusDirectory).Path
if (-not (Test-Path -LiteralPath (Join-Path $corpus 'corpus.json') -PathType Leaf)) { throw 'corpus.json is required.' }
$files = @(Get-ChildItem -LiteralPath $corpus -Recurse -Force)
if ($files.Count -gt 2000 -or (($files | Where-Object { -not $_.PSIsContainer } | Measure-Object Length -Sum).Sum -gt 128MB)) {
    throw 'Evaluation upload is bounded to 2000 entries and 128 MiB to fit the inference tmpfs.'
}
if (((Get-Item -LiteralPath $corpus).Attributes -band [IO.FileAttributes]::ReparsePoint) -or
    ($files | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })) { throw 'Corpus cannot contain reparse points.' }
$output = [IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $output) { throw 'Choose a new output file; measured results are not overwritten.' }
if (-not (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($output)) -PathType Container)) { throw 'Output parent directory must exist.' }
$container = ((Invoke-Compose @('ps', '-q', 'inference')) -join '').Trim()
if ($container -notmatch '^[a-f0-9]{12,64}$') { throw 'Exactly one running inference container is required.' }
$temporary = '/tmp/evaluation-' + [Guid]::NewGuid().ToString('N')
try {
    Invoke-Checked docker @('exec', $container, 'mkdir', '-m', '700', $temporary)
    # PowerShell 7.4 preserves native-to-native byte streams. docker cp refuses a read-only rootfs even for tmpfs.
    & tar -cf - -C $corpus . | & docker exec -i $container tar -xf - -C $temporary
    if ($LASTEXITCODE -ne 0) { throw 'Corpus upload failed.' }
    & docker exec $container python3 /app/evaluate.py --corpus "$temporary/corpus.json" --output "$temporary/result.json" --budget-minutes $BudgetMinutes
    $evaluationExit = $LASTEXITCODE
    $report = & docker exec $container cat "$temporary/result.json"
    if ($LASTEXITCODE -ne 0) { throw 'Evaluation failed before producing a complete measured report.' }
    $json = $report -join "`n"
    $null = $json | ConvertFrom-Json
    Write-Utf8 $output ($json + "`n")
    if ($evaluationExit -ne 0) { throw "Model evaluation gates failed. Measured report: $output" }
    Write-Output "Model evaluation gates passed for this corpus only: $output"
}
finally {
    # A generated fixed-prefix path inside this container's tmpfs; never a caller-selected deletion target.
    Invoke-Checked docker @('exec', $container, 'rm', '-rf', '--', $temporary)
}
