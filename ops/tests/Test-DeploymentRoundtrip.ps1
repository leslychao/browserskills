#Requires -Version 7.4
[CmdletBinding()]
param(
    [string]$ApiImage = 'browserskills-api:lan-http',
    [string]$BrowserImage = 'browserskills-browser:local',
    [string]$ProfileFixture = '.cache/profile-lifecycle.mjs'
)
# Integration test. Uses the unchanged backup/restore scripts in disposable project roots.
# Only uniquely labelled test projects/volumes are removed. No model is started or mounted.
. "$PSScriptRoot/../windows/Common.ps1"
Assert-Docker
$repository = Get-ProjectRoot
$fixture = [IO.Path]::GetFullPath((Join-Path $repository $ProfileFixture))
if (-not (Test-Path -LiteralPath $fixture -PathType Leaf)) { throw 'Build apps/browser/test/profile-lifecycle.ts first; see docs/operations.md.' }
$id = 'browserskills-roundtrip-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
$testRoot = Join-Path $repository "runtime/$id"
Set-ProtectedDirectory $testRoot
# Freeze mounted code as well as image IDs; another local build/edit cannot alter
# the restored half of this test after the source snapshot has been recorded.
$fixtureSnapshot = Join-Path $testRoot profile-lifecycle.mjs
$entrypointSnapshot = Join-Path $testRoot browser-start.sh
Copy-Item -LiteralPath $fixture -Destination $fixtureSnapshot
Copy-Item -LiteralPath (Join-Path $repository apps/browser/start.sh) -Destination $entrypointSnapshot
$projects = [Collections.Generic.List[string]]::new()
$workers = @('browser-1', 'browser-2', 'browser-3', 'browser-4', 'browser-5')
$report = [ordered]@{schemaVersion=1; startedAtUtc=[DateTime]::UtcNow.ToString('o'); testId=$id; passed=$false}
$report.windowsAdministrator = ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

