# BrowserSkills: Windows / Docker Compose

Run these commands locally on the intended Windows server. The target is `192.168.0.107`; the supplied screenshot shows RTX 3070 and about 32 GiB RAM. Driver version, free VRAM and model performance require fresh measurements. Local build results on another machine do not establish readiness of `.107`.

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

`Initialize-Deployment.ps1` verifies that the requested IP belongs to this machine. It creates random database/worker credentials, an internal CA and a one-year TLS certificate with the IP in SAN. Secrets reside in the ignored `secrets` directory with inheritance disabled and access limited to the current operator, Administrators and SYSTEM. Existing credentials are never replaced by a rerun. API certificate and key are mounted only into the API; each browser receives only its own worker token. The CA signing key is never mounted into any container.

Distribute **only** `secrets/ca_cert.pem` to clients and import it into the current user's trusted root store after verifying its SHA256 out of band. Open [BrowserSkills on the LAN](https://192.168.0.107:8443). No certificate-validation bypass is required. Before the certificate expires, run `pwsh -NoProfile -File ops/windows/Renew-Certificate.ps1 -ServerIp 192.168.0.107`; it preserves the CA/server key, replaces the certificate while the API is stopped and retains the previous certificate for rollback. Keep an offline protected backup of the CA key.

Compose publishes only API port 8443 on the explicitly selected IP. PostgreSQL and inference use internal networks. Each browser has its own network, token and named persistent profile; only the API joins all five. Workers can reach Yandex on the Internet, but cannot directly reach the inference or database network. There is no Docker socket mount or privileged container. Chromium runs as a non-root user with the [Playwright v1.63 seccomp profile](https://github.com/microsoft/playwright/blob/v1.63.0/utils/docker/seccomp_profile.json), plus `chroot` allowed for its zygote inside the sandbox user namespace. This addition is required with `cap_drop: ALL`; the resulting configuration was verified with a real non-root Chromium launch while retaining `no-new-privileges` and without granting `SYS_ADMIN`.

The firewall script adds an allow rule restricted to the supplied client addresses and Private/Domain profiles. Existing broad Docker Desktop / Windows firewall rules can widen effective access; inspect effective inbound rules and verify from an allowed and a disallowed client before exposing real accounts. Do not publish Docker daemon or VNC ports.

## Model preparation and evaluation

`ops/inference/model.lock.json` records immutable llama.cpp and official Qwen revisions. Large source-file SHA256 values come from official Hugging Face LFS metadata; small-file and source-archive hashes were computed from downloaded bytes. The source is [llama.cpp v0.4.0](https://github.com/ggml-org/llama.cpp/tree/5266f24da75dc449bd56cbed7addb9c8e4a6a73e); weights are [Qwen/Qwen2.5-Omni-7B](https://huggingface.co/Qwen/Qwen2.5-Omni-7B/tree/ae9e1690543ffd5c0221dc27f79834d0294cba00), Apache-2.0. Container bases are pinned by actual registry digests in Dockerfiles/Compose.

The converter verifies every required source file, converts the language model to F16 then Q4_K_M, and exports the combined image/audio mmproj as Q8_0. Talker generation is unused. Its global deadline is 180 minutes by default, maximum 360; transport retries are limited to three attempts per file. Completed source files are reused after checksum verification. A partial file or partial conversion never becomes a serving manifest. Converted SHA256 values and the installed Python package list are written from actual output into `/models/provenance.json`. Upgrades use a new model volume; a differing recipe cannot overwrite an established manifest.

The serving wrapper rechecks model hashes at startup. It fixes 8192 tokens, one slot, GPU language layers, CPU mmproj, 120-second inference timeout and disabled context shifting. Inference HTTP is private, tools are unused and request/output logging is disabled. API concurrency and quota are enforced separately. Resource limits in Compose are initial limits, not measured capacity claims.

The optional diagnostic generator below creates 100 synthetic cases from programmatic shapes/tones and an installed English Windows SAPI voice. It does not download audio, clone a voice or use model-generated expected answers. For acceptance of natural speech, environmental sounds, music and live tasks, supply a reviewed corpus reflecting the actual project.

Evaluate a labelled corpus through the actual running inference endpoint:

```powershell
pwsh -NoProfile -File ops/windows/New-DiagnosticCorpus.ps1 -Destination artifacts/evaluation
docker compose cp .\artifacts\evaluation inference:/tmp/evaluation
docker compose exec -T inference python3 /app/evaluate.py --corpus /tmp/evaluation/corpus.json --output /tmp/evaluation-result.json
docker compose cp inference:/tmp/evaluation-result.json .\artifacts\evaluation-result.json
```

The corpus must contain at least 25 cases each for `text`, `image`, `speech`, and `sound-prosody`; include provenance, label method, fixed option IDs, independently assigned expected answers and media SHA256. `--validate-only` checks corpus shape/hashes without running the model. Each case has `id`, `category`, `instruction`, `question`, `options:[{id,label}]`, `expectedOptionId`, and optional `media:[{path,kind,mimeType,sha256,durationMs}]`. Media paths remain inside the corpus directory. Input audio uses the same standard `input_audio` contract documented in the pinned [llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/5266f24da75dc449bd56cbed7addb9c8e4a6a73e/tools/server/README.md).

Warmups are excluded; abstentions/errors are unsolved. Acceptance is at least 90% per category and p95 at most 30 seconds for text/image or 90 seconds for audio tasks. The harness reports only measured results and fails with nonzero exit when gates fail. Attach GPU telemetry (`nvidia-smi` while evaluating), host preflight, model provenance and source corpus hash to the result. Synthetic fixture performance alone does not prove Yandex accuracy, environmental-sound understanding, natural speech/prosody or the acceptance of the actual project template.

If inference is unavailable, `Start-Deployment.ps1 -WithoutInference` starts the app for manual review with an explicit AI error. This is not successful model installation or acceptance.

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

Restore only into a **fresh deployment with empty database/profile volumes**. Copy the original backup's `secrets` and `deployment.env` to `secrets` and `.env` with protected permissions before starting PostgreSQL, so its initialized roles use the preserved credentials. Keep the original server IP or deliberately reissue TLS and adjust origin for a replacement host. Build the same application release first, then run:

```powershell
pwsh -NoProfile -File ops/windows/Restore-Deployment.ps1 -BackupDirectory D:\BrowserSkillsBackups\2026-09-09
pwsh -NoProfile -File ops/windows/Start-Deployment.ps1
```

Restore rejects any nonempty application database/profile. It never drops a database, clears a volume or automatically overwrites secrets. Verify login, the five user/profile assignments, history, and the reconciliation of interrupted runs after restore. Restore inputs must be trusted backups produced by this deployment.

For updates, create a backup, build a uniquely versioned image set, record `docker image inspect` IDs with the Git commit and model provenance, then change `BROWSERSKILLS_RELEASE` to that prepared version and start without rebuilding. Do not reuse a release tag for different bytes. Preserve named volumes and credentials. Rollback uses the previous recorded image set; if the new release has applied incompatible migrations, restore the matching backup into fresh volumes. `docker compose down` preserves volumes by default; **do not use `down -v`** for updates or normal uninstall. Removing the sign-in task uses `Unregister-ScheduledTask -TaskName BrowserSkillsAfterLogon`; removing the application-specific firewall rule uses `Remove-NetFirewallRule -Name BrowserSkillsHttps`.

Save the exact built image IDs before an update with `pwsh -NoProfile -File ops/windows/Save-ReleaseManifest.ps1 -Destination artifacts/release-0.1.0.json`. The manifest also records the Git commit, whether the worktree is dirty, and dependency/model recipe hashes; an uncommitted build is not misreported as a reproducible tagged release.

## Local verification of this tooling

```powershell
python -m unittest discover -s ops/tests -v
pwsh -NoProfile -File ops/tests/Test-WindowsTools.ps1
pwsh -NoProfile -File ops/tests/Test-PostgresBackup.ps1
docker compose config --quiet
```

These checks cover checksum rejection, bounded corpus validation, fail-closed model startup, score calculation, actual certificate-chain/IP-SAN/private-key checks and a real PostgreSQL17 binary dump/copy/transactional restore roundtrip in uniquely named test containers. The PostgreSQL test removes only its newly created labelled containers/volumes; protected test artifacts remain under `runtime`. These checks do not prove full five-profile restore, clean-Windows reboot, live-Yandex or target `.107` performance; those require the corresponding deployment checks.

Run the actual Chromium/media coverage suite using the commands in [the browser worker checks](../apps/browser/README.md#checks). They invoke the browser image under the same dropped capabilities, seccomp policy and `no-new-privileges` used by Compose. The suite exercises real HTTP submissions against the owned fixture site and real ffmpeg/ffprobe media decoding.

The separate real RFB smoke is:

```powershell
docker build -f apps/browser/Dockerfile -t browserskills-browser:local .
npx esbuild apps/browser/test/live-rfb.ts --bundle --platform=node --format=esm --packages=external --outfile=.cache/live-rfb.mjs
$seccompPath = (Resolve-Path ops/seccomp-profile.json).Path
$rfbTest = (Resolve-Path .cache/live-rfb.mjs).Path
docker run --rm --init --cap-drop=ALL --security-opt no-new-privileges --security-opt "seccomp=$seccompPath" --shm-size=1g --mount "type=bind,source=$rfbTest,target=/app/live-rfb.mjs,readonly" --entrypoint node browserskills-browser:local /app/live-rfb.mjs
```

It starts Xvfb, x11vnc and headed Chromium, exchanges the real RFB handshake, sends keyboard input and verifies navigation, then verifies that automation revokes the live manual-control socket. This was checked against the deterministic owned test surface; it is not evidence of authenticated Yandex compatibility or model quality.
