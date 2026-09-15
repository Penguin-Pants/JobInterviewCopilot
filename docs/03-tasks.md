# Interview CoPilot — Implementation Tasks

Version 1.0. Each task is independently reviewable and has binary acceptance
criteria. `Traces` lists the requirements the task satisfies. `Verified by`
lists the test cases in `04-test-strategy.md`.

## Global Definition of Done

A task is done only when **all** of these hold. No exceptions, no partial done.

1. Code compiles with `tsc --noEmit`, zero errors, zero `@ts-ignore` added.
2. `eslint` and `prettier` pass with zero warnings.
3. Every acceptance criterion in the task is demonstrably met.
4. Every test case listed under `Verified by` exists, runs in CI and passes.
5. Unit line coverage for the files the task touches is at least 80 percent.
   Provider adapters and renderer components are exempt from the number but must
   still have at least one integration or E2E test.
6. No new runtime dependency was added without an entry in the dependency table
   in `02-architecture.md` and a passing license check.
7. No API key, no audio buffer and no file path outside `userData` appears in
   any log line produced by the task's code.
8. Public functions and every exported type carry a TSDoc comment stating the
   requirement ID they implement.
9. Any deviation from `01-requirements.md` or `02-architecture.md` is either
   reverted or landed together with an update to those documents and to
   `00-decision-log.md` in the same pull request.
10. The pull request description lists the task ID, the traced requirement IDs
    and the test case IDs.

---

## Milestone 0 — Foundations

### TASK-001 Project scaffold
**Traces** FR-001, FR-086, NFR-006, NFR-015
**Depends on** nothing
**Acceptance criteria**
- `npm ci && npm run build && npm run package` produces a Windows x64 installer
  from a clean checkout.
- `electron-vite` builds three renderer entry points: dashboard, overlay, audio
  worker.
- All `BrowserWindow` instances use `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`.
- A CSP without `unsafe-eval` is applied to all renderers. `will-navigate` and
  `setWindowOpenHandler` both deny.
- `npm run lint`, `npm run typecheck`, `npm run test`, `npm run licenses` all
  exist and pass.
**Verified by** TC-001, TC-007, TC-008, TC-009

### TASK-002 Shared types and IPC contract
**Traces** FR-086, CMP-10
**Depends on** TASK-001
**Acceptance criteria**
- `src/shared/types.ts` contains every interface from section 2 of
  `02-architecture.md`, verbatim in shape.
- `src/shared/ipc.ts` declares every channel ID from section 4 with a `zod`
  schema for each payload and each response.
- The IPC router rejects a payload that fails its schema, logs it and returns a
  typed error. It never forwards it.
- A compile-time test asserts the renderer bridge and the main handlers share
  the same types (a type-level test with `expectTypeOf`).
**Verified by** TC-002, TC-003

### TASK-003 Settings store
**Traces** FR-020, FR-023, FR-024, FR-025, FR-029, FR-030, FR-031, FR-032, FR-033
**Depends on** TASK-002
**Acceptance criteria**
- Every field and default from `Settings` in `02-architecture.md` section 2.1 is
  implemented, with the exact defaults listed there.
- Loading a corrupt or schema-invalid file replaces it with defaults and renames
  the original to `settings.corrupt-<ISO timestamp>.json`. The original is never
  deleted.
- `schemaVersion` mismatch runs a migration chain. Version 1 is the baseline, so
  the chain is empty but the mechanism exists and is unit tested with a fake
  version 0.
- Out-of-range values are clamped, not rejected: `overlayOpacity` to 0.30-1.00,
  `overlayFontSizePx` to 16-32, `turnEndGapMs` to 500-1500.
**Verified by** TC-030, TC-031, TC-032, TC-033

### TASK-004 Secret vault
**Traces** FR-021, FR-022, FR-026, NFR-003
**Depends on** TASK-002
**Acceptance criteria**
- Keys are encrypted with `safeStorage.encryptString` and written to
  `secrets.bin`, never to `settings.json`.
- When `safeStorage.isEncryptionAvailable()` is false, `secrets:set` returns an
  error, nothing is written and no plaintext fallback path exists in the code.
- `secrets:status` (CH-104) returns booleans only. Grep across the codebase
  finds no channel whose response type can carry a key string.
- A redaction helper masks any value matching a known key shape in log output
  and in serialized `Error` objects. It is applied at the logger, not at call
  sites.
- `secrets:set` validates the key live before saving. A failed validation saves
  nothing and returns the provider's reason.
**Verified by** TC-020, TC-021, TC-022, TC-023, TC-024, TC-025

