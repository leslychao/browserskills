#Requires -Version 7.4
[CmdletBinding()]
param([Parameter(Mandatory)][string]$BackupDirectory)
. "$PSScriptRoot/Common.ps1"
# This operates only on Docker resources and readable backup files, not host settings.
Assert-Docker
$backup = [IO.Path]::GetFullPath($BackupDirectory)
$manifest = Get-Content -LiteralPath (Join-Path $backup backup.json) -Raw | ConvertFrom-Json -AsHashtable
if (($manifest['schemaVersion'] -isnot [int] -and $manifest['schemaVersion'] -isnot [long]) -or $manifest['schemaVersion'] -ne 1 -or
    $manifest['profilesStopped'] -isnot [bool] -or $manifest['profilesStopped'] -ne $true -or
    $manifest['profilesVerifiedClean'] -isnot [bool] -or $manifest['profilesVerifiedClean'] -ne $true) {
    throw 'Unsupported or unverified backup manifest: clean browser shutdown must have been verified before backup.'
}
$names = @('database.dump', 'profile-1.tar.gz', 'profile-2.tar.gz', 'profile-3.tar.gz', 'profile-4.tar.gz', 'profile-5.tar.gz', 'deployment.env')
$names += @('postgres_password','db_password','api_cert','api_key','worker_1_token','worker_2_token','worker_3_token','worker_4_token','worker_5_token','ca_cert.pem','ca_private.key') | ForEach-Object { "secrets/$_" }
foreach ($name in $names) {
    if ((Get-FileHash -LiteralPath (Join-Path $backup $name)).Hash.ToLowerInvariant() -ne $manifest.files[$name]) { throw "Backup checksum mismatch: $name" }
}
$root = Get-ProjectRoot
Invoke-Compose @('stop', '-t', '45', 'api', 'browser-1', 'browser-2', 'browser-3', 'browser-4', 'browser-5')
Invoke-Compose @('up', '-d', 'postgres')
$ready = $false
foreach ($attempt in 1..20) {
    & docker compose --project-directory $root -f (Join-Path $root compose.yaml) exec -T postgres pg_isready -h 127.0.0.1 -U postgres -d browserskills *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 3
}
if (-not $ready) { throw 'PostgreSQL did not become ready for restore within 60 seconds.' }
$tableCount = & docker compose --project-directory $root -f (Join-Path $root compose.yaml) exec -T postgres psql -U postgres -d browserskills -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public'"
if ($LASTEXITCODE -ne 0 -or $tableCount.Trim() -ne '0') { throw 'Restore requires an empty application database. Existing data is never dropped. Use a fresh deployment/project.' }
Invoke-Compose @('create', 'browser-1', 'browser-2', 'browser-3', 'browser-4', 'browser-5')
$volumes = @{}
foreach ($number in 1..5) {
    $container = & docker compose --project-directory $root -f (Join-Path $root compose.yaml) ps --all --quiet "browser-$number"
    $mounts = & docker inspect $container --format '{{json .Mounts}}' | ConvertFrom-Json
    $volume = ($mounts | Where-Object Destination -EQ '/data/profile').Name
    if (-not $volume) { throw 'Missing profile volume.' }
    $volumes[$number] = $volume
    Invoke-Checked docker @('run', '--rm', '--network', 'none', '--user', '0', '--entrypoint', 'sh', '--mount', "type=volume,src=$volume,dst=/profile,readonly",
        'postgres:17.9-bookworm@sha256:47f917f7409eacd22fc5dfb1dee634e1b55cf0c01d1a7eb701be2227a03e0641',
        '-c', 'test -z "$(ls -A /profile)"')
}
Invoke-Compose @('cp', (Join-Path $backup database.dump), 'postgres:/tmp/browserskills-restore.dump')
Invoke-Compose @('exec', '-T', 'postgres', 'pg_restore', '--exit-on-error', '--single-transaction', '--username=postgres', '--dbname=browserskills', '/tmp/browserskills-restore.dump')
Invoke-Compose @('exec', '-T', 'postgres', 'rm', '--', '/tmp/browserskills-restore.dump')
foreach ($number in 1..5) {
    Invoke-Checked docker @('run', '--rm', '--network', 'none', '--user', '0', '--entrypoint', 'tar',
        '--mount', "type=volume,src=$($volumes[$number]),dst=/profile", '--mount', "type=bind,src=$backup,dst=/backup,readonly",
        'postgres:17.9-bookworm@sha256:47f917f7409eacd22fc5dfb1dee634e1b55cf0c01d1a7eb701be2227a03e0641',
        '-xzf', "/backup/profile-$number.tar.gz", '-C', '/profile', '--no-same-permissions')
}
Write-Output 'DB and profiles restored. Restore the original secrets before first start; no automatic run resumes. API and browsers remain stopped.'
