# Manual browser connection: incident and recovery

## Cause and behavior

On 2026-09-09 a fresh Chrome session reproduced the reported warning on `.107`: the UI opened a WebSocket merely because the shared worker was in `MANUAL`, although the new session had not acquired its control lease. The rejected connection produced the same generic warning as a transport failure. Tabs sharing a session could also replace each other's socket automatically.

Control now belongs to a browser tab scoped to the HttpOnly application session. Polling shared worker state does not grant control or open a screen for another tab. The interface shows **Перехватить управление** when another tab owns it; only that explicit action revokes the old controller. A disconnected owner can use **Переподключиться** without restarting services. Refreshing the page creates a new tab controller and requires explicitly acquiring/taking over control again. Yang profile data is independent of this control lease.

## API contract

- GET `/api/browser/manual-control` requires `X-Browser-Control: <UUID>` and returns `state` (`AVAILABLE`, `OWNED`, `IN_USE`) and nullable `expiresAt`.
- POST on the same route acquires control for the current session and tab. `?takeOver=true` explicitly transfers it. Without this parameter another owner produces `409 CONTROL_IN_USE`.
- DELETE requires the current owner; a stale or foreign controller receives `403 CONTROL_REQUIRED` and cannot disconnect the replacement.
- WebSocket `/api/browser/view?controlId=<UUID>` requires the same session cookie and owner. The UUID is not a bearer credential. A second socket cannot evict an existing socket without reacquiring control first.
- Mutation endpoints retain CSRF checks; the WebSocket retains origin validation. The one-hour lease remains. Worker mode or generation changes invalidate stale control.

The old session-only acquisition path is removed. Existing pages must be refreshed after this deployment. The public UI is still LAN HTTP without BrowserSkills login.

API logs record bounded technical close reasons (`CONTROL_ENDED`, `VIEW_ALREADY_CONNECTED`, `UPSTREAM_CLOSED`, `UPSTREAM_ERROR`, `UPSTREAM_CONNECT_FAILED`, `CLIENT_CLOSED_<code>`, `CLIENT_TRANSPORT_ERROR`), without credentials or page materials.

## Deployment and verification

Deployed only the API/web image `browserskills-api:manual-control-20260909T084818Z` on `192.168.0.107:8080`; verified image ID `sha256:0f94103641b6600f9ac962149d9470e60b258e388ca501110cb5cef461940323`. Other BrowserSkills container IDs remained unchanged. API health was `UP` after acceptance.

Current standalone Compose file:

`runtime/remote-107/71a2479ad7764a008143936e204f355c/yang-20260909T081511Z-d6fcd579/manual-control-20260909T084818Z/compose.manual-control.json`

The previous image and Compose path are retained in `.cache/manual-control-20260909T084818Z/before.json`; deployment verification is in the adjacent `deployment-result.json`. Use the current Compose file for subsequent operations so later restarts do not revert the fix.

Acceptance passed using real Chrome, the deployed API, worker and noVNC framebuffer:

1. Initial connection paints a real 1366 x 768 image.
2. A second tab does not open a socket or interrupt the owner; unapproved acquisition/release is rejected.
3. Explicit takeover between tabs works; stale release cannot terminate the new owner.
4. A separate browser session can explicitly take over; replaying another tab's ID with a different session is rejected.
5. An intentionally closed transport reconnects with the UI button and paints the image again.
6. Two reload/takeover cycles restore the image.
7. Release allows another tab to acquire control.

No input was sent to Yang and no run or answer was submitted. Evidence: `.cache/remote-control-1788944121530/report.json`. Repeat only with authorization to manipulate the live shared controller: `node tests/e2e/run-remote-control.ts` (uses installed Chrome).

Local checks passed: TypeScript checks; focused web tests including ownership and reconnect; the web coverage gate; three UI E2E scenarios using installed Chrome; 10 focused Java tests and 11 HTTP/WebSocket integration tests with an isolated PostgreSQL. A broader Maven `verify` attempt stopped at the existing audio-normalization test because `ffmpeg` was absent from the local PATH; it is not claimed as a passing full-suite verification. The additional duplicate-socket regression passed after correcting its test mock.
