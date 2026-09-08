#Requires -Version 7.4
# Destructive cleanup is restricted to newly created, uniquely named test containers/volumes.
. "$PSScriptRoot/../windows/Common.ps1"
Assert-Docker
$id = 'browserskills-ops-test-' + [Guid]::NewGuid().ToString('N').Substring(0,12)
$testRoot = Join-Path (Get-ProjectRoot) "runtime/$id"
Set-ProtectedDirectory $testRoot
$dbSecret = Join-Path $testRoot db_password
$adminSecret = Join-Path $testRoot postgres_password
Write-Utf8 $dbSecret ([Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)))
Write-Utf8 $adminSecret ([Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)))
$image = 'postgres:17.9-bookworm@sha256:47f917f7409eacd22fc5dfb1dee634e1b55cf0c01d1a7eb701be2227a03e0641'
$containers = @()
$volumes = @()
function Start-TestDatabase([string]$Suffix) {
    $name = "$id-$Suffix"
    $volume = "$name-data"
    Invoke-Checked docker @('volume', 'create', '--label', "browserskills.test=$id", $volume)
    $script:volumes += $volume
    $init = Join-Path (Get-ProjectRoot) ops/postgres/init.sh
    Invoke-Checked docker @('run', '-d', '--name', $name, '--label', "browserskills.test=$id", '--network', 'none', '--memory', '512m', '--cpus', '1',
        '--mount', "type=volume,src=$volume,dst=/var/lib/postgresql/data",
        '--mount', "type=bind,src=$init,dst=/docker-entrypoint-initdb.d/10-browserskills.sh,readonly",
        '--mount', "type=bind,src=$dbSecret,dst=/run/secrets/db_password,readonly",
        '--mount', "type=bind,src=$adminSecret,dst=/run/secrets/postgres_password,readonly",
        '-e', 'POSTGRES_DB=browserskills', '-e', 'POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password', $image)
    $script:containers += $name
    foreach ($attempt in 1..30) {
        & docker exec $name pg_isready -h 127.0.0.1 -U postgres -d browserskills *> $null
        if ($LASTEXITCODE -eq 0) { return $name }
        Start-Sleep -Seconds 1
    }
    throw 'Test PostgreSQL did not start.'
}
try {
    $source = @(Start-TestDatabase 'source')[-1]
    $role = & docker exec $source psql -U postgres -d browserskills -Atc "SELECT rolsuper FROM pg_roles WHERE rolname='browserskills'"
    if ($LASTEXITCODE -ne 0 -or $role.Trim() -ne 'f') { throw 'Application role must exist and must not be a superuser.' }
    Invoke-Checked docker @('exec', $source, 'psql', '-U', 'postgres', '-d', 'browserskills', '-v', 'ON_ERROR_STOP=1', '-c',
        "SET ROLE browserskills; CREATE TABLE ops_backup_probe(id integer PRIMARY KEY, value text NOT NULL); INSERT INTO ops_backup_probe VALUES(1,'roundtrip-verified');")
    Invoke-Checked docker @('exec', $source, 'pg_dump', '--username=postgres', '--dbname=browserskills', '--format=custom', '--file=/tmp/backup.dump')
    $dump = Join-Path $testRoot database.dump
    Invoke-Checked docker @('cp', "${source}:/tmp/backup.dump", $dump)
    $target = @(Start-TestDatabase 'restore')[-1]
    Invoke-Checked docker @('cp', $dump, "${target}:/tmp/restore.dump")
    Invoke-Checked docker @('exec', $target, 'pg_restore', '--exit-on-error', '--single-transaction', '--username=postgres', '--dbname=browserskills', '/tmp/restore.dump')
    $value = & docker exec $target psql -U postgres -d browserskills -Atc 'SELECT value FROM ops_backup_probe WHERE id=1'
    if ($LASTEXITCODE -ne 0 -or $value.Trim() -ne 'roundtrip-verified') { throw 'Actual PostgreSQL dump/copy/restore roundtrip failed.' }
    Write-Output 'PostgreSQL17 initialization, non-superuser application role and binary dump/copy/transactional restore roundtrip passed.'
} finally {
    foreach ($container in $containers) {
        $label = & docker inspect $container --format '{{index .Config.Labels "browserskills.test"}}' 2>$null
        if ($LASTEXITCODE -eq 0 -and $label -eq $id) { & docker rm -f $container | Out-Null }
    }
    foreach ($volume in $volumes) {
        $label = & docker volume inspect $volume --format '{{index .Labels "browserskills.test"}}' 2>$null
        if ($LASTEXITCODE -eq 0 -and $label -eq $id) { & docker volume rm $volume | Out-Null }
    }
    # Test secrets and dump remain under the protected runtime directory for inspection.
}
