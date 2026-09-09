# BrowserSkills API

Spring Boot 4.1.1 / Java 21 server for the accepted contract in `docs/IMPLEMENTATION.md`. The API owns sessions, browser leases, durable run state, quota and model requests. A worker never receives an API session cookie or account password.

## Verification

Use Java 21, a running Docker daemon and FFmpeg on `PATH`, then run `./mvnw verify` (`.\mvnw.cmd verify` on Windows). Integration tests start a real, digest-pinned PostgreSQL 17.9 container; no Docker test is skipped. FFmpeg tests perform real WAV conversion and check original bytes, duration and preserved silence. JaCoCo enforces at least 80% line coverage over all production classes, without exclusions. Reports are under `target/site/jacoco`, `target/surefire-reports` and `target/failsafe-reports`.

The network WebSocket test uses an RFC6455/RFB fixture peer to prove API authorization, binary relay and revocation. It does not prove the real Xvfb/noVNC stack, a Yandex template, model quality or `.107` GPU performance. The root full-system harness verifies the API with real browser workers and labelled fixtures. Actual site/model acceptance remains separate.

The source is formatted with google-java-format 1.35.0. The official Maven wrapper pins Maven 3.9.16. The multi-stage Dockerfile builds React assets into the API JAR; image construction does not substitute for `mvnw verify`.

## Configuration

The agreed LAN deployment serves HTTP on port 8080. Certificate files are not required. Mount read-only secrets via `/run/secrets`:

- `db_password`.
- `worker_1_token` through `worker_5_token`; each token authorizes exactly its configured private worker.

Environment variables: `BROWSERSKILLS_DB_URL`, `BROWSERSKILLS_DB_USERNAME`, `BROWSERSKILLS_PUBLIC_ORIGIN`, `API_WORKER_1_URL` through `API_WORKER_5_URL`, `API_INFERENCE_URL`, `API_MODEL_SHA256`, and optional `BROWSERSKILLS_DAILY_QUOTA` (100). Default workers are `http://browser-N:3000`; inference is `http://inference:8080`. See the Compose deployment for network isolation, resource limits and model provenance.

For local tests, the explicit `dev` profile binds HTTP to `127.0.0.1:8080`. Override `server.port` and `api.public-origin` together when using another local port. The production LAN cookie keeps HttpOnly and SameSite=Lax and omits Secure so browsers send it over the explicitly selected HTTP transport. No default user or password is provisioned.

Account CLI, with the same database configuration as the service:

```text
java -jar target/browserskills-api-0.1.0.jar --spring.main.web-application-type=none --spring.profiles.active=admin --create-user=LOGIN
java -jar target/browserskills-api-0.1.0.jar --spring.main.web-application-type=none --spring.profiles.active=admin --disable-user=LOGIN
```

The create command reads a password from the console, or UTF-8 stdin followed by EOF. Passwords are 12–72 UTF-8 bytes; never put one in command arguments. Assignment slots are permanent, including disabled users. The sixth account is rejected.

`GET /health/live` reports API process liveness. `GET /health/ready` accepts loopback callers only and reports database, all five browser workers and inference separately within a bounded probe window. `DEGRADED` with an unavailable model still permits manual control of the server browser; readiness does not certify a live Yandex template or model quality.

## Autonomous Yang workflow

The user signs into Yang and completes OTP inside their server Chromium through the existing manual lease/noVNC view. `GET /api/yang/session` detects the authenticated interface; it does not infer authentication from URL alone. An expired Yang session pauses the run in `WAITING_FOR_AUTH`, allowing manual login. `POST /api/runs/{id}/resume` explicitly continues the same frozen selection settings after authentication.

`GET /api/yang/catalogue` reads the catalogue; `POST /api/yang/catalogue/refresh` refreshes it between runs. `GET`/`PUT /api/yang/selection` stores next-run settings. `POST /api/runs` accepts `{requestId,maxTasks,selection}`. Manual selection or automatic maximum comparable whole-suite price is applied before reserving a new suite. Known quality blockers appear before instruction processing; auto mode tries another eligible project after a preparation failure before reservation.

TaskSet contains pool/suite identity, ordered parts, typed fields, originals and the instruction version. Each next required field stage is interpreted and filled separately. Existing earlier stages are read back after every APPLY, conditional fields are discovered, and every required answer is checked before SUBMIT. The per-answer confirmation endpoint and nonce execution path have been removed. Migration V2 preserves their historical values in `legacy_response`.

## Safety, quality and storage

A transaction saves the complete answer and `SUBMIT_INTENT` before the only external dispatch. Unknown network outcomes are never retried, even in a later run of the same suite. A restart reconciles unfinished intents to `UNKNOWN`; other active runs become `INTERRUPTED`. Stopping while a submission is in flight does not authorize a resend.

Workers retain the original materials with a 960 MiB per-user budget. `API_MATERIALS_DIR` (default temporary directory; deployment `/data/materials`) holds a disposable LRU cache of at most 64 MiB per user. Cache misses fetch the original from the assigned worker and verify length and SHA256. Thus the combined disk budget is at most 1 GiB per user. API material network I/O does not hold another user's ownership lock. Completed suite metadata and cache files are released while current instruction examples remain available until the run ends; shutdown and startup clean only owned temporary run directories. The account CLI does not instantiate or clean web-runtime material storage.

The compiler covers every text chunk and media example, including closed instruction sections. Chunks prefer paragraph and sentence boundaries; bounded neighboring original fragments and captions preserve the context of split rules and audio examples. Each interpretation records its source ID and must declare complete coverage. This flag and coverage accounting do not prove semantic accuracy; admission still requires independent labelled whole-suite evaluation. Subsequent answers include the complete compiled rules and selected original sections. Missing material, unsupported context, or excessive selected media blocks the answer without truncation. The original text remains in the current compiled instruction; the worker remains the owner of original media. Only model audio is converted to mono 16 kHz PCM WAV; speed and duration are preserved.

Each actual model call (instruction interpretation, original-source selection, grouping or answer) consumes one daily quota entry. There is one inference slot, four waiting slots, one pending call per user, a 120-second queue deadline and a 120-second execution deadline bounded further by suite expiry. Prompt caching and context shifting remain disabled. No cloud model is used.

`API_QUALITY_EVIDENCE_PATH` optionally points to local JSON: `{modelSha256,categories:[{category,total,correct,wholeSets,corpusSha256,evaluatedAt}]}`. The model SHA must match `API_MODEL_SHA256`; each admitted category requires at least 25 whole labelled suites and at least 90% completely correct. Missing, malformed, mismatched or failing evidence admits no category. Categories are TEXT, IMAGE, SPEECH and SOUND_PROSODY. Audio defaults to SOUND_PROSODY unless instruction interpretation positively establishes content-only speech. Fixture evidence is not production acceptance.

Do not enable request-body, HTTP wire or inference prompt logs. History stores suite identities, hashes, structured answers and outcome codes, not raw task material or account credentials. App sessions last one absolute hour; restart requires app login. Manual WebSockets are revoked on release, logout, expiry, disabled account, automation start or worker-generation termination.