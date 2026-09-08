# Browser worker

Node 24 owns exactly one persistent Chromium profile. The API is the only HTTP/WebSocket caller and supplies a per-worker bearer secret. `BEGIN` synchronously revokes all manual RFB sockets before claiming the generation/run; `STOP` cancels queued work, closes Chromium and rotates the generation. Browser context uses Chromium sandbox, no automatic downloads, one page and no ignored TLS errors.

The pinned Playwright image uses `pwuser` UID/GID **1001**. The `/run/browser` tmpfs must use that owner with mode `0700`. Use Docker `--init` (Compose `init: true`); the image starts the process supervisor shell directly. The custom seccomp profile permits Chromium's namespace operations and namespaced `chroot`; `cap_drop: ALL` and `no-new-privileges` remain enabled.

`FixedAdapter` accepts source-owned template profiles. Production `verifiedYandexProfiles` remains empty until an authenticated compatible whole-task template is verified. Fixture descriptors are injected only by test constructors. No runtime environment variable, HTTP endpoint or model response can add selectors or a target site. The first observed Yandex demo route is `/task/{poolId}/{taskSuiteId}`; a suite ID alone is not proof of one task per submission. Do not claim live support from fixture tests.

The driver hashes actual media bytes and complete ordered instruction blocks. Original audio is retained temporarily for the authorized Range endpoint. Real ffprobe verifies the stream layout; full bounded ffmpeg decoding counts samples even for FLAC/WebM without container duration. No raw media is logged or persisted in task history. Stops invalidate late media writes. Inference normalization belongs to the API.

## Checks

From repository root:

```powershell
npm run typecheck --workspace @browserskills/browser
npm run build --workspace @browserskills/browser
docker build -f apps/browser/Dockerfile -t browserskills-browser:local .
$seccompPath = (Resolve-Path ops/seccomp-profile.json).Path
$browserSource = (Resolve-Path apps/browser).Path
$fixtureSource = (Resolve-Path tests/test-site).Path
docker run --rm --init --cap-drop=ALL --security-opt no-new-privileges --security-opt "seccomp=$seccompPath" --shm-size=1g --mount "type=bind,source=$browserSource,target=/app/apps/browser,readonly" --mount "type=bind,source=$fixtureSource,target=/app/tests/test-site,readonly" --entrypoint node --workdir /app/apps/browser browserskills-browser:local /app/node_modules/vitest/vitest.mjs run --configLoader runner --coverage --coverage.reportsDirectory=/tmp/coverage
```

The suite uses real Chromium, real HTTP sends, a deterministic test site, original media decoded by ffmpeg/ffprobe, DOM unit tests and bearer/lease tests. The 80% coverage gate includes worker production modules; DOM functions have separate unit coverage because code serialized into Chromium is invisible to Node V8 coverage.

Actual headed-browser RFB smoke (separate from a mock RFB peer):

```powershell
npx esbuild apps/browser/test/live-rfb.ts --bundle --platform=node --format=esm --packages=external --outfile=.cache/live-rfb.mjs
$rfbTest = (Resolve-Path .cache/live-rfb.mjs).Path
docker run --rm --init --cap-drop=ALL --security-opt no-new-privileges --security-opt "seccomp=$seccompPath" --shm-size=1g --mount "type=bind,source=$rfbTest,target=/app/live-rfb.mjs,readonly" --entrypoint node browserskills-browser:local /app/live-rfb.mjs
```

This starts Xvfb and x11vnc, negotiates RFB 3.8 through the authenticated WebSocket, types a fixture URL with actual keyboard events, checks Chromium navigated, and checks that `BEGIN` terminates the socket. It never sends an answer to Yandex.

For API integration, compile `tests/test-site/worker.ts` to `.cache/fixture-worker.mjs` with the same esbuild options. Run Node directly for headless tests, or mount it as `/app/tests/fixture-worker.mjs` and invoke `/bin/bash /app/tests/test-site/start-worker.sh` in the browser image. The shell starts Xvfb/x11vnc and the **test-only** headed worker. Configure `FIXTURE_WORKER_PORT`, `FIXTURE_WORKER_TOKEN`, `FIXTURE_WORKER_ID` and an isolated `FIXTURE_DATA_DIR`; production main ignores these fixture variables.