### TASK-005 Window orchestrator and content protection
**Traces** FR-002, FR-005, FR-080, FR-081, FR-082, FR-083, NFR-012
**Depends on** TASK-003
**Acceptance criteria**
- Dashboard window: resizable, standard frame, follows `theme.mode`.
- Overlay window: `transparent`, `frameless`, `alwaysOnTop`, `skipTaskbar`,
  `resizable: false`, and `setContentProtection(true)` called before `show()`.
- A static analysis test asserts `setContentProtection(false)` appears nowhere
  in `src/`.
- Overlay defaults to `setIgnoreMouseEvents(true, { forward: true })`.
- Overlay position and `displayId` persist. On relaunch with the stored display
  absent, the overlay is placed at the default position on the primary display.
- On Windows build below 19041 the app logs and shows a one-time Dashboard
  notice that the overlay renders as a black rectangle in captures.
- A single-instance lock is held. A second launch focuses the existing
  Dashboard.
**Verified by** TC-004, TC-005, TC-009, TC-036

### TASK-006 Hotkey manager
**Traces** FR-030, FR-053, FR-084
**Depends on** TASK-005
**Acceptance criteria**
- Both accelerators register at startup from settings.
- A rebind that `globalShortcut.register` rejects returns an error, keeps the
  previous binding active and surfaces an inline Dashboard message.
- Rebinding takes effect without a restart. The old accelerator is unregistered.
- All shortcuts are unregistered on `will-quit`.
**Verified by** TC-034, TC-035

---

## Milestone 1 — Audio and transcription

### TASK-010 Audio Worker spike
**Traces** FR-040, ADR-005
**Depends on** TASK-001
**Acceptance criteria**
- A throwaway branch proves `electron-audio-loopback` returns a working system
  audio `MediaStream` in a hidden renderer on both Windows 10 and Windows 11.
- The result is written into `docs/00-decision-log.md` as a confirmation note,
  or as a new ADR selecting the replacement approach if it fails.
- This task gates TASK-011. Do not start TASK-011 before it closes.
**Verified by** MW-02

### TASK-011 Dual-stream capture
**Traces** FR-040, FR-041, FR-042, FR-043, FR-044, FR-045, FR-046, NFR-002
**Depends on** TASK-010, TASK-005
**Acceptance criteria**
- The hidden Audio Worker window acquires the loopback stream and the mic
  stream independently. The two are never connected to the same node graph.
- Each stream uses its own `AudioContext({ sampleRate: 16000 })` and an
  `AudioWorkletProcessor` that emits Int16 LE mono PCM.
- Each chunk is exactly 32000 bytes (1000 ms at 16 kHz, 16-bit, mono) except
  the final partial chunk on stop.
- Chunks carry `source`, `timestamp` and a per-source monotonic `sequence`.
- The `ArrayBuffer` is transferred on `CH-303`, so `byteLength` in the worker is
  0 after send.
- An ESLint rule forbids importing `fs`, `fs/promises` or `original-fs` anywhere
  under `src/renderer/audio-worker/` and in `src/main/audio.ts`.
- Loopback failure still starts the mic, sets the interviewer stream state to
  `error` and blocks `session:start` with a named reason.
- Unexpected stream end retries 3 times before surfacing an error badge.
- `session:stop` destroys both contexts, stops all tracks and closes the worker
  window. No `AudioContext` remains after stop.
**Verified by** TC-040, TC-041, TC-042, TC-043, TC-044, TC-045

### TASK-012 STT interface and Deepgram adapter
**Traces** FR-047, FR-048, FR-100
**Depends on** TASK-011, TASK-004
**Acceptance criteria**
- `SttProvider` and `SttSession` match `02-architecture.md` section 3.1 exactly.
- One session per stream. Two concurrent WebSocket connections during a live
  session, each with its own interim and final state.
- Deepgram connects with `encoding=linear16&sample_rate=16000&channels=1&interim_results=true&endpointing=800`.
- Every emitted event is a normalized `TranscriptEvent` including `providerId`.
- The native endpoint message emits an `endpoint` event.
- A dropped socket reconnects and resumes without ending the session.
**Verified by** TC-050, TC-051, TC-052, TC-053, TC-054

### TASK-013 Whisper adapter, degraded mode
**Traces** FR-047, FR-049, ADR-008
**Depends on** TASK-012
**Acceptance criteria**
- Buffers 4000 ms of PCM, wraps it in a valid WAV container and posts one
  request per buffer.
- Emits `isFinal: true` only. Never emits an interim event.
- `supportsInterim` and `supportsEndpointing` are both `false`, and the trigger
  reads those flags rather than checking the provider ID.
