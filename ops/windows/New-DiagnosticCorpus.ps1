#Requires -Version 7.4
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Destination)
. "$PSScriptRoot/Common.ps1"
if (-not $IsWindows) { throw 'Windows SAPI speech synthesis is required.' }
$directory = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath (Join-Path $directory corpus.json)) { throw 'Corpus already exists. Preserve its labelled bytes; choose a new directory.' }
$media = Join-Path $directory media
New-Item -ItemType Directory -Force $media | Out-Null
$words = @('one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen','twenty','twenty one','twenty two','twenty three','twenty four','twenty five')
$voice = New-Object -ComObject SAPI.SpVoice
$voices = $voice.GetVoices('Language=409')
if ($voices.Count -lt 1) { throw 'An English SAPI voice is required for the authored English diagnostic prompts.' }
$voice.Voice = $voices.Item(0)
function Write-Speech([string]$Name, [string]$Text, [switch]$Xml) {
    $stream = New-Object -ComObject SAPI.SpFileStream
    try {
        $stream.Format.Type = 22
        $stream.Open((Join-Path $media $Name), 3, $false)
        $voice.AudioOutputStream = $stream
        $voice.Speak($Text, $(if ($Xml) { 8 } else { 0 })) | Out-Null
    } finally { $stream.Close(); [Runtime.InteropServices.Marshal]::FinalReleaseComObject($stream) | Out-Null }
}
try {
    foreach ($number in 1..25) { Write-Speech ('speech-{0:D2}.wav' -f $number) $words[$number - 1] }
    foreach ($number in 21..25) {
        $speed = if (($number - 1) % 2) { 5 } else { -5 }
        Write-Speech ('prosody-{0:D2}.wav' -f $number) "<rate absspeed='0'>The train will leave the station.</rate><silence msec='500'/><rate absspeed='$speed'>The train will leave the station.</rate>" -Xml
    }
} finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($voice) | Out-Null }
Invoke-Checked python @((Join-Path $PSScriptRoot '../inference/generate_diagnostic_corpus.py'), '--output', $directory)
Invoke-Checked python @((Join-Path $PSScriptRoot '../inference/evaluate.py'), '--corpus', (Join-Path $directory corpus.json), '--output', (Join-Path $directory results.json), '--validate-only')
Write-Output '100 labelled synthetic diagnostic cases generated and validated. No inference or accuracy measurement was performed.'
