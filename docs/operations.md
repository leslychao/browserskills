# BrowserSkills: Windows / Docker Compose

The local first-start commands below run on the Windows server; the remote Docker workflow runs on the operator computer. The target is `192.168.0.107`. A real remote CUDA probe confirmed RTX 3070, driver 610.62 and 8192 MiB VRAM (6156 MiB free at measurement). Docker Desktop WSL2 reported 15.52 GiB guest RAM, distinct from the approximately 32 GiB Windows physical RAM shown in the supplied screenshot. The target model completed its synthetic diagnostic, as recorded below.

The final 100-case synthetic evaluation on `.107` (RTX 3070) measured 88% text, 80% image, 100% speech and 28% sound/prosody accuracy. Text, image and sound/prosody failed the unchanged 90% quality gate; all measured latency gates passed, without inference errors. These diagnostics do not establish live-Yang acceptance. Exact measurements, historical `.109` results, conditions and outstanding checks are recorded in [verification](verification.md).

The service target is `https://yang.yandex-team.ru/?activeTab=all`. The autonomous Yang release has been deployed on `.107`; current image identities and acceptance results are recorded in [verification](verification.md). Corporate sign-in and one-time codes remain interactive; credentials must not be embedded in images or configuration.

## Remote Docker deployment used on .107