- When Whisper is the active STT provider the Dashboard shows an informational
  badge naming the accuracy and latency penalty.
**Verified by** TC-055, TC-056, TC-057

### TASK-014 Provider health and failover
**Traces** FR-100, FR-104, ADR-009, ADR-010
**Depends on** TASK-012
**Acceptance criteria**
- One shared implementation serves both the STT and the LLM capability.
- Errors classify to `auth`, `rate-limit`, `network`, `timeout`, `server`,
  `client`. `auth` and `client` are `retryable: false`.
- Retry backoff is 250, 500, 1000 ms with up to 20 percent jitter, 3 attempts.
- An `auth` error skips the retry loop entirely and fails over immediately.
- After failover the adapter stays on the backup for the rest of the session.
- A probe runs against the primary every 60 s. Two consecutive passes return to
  the primary at the next clean boundary, not mid-stream.
- With no backup configured the state is `DEGRADED`, retries continue with
  backoff capped at 10 s, and the overlay is never touched.
- `CH-202 state:providers` reflects every transition.
**Verified by** TC-100, TC-101, TC-102, TC-103

---

## Milestone 2 — Knowledge base

### TASK-020 Document import and conversion
**Traces** FR-060, FR-061, FR-069
**Depends on** TASK-003
**Acceptance criteria**
- `.md` is ingested as-is. `.pdf` goes through `pdf-parse`, `.docx` through
  `mammoth`, each written to `derived/<docId>.md`.
- A converted document with no detected heading is wrapped in a single
  `# Document` section.
- A `.pdf` import sets `extractionQuality: 'best-effort'` and the Dashboard row
  shows that label with an explanation on hover.
- A conversion failure sets `state: 'error'` with the message. It never throws
  out of the import call and never blocks other documents in the same batch.
- Every document belongs to exactly one profile. There is no shared document
  store.
**Verified by** TC-060, TC-061, TC-062, TC-063

### TASK-021 Chunking
**Traces** FR-062, FR-063, ASM-001
**Depends on** TASK-020
**Acceptance criteria**
- Splits on `#`, `##`, `###`. `####` and deeper stay inside the parent chunk as
  body text.
- `headerPath` is the ordered ancestor chain, for example
  `['Experience', 'Acme Corp']`.
- A section over 500 MiniLM tokens soft-splits on blank lines. A single
  paragraph over the cap is hard-split at the token boundary rather than dropped.
- Every chunk carries `{ sourceFile, headerPath, docType, profileId }` and a
  `tokenCount`.
- Chunking is pure and deterministic: the same input bytes always produce the
  same chunk array. A `chunkerVersion` constant is exported and included in the
  cache key.
**Verified by** TC-064, TC-065, TC-066, TC-067

### TASK-022 Local embeddings and cache
**Traces** FR-066, FR-067, ADR-011, ADR-012
**Depends on** TASK-021
**Acceptance criteria**
- Uses `@xenova/transformers` with `Xenova/all-MiniLM-L6-v2`, 384 dimensions.
- First run shows determinate download progress on `CH-214`. Ingestion is
  blocked until it completes. Session start is not blocked.
- Vectors are L2-normalized before write, stored as a flat `Float32Array` in
  `<docId>.vectors.bin`.
- The cache key is `sha256(fileBytes):chunkerVersion:embeddingModelId`. An
  unchanged file is not re-embedded on relaunch.
- Changing `chunkerVersion` invalidates the cache with no manual purge.
**Verified by** TC-068, TC-069, TC-070, TC-071

### TASK-023 Auto-tagging and user override
**Traces** FR-064
**Depends on** TASK-020
**Acceptance criteria**
- Guesses `resume`, `company-notes` or `job-description` from filename and
  content, with a documented, deterministic rule set. It is not an LLM call.
- A user override sets `docTypeSource: 'user'`. Re-import or a file change never
  overwrites a user override.
- An override updates chunk metadata in place without re-embedding.
**Verified by** TC-072, TC-073, TC-074

### TASK-024 Retrieval
**Traces** FR-065, ASM-006
**Depends on** TASK-022
**Acceptance criteria**
- `query(profileId, text, k=3)` returns the top 3 chunks by dot product over
  normalized vectors, scoped to that profile only.
- No doc-type weighting exists in the code. A test asserts that two chunks with
  equal similarity and different doc types tie.
- A profile with no ready documents returns an empty array without throwing.
- A profile with 5000 chunks returns in under 50 ms.
**Verified by** TC-075, TC-076, TC-077, TC-078

