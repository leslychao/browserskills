# Accepted implementation contract

This document records the accepted server-only Yandex Tasks MVP (2026-09-09). No Electron, CSV, recorder, arbitrary-site workflows or Ollama remain in the final implementation.

## Product

- Five provisioned application users maximum, each permanently assigned a distinct browser worker and persistent Chromium volume. One active run per user, 1–50 tasks per run.
- A user logs into the app, opens their server browser via noVNC, signs into Yandex manually, opens a compatible project/task and starts a run. Every answer requires explicit confirmation in our UI; the proposed option can be changed.
- One whole task per submission, 2–10 options, exactly one answer. Text and/or one image and/or one audio clip. Audio includes speech content, environmental sounds, music and prosody. Free text, multiple questions per submit, video, DRM/live streams and channel-specific stereo analysis are outside v1.
- Full project instructions, task-specific rules and examples are required. Preserve text structure and linked image/audio examples. No silent truncation or summarization. Inaccessible/unsupported instructions block AI analysis.
- Audio task clip maximum 60 seconds / 20 MiB; total audio including instruction examples maximum 120 seconds. Preserve original bytes for the user's HTML audio player; normalize only the inference representation. No denoising, silence removal or speed changes.
- Instruction changes invalidate all pending proposals/confirmations. Instruction and task materials are untrusted data, never executable automation instructions.

## Architecture

- apps/api: Spring Boot 4.1.1 / Java 21, Spring Security, JDBC, Flyway, PostgreSQL 17. Serves production React assets and HTTPS.
- apps/web: React 19 / TypeScript / Vite; noVNC and native audio player. Same origin session authentication; poll current run every second.
- apps/browser: Node 24 / TypeScript / Playwright 1.63.0; fixed Yandex adapter, persistent Chromium, Xvfb/x11vnc and an authenticated WebSocket-to-RFB bridge. No general recorder.
- inference: llama.cpp CUDA, Qwen2.5-Omni-7B converted from the official Apache-2.0 Qwen weights to Q4_K_M + Q8_0 mmproj. Text JSON output only; no Talker. One request at a time, 8192-token context, GPU language layers and CPU mmproj initially. Pin source revisions and hashes. Never claim actual .107 GPU performance from source or fixture tests.
- Docker Compose on Windows via Docker Desktop WSL2. Fixed browser-1..5 services, separate profiles; no Docker socket. Only API HTTPS is published. Native Windows scripts prepare/check Docker deployment, not WinSW/native application services.
- PostgreSQL, models and five browser profiles use separate persistent volumes. Active instructions/media use bounded ephemeral storage and are removed at task/run completion. No raw media, credentials, cookies or request bodies in logs/history.

## Public HTTP contract

All JSON fields use camelCase. Dates use ISO-8601 UTC strings. Errors: {code, message}. Unknown/foreign resources must not disclose another owner's data.

