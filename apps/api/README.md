# BrowserSkills API

Spring Boot 4.1.1 / Java 21 server for the accepted contract in `docs/IMPLEMENTATION.md`. The API owns sessions, browser leases, durable run state, quota and model requests. A worker never receives an API session cookie or account password.

## Verification

Use Java 21, a running Docker daemon and FFmpeg on `PATH`, then run `./mvnw verify` (`.\mvnw.cmd verify` on Windows). Integration tests start a real, digest-pinned PostgreSQL 17.9 container; no Docker test is skipped. FFmpeg tests perform real WAV conversion and check original bytes, duration and preserved silence. JaCoCo enforces at least 80% line coverage over all production classes, without exclusions. Reports are under `target/site/jacoco`, `target/surefire-reports` and `target/failsafe-reports`.

The network WebSocket test uses an RFC6455/RFB fixture peer to prove API authorization, binary relay and revocation. It does not prove the real Xvfb/noVNC stack, a Yandex template, model quality or `.107` GPU performance. The root full-system harness verifies the API with real browser workers and labelled fixtures. Actual site/model acceptance remains separate.

The source is formatted with google-java-format 1.35.0. The official Maven wrapper pins Maven 3.9.16. The multi-stage Dockerfile builds React assets into the API JAR; image construction does not substitute for `mvnw verify`.

## Configuration

Production serves HTTPS on port 8443. Mount read-only secrets via `/run/secrets`:

- `db_password`, `api_cert` and `api_key` (PEM certificate/private key).
- `worker_1_token` through `worker_5_token`; each token authorizes exactly its configured private worker.

Environment variables: `BROWSERSKILLS_DB_URL`, `BROWSERSKILLS_DB_USERNAME`, `BROWSERSKILLS_PUBLIC_ORIGIN`, `API_WORKER_1_URL` through `API_WORKER_5_URL`, `API_INFERENCE_URL`, `API_MODEL_SHA256`, and optional `BROWSERSKILLS_DAILY_QUOTA` (100). Default workers are `http://browser-N:3000`; inference is `http://inference:8080`. See the Compose deployment for TLS, resource limits and model provenance.

For local tests, the explicit `dev` profile binds HTTP to `127.0.0.1:8080`. Override `server.port` and `api.public-origin` together when using another local port. Do not publish the dev profile on a LAN interface. Production cookie security stays enabled. No default user or password is provisioned.

Account CLI, with the same database configuration as the service:

```text
java -jar target/browserskills-api-0.1.0.jar --spring.main.web-application-type=none --spring.profiles.active=admin --create-user=LOGIN
java -jar target/browserskills-api-0.1.0.jar --spring.main.web-application-type=none --spring.profiles.active=admin --disable-user=LOGIN
```

The create command reads a password from the console, or UTF-8 stdin followed by EOF. Passwords are 12–72 UTF-8 bytes; never put one in command arguments. Assignment slots are permanent, including disabled users. The sixth account is rejected.

`GET /health/live` reports API process liveness. `GET /health/ready` accepts loopback callers only and reports database, all five browser workers and inference separately within a bounded probe window. `DEGRADED` with an unavailable model still permits complete manual task review; readiness does not certify a live Yandex template or model quality.

## Safety and storage

Each confirmation is bound to the task, full instruction hash, snapshot and single-use nonce. A database transaction consumes it and saves `SUBMIT_INTENT` before the only dispatch. Unknown network outcomes are never retried, even in a later run of the same task. Restart reconciles unfinished intents to `UNKNOWN`; other active runs become `INTERRUPTED`. New browser access first revokes that worker's old generation.

Current full text/media are ephemeral and bounded (512 KiB of text and 64 MiB of original assets per current task). Oversized or inaccessible material fails explicitly; nothing is silently clipped. Original audio is served with owner-checked single-range responses. Only the model representation is converted to mono 16 kHz PCM WAV; silence, speed and duration are preserved. Multimodal context overflow is rejected by inference configured with `--no-context-shift` and exposed for manual selection.

Model requests use fresh opaque ten-letter option aliases with unchanged labels and order. A valid reply is mapped back to the original option ID; aliases remain local to that inference call and never enter the UI or database. Unknown aliases are rejected, and `ABSTAIN` remains available. Prompt caching is explicitly disabled.

Do not enable request-body, HTTP wire or inference prompt logs. Database history contains task identities, hashes, outcomes and selected option IDs, not raw tasks, instructions or media. Session lifetime is one absolute hour; restart requires login. Existing manual WebSockets are revoked on lease release, logout, expiry, disabled account, automation start or worker-generation termination.
