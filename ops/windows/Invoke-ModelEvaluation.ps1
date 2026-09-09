#Requires -Version 7.4
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$CorpusDirectory,
    [Parameter(Mandatory)][string]$OutputPath,
    [ValidateRange(1,360)][int]$BudgetMinutes = 180,
    [ValidatePattern('^(tcp|ssh|npipe|unix)://[^\r\n]+$')][string]$DockerHost,
    [string[]]$ComposeFile = @()
)
. "$PSScriptRoot/Common.ps1"

function Get-ModelEvaluationInvocation([string]$Endpoint, [string[]]$Files, [string]$Root) {
    $prefix = @()
    if ($Endpoint) { $prefix = @('--host', $Endpoint) }
    if (-not $Files.Count) { $Files = @(Join-Path $Root compose.yaml) }
    $compose = @('compose', '--project-directory', $Root)
    foreach ($file in $Files) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Compose file does not exist: $file" }
        $compose += @('-f', (Resolve-Path -LiteralPath $file).Path)
    }
    return @{Docker=$prefix; Compose=($prefix + $compose)}
}

function Invoke-ModelEvaluation {
$invocation = Get-ModelEvaluationInvocation $DockerHost $ComposeFile (Get-ProjectRoot)
$dockerArguments = $invocation.Docker
$corpus = (Resolve-Path -LiteralPath $CorpusDirectory).Path
if (-not (Test-Path -LiteralPath (Join-Path $corpus 'corpus.json') -PathType Leaf)) { throw 'corpus.json is required.' }
$corpusManifest = Get-Item -LiteralPath (Join-Path $corpus 'corpus.json')
if ($corpusManifest.Length -gt 10MB) { throw 'Corpus manifest exceeds 10 MiB.' }
$corpusDocument = Get-Content -LiteralPath $corpusManifest.FullName -Raw | ConvertFrom-Json
if ($corpusDocument.schemaVersion -ne 2) { throw 'Generate a new v2 whole-set diagnostic corpus. Historical v1 corpora must remain unchanged.' }
$files = @(Get-ChildItem -LiteralPath $corpus -Recurse -Force)
if ($files.Count -gt 2000 -or (($files | Where-Object { -not $_.PSIsContainer } | Measure-Object Length -Sum).Sum -gt 128MB)) {
    throw 'Evaluation upload is bounded to 2000 entries and 128 MiB to fit the inference tmpfs.'
}
if (((Get-Item -LiteralPath $corpus).Attributes -band [IO.FileAttributes]::ReparsePoint) -or
    ($files | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })) { throw 'Corpus cannot contain reparse points.' }
$output = [IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $output) { throw 'Choose a new output file; measured results are not overwritten.' }
if (-not (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($output)) -PathType Container)) { throw 'Output parent directory must exist.' }
$engine = & docker @dockerArguments info --format '{{.OSType}}'
if ($LASTEXITCODE -ne 0 -or $engine -ne 'linux') { throw 'The selected Docker host must run a Linux engine.' }
$composeArguments = $invocation.Compose + @('ps', '-q', 'inference')
$container = ((& docker @composeArguments) -join '').Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve inference in the selected Compose deployment.' }
if ($container -notmatch '^[a-f0-9]{12,64}$') { throw 'Exactly one running inference container is required.' }
$temporary = '/tmp/evaluation-' + [Guid]::NewGuid().ToString('N')
try {
    Invoke-Checked docker ($dockerArguments + @('exec', $container, 'mkdir', '-m', '700', $temporary))
    # PowerShell 7.4 preserves native-to-native byte streams. docker cp refuses a read-only rootfs even for tmpfs.
    & tar -cf - -C $corpus . | & docker @dockerArguments exec -i $container tar -xf - -C $temporary
    if ($LASTEXITCODE -ne 0) { throw 'Corpus upload failed.' }
    & docker @dockerArguments exec $container timeout --signal=TERM --kill-after=5 "$($BudgetMinutes * 60 + 150)s" python3 /app/evaluate.py --corpus "$temporary/corpus.json" --output "$temporary/result.json" --budget-minutes $BudgetMinutes
    $evaluationExit = $LASTEXITCODE
    $report = & docker @dockerArguments exec $container cat "$temporary/result.json"
    if ($LASTEXITCODE -ne 0) { throw 'Evaluation failed before producing a complete measured report.' }
    $json = $report -join "`n"
    $result = $json | ConvertFrom-Json
    if ($result.schemaVersion -ne 2 -or $result.source -ne 'direct-model-diagnostic' -or
        $result.productionPipeline -ne $false -or $result.admissionEvidence -ne $false) {
        throw 'The inference container did not return a v2 direct-model diagnostic report. Update the deployment before evaluating.'
    }
    $file = [IO.File]::Open($output, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    try { $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json + "`n"); $file.Write($bytes) } finally { $file.Dispose() }
    if ($evaluationExit -ne 0) { throw "Whole-set diagnostic criteria failed. This is not production admission evidence. Measured report: $output" }
    Write-Output "Whole-set diagnostic criteria passed for this corpus only: $output. Production pipeline quality was not evaluated; no admission evidence was installed."
}
finally {
    # A generated fixed-prefix path inside this container's tmpfs; never a caller-selected deletion target.
    Invoke-Checked docker ($dockerArguments + @('exec', $container, 'rm', '-rf', '--', $temporary))
}
}

if ($MyInvocation.InvocationName -ne '.') { Invoke-ModelEvaluation }