- GET /api/auth/csrf -> {token, headerName}; usable before login.
- POST /api/auth/login {login,password} -> {id,login}; JSON login with session fixation protection, CSRF. HttpOnly Secure SameSite=Lax cookie; 1h absolute session lifetime. Sessions are in-memory, restart requires login.
- POST /api/auth/logout -> 204; invalidate session and close its manual view/control.
- GET /api/me -> {id,login,quota:{limit,used,remaining,resetsAt}}.
- GET /api/browser -> BrowserStatus.
- POST /api/browser -> BrowserStatus (open user's persistent browser on tasks.yandex.ru/user).
- POST /api/browser/manual-control -> BrowserStatus (exclusive authenticated session owner); DELETE same path releases it.
- WS /api/browser/view -> binary RFB. Verify authenticated session, exact Origin and control lease; enforce expiry/revocation on existing connection. Client viewOnly is never an authorization control.
- POST /api/runs {requestId,maxTasks} -> RunView, starts from current browser task. Close/revoke manual control before automation. requestId is idempotent per user; changed payload with same id is conflict.
- GET /api/runs -> RunSummary[]; GET /api/runs/{id} -> RunView.
- POST /api/runs/{id}/confirm {requestId,taskId,snapshotHash,instructionHash,optionId,confirmationNonce} -> RunView. Consume confirmation atomically, store submit intent before dispatch, never retry dispatch on network uncertainty.
- POST /api/runs/{id}/stop -> RunView.
- GET /api/runs/{id}/media/{assetId} -> bounded original bytes with content type, owner authorization, Cache-Control:no-store, single-range support for audio.
- GET /health/live -> {status:"UP"}; readiness is internal and must distinguish DB/browser/inference. Model unavailability permits manual review when extraction is complete.

## Shared data (contracts package)

MediaAsset {id,kind:"image"|"audio",mimeType,byteLength,sha256,durationMs?:number}.
InstructionBlock = {type:"text",text} | {type:"image"|"audio",asset:MediaAsset,caption?:string}.
InstructionBundle {sourceKey,hash,blocks:InstructionBlock[]}.
TaskSnapshot {projectId,taskId,question,instruction,image:MediaAsset|null,audio:MediaAsset|null,options:[{id,label}],snapshotHash,expiresAt:string|null,adapterVersion}.
Decision {decision:"ANSWER",optionId} | {decision:"ABSTAIN"}.
ReviewTask = TaskSnapshot + {proposal:Decision|null,aiError:{code,message}|null,confirmationNonce}.
RunSummary {id,status,maxTasks,processed,createdAt,updatedAt,error:{code,message}|null}.
RunView = RunSummary + {current:ReviewTask|null,results:RunItemResult[]}.
RunItemResult {taskId,ordinal,status,optionId:string|null,code:string|null,createdAt}.
Run status: PREPARING, ANALYZING, AWAITING_CONFIRMATION, SUBMITTING, COMPLETED, STOPPED, INTERRUPTED, UNKNOWN, FAILED.
Item status: DRAFT, SUBMIT_INTENT, SUBMITTED, UNKNOWN, FAILED.
BrowserStatus {workerId,generation:string|null,mode:"CLOSED"|"IDLE"|"MANUAL"|"AUTOMATION",url:string|null,runId:string|null}.

## Private worker protocol (API is sole caller)

HTTP bearer token from per-worker secret file. No arbitrary worker URL from public client. Fixed worker addresses configured server-side.

- GET /internal/status -> BrowserStatus.
- POST /internal/commands {id,type,generation?,runId?,payload?} -> JSON result directly; errors {code,message} with appropriate HTTP status.
- OPEN -> BrowserStatus; ENTER_MANUAL -> BrowserStatus; EXIT_MANUAL -> BrowserStatus (disconnect all input sockets); BEGIN with generation and runId -> BrowserStatus (revoke input, claim automation ownership).
- SNAPSHOT with generation/runId -> TaskSnapshot. Check fixed supported adapter and complete instruction/material capture.
- SUBMIT with generation/runId and payload {taskId,snapshotHash,instructionHash,optionId} -> {outcome:"SUBMITTED"|"COMPLETE"|"UNKNOWN"|"REJECTED",nextTaskId?:string,code?:string}.
- STOP with generation/runId -> BrowserStatus; CLOSE -> BrowserStatus.
- GET /internal/media/{assetId} -> original bytes, supports Range. IDs bound to current worker generation/task; no filesystem path input.
- WS /internal/view -> authenticated RFB bridge, usable only in MANUAL mode; actively disconnect on EXIT_MANUAL/BEGIN/STOP/CLOSE.
- Commands serialized, STOP cancels pending actions; in-memory dedup by command id and generation. Worker restart changes generation and never resumes a run.

## Submission invariants

- taskId is a stable platform identity, not a content hash. snapshotHash includes full instruction identity/hash and actual material bytes/options. Identical content in different tasks is valid.
- Validate the whole submission unit; reject multi-question pages. Bind exact current elements, do not allow a locator to rebind an old approval to a new task after rerender.
- Fresh read before confirm/submit; changed instruction/frame/origin/material/task invalidates old approval. Never silently truncate model context; do not allow runtime context shifting to discard instruction.
- PostgreSQL transaction changes item to SUBMIT_INTENT and consumes nonce before dispatch. DB failure means no click. Duplicate HTTP confirm never creates another attempt.
- Any uncertain result after intent becomes UNKNOWN; no automatic retry or restart, including a later run of the same unresolved task. User resolves it manually on Yandex and opens a different task.
- Explicit success acknowledgement, verified end of task batch, or verified task identity advance after click is required; validation errors dominate. Submitted is not accepted/paid.
- API startup reconciles active runs to INTERRUPTED or UNKNOWN, revokes worker automation before allowing new runs. At most one active run/user via DB constraint.
- First inspected task is first run item; do not submit it twice when continuing. Stop cannot undo a dispatched answer. Late inference results or stale confirmations are ignored.

## AI and persistence

- API builds model request itself from the worker snapshot and complete instruction blocks. POST /v1/chat/completions to private inference, input_audio plus images/text, schema-constrained Decision, strict response validation against current option IDs. No tools.
- One running request + at most four waiting; max one/user. Queue deadline120s, inference120s, platform task expiry takes precedence. Invalid JSON, timeout, model absence and quota exhaustion expose manual selection with aiError.
- 100 analyses/user/day UTC; atomic reservation and idempotent request IDs, don't reserve again on retry. No indefinite retries.
- Store users, browser assignments, runs, run_items and ai_usage plus instruction/media/model hashes. Active material bytes and full instruction bodies aren't persistent history.
- Account provisioning CLI inside API artifact creates/disables a user, assigns a free worker. Password input through stdin/console, never args/logs. Five slots maximum.

## Verification and deliverables

- Meaningful unit/integration/browser tests; keep 80% coverage checks honest. Real PostgreSQL integration, no skipped Docker tests portrayed as passed.
- Test 50 unique confirmed sends, idempotent confirms, changed instructions, stale task rerenders, whole-task rejection, error/timeout after click, API/worker crashes, stop, login expiry, owner isolation and noVNC revocation.
- Media tests: Range, cross-user access, bad audio, bounds, inaccessible instructions/examples, no silent clipping, instructions asking about speech vs background sound.
- Model evaluation: labelled 25 text,25 image,25 speech,25 sound/prosody minimum; >=90% correct/category counting abstentions as unsolved. p95<=30s text/image,<=90s task audio<=60s excluding queue. Report real GPU/RAM usage and actual measured evidence; fixture/mock is not real model/site verification.
- Live Yandex DOM is not inspected yet; do not invent evidence or label synthetic selectors as verified live support. Final ready claim requires authenticated compatible real templates.
- Operations: start after Windows reboot, pinned image update, DB and stopped-profile backup/restore, explicit .107 preflight. Root coordinates final diff and requirement audit.

## Ownership

Root: contracts, root manifests, apps/web, tests/e2e, integration and README.
implement_api: apps/api only.
implement_browser: apps/browser, tests/test-site, removal of replaced apps/desktop files only.
implement_windows_ops: ops, compose files, Dockerfiles outside apps/api/browser/web, docs/operations.md and model packaging/evaluation scripts. Coordinate before changing another owner's files.
