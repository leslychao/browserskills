# Browser worker

Node 24 owns exactly one persistent Chromium profile. The API is the only HTTP/WebSocket caller and supplies a per-worker bearer secret. `BEGIN` synchronously revokes all manual RFB sockets before claiming the generation/run; `STOP` cancels queued work, closes Chromium and rotates the generation. Browser context uses Chromium sandbox, no automatic downloads, one page and no ignored TLS errors.

The pinned Playwright image uses `pwuser` UID/GID **1001**. The `/run/browser` tmpfs must use that owner with mode `0700`. Use Docker `--init` (Compose `init: true`); the image starts the process supervisor shell directly. The custom seccomp profile permits Chromium's namespace operations and namespaced `chroot`; `cap_drop: ALL` and `no-new-privileges` remain enabled.

The entrypoint puts XDG configuration/cache files in that private tmpfs so Chromium can start with a read-only root filesystem. Chromium documents the Linux crash database under [XDG_CONFIG_HOME](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/linux/debugging_minidump.md). On SIGTERM/SIGINT the application alone closes Chromium; Playwright's duplicate signal handlers are disabled. The supervisor keeps Xvfb running until the application has closed the profile, then stops x11vnc/Xvfb. This preserves persistent cookies/localStorage and removes Chromium process locks before backup or container replacement. Compose allows 45 seconds for this graceful stop.

The production browser opens `https://yang.yandex-team.ru/?activeTab=all`, the actual target confirmed by the user. Corporate sign-in uses the site's own `passport.yandex-team.ru` redirect. `FixedAdapter` accepts source-owned template profiles and the Yang origin. Production `verifiedYandexProfiles` remains empty until an authenticated compatible whole-task template is verified. Fixture descriptors are injected only by test constructors. No runtime environment variable, HTTP endpoint or model response can add selectors or a target site. Earlier `tasks.yandex.ru` demo observations were for a different target and do not define Yang templates. Do not claim live support from fixture tests.

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

For API integration, compile `tests/test-site/worker.ts` to `.cache/fixture-worker.mjs` with the same esbuild options. Run Node directly for headless tests, or mount it over `/app/apps/browser/dist/main.js` and invoke `/bin/bash /app/tests/test-site/start-worker.sh` in the browser image. The test wrapper configures the fixture and delegates to the actual production entrypoint. Configure `FIXTURE_WORKER_PORT`, `FIXTURE_WORKER_TOKEN`, `FIXTURE_WORKER_ID` and an isolated `FIXTURE_DATA_DIR`; production main ignores these fixture variables.

`npm run test:profile` uses the actual entrypoint and `BrowserOwner` in a non-root/read-only/sandboxed container with a new named volume. It writes a persistent HttpOnly cookie and localStorage through an owned page, immediately stops Docker, checks that all Chromium process locks were removed, then reads both values from a replacement container with a different hostname. It never opens a real account. The fixture and current entrypoint are mounted read-only; only the test's own containers and volume are removed afterward.
