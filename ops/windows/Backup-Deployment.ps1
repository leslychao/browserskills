#Requires -Version 7.4
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Destination)
. "$PSScriptRoot/Common.ps1"
# Docker access and ownership/read access to this deployment are sufficient.
# Set-ProtectedDirectory still enforces the backup ACL; no host settings are changed.
Assert-Docker
$destinationPath = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $destinationPath) { throw 'Choose a new backup directory; existing backups are never overwritten.' }
Set-ProtectedDirectory $destinationPath
$workers = @('browser-1', 'browser-2', 'browser-3', 'browser-4', 'browser-5')
# Quiesce writes before the DB snapshot and profile archives. Leave stopped on every outcome.
Invoke-Compose (@('stop', '-t', '45', 'api') + $workers)
Invoke-Compose @('exec', '-T', 'postgres', 'pg_dump', '--username=postgres', '--dbname=browserskills', '--format=custom', '--file=/tmp/browserskills-backup.dump')
Invoke-Compose @('cp', 'postgres:/tmp/browserskills-backup.dump', (Join-Path $destinationPath 'database.dump'))
Invoke-Compose @('exec', '-T', 'postgres', 'rm', '--', '/tmp/browserskills-backup.dump')
$root = Get-ProjectRoot
$archiveImage = 'postgres:17.9-bookworm@sha256:47f917f7409eacd22fc5dfb1dee634e1b55cf0c01d1a7eb701be2227a03e0641'
foreach ($number in 1..5) {
    $container = & docker compose --project-directory $root -f (Join-Path $root compose.yaml) ps --all --quiet "browser-$number"
    if ($LASTEXITCODE -ne 0 -or -not $container) { throw "Missing browser-$number container; backup is incomplete." }
    $details = & docker inspect $container | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw "Could not inspect browser-$number after stopping it." }
    $state = $details[0].State
    if ($state.Running -or $state.OOMKilled -or $state.Status -notin @('created', 'exited') -or ($state.Status -eq 'exited' -and $state.ExitCode -ne 0)) {
        throw "browser-$number did not stop cleanly. Preserve the profile and investigate before backup."
    }
    $volume = ($details[0].Mounts | Where-Object Destination -EQ '/data/profile').Name
    if (-not $volume) { throw 'Expected named browser profile volume was not found.' }
    if ($state.Status -eq 'created') {
        & docker run --rm --network none --user 0 --entrypoint sh --mount "type=volume,src=$volume,dst=/profile,readonly" $archiveImage -c 'test -z "$(ls -A /profile)"'
        if ($LASTEXITCODE -ne 0) { throw "Never-started browser-$number has a nonempty profile; its clean shutdown cannot be verified." }
    }
    # -L detects dangling links too: stale Chromium locks usually target the old
    # container's hostname or tmpfs. Never delete them to make a backup pass.
    & docker run --rm --network none --user 0 --entrypoint sh --mount "type=volume,src=$volume,dst=/profile,readonly" $archiveImage -c 'for name in SingletonLock SingletonCookie SingletonSocket; do if [ -e "/profile/$name" ] || [ -L "/profile/$name" ]; then exit 1; fi; done'
    if ($LASTEXITCODE -ne 0) { throw "browser-$number profile has Chromium singleton locks or could not be inspected; backup is incomplete." }
    Invoke-Checked docker @('run', '--rm', '--network', 'none', '--user', '0', '--entrypoint', 'tar',
        '--mount', "type=volume,src=$volume,dst=/profile,readonly", '--mount', "type=bind,src=$destinationPath,dst=/backup",
        $archiveImage,
        '-czf', "/backup/profile-$number.tar.gz", '-C', '/profile', '.')
}
Copy-Item -LiteralPath (Join-Path $root secrets) -Destination (Join-Path $destinationPath secrets) -Recurse
Copy-Item -LiteralPath (Join-Path $root '.env') -Destination (Join-Path $destinationPath deployment.env)
$files = @('database.dump', 'profile-1.tar.gz', 'profile-2.tar.gz', 'profile-3.tar.gz', 'profile-4.tar.gz', 'profile-5.tar.gz', 'deployment.env')
$files += @('postgres_password','db_password','worker_1_token','worker_2_token','worker_3_token','worker_4_token','worker_5_token') | ForEach-Object { "secrets/$_" }
$hashes = @{}
foreach ($file in $files) { $hashes[$file] = (Get-FileHash -LiteralPath (Join-Path $destinationPath $file)).Hash.ToLowerInvariant() }
Write-Utf8 (Join-Path $destinationPath 'backup.json') (@{schemaVersion=1; createdAtUtc=[DateTime]::UtcNow.ToString('o'); files=$hashes; profilesStopped=$true; profilesVerifiedClean=$true} | ConvertTo-Json -Depth 5)
Write-Output 'Backup complete. API and browsers remain stopped; Start-Deployment.ps1 resumes service. Backup contains credentials and browser sessions; keep its protected ACL.'