### TASK-025 Knowledge base watcher
**Traces** FR-068
**Depends on** TASK-022
**Acceptance criteria**
- `chokidar` watches each profile's `kb/` folder with a 500 ms stability debounce.
- An add, change or unlink re-processes only that file.
- A change is reflected in `query` results within 5 s of the file system
  settling.
- A delete removes the document record, its chunks and its vectors.
- Rapid successive writes to one file cause exactly one re-embed.
**Verified by** TC-079

---

## Milestone 3 — Trigger and suggestions

### TASK-030 Trigger state machine
**Traces** FR-003, FR-050, FR-051, FR-052, FR-053, FR-054, FR-055, ASM-004, ASM-007, ASM-008, ASM-009
**Depends on** TASK-012, TASK-006
**Acceptance criteria**
- Implements exactly the states and transitions in `02-architecture.md`
  section 5.3.
- The turn-end timer uses `settings.trigger.turnEndGapMs` and is reset by any
  new interviewer interim or final event.
- A provider `endpoint` event fires the turn immediately, bypassing the timer.
- The guard rejects a turn under `minTurnWords` or `minTurnChars` and returns to
  `LISTENING` without firing.
- Candidate finals only append to the context ring. A test drives 100 candidate
  finals and asserts zero `generate-suggestion` events.
- The context ring keeps the last 2 candidate turns, truncated to 400 characters
  total, oldest content dropped first.
- A new turn end during `GENERATING` aborts the in-flight `AbortController`
  before starting the new generation.
- `PAUSED` aborts any in-flight generation and pushes the overlay idle state.
  Audio capture and STT connections stay open while paused.
- The state machine is a pure module with injected timers, testable with fake
  timers and no Electron import.
**Verified by** TC-080, TC-081, TC-082, TC-083, TC-084, TC-085, TC-086, TC-087, TC-088

### TASK-031 Prompt assembly
**Traces** FR-004, FR-072, FR-073
**Depends on** TASK-024, TASK-030
**Acceptance criteria**
- The system prompt is byte-identical to `02-architecture.md` section 6.
- The user message uses the template in section 6, with chunks numbered and
  labeled by `docType` and `headerPath`.
- Empty candidate context renders as `(nothing yet)`.
- Zero retrieved chunks renders the notes section as absent, not as an empty
  heading.
- `max_tokens: 200`, `temperature: 0.3` for both providers.
**Verified by** TC-090, TC-091, TC-092

### TASK-032 LLM adapters and line buffering
**Traces** FR-070, FR-071, FR-074, FR-075, FR-076
**Depends on** TASK-031, TASK-014
**Acceptance criteria**
- Anthropic and OpenAI adapters both satisfy `LlmProvider` and both yield raw
  deltas plus one terminal usage record.
- Line buffering is implemented once, above the adapters, so both providers
  produce identical `CH-208` timing.
- A `SuggestionLine` is emitted per newline, plus a final flush of the
  remainder, plus a forced flush at 240 pending characters with no newline.
- A test feeds character-by-character deltas and asserts the number of
  `CH-208` messages equals the number of lines, not the number of characters.
- `AbortSignal` cancellation aborts the underlying HTTP request. A test asserts
  the request is aborted, not merely unsubscribed.
- No code path sends an error to the overlay. A static test asserts the overlay
  preload exposes no error channel.
**Verified by** TC-093, TC-094, TC-095, TC-096

---

## Milestone 4 — Sessions, cost, UI

### TASK-040 Session manager and transcript
**Traces** FR-088, FR-101, FR-105, ADR-003, ADR-013
**Depends on** TASK-011, TASK-032
**Acceptance criteria**
- `session:start` refuses when a session is active, when no profile is active,
  or when the STT primary key or the LLM primary key is missing. Each refusal
  returns a distinct, named reason.
- The session binds `profileId` at start. Profile switching is disabled in the
  Dashboard for the duration.
- Interviewer turns, candidate turns and suggestions are appended to
  `<sessionId>.ndjson` within 2 s of being produced.
- A clean stop compacts the `.ndjson` into `<sessionId>.json` and deletes the
  `.ndjson`.
- An `.ndjson` present at startup is compacted with
  `endReason: 'crash-recovered'` and appears in Session History.
- No audio byte is ever passed to the session writer. The writer's input type
  cannot express one.
**Verified by** TC-104, TC-105, TC-106, TC-107

### TASK-041 Cost meter
**Traces** FR-103, ASM-011
**Depends on** TASK-040
**Acceptance criteria**
- Accumulates STT audio seconds per stream and LLM input and output tokens from
  provider usage fields, never from a local estimate when the provider reports
  actual usage.