The user explicitly selected LAN HTTP without certificates and subsequently chose one shared workspace without BrowserSkills authentication. The endpoint is [BrowserSkills](http://192.168.0.107:8080). Application sessions coordinate exclusive manual browser control; CSRF and HttpOnly/SameSite cookies remain. All application sessions see the same history and quota. Yang's own corporate login and second factor remain in the server browser. No CA installation or certificate bypass is required.

The shared workspace reuses the existing assignment with the lowest worker number, preserving its history and Yang profile. An empty installation creates `local` automatically. Historical user rows, other profile volumes and protected operator credential archives are retained for data recovery and rollback; they no longer provide separate application logins. The earlier provisioning commands below document the existing installation and its recovery tools.

The operator supplied the existing `tcp://192.168.0.107:2375` Docker endpoint. These scripts do not enable or reconfigure it, alter Windows settings, or stop another project. Local bind paths and Compose file secrets are replaced with separate named volumes on the selected daemon. The API receives its own secret volume, PostgreSQL another, and each worker only its own token. Files are transferred through an isolated temporary uploader, verified by SHA256 and restricted to the actual runtime UID (API 10001, browser 1001, PostgreSQL 999). Operator credentials remain in a protected local directory and never enter an image.

The existing installation was prepared with these commands:

```powershell
pwsh -NoProfile -File ops/windows/Get-RemotePreflight.ps1 -Endpoint tcp://192.168.0.107:2375 -OutputPath runtime/remote-107-preflight.json
pwsh -NoProfile -File ops/windows/Prepare-RemoteUi.ps1 -ServerIp 192.168.0.107 -Endpoint tcp://192.168.0.107:2375 -ApiImage browserskills-api:lan-http -Login vitalii
# Use the new protected directory printed by Prepare-RemoteUi:
$deploymentDirectory = '<prepared directory>'
pwsh -NoProfile -File ops/windows/Publish-RemoteUi.ps1 -Directory $deploymentDirectory
```

Prepare freezes local image IDs and generates only database/worker credentials and the first operator password. Publish streams image bytes using `docker save`/`load`, rejects conflicting resources, verifies hashes and UID permissions, starts the UI services and provisions the account through Java CLI stdin. It publishes only `192.168.0.107:8080`. Compose reads the frozen seccomp file on the operator computer and sends compact JSON to the daemon; this is not a remote bind path ([Compose 2.29.7 implementation](https://github.com/docker/compose/blob/v2.29.7/pkg/compose/create.go#L436-L471)). Workers retain read-only roots, dropped capabilities, no privileged mode, individual networks and the actual seccomp JSON.

The existing `.107` deployment was migrated from its initial HTTPS configuration using these actual commands:

```powershell
$deploymentDirectory = 'runtime/remote-107/71a2479ad7764a008143936e204f355c'
& ./ops/windows/Prepare-RemoteLanHttp.ps1 -Directory $deploymentDirectory -ComposeFile @("$deploymentDirectory/compose.remote.json", 'runtime/remote-107-inference-20260909T045336Z.override.json') -ApiImage sha256:235c84d251fc91a5ff3fac02d2643bb119e4c8dbf41df3607b7c48fb5285fb3e
& ./ops/windows/Publish-RemoteLanHttp.ps1 -Directory $deploymentDirectory
node ops/tests/Test-RemoteAuth.mjs $deploymentDirectory
```

Preparation renders a standalone combined configuration and freezes the prior container IDs. Publication changes only the API image, its origin/session/listener environment and published port. The actual migration preserved PostgreSQL, all five browsers and inference IDs, the verified model SHA256 and operator password. It removed the old API publication on 8443. Evidence is `lan-http-result.json` and `auth-http-smoke-result.json` in the protected directory. The HTTP auth smoke passed static assets/CSP, anonymous rejection, CSRF requirement, login/session rotation, authenticated status and logout, with no browser OPEN, RFB input or Yandex action. Run this smoke before interactive user sessions.

**Subsequent operations on this deployment must use the single current `compose.lan-http.json`, not the historical HTTPS base/overlay or the initial UI bootstrap.** The current full stack includes the verified model. For an intentional full stack start:

```powershell
docker --host tcp://192.168.0.107:2375 compose --project-directory . --project-name browserskills -f runtime/remote-107/71a2479ad7764a008143936e204f355c/compose.lan-http.json up -d --no-build --pull never
```

The original HTTPS configuration and certificate artifacts remain only as protected prior-deployment rollback data; no new certificate is generated. `operator-credentials.json` contains the unchanged login/password and updated HTTP origin. The local-host backup/restore scripts use local bind paths and are not the remote-volume recovery workflow. Remote backups require streaming the dump/profile archives and secret volumes through the Docker API; implementation is pending. Docker restart policies apply once Docker Desktop is running, but this remote deployment did not configure Windows sign-in startup or verify a Windows reboot.

## Prerequisites and first start

Use PowerShell 7.4+, Docker Desktop with its Linux WSL2 engine, a working NVIDIA Windows/WSL driver and at least 100 GiB free on the host drive and inside Docker storage for build caches, model sources and conversion. The converter itself requires 60 GiB free at its start. Reserve about 24 GiB RAM for Docker if the machine is dedicated to this application, leaving RAM for Windows. The scripts do not install drivers, enable automatic Windows sign-in or change WSL resource settings.

From the repository root in an administrator PowerShell window:

```powershell
pwsh -NoProfile -File ops/windows/Get-ServerPreflight.ps1 -ServerIp 192.168.0.107 -CheckContainerGpu -OutputPath runtime/preflight-107.json
pwsh -NoProfile -File ops/windows/Initialize-Deployment.ps1 -ServerIp 192.168.0.107 -ClientAddress 192.168.0.0/24 -ConfigureFirewall
docker compose config --quiet
docker compose build api browser-1 inference
pwsh -NoProfile -File ops/windows/Prepare-Model.ps1 -Build -BudgetMinutes 180
pwsh -NoProfile -File ops/windows/Start-Deployment.ps1
pwsh -NoProfile -File ops/windows/Manage-User.ps1 -Action Create -Login user1
```

Create the `runtime` directory before selecting an output path there. The provisioning command asks for a password through the Java console, never through a command argument. Repeat for up to five users; assignments are permanent and managed by the API. `-Action Disable` immediately disables an account through the same CLI.

`Initialize-Deployment.ps1` verifies that the requested IP belongs to this machine. It creates random database/worker credentials and a LAN HTTP origin. Secrets reside in the ignored `secrets` directory with inheritance disabled and access limited to the current operator, Administrators and SYSTEM. Existing credentials are never replaced by a rerun. No CA or server certificate is generated. An existing different origin is rejected for explicit migration rather than silently overwritten.

Open [BrowserSkills on the LAN](http://192.168.0.107:8080). Use only the trusted client network selected for this deployment; credentials and task contents travel over HTTP. The session cookie retains HttpOnly and SameSite=Lax and intentionally omits Secure for the user-selected HTTP contract.

Compose publishes only API port 8080 on the explicitly selected IP. PostgreSQL and inference use internal networks. Each browser has its own network, token and named persistent profile; only the API joins all five. Workers can reach Yandex on the Internet, but cannot directly reach the inference or database network. There is no Docker socket mount or privileged container. Chromium runs as a non-root user with the [Playwright v1.63 seccomp profile](https://github.com/microsoft/playwright/blob/v1.63.0/utils/docker/seccomp_profile.json), plus `chroot` allowed for its zygote inside the sandbox user namespace. This addition is required with `cap_drop: ALL`; the resulting configuration was verified with a real non-root Chromium launch while retaining `no-new-privileges` and without granting `SYS_ADMIN`.

The firewall script adds an allow rule restricted to the supplied client addresses and Private/Domain profiles. Existing broad Docker Desktop / Windows firewall rules can widen effective access; inspect effective inbound rules and verify from an allowed and a disallowed client before exposing real accounts. Do not publish Docker daemon or VNC ports.

## Model preparation and evaluation

`ops/inference/model.lock.json` records immutable llama.cpp and official Qwen revisions. Large source-file SHA256 values come from official Hugging Face LFS metadata; small-file and source-archive hashes were computed from downloaded bytes. The source is [llama.cpp v0.4.0](https://github.com/ggml-org/llama.cpp/tree/5266f24da75dc449bd56cbed7addb9c8e4a6a73e); weights are [Qwen/Qwen2.5-Omni-7B](https://huggingface.co/Qwen/Qwen2.5-Omni-7B/tree/ae9e1690543ffd5c0221dc27f79834d0294cba00), Apache-2.0. Container bases are pinned by actual registry digests in Dockerfiles/Compose.

The converter verifies every required source file, converts the language model to F16 then Q4_K_M, and exports the combined image/audio mmproj as Q8_0. Talker generation is unused. Its global deadline is 180 minutes by default, maximum 360; transport retries are limited to three attempts per file. Completed source files are reused after checksum verification. A partial file or partial conversion never becomes a serving manifest. Converted SHA256 values and the installed Python package list are written from actual output into `/models/provenance.json`. Upgrades use a new model volume; a differing recipe cannot overwrite an established manifest.

The serving wrapper rechecks model hashes at startup. It fixes 8192 tokens, one slot, GPU language layers, CPU mmproj, 120-second inference timeout and disabled context shifting. Inference HTTP is private, tools are unused and request/output logging is disabled. API concurrency and quota are enforced separately. Resource limits in Compose are initial limits, not measured capacity claims.

Converter Python dependencies are pinned in `ops/inference/conversion-requirements.lock`, resolved and checked from the actual successful converter build. Its SHA256 is part of the recipe lock, which the serving wrapper also verifies. The initial CUDA build uses the upstream dynamic-backend/link strategy because a build container does not contain the host GPU driver; GPU access is enabled only for inference.

The recipe identity uses canonical JSON, so Windows/Linux whitespace or line endings cannot silently change it. The dependency lock is explicitly LF and its actual file SHA256 is checked during the converter build. Both the API and evaluator read `apps/api/src/main/resources/decision-system.txt`; the evaluation report records the exact system-prompt and evaluator hashes. The explicit ANSWER/ABSTAIN object semantics matter: a grammar alone constrains syntax but does not explain the choice to the model.

Cross-request prompt and idle-slot caching are disabled (`--cache-ram 0`, `--no-cache-idle-slots`, `--no-cache-prompt`, and `cache_prompt:false` in requests). The API keeps original snapshot option IDs while the model sees a fresh bijection of random ten-letter lowercase aliases. The evaluator uses the same rule, preserves option labels/order and records each case's actual aliases in that order. Replaying with `--replay-aliases` requires the identical corpus SHA256, so diagnostic results can be reproduced without choosing a more favorable random mapping.

The optional diagnostic generator below creates 120 synthetic sets from programmatic shapes/tones and an installed English Windows SAPI voice, including five 60-second audio boundary cases and 20 composed sets. It does not download audio, clone a voice or use model-generated expected answers. For acceptance of natural speech, environmental sounds, music and live tasks, supply a reviewed corpus reflecting the actual project.

Evaluate a labelled corpus through the actual running inference endpoint:

```powershell
pwsh -NoProfile -File ops/windows/New-DiagnosticCorpus.ps1 -Destination artifacts/evaluation
pwsh -NoProfile -File ops/windows/Invoke-ModelEvaluation.ps1 -CorpusDirectory artifacts/evaluation -OutputPath artifacts/evaluation-result.json
```

The version 2 diagnostic corpus contains `schemaVersion:2`, provenance/labelMethod and cases with `id`, category, instruction, ordered `parts:[{id,text,fields,media}]` and scoped `expected:[{partId,fieldId,value}]`. Fields use the production TaskField kinds. No `expectedOptionId` or one-choice response is accepted. Media paths stay inside the corpus directory; SHA256 and byte/audio budgets are validated. `--validate-only` does not call the model. The generator preserves 100 original diagnostic questions and adds 20 composed sets (30 per category); these synthetic labels do not establish production quality.

The Windows wrapper accepts at most 128 MiB/2000 corpus entries, rejects reparse points, streams into a unique temporary directory, removes the copy after evaluation and never overwrites reports or original audio. FFmpeg retains bounded mono 16k PCM16 WAV normalization. Context 8192, request 120 s, selected audio 120 s and 64 MiB request material limits remain. `evaluate.py` reports whole-set exact accuracy, refusals as unsolved, measured latency/resources and `source=direct-model-diagnostic`, `productionPipeline=false`, `admissionEvidence=false`. It uses the canonical AnswerSet prompt with 2048 output tokens. Its result cannot enable production categories.

Production admission requires independently labelled whole sets executed through actual extraction, instruction preparation and answer stages, minimum 25 per capability and 90% wholly correct (all fields). Record predictions separately, then score them:

```powershell
python ops/inference/score_sets.py --corpus artifacts/labelled-sets.json --predictions artifacts/pipeline-predictions.json --output artifacts/whole-set-report.json --evidence-output artifacts/quality-evidence.json
```

The scorer input prediction manifest must contain the actual model SHA256, exact corpus SHA256, `source=production-pipeline-evaluation`, and case results. A provenance label is not proof of how an experiment ran: preserve the real run evidence and independent labels. The script counts missing/abstained cases in the denominator and writes no existing file. Scoring fixtures or direct diagnostics are not admission evidence.

Install an actually passing evidence file read-only at `API_QUALITY_EVIDENCE_PATH` and set matching `API_MODEL_SHA256`, then restart API. The delivered `ops/inference/quality-evidence.json` admits no categories. No cloud fallback is used. Model unavailable or category blocked still permits manual server-browser control; automatic answering remains blocked.

`Test-Deployment.ps1` checks HTTP liveness, then probes the loopback-only `/health/ready` endpoint from inside the API container. It reports database, all five browsers and inference separately. `-WithoutInference` permits the model to be down; it does not ignore a failed database or browser worker.

## Updating the existing remote Yang deployment

After successful source/system checks and image builds, use the standalone currently active Compose descriptor (do not combine an old TLS descriptor):

```powershell
pwsh -NoProfile -File ops/windows/Update-RemoteYang.ps1 -Directory runtime/remote-107/INSTALL_ID -ComposeFile runtime/remote-107/INSTALL_ID/compose.lan-http.json -ApiImage browserskills-api:yang-RELEASE -BrowserImage browserskills-browser:yang-RELEASE -InferenceImage browserskills-inference:yang-RELEASE
```

The updater freezes image IDs, transfers missing images, prepares a new descriptor, runs the real remote backup before mutation and adds six isolated temporary material volumes. It updates API, five workers and the inference wrapper/diagnostics. PostgreSQL, model weight mounts, secrets, profile mounts and HTTP origin are verified unchanged; the llama.cpp revision and Qwen hashes remain pinned. It outputs the active descriptor and keeps the previous backup/config. Subsequent backups/updates must use that new descriptor. V2 changes the database schema: rollback to the old API requires restoring the corresponding backup into fresh volumes, not merely switching the image. Temporary originals/cache are excluded from backup; restored volumes are empty and owned by the runtime UID.

## Stop, restart and Windows reboot

```powershell
pwsh -NoProfile -File ops/windows/Stop-Deployment.ps1
pwsh -NoProfile -File ops/windows/Start-Deployment.ps1
pwsh -NoProfile -File ops/windows/Test-Deployment.ps1
pwsh -NoProfile -File ops/windows/Register-LogonStartup.ps1
```

The scheduled task starts Docker Desktop and the stack after the configured operator signs into Windows. Docker Desktop WSL2 does **not** provide guaranteed availability before interactive sign-in. No Windows password or automatic sign-in is configured. Container `restart: unless-stopped` applies once the Docker engine is running. If unattended service before sign-in becomes mandatory, change the host design explicitly.

Restart revokes application sessions and reconciles unfinished runs; unknown submissions are never replayed. Browser profiles preserve manual Yandex sign-in unless Yandex expires the session. Stop closes further automation, but cannot undo already-dispatched submissions.

## Backup, restore and pinned updates

```powershell
pwsh -NoProfile -File ops/windows/Backup-Deployment.ps1 -Destination D:\BrowserSkillsBackups\2026-09-09
pwsh -NoProfile -File ops/windows/Start-Deployment.ps1
```

Backup first stops the API and all five browsers, creates a PostgreSQL custom-format dump, then archives the stopped browser profiles, protected secrets and deployment settings. It records archive SHA256 and leaves API/workers stopped even on failure. A failed backup has no final manifest and is incomplete. The backup contains session cookies and account hashes; retain its restricted ACL and encrypt offline copies according to the operator's storage policy. Models can be regenerated or backed up separately with their provenance; they are not copied into every daily backup.

A successful Docker `stop` alone is insufficient: Docker may have killed a process after its timeout. Backup requires each started browser to have exit code 0, no OOM flag and no remaining `SingletonLock`, `SingletonCookie` or `SingletonSocket`, including dangling symlinks. A never-started container is accepted only with an empty profile. Failed clean-shutdown verification leaves an incomplete backup without a final manifest; investigate the profile instead of deleting its locks or calling that backup complete. Normal Compose stop allows 45 seconds for Node/Chromium to close before the display processes exit.

Backup and restore run under the ordinary Windows operator account with Docker access and permission to read the deployment files; the operator must own the new backup directory to apply its protected ACL. They do not need an elevated Windows token and do not change the firewall, certificate store or sign-in settings. This does not bypass existing secret ACLs: use the authorized deployment operator account.

Restore only into a **fresh deployment with empty database/profile volumes**. Copy the original backup's `secrets` and `deployment.env` to `secrets` and `.env` with protected permissions before starting PostgreSQL, so its initialized roles use the preserved credentials. Keep the original server IP or explicitly adjust the HTTP bind address and origin for a replacement host. Build the same application release first, then run:

```powershell
pwsh -NoProfile -File ops/windows/Restore-Deployment.ps1 -BackupDirectory D:\BrowserSkillsBackups\2026-09-09
pwsh -NoProfile -File ops/windows/Start-Deployment.ps1
```

Restore requires manifest schema 1 with both `profilesStopped=true` and `profilesVerifiedClean=true`, verifies every required file hash before changing Docker resources, and rejects any nonempty application database/profile. It never drops a database, clears a volume or automatically overwrites secrets. Verify login, the five user/profile assignments, history, and the reconciliation of interrupted runs after restore. Restore inputs must be trusted backups produced by this deployment; old unverified development backups are rejected.

For updates, create a backup, build a uniquely versioned image set, record `docker image inspect` IDs with the Git commit and model provenance, then change `BROWSERSKILLS_RELEASE` to that prepared version and start without rebuilding. Do not reuse a release tag for different bytes. Preserve named volumes and credentials. Rollback uses the previous recorded image set; if the new release has applied incompatible migrations, restore the matching backup into fresh volumes. `docker compose down` preserves volumes by default; **do not use `down -v`** for updates or normal uninstall. Removing the sign-in task uses `Unregister-ScheduledTask -TaskName BrowserSkillsAfterLogon`; removing the application-specific firewall rule uses `Remove-NetFirewallRule -Name BrowserSkillsHttp`.

Save the exact built image IDs before an update with `pwsh -NoProfile -File ops/windows/Save-ReleaseManifest.ps1 -Destination artifacts/release-0.1.0.json`. The manifest also records the Git commit, whether the worktree is dirty, and dependency/model recipe hashes; an uncommitted build is not misreported as a reproducible tagged release.

## Local verification of this tooling

```powershell
python -m unittest discover -s ops/tests -v
pwsh -NoProfile -File ops/tests/Test-WindowsTools.ps1
pwsh -NoProfile -File ops/tests/Test-RemotePreparation.ps1 -ApiImage browserskills-api:lan-http
pwsh -NoProfile -File ops/tests/Test-SecretAcl.ps1
pwsh -NoProfile -File ops/tests/Test-PostgresBackup.ps1
npx esbuild apps/browser/test/profile-lifecycle.ts --bundle --platform=node --format=esm --packages=external --outfile=.cache/profile-lifecycle.mjs
pwsh -NoProfile -File ops/tests/Test-DeploymentRoundtrip.ps1 -ApiImage browserskills-api:lan-http
docker compose config --quiet
```

These checks cover checksum rejection, bounded corpus validation, fail-closed model startup, score calculation, PowerShell parsing and a real PostgreSQL 17 binary dump/copy/transactional restore roundtrip in uniquely named test containers. The PostgreSQL test removes only its newly created labelled containers/volumes; protected test artifacts remain under `runtime`. They do not prove clean-Windows reboot, live-Yandex or target `.107` performance; those require the corresponding deployment checks.

The deployment roundtrip requires prepared `browserskills-api:lan-http` and `browserskills-browser:local` images (override using `-ApiImage`/`-BrowserImage`). It resolves both tags to immutable image IDs, copies the actual Compose configuration and unchanged backup/restore scripts to isolated roots, publishes no ports, excludes model services/volume, and freezes copies of the current browser entrypoint and owned profile fixture before mounting them. The actual Spring API applies Flyway and provisions five accounts; SQL fixtures add completed history. Five real headed Chromium profiles receive distinct persistent HttpOnly cookies and localStorage at a local fixture origin.

The test invokes the real backup/restore scripts, compares all DB row digests and browser readbacks, checks protected backup ACLs, and rejects nonempty DB/profile volumes, a corrupted archive and an unverified manifest. Using only the disposable source profiles, it also verifies incomplete-backup rejection after a real SIGKILL and after a deliberately stale dangling lock. It removes only containers/volumes carrying its unique test label and retains the report, actual container image IDs, file hashes and protected backup under `runtime/browserskills-roundtrip-*`. A fixture HTTP server replaces the external website, so this is evidence of local storage and recovery behavior, not Yandex session validity.

The current LAN HTTP local `.109` run passed in 159.84 seconds on 2026-09-09 (local time), under a non-administrator Windows token. All six database table digests and all five independent cookie/localStorage profiles matched after restore; every refusal case and backup ACL check passed. Evidence: `runtime/browserskills-roundtrip-96f2f913d617/report.json`, SHA256 `17d4413da9fe8962b5ac6fee49f97dbf9759d601ad2b69dda00637890a00940d`. It generated no certificates and used API image `sha256:235c84d251fc91a5ff3fac02d2643bb119e4c8dbf41df3607b7c48fb5285fb3e` with the same browser image ID in source and restored containers and removed all three labelled test projects and their volumes. Target `.107`, Windows reboot behavior and real Yandex sessions remain separate acceptance checks.

The ACL test creates only a uniquely named workspace fixture with dummy data, removes inherited and explicit broad grants using the real protection helper, verifies unchanged bytes and approved identities, then removes that fixture. Existing deployment secrets receive the same ACL repair without changing their contents.

Run the actual Chromium/media coverage suite using the commands in [the browser worker checks](../apps/browser/README.md#checks). They invoke the browser image under the same dropped capabilities, seccomp policy and `no-new-privileges` used by Compose. The suite exercises real HTTP submissions against the owned fixture site and real ffmpeg/ffprobe media decoding.

The separate real RFB smoke is:

```powershell
docker build -f apps/browser/Dockerfile -t browserskills-browser:local .
npx esbuild apps/browser/test/live-rfb.ts --bundle --platform=node --format=esm --packages=external --outfile=.cache/live-rfb.mjs
$seccompPath = (Resolve-Path ops/seccomp-profile.json).Path
$rfbTest = (Resolve-Path .cache/live-rfb.mjs).Path
docker run --rm --init --cap-drop=ALL --security-opt no-new-privileges --security-opt "seccomp=$seccompPath" --shm-size=1g --mount "type=bind,source=$rfbTest,target=/app/live-rfb.mjs,readonly" --entrypoint node browserskills-browser:local /app/live-rfb.mjs
```

It starts TigerVNC and headed Chromium, exchanges the real RFB handshake, sends keyboard input and verifies navigation, then verifies that automation revokes the live manual-control socket. This was checked against the deterministic owned test surface; it is not evidence of authenticated Yandex compatibility or model quality.
