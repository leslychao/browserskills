#Requires -Version 7.4
[CmdletBinding()]
param([switch]$Build, [ValidateRange(1,360)][int]$BudgetMinutes = 180)
. "$PSScriptRoot/Common.ps1"
Assert-Docker
if ($Build) { Invoke-Compose @('--profile', 'tools', 'build', 'model-prepare') }
Invoke-Compose @('--profile', 'tools', 'run', '--rm', 'model-prepare', '--budget-minutes', "$BudgetMinutes")
$root = Get-ProjectRoot
$raw = & docker compose --project-directory $root -f (Join-Path $root compose.yaml) --profile tools run --rm --no-deps --entrypoint cat model-prepare /models/provenance.json
if ($LASTEXITCODE -ne 0) { throw 'Cannot read converted model provenance.' }
$provenance = ($raw -join "`n") | ConvertFrom-Json
$hash = $provenance.outputs.'language-Q4_K_M.gguf'
if ($hash -notmatch '^[a-f0-9]{64}$') { throw 'Invalid model output hash.' }
$envPath = Join-Path $root '.env'
if (-not (Test-Path -LiteralPath $envPath)) { throw 'Initialize deployment before preparing model configuration.' }
$lines = @(Get-Content -LiteralPath $envPath | Where-Object { $_ -notmatch '^API_MODEL_SHA256=' })
Write-Utf8 $envPath (($lines + "API_MODEL_SHA256=$hash") -join "`n")
New-Item -ItemType Directory -Force (Join-Path $root runtime) | Out-Null
Write-Utf8 (Join-Path $root runtime/model-provenance.json) ($provenance | ConvertTo-Json -Depth 10)
Write-Output 'Model converted and verified; actual language-model hash configured for API usage history.'