- `estimatedUsd` is computed from `pricing.json` and the Dashboard shows the
  price table version next to it.
- `CH-204 state:usage` updates at least once per second during a session.
- Each threshold warns exactly once per session. Crossing back and forth does
  not re-warn.
- No code path stops a session because of cost or time.
**Verified by** TC-108, TC-109

### TASK-042 Dashboard UI
**Traces** FR-023, FR-024, FR-025, FR-026, FR-027, FR-028, FR-029, FR-030, FR-031, FR-032, FR-080, FR-087, FR-088, NFR-010, NFR-014
**Depends on** TASK-003, TASK-004, TASK-014, TASK-025, TASK-041
**Acceptance criteria**
- All six sections exist: Provider Setup, Company Profiles, Session History,
  Hotkeys, Cost and Usage, Consent Reminder.
- Provider Setup prevents selecting the same provider as primary and backup, and
  states plainly that one OpenAI key serves both Whisper and GPT.
- Key entry shows an inline pass or fail within 10 s and does not save a failing
  key.
- Company Profiles supports create, switch, delete and drag-and-drop import,
  with a doc-type override control per document row.
- Profile delete requires a confirmation that names the counts of documents and
  sessions to be deleted. Deleting the active profile activates another profile,
  or creates a default profile when none remains (FR-028).
- Exactly one profile is active at a time, and the active profile is shown
  unambiguously in the Dashboard header (FR-027).
- Session History groups by profile and supports view and delete.
- Cost and Usage shows the live timer and spend estimate during a session.
- Consent Reminder is editable with a one-action reset to default.
- Every interactive element is reachable and operable by keyboard.
**Verified by** TC-120, TC-121, TC-122, TC-123, TC-124, TC-125

### TASK-043 Overlay UI
**Traces** FR-006, FR-007, FR-076, FR-085, FR-090, FR-091, FR-092, FR-093, FR-094, FR-102, NFR-007, NFR-010
**Depends on** TASK-032, TASK-005
**Acceptance criteria**
- Idle card shows the standing-by message before the first suggestion and
  whenever paused.
- The consent reminder renders before the first suggestion of every session, is
  dismissible and does not block input to other applications.
- Active state holds at most 3 cards. A 4th entering fades the oldest out
  through `AnimatePresence`.
- Each completed bullet reveals with fade plus upward slide over 200 to 300 ms.
  No per-word reveal exists in the code.
- Font size defaults to 22 px, is adjustable 16 to 32 px from the Dashboard and
  from an in-overlay control, and persists.
- Text meets a 4.5 to 1 contrast ratio against the card background in both
  themes at every supported opacity level.
- `prefers-reduced-motion` disables the slide component and keeps the fade.
- Theme, translucency mode and opacity apply live without a restart.
- Interactive mode versus click-through mode is visually distinguishable.
- Extended silence keeps the idle card visible and is never rendered as an
  error or a warning (FR-102).
- No error state exists in the overlay component tree.
**Verified by** TC-006, TC-110, TC-111, TC-112, TC-113, TC-114, TC-115, TC-116, TC-117

---

## Milestone 5 — Hardening and release

### TASK-050 Global resilience
**Traces** NFR-001, NFR-004, NFR-005, NFR-008, NFR-009
**Depends on** all of Milestone 4
**Acceptance criteria**
- `process.on('uncaughtException')` and `process.on('unhandledRejection')` in
  main log and continue. A test injects a rejection during a session and
  asserts the session stays active.
- A 60-minute soak test with synthetic transcript events keeps main-process RSS
  under 600 MB with no upward trend over the last 30 minutes.
- With the network disabled the app starts, manages profiles, imports documents
  and embeds. Session start warns that transcription is unavailable.
- App-side overhead on the turn-end to first-line path is under 150 ms with
  scripted fakes (TC-133). The end-to-end `NFR-001` budget (p50 under 2.5 s,
  p95 under 4.0 s) is measured and recorded by MW-06 before release.
**Verified by** TC-130, TC-131, TC-132, TC-133, MW-06

### TASK-051 Release pipeline
**Traces** NFR-011, NFR-013, NFR-015
**Depends on** TASK-050
**Acceptance criteria**
- CI runs typecheck, lint, unit, integration, license check on every pull
  request, and the Playwright Electron E2E suite on a Windows runner.
- `npm run package` produces an x64 NSIS installer that installs and launches on
  a clean Windows 11 virtual machine.
- The installer is reproducible from a clean checkout with one documented
  command.
- The release checklist in `04-test-strategy.md` section 6 is executed and
  recorded before a tag is cut.
**Verified by** TC-001, MW-01 to MW-10