function Run([string]$Exe, [string[]]$Arguments, [string]$InputText = '', [int]$TimeoutSeconds = 180, [switch]$AllowFailure) {
    $info = [Diagnostics.ProcessStartInfo]::new($Exe)
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true; $info.RedirectStandardInput = $true
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::Start($info)
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
        $process.StandardInput.Write($InputText); $process.StandardInput.Close()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) { $process.Kill($true); throw "Timed out: $Exe" }
        $result = @{Code=$process.ExitCode; Out=$stdout.GetAwaiter().GetResult(); Err=$stderr.GetAwaiter().GetResult()}
        if ($result.Out.Length + $result.Err.Length -gt 1MB) { throw 'Fixture command output exceeded 1 MiB.' }
        if ($result.Code -ne 0 -and -not $AllowFailure) { throw "$Exe failed ($($result.Code)): $($result.Out)$($result.Err)" }
        return $result
    } finally { $process.Dispose() }
}
function Dc([string]$Root, [string[]]$Arguments, [string]$InputText = '') {
    return (Run docker (@('compose', '--project-directory', $Root, '-f', (Join-Path $Root compose.yaml)) + $Arguments) $InputText).Out.Trim()
}
function Sql([string]$Root, [string]$Query) {
    return Dc $Root @('exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'browserskills', '-v', 'ON_ERROR_STOP=1', '-Atc', $Query)
}
function New-TestSecrets([string]$Directory) {
    Set-ProtectedDirectory $Directory
    foreach ($name in @('postgres_password', 'db_password', 'worker_1_token', 'worker_2_token', 'worker_3_token', 'worker_4_token', 'worker_5_token')) {
        Write-Utf8 (Join-Path $Directory $name) ([Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)))
    }
}
function New-TestProject([string]$Suffix, [string]$SecretsFrom = '') {
    $root = Join-Path $testRoot $Suffix
    Set-ProtectedDirectory $root
    New-Item -ItemType Directory -Path (Join-Path $root ops/windows), (Join-Path $root ops/postgres) -Force | Out-Null
    foreach ($file in @('Common.ps1', 'Backup-Deployment.ps1', 'Restore-Deployment.ps1')) {
        Copy-Item -LiteralPath (Join-Path $repository "ops/windows/$file") -Destination (Join-Path $root "ops/windows/$file")
    }
    # The actual entrypoint, unchanged; LF is required by its Linux interpreter.
    $init = (Get-Content -LiteralPath (Join-Path $repository ops/postgres/init.sh) -Raw).Replace("`r`n", "`n")
    Write-Utf8 (Join-Path $root ops/postgres/init.sh) $init
    Copy-Item -LiteralPath (Join-Path $repository ops/seccomp-profile.json) -Destination (Join-Path $root ops/seccomp-profile.json)
    if ($SecretsFrom) { Copy-Item -LiteralPath $SecretsFrom -Destination (Join-Path $root secrets) -Recurse; Set-ProtectedDirectory (Join-Path $root secrets) }
    else { New-TestSecrets (Join-Path $root secrets) }
    Write-Utf8 (Join-Path $root .env) "BROWSERSKILLS_RELEASE=local`nBROWSERSKILLS_BIND_IP=127.0.0.1`nBROWSERSKILLS_PUBLIC_ORIGIN=http://127.0.0.1:8080`n"
    Copy-Item -LiteralPath (Join-Path $repository compose.yaml) -Destination (Join-Path $root compose.yaml)
    $config = (Run docker @('compose', '--project-directory', $root, '-f', (Join-Path $root compose.yaml), '-p', "$id-$Suffix", 'config', '--format', 'json')).Out | ConvertFrom-Json -AsHashtable
    # Docker Compose accepts split inline YAML items such as "mode=1777", but Docker
    # rejects them as mount targets. Check every service, including the excluded model.
    foreach ($service in $config.services.Values) {
        if ($service.Contains('tmpfs')) {
            foreach ($mount in $service.tmpfs) { if (-not $mount.StartsWith('/')) { throw "Invalid tmpfs target in actual Compose configuration: $mount" } }
        }
    }
    $config.services.Remove('inference'); $config.services.Remove('model-prepare'); $config.volumes.Remove('models'); $config.networks.Remove('download')
    $config.services.api.image = $report.images[$ApiImage]; $config.services.api.Remove('ports')
    foreach ($name in $config.services.Keys) {
        $service = $config.services[$name]
        $service.Remove('build'); $service.restart = 'no'; $service.pull_policy = 'never'; $service.labels = @{'browserskills.test'=$id}
    }
    foreach ($volume in $config.volumes.Values) { $volume.labels = @{'browserskills.test'=$id} }
    foreach ($network in $config.networks.Values) { $network.labels = @{'browserskills.test'=$id} }
    foreach ($number in 1..5) {
        $service = $config.services["browser-$number"]
        $service.image = $report.images[$BrowserImage]
        $service.environment.PROFILE_TEST_MODE = if ($Suffix -eq 'source') { 'seed' } else { 'read' }
        $service.environment.PROFILE_TEST_MARKER = "$id-worker-$number"
        $service.volumes += @{type='bind'; source=$fixtureSnapshot; target='/app/apps/browser/dist/main.js'; read_only=$true}
        $service.volumes += @{type='bind'; source=$entrypointSnapshot; target='/usr/local/bin/browser-start'; read_only=$true}
    }
    Write-Utf8 (Join-Path $root compose.yaml) ($config | ConvertTo-Json -Depth 30)
    $script:projects.Add($root)
    return $root
}
function Wait-Api([string]$Root) {
    foreach ($attempt in 1..60) {
        $result = Run docker @('compose', '--project-directory', $Root, '-f', (Join-Path $Root compose.yaml), 'exec', '-T', 'api', 'curl', '--fail', '--silent', '--max-time', '2', 'http://127.0.0.1:8080/health/live') -AllowFailure
        if ($result.Code -eq 0) { return }
        Start-Sleep -Seconds 1
    }
    throw 'Actual HTTP API did not start within bounded readiness wait.'
}
function Profile-Evidence([string]$Root) {
    $all = @()
    foreach ($number in 1..5) {
        $evidence = $null
        foreach ($attempt in 1..60) {
            $result = Run docker @('compose', '--project-directory', $Root, '-f', (Join-Path $Root compose.yaml), 'exec', '-T', "browser-$number", 'cat', '/tmp/profile-evidence.json') -AllowFailure
            if ($result.Code -eq 0) { $evidence = $result.Out | ConvertFrom-Json -AsHashtable; break }
            Start-Sleep -Seconds 1
        }
        if (-not $evidence) { throw "Missing profile evidence for browser-$number." }
        if ($evidence.workerId -ne "browser-$number" -or $evidence.expectedMarker -ne "$id-worker-$number" -or
            $evidence.match -ne $true -or $evidence.stored -ne "$id-worker-$number" -or $evidence.cookie -ne "$id-worker-$number") {
            $script:report.profileMismatch = $evidence
            throw "Real cookie/localStorage readback mismatch for browser-$number."
        }
        $all += $evidence
    }
    return $all
}
function Assert-Stopped([string]$Root) {
    foreach ($service in @('api') + $workers) {
        $container = Dc $Root @('ps', '--all', '--quiet', $service)
        if (-not $container) { continue }
        if ((Run docker @('inspect', $container, '--format', '{{.State.Running}}')).Out.Trim() -ne 'false') { throw "$service must remain stopped after backup/restore." }
    }
}
function Profile-Volume([string]$Root, [int]$Number) {
    $container = Dc $Root @('ps', '--all', '--quiet', "browser-$Number")
    $mounts = (Run docker @('inspect', $container, '--format', '{{json .Mounts}}')).Out | ConvertFrom-Json
    return ($mounts | Where-Object Destination -EQ '/data/profile').Name
}
function Container-Images([string]$Root, [switch]$IncludeApi) {
    $result = [ordered]@{}
    $services = if ($IncludeApi) { @('api') + $workers } else { $workers }
    foreach ($service in $services) {
        $container = Dc $Root @('ps', '--all', '--quiet', $service)
        $state = (Run docker @('inspect', $container)).Out | ConvertFrom-Json
        $expected = if ($service -eq 'api') { $report.images[$ApiImage] } else { $report.images[$BrowserImage] }
        if ($state[0].Image -ne $expected -or -not $state[0].State.Running) { throw "Expected running $service using its frozen image ID." }
        $result[$service] = $state[0].Image
    }
    return $result
}
$tables = @('flyway_schema_history', 'users', 'browser_assignments', 'runs', 'run_items', 'ai_usage', 'selection_settings')
function Database-Evidence([string]$Root) {
    $result = [ordered]@{}
    foreach ($table in $tables) {
        # DB computes the digest; account hashes never leave PostgreSQL in this report.
        $query = "SELECT json_build_object('count',count(*),'digest',md5(COALESCE(string_agg(row_to_json(t)::text,E'\n' ORDER BY row_to_json(t)::text),''))) FROM $table t"
        $result[$table] = (Sql $Root $query) | ConvertFrom-Json -AsHashtable
    }
    return $result
}
try {
    $report.images = @{}
    foreach ($name in @($ApiImage, $BrowserImage)) { $report.images[$name] = (Run docker @('image', 'inspect', $name, '--format', '{{.Id}}')).Out.Trim() }
    $report.fileSha256 = @{}
    foreach ($file in @('compose.yaml', 'ops/windows/Common.ps1', 'ops/windows/Backup-Deployment.ps1', 'ops/windows/Restore-Deployment.ps1', 'ops/tests/Test-DeploymentRoundtrip.ps1', 'apps/browser/start.sh', 'apps/browser/test/profile-lifecycle.ts', $ProfileFixture)) {
        $report.fileSha256[$file] = (Get-FileHash -LiteralPath (Join-Path $repository $file)).Hash.ToLowerInvariant()
    }
    Write-Output 'Starting isolated PostgreSQL and production HTTP API; applying real Flyway migrations.'
    $source = New-TestProject source
    Dc $source @('up', '-d', '--no-build', 'postgres', 'api') | Out-Null
    Wait-Api $source
    foreach ($number in 1..5) {
        $password = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
        Dc $source @('exec', '-T', 'api', 'java', '-jar', '/app/api.jar', '--spring.main.web-application-type=none', '--spring.profiles.active=admin', "--create-user=roundtrip$number") ($password + "`n") | Out-Null
        $password = $null
    }
    foreach ($number in 1..5) {
        $run = [Guid]::NewGuid(); $item = [Guid]::NewGuid(); $usage = [Guid]::NewGuid(); $request = [Guid]::NewGuid()
        $hash = ('a' * 64)
        $sql = @"
SET ROLE browserskills;
INSERT INTO runs(id,user_id,request_id,max_tasks,processed,status,generation,created_at,updated_at)
SELECT '$run',id,'$request',1,1,'COMPLETED','fixture-$number',now(),now() FROM users WHERE login='roundtrip$number';
INSERT INTO run_items(id,run_id,ordinal,pool_id,suite_id,snapshot_hash,instruction_hash,status,answer_json,created_at)
VALUES('$item','$run',1,'owned-fixture','task-$number','$hash','$hash','SUBMITTED','{"decision":"ANSWER","reason":null,"answers":[{"partId":"part-1","fieldId":"field-1","value":"option-$number"}]}',now());
INSERT INTO ai_usage(id,user_id,request_id,snapshot_hash,instruction_hash,model_hash,status,result_json,created_at,completed_at)
SELECT '$usage',id,'$request','$hash','$hash','fixture-no-inference','COMPLETED','{"decision":"ANSWER","answers":[{"partId":"part-1","fieldId":"field-1","value":"option-$number"}],"reason":null}',now(),now() FROM users WHERE login='roundtrip$number';
INSERT INTO selection_settings(user_id,settings_json) SELECT id,'{"mode":"AUTO","poolId":null,"includePoolIds":[],"excludePoolIds":[],"minReward":"1.00","modalities":["text"],"includeTraining":false,"includeExams":false}' FROM users WHERE login='roundtrip$number';
"@
        Sql $source $sql | Out-Null
    }
    $report.databaseBefore = Database-Evidence $source
    foreach ($table in @('users', 'browser_assignments', 'runs', 'run_items', 'ai_usage', 'selection_settings')) {
        if ($report.databaseBefore[$table].count -ne 5) { throw "Expected five actual rows in $table." }
    }
    Write-Output 'Seeding five real Chromium profiles with independent persistent cookies and localStorage.'
    Dc $source (@('up', '-d', '--no-build') + $workers) | Out-Null
    $report.profilesBefore = @(Profile-Evidence $source)
    $report.sourceContainerImages = Container-Images $source -IncludeApi
    $backup = Join-Path $testRoot backup
    Run pwsh @('-NoProfile', '-File', (Join-Path $source ops/windows/Backup-Deployment.ps1), '-Destination', $backup) -TimeoutSeconds 360 | Out-Null
    Assert-Stopped $source
    if (-not (Test-Path -LiteralPath (Join-Path $backup backup.json))) { throw 'Actual backup did not finish its manifest.' }
    $approvedSids = @('S-1-5-18', 'S-1-5-32-544', [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
    foreach ($entry in @((Get-Item -LiteralPath $backup)) + @(Get-ChildItem -LiteralPath $backup -Recurse -Force)) {
        foreach ($rule in (Get-Acl -LiteralPath $entry.FullName).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $approvedSids) { throw 'Backup retained a broad Windows ACL grant.' }
        }
    }
    if (-not (Get-Acl -LiteralPath $backup).AreAccessRulesProtected) { throw 'Backup ACL inheritance must be disabled.' }
    $report.backupAclProtected = $true
    $report.backupManifestSha256 = (Get-FileHash -LiteralPath (Join-Path $backup backup.json)).Hash.ToLowerInvariant()
    if ((Get-Content -LiteralPath (Join-Path $backup backup.json) -Raw | ConvertFrom-Json).profilesVerifiedClean -ne $true) { throw 'Backup did not attest its clean-profile verification.' }
    # Reproduce the stale dangling lock from an interrupted Chromium shutdown only
    # in this disposable source volume. The production backup must fail closed.
    $sourceVolume = Profile-Volume $source 3
    $pgImage = 'postgres:17.9-bookworm@sha256:47f917f7409eacd22fc5dfb1dee634e1b55cf0c01d1a7eb701be2227a03e0641'
    Run docker @('run', '--rm', '--network', 'none', '--user', '0', '--entrypoint', 'ln', '--mount', "type=volume,src=$sourceVolume,dst=/profile", $pgImage, '-s', 'old-disposable-container-123', '/profile/SingletonLock') | Out-Null
    $uncleanBackup = Join-Path $testRoot rejected-unclean-backup
    $reject = Run pwsh @('-NoProfile', '-File', (Join-Path $source ops/windows/Backup-Deployment.ps1), '-Destination', $uncleanBackup) -TimeoutSeconds 180 -AllowFailure
    if ($reject.Code -eq 0 -or $reject.Err -notmatch 'Chromium singleton locks' -or (Test-Path -LiteralPath (Join-Path $uncleanBackup backup.json))) { throw 'Unclean profile was accepted as a complete backup.' }
    $report.uncleanProfileBackupRejected = $true
    # Docker stop returns success for an already-killed process too. Verify the
    # separate exit-code guard with a real SIGKILL of one disposable worker.
    Dc $source @('start', 'browser-1') | Out-Null
    $seedReady = $false
    foreach ($attempt in 1..30) {
        $result = Run docker @('compose', '--project-directory', $source, '-f', (Join-Path $source compose.yaml), 'exec', '-T', 'browser-1', 'cat', '/tmp/profile-evidence.json') -AllowFailure
        if ($result.Code -eq 0 -and ($result.Out | ConvertFrom-Json).match) { $seedReady = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $seedReady) { throw 'Disposable worker did not become ready for interrupted-shutdown regression.' }
    $killedContainer = Dc $source @('ps', '--quiet', 'browser-1')
    Run docker @('kill', '--signal', 'KILL', $killedContainer) | Out-Null
    $killedBackup = Join-Path $testRoot rejected-killed-backup
    $reject = Run pwsh @('-NoProfile', '-File', (Join-Path $source ops/windows/Backup-Deployment.ps1), '-Destination', $killedBackup) -TimeoutSeconds 180 -AllowFailure
    if ($reject.Code -eq 0 -or $reject.Err -notmatch 'did not stop cleanly' -or (Test-Path -LiteralPath (Join-Path $killedBackup backup.json))) { throw 'SIGKILL was accepted as a clean complete backup.' }
    $report.killedBrowserBackupRejected = $true
    # The source archives are complete. Release its networks/memory before the fresh project;
    # its labelled volumes are retained until the guarded final cleanup.
    Dc $source @('down', '--timeout', '45') | Out-Null
    Write-Output 'Restoring the genuine database dump and five profile archives into a fresh isolated project.'
    $target = New-TestProject restored (Join-Path $backup secrets)
    Copy-Item -LiteralPath (Join-Path $backup deployment.env) -Destination (Join-Path $target .env) -Force
    Run pwsh @('-NoProfile', '-File', (Join-Path $target ops/windows/Restore-Deployment.ps1), '-BackupDirectory', $backup) -TimeoutSeconds 360 | Out-Null
    Assert-Stopped $target
    $report.databaseAfter = Database-Evidence $target
    if (($report.databaseBefore | ConvertTo-Json -Depth 8 -Compress) -cne ($report.databaseAfter | ConvertTo-Json -Depth 8 -Compress)) { throw 'Restored DB rows/digests differ from the source.' }
    Dc $target (@('up', '-d', '--no-build') + $workers) | Out-Null
    $report.profilesAfter = @(Profile-Evidence $target)
    $report.restoredContainerImages = Container-Images $target
    Dc $target (@('stop', '-t', '45') + $workers) | Out-Null

    Write-Output 'Checking rejection of nonempty database, corrupted backup and nonempty profile without losing existing data.'
    $reject = Run pwsh @('-NoProfile', '-File', (Join-Path $target ops/windows/Restore-Deployment.ps1), '-BackupDirectory', $backup) -TimeoutSeconds 180 -AllowFailure
    if ($reject.Code -eq 0 -or $reject.Err -notmatch 'empty application database') { throw 'Nonempty database was not rejected for the expected reason.' }
    if (($report.databaseAfter | ConvertTo-Json -Depth 8 -Compress) -cne ((Database-Evidence $target) | ConvertTo-Json -Depth 8 -Compress)) { throw 'Rejected restore changed existing DB contents.' }
    $badBackup = Join-Path $testRoot damaged-backup
    Copy-Item -LiteralPath $backup -Destination $badBackup -Recurse
    Set-ProtectedDirectory $badBackup
    [IO.File]::AppendAllText((Join-Path $badBackup profile-3.tar.gz), 'deliberate fixture corruption')
    $reject = Run pwsh @('-NoProfile', '-File', (Join-Path $target ops/windows/Restore-Deployment.ps1), '-BackupDirectory', $badBackup) -AllowFailure
    if ($reject.Code -eq 0 -or $reject.Err -notmatch 'Backup checksum mismatch: profile-3.tar.gz') { throw 'Corrupted backup was not rejected by its SHA256.' }
    $unverifiedBackup = Join-Path $testRoot unverified-backup
    Copy-Item -LiteralPath $backup -Destination $unverifiedBackup -Recurse
    Set-ProtectedDirectory $unverifiedBackup
    $unverifiedManifest = Get-Content -LiteralPath (Join-Path $unverifiedBackup backup.json) -Raw | ConvertFrom-Json -AsHashtable
    $unverifiedManifest.Remove('profilesVerifiedClean')
    Write-Utf8 (Join-Path $unverifiedBackup backup.json) ($unverifiedManifest | ConvertTo-Json -Depth 5)
    $reject = Run pwsh @('-NoProfile', '-File', (Join-Path $target ops/windows/Restore-Deployment.ps1), '-BackupDirectory', $unverifiedBackup) -AllowFailure
    if ($reject.Code -eq 0 -or $reject.Err -notmatch 'Unsupported or unverified backup manifest') { throw 'Missing clean-profile attestation was not rejected before restore.' }
    $nonempty = New-TestProject nonempty (Join-Path $backup secrets)
    Dc $nonempty (@('create', '--no-build') + $workers) | Out-Null
    $volume = Profile-Volume $nonempty 3
    Run docker @('run', '--rm', '--network', 'none', '--user', '0', '--entrypoint', 'sh', '--mount', "type=volume,src=$volume,dst=/profile", $pgImage, '-c', 'printf preserved > /profile/do-not-overwrite') | Out-Null
    $reject = Run pwsh @('-NoProfile', '-File', (Join-Path $nonempty ops/windows/Restore-Deployment.ps1), '-BackupDirectory', $backup) -TimeoutSeconds 180 -AllowFailure
    if ($reject.Code -eq 0) { throw 'Nonempty profile volume was accepted.' }
    if ((Sql $nonempty "SELECT count(*) FROM pg_tables WHERE schemaname='public'") -ne '0') { throw 'DB was modified before all target profiles were verified empty.' }
    $marker = (Run docker @('run', '--rm', '--network', 'none', '--user', '0', '--entrypoint', 'cat', '--mount', "type=volume,src=$volume,dst=/profile,readonly", $pgImage, '/profile/do-not-overwrite')).Out.Trim()
    if ($marker -ne 'preserved') { throw 'Rejected profile restore overwrote the existing marker.' }
    $report.rejections = @{nonemptyDatabase=$true; damagedProfileHash=$true; unverifiedManifest=$true; nonemptyProfile=$true; existingDataPreserved=$true}
    $report.passed = $true
} catch {
    $report.error = $_.Exception.Message
    throw
} finally {
    $cleanup = @()
    foreach ($root in $projects) {
        $name = (Get-Content -LiteralPath (Join-Path $root compose.yaml) -Raw | ConvertFrom-Json).name
        if (-not $name.StartsWith($id + '-')) { throw 'Refusing cleanup outside the unique fixture project prefix.' }
        $containers = (Run docker @('ps', '-aq', '--filter', "label=com.docker.compose.project=$name")).Out.Trim()
        foreach ($container in @($containers -split '\r?\n' | Where-Object { $_ })) {
            if ((Run docker @('inspect', $container, '--format', '{{index .Config.Labels "browserskills.test"}}')).Out.Trim() -ne $id) { throw 'Refusing cleanup of an unlabelled container.' }
        }
        $volumes = (Run docker @('volume', 'ls', '-q', '--filter', "label=com.docker.compose.project=$name")).Out.Trim()
        foreach ($volume in @($volumes -split '\r?\n' | Where-Object { $_ })) {
            if ((Run docker @('volume', 'inspect', $volume, '--format', '{{index .Labels "browserskills.test"}}')).Out.Trim() -ne $id) { throw 'Refusing cleanup of an unlabelled volume.' }
        }
        Dc $root @('down', '--volumes', '--remove-orphans', '--timeout', '45') | Out-Null
        $cleanup += $name
    }
    $report.cleanedProjects = $cleanup
    $report.finishedAtUtc = [DateTime]::UtcNow.ToString('o')
    Write-Utf8 (Join-Path $testRoot report.json) ($report | ConvertTo-Json -Depth 16)
    Write-Output "Roundtrip report: $(Join-Path $testRoot report.json)"
}
Write-Output 'Real backup/restore roundtrip passed: Flyway database, five Chromium profiles and rejection/preservation cases. Only disposable labelled Docker resources were removed.'
