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

**Status: COMPLETE, 2026-09-15.** All six tasks implemented and verified.
`npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run licenses`,
98 unit and integration tests, and `npm run build` all pass. Line coverage is
93.6 percent against an 80 percent floor.

Two acceptance criteria could not be verified in the development container.
Both are now **verified green on the Windows CI runner**, so neither is
outstanding:

| Criterion | Why not here | Verified |
|---|---|---|
| `npm run package` produces a Windows x64 installer | Wine is not installed in the Linux container, so electron-builder cannot emit NSIS | `package` job on `windows-latest`, green |
| The five E2E cases (TC-005, TC-007, TC-008, TC-009, TC-148) | They assert window flags, capture protection and single-instance focus, none of which mean anything off Windows. The suite skips rather than passing vacuously | `e2e` job on `windows-latest`, all five green |

Three questions left open during implementation were answered by those runs:
- The content security policy does not break the packaged app. The renderer
  loads and the Dashboard renders under `file://` in Electron with the meta
  policy in place, so `'self' file:` is correct.
- The policy is genuinely enforced. An inline script is blocked and the
  violation is reported, verified both on the runner and locally by serving the
  built renderer over HTTP and driving Chromium.
- Reset Overlay works. It needed the window shown before its bounds were set:
  Windows can re-apply the placement of a never-shown window when it is finally
  shown, silently undoing the move.

Deferred out of Milestone 0 by design, each failing loudly rather than silently:
- Invoke channels for profiles, documents, sessions and `consent:dismiss` are
  declared in the contract but have no handler yet. A caller gets an error
  rather than a plausible-looking stub.
- `validateKey` refuses every key until the provider adapters land in TASK-012
  and TASK-032, because FR-026 forbids saving a key that has not passed
  validation.
- The `togglePause` hotkey is registered and rebindable, but its handler only
  logs until the trigger exists in TASK-030.

Found by the first CI run and fixed on the same branch:
- The main process ships as CommonJS and `electron-store` is ESM-only, so
  `require('electron-store')` yielded the module namespace object rather than
  the class. `new` on it threw inside `bootstrap`, where the app's own
  `unhandledRejection` handler swallowed it, leaving a live process with no
  windows. All five E2E cases reported only a 30-second "no window appeared"
  timeout. Fixed with an interop guard, pinned by `TC-037`, and turned into a
  fast failure by `npm run smoke:main`, which loads the built bundle against a
  stubbed Electron and asserts bootstrap wrote its settings file. `zod` was
  checked for the same problem and is fine, because it exports `z` as a named
  export that survives the namespace.

Found by the second CI run and fixed on the same branch:
- **Reset Overlay silently did nothing.** `resolveOverlayPosition` returns
  `{ x, y, displayId }`, and that was spread straight into `setBounds`, which
  takes a Rectangle. The extra string key made the call fail, so the window
  stayed put. Extracted as `overlayBoundsFor` and pinned by a unit test.
- **The Dashboard reported a failed IPC call as success.** An `IpcError`
  resolves like any other response, so the reset button showed "Overlay reset"
  even though the reset had thrown. It now checks `isIpcError` and shows a
  failure. Errors belong in the Dashboard; `FR-076` bars them only from the
  overlay.
- **TC-008 was not testing anything.** It called `eval` inside
  `page.evaluate`, which Playwright runs over the DevTools protocol, outside the
  page's CSP. It now injects a script element, a page-level operation the policy
  does govern, and asserts it neither runs nor passes without a violation. The
  policy itself is verified enforced: an inline script is blocked and Chromium
  reports `script-src-elem`.
- The CSP question left open at the end of Milestone 0 is settled. The renderer
  loads and the Dashboard renders under `file://` in Electron with the meta
  policy in place, so `'self' file:` is correct and the app is not broken by it.

Found by automated review and fixed on the same branch (nine findings, all
valid, two of them security):
- **The overlay preload forwarded every invoke channel.** Push had a per-window
  allowlist, invoke had none, so a compromised overlay renderer could write
  settings, rebind hotkeys or replace credentials. Both directions are now
  allowlisted and the overlay's list is three channels.
- **The bridge type promised only the success shape.** The router resolves with
  an `IpcError` rather than rejecting, so TypeScript could not force callers to
  check. `invoke` now returns `InvokeResponse<C> | IpcError`, which immediately
  caught an unchecked caller at compile time.
- **The consent gate could not work.** The overlay reported `overlay:ready` on
  mount while the consent text was still null, because main only sent the text
  in reply to that message. Main now pushes it on `did-finish-load` and the
  renderer reports ready only after the card has painted (ADR-016).
- **Theme changes never reached the running overlay.** `config:set` persisted
  the patch and stopped; `translucencyChangeNeedsRecreate` was exported and
  tested but never called. `config:set` now pushes the theme and recreates the
  window on a mode change, preserving position and click-through (FR-085).
- **A startup hotkey conflict was forgotten.** `register` stored the handler but
  not the accelerator, so `reregisterAll` had nothing to retry, defeating Reset
  Overlay's recovery path for the exact case it exists for (FR-009).
- **A closed Dashboard could not be reopened.** The overlay keeps the process
  alive, so a second launch lost the lock and returned early, leaving no way
  back short of killing the process.
- **Provider separation was only enforced on write.** A schema-valid file naming
  the same provider for primary and backup loaded cleanly, so the app could run
  with a backup sharing the failing service and credential. Now cleared on load
  with a logged reason, rather than refusing to start (FR-025).
- **The vault accepted a decrypted array.** Assigning a named property to an
  array is dropped by `JSON.stringify`, so `set()` returned success while
  storing nothing and `status()` stayed false. A silent credential loss.
- **The overlay was not draggable.** A frameless window needs an explicit drag
  region; accepting mouse events is not enough. The `moved` persistence handler
  was unreachable through the UI (FR-082, FR-084).

Follow-up work found during implementation:
- **OQ-003 resolved by ADR-027** at the start of Milestone 1: accept the copy,
  bound retention instead. `TC-041` is rewritten from a byteLength assertion to
  a retention assertion, and `FR-043` now states the enforceable property.
- **TASK-011** must add the `media` permission to the permission request
  handler, which Milestone 0 sets to deny everything. **Done.** The handler now
  lives in `src/main/audio-host.ts` and grants `media` only to the Audio Worker.
- `Logger.rotateIfNeeded` calls `statSync` on every line. Harmless at Milestone 0
  volumes, worth revisiting if logging becomes hot during a live session.
- The content security policy lists `file:` because the packaged app loads
  renderers over `file://`, where `'self'` alone does not match. A probe in the
  Linux container could not settle whether the stricter form breaks asset
  loading under Electron, because plain Chromium cannot load ES modules from
  `file://` at all and the no-CSP baseline failed the same way. `TC-008` on the
  Windows runner is the real check: it fails if `eval` is permitted, and the
  suite's own setup fails if the Dashboard does not render.
- `ConfigStore` rewrites `settings.json` on every construction even when nothing
  changed. Harmless, but it touches mtime on every launch.


Issues found by code review on PR #4 and fixed in the same branch. All ten were
real; one had already been fixed when the review landed.

- **A failing installer build reported success.** The step piped `npm run
  package` into `tee` without `pipefail`, so the pipeline exited with `tee`'s
  status. The failure-log upload was skipped and the installer upload only
  warned about a missing `release/*.exe`. Now `set -o pipefail`, plus a separate
  step that asserts the artifact exists.
- **`session:start` was allowed while capture was still starting.** The gate
  refused only on `error`, but `start()` resolves as soon as the worker has been
  told to start, so a loopback failure was not yet known. It now requires
  `running`, and the worker reports that state directly instead of the
  supervisor inferring it from the first chunk a second later (FR-044).
- **The worklet could never load.** It was fetched from a `blob:` URL, and a
  module URL is governed by `script-src`, which the audio worker restricts to
  `'self' file:`; `blob:` is allowed only in `worker-src`. Capture would have
  failed on every start with no PCM ever emitted. The first fix was worse than
  it looked: `new URL('./x.js', import.meta.url)` is rewritten by Vite into an
  inlined `data:` URL, which `script-src` rejects for the same reason. The
  worklet now ships from `src/renderer/public/` and is resolved against the page
  URL, and a test reads the build output to prove it is neither form.
- **An acquired stream leaked when graph setup failed.** Anything that threw
  after `getDisplayMedia` or `getUserMedia` succeeded left the tracks live and
  the context open, so the microphone or system audio stayed captured invisibly
  while the stream reported `error`. Setup is now wrapped and releases both.
- **The final partial chunk was discarded.** Stopping 1.5 s in emitted the first
  full chunk and dropped the remaining half second, which TASK-011 requires to
  be delivered. The processor now takes a `flush` message and emits the
  remainder at its true length, not padded with silence.
- **Sequence numbers reset on restart.** The counter lived inside the graph, and
  a graph is replaced on the recovery path (FR-045), so the first chunk after a
  restart repeated sequence 1 and the supervisor's gap detection saw a duplicate
  on the exact path it exists to watch. The counter now lives per source and
  resets only when the session stops.
- **Stereo was truncated, not downmixed.** Taking channel 0 alone meant an
  interviewer whose audio sat mostly in the right channel arrived as
  near-silence. The channels are averaged.
- **The audio worker window skipped the navigation lockdown.** A redirect to a
  remote origin would have kept the window's preload bridge and still counted as
  the media-authorized worker under `owns()`, handing a remote page the capture
  and audio IPC surface every other renderer is denied (FR-086).
- **`chunksInFlight` treated an async consumer as finished when it returned.**
  The count is released when the promise settles now. The reviewer is also right
  that the counter cannot detect a consumer that retains the buffer; it measures
  concurrency, and retention is proved by the direct-reference assertions in
  `TC-041` and by `TC-137`'s runtime write monitor, not by this number.
- **The concurrency group did not dedupe push and pull-request runs.** Already
  fixed before the review landed.

Two process lessons, both fixed rather than noted:
- The `git grep` guardrails missed untracked files, so a new file passed locally
  and failed in CI once committed. That is how the Whisper rule was first
  broken. They now pass `--untracked`, verified by planting a violation.
- Coverage excluded `src/main/ai/**`, written before the directory existed. It
  would have hidden every untested adapter.


### TASK-001 Project scaffold
**Traces** FR-001, FR-086, NFR-006, NFR-015, NFR-016
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
- `VENDORED.md` exists. `npm run licenses` fails when a file under
  `src/renderer/**/vendor/` has no entry naming its source, version and license
  (NFR-016).
- A lint rule forbids deep imports into `src/main/rag/*` from outside
  `src/main/rag.ts`.
**Verified by** TC-001, TC-007, TC-008, TC-009, TC-146

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
**Traces** FR-020, FR-023, FR-024, FR-025, FR-029, FR-030, FR-031, FR-032, FR-033, FR-035, FR-036
**Depends on** TASK-002
**Acceptance criteria**
- Every field and default from `Settings` in `02-architecture.md` section 2.1 is
  implemented, with the exact defaults listed there.
- Loading a corrupt or schema-invalid file replaces it with defaults and renames
  the original to `settings.corrupt-<epochMillis>.json`. The original is never
  deleted. The name must be filesystem-safe on Windows: an ISO 8601 timestamp
  contains colons and the rename would fail at exactly the moment the app is
  recovering from corruption (FR-033).
- `schemaVersion` mismatch runs a migration chain. Version 1 is the baseline, so
  the chain is empty but the mechanism exists and is unit tested with a fake
  version 0.
- Out-of-range values are clamped, not rejected: `overlayOpacity` to 0.30-1.00,
  `overlayFontSizePx` to 16-32, `turnEndGapMs` to 500-1500.
- `main.log` rotates at 5 MB keeping 3 files. At most 3
  `settings.corrupt-*.json` files are kept, oldest deleted first.
**Verified by** TC-030, TC-031, TC-032, TC-033, TC-147

### TASK-004 Secret vault
**Traces** FR-021, FR-022, FR-026, FR-034, NFR-003
**Depends on** TASK-002
**Acceptance criteria**
- Keys are encrypted with `safeStorage.encryptString` and written to
  `secrets.bin`, never to `settings.json`.
- When `safeStorage.isEncryptionAvailable()` is false, `secrets:set` returns an
  error, nothing is written and no plaintext fallback path exists in the code.
- `secrets:status` (CH-104) returns booleans only. Grep across the codebase
  finds no channel whose response type can carry a key string.
- A redaction helper masks any value matching a known key shape in log output
  and in serialized `Error` objects. It is applied at the logger and the error
  serializer, and nowhere else. The IPC router does not redact. A test proves a
  key leaked from a health-probe error, which never crosses IPC, is still masked
  (FR-034).
- `secrets:set` validates the key live before saving. A failed validation saves
  nothing and returns the provider's reason.
**Verified by** TC-020, TC-021, TC-022, TC-023, TC-024, TC-025, TC-139

### TASK-005 Window orchestrator and content protection
**Traces** FR-002, FR-005, FR-009, FR-080, FR-081, FR-082, FR-083, FR-089, NFR-012
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
- Acrylic uses Electron `backgroundMaterial: 'acrylic'` with
  `transparent: false`. Flat opacity uses `transparent: true`. Changing the mode
  destroys and recreates the overlay, preserving position, monitor,
  click-through state and the card stack. Changing opacity alone applies live.
  On Windows 10 acrylic is disabled with a note (FR-089).
- A Reset Overlay action returns the overlay to the primary monitor default
  position, sets interactive mode and re-registers both hotkeys (FR-009).
- The pre-19041 capture warning shows once per session alongside the consent
  reminder, not once per install (NFR-012).
**Verified by** TC-004, TC-005, TC-009, TC-036, TC-142, TC-148

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

### TASK-010 Audio Worker spike — COMPLETE
**Traces** FR-040, ADR-005
**Depends on** TASK-001
**Acceptance criteria**
- A throwaway branch proves `electron-audio-loopback` returns a working system
  audio `MediaStream` in a hidden renderer on both Windows 10 and Windows 11.
- The result is written into `docs/00-decision-log.md` as a confirmation note,
  or as a new ADR selecting the replacement approach if it fails.
- If the package fails, the fallback is already designed in ADR-005 and is
  selected here rather than invented.
- **Result: ADR-028. CLOSED, confirmed on Windows.** The package is not needed
  and is removed. A sandboxed, context-isolated renderer acquires the loopback
  stream through `getDisplayMedia` alone, with main owning
  `setDisplayMediaRequestHandler({ useSystemPicker: false })`. The
  `loopback-spike` job on `windows-latest` returns `works-with-audio`, with a
  real audio track, non-silent samples and the context forced to 16 kHz.
- This task gates TASK-011, and the gate is now open.
**Verified by** MW-02

### TASK-011 Dual-stream capture — COMPLETE
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
- PCM retention is bounded (ADR-027). After a chunk is handed on, neither the
  worker nor the supervisor retains a reference. Any deliberate buffering is
  bounded by an exported constant, and the audio path exposes its live-chunk
  count so the bound can be asserted from outside rather than inferred. The
  chunk is copied rather than transferred, because Electron cannot transfer an
  `ArrayBuffer`; the copy costs 31 KiB and 0.08 ms and is not the risk.
- An ESLint rule forbids importing `fs`, `fs/promises` or `original-fs` across
  the whole reachable audio path, not just its start: `src/renderer/audio-worker/**`,
  `src/main/audio.ts`, `src/main/ai/stt.ts` and `src/main/ai/stt/**`. Transferring
  the buffer neuters the worker's reference, it does not stop a downstream
  adapter from persisting the bytes it receives (NFR-002).
- Loopback failure still starts the mic, sets the interviewer stream state to
  `error` and blocks `session:start` with a named reason.
- Unexpected stream end retries 3 times before surfacing an error badge.
- `session:stop` destroys both contexts, stops all tracks and closes the worker
  window. No `AudioContext` remains after stop.
- **Result: complete.** The hidden Audio Worker acquires each stream through
  its own `getDisplayMedia`/`getUserMedia` call and its own forced 16 kHz
  `AudioContext`; the two graphs are never joined. `pcm-worklet.ts` emits
  32000-byte Int16 LE mono chunks tagged with `source`, `timestamp` and a
  per-source `sequence`. `AudioSupervisor` bounds live chunks by the exported
  `MAX_CHUNKS_IN_FLIGHT` and exposes `chunksInFlight` so the bound is asserted
  from outside. `main/index.ts` installs the loopback display-media handler
  and replaces the Milestone 0 deny-all permission handler with one that
  grants `media` to the Audio Worker `webContents` alone. Capture is wired but
  not started; starting is TASK-040.
- The runtime filesystem-write monitor is TASK-050 (TC-137). The static ban
  required here is in place and covers `src/main/ai/stt.ts` and
  `src/main/ai/stt/**` before those files exist, so TASK-012 cannot open the
  hole it guards.
**Verified by** TC-040, TC-041, TC-042, TC-043, TC-044, TC-045, TC-136

### TASK-012 STT registry and the streaming adapters — COMPLETE
**Traces** FR-023, FR-037, FR-038, FR-047, FR-048, FR-100, NFR-001
**Depends on** TASK-011, TASK-004
**Acceptance criteria**
- `src/shared/registry/stt.ts` and `src/shared/registry/llm.ts` exist with the
  v1 contents in `02-architecture.md` section 2.1a.
- `SttProvider` and `SttSession` match section 3.1 exactly, taking a
  `ProviderChoice`, not a provider id alone.
- Capability flags are read from the selected model's registry entry. A grep
  finds no branch on a provider id string outside the adapter files and the
  registry itself.
- Three streaming adapters ship and all three accept the same 16 kHz, 16-bit,
  mono PCM with no per-provider resampling:
  - Deepgram: `encoding=linear16&sample_rate=16000&channels=1&interim_results=true`
    and `endpointing` set from `settings.trigger.turnEndGapMs`, never hard-coded,
    so a native signal cannot preempt the user's chosen gap (FR-050).
  - OpenAI realtime: a transcription session on the realtime WebSocket with the
    chosen model and server VAD. Deltas to `isFinal: false`, completed items to
    `isFinal: true`, VAD stop to `endpoint`.
  - ElevenLabs: Scribe v2 Realtime WebSocket, input format `pcm_16000`. Partials
    to `isFinal: false`, committed segments to `isFinal: true` and `endpoint`.
- One session per stream. Two concurrent connections during a live session, each
  with its own interim and final state.
- Every emitted event is a normalized `TranscriptEvent` including `providerId`.
- A dropped socket reconnects and resumes without ending the session.
- The ElevenLabs key is a fourth credential in the vault, validated on entry and
  health-keyed like the others.
- Adding a fake provider to the registry makes it selectable and usable end to
  end with no edit outside the registry and its adapter (FR-037).
- Every registry model has a `providerId:modelId` row in `pricing.json`.
- **Result: complete.** `src/shared/registry/{stt,llm}.ts` hold the v1 contents.
  `src/main/ai/stt.ts` is the facade; `src/main/ai/stt/` holds the three
  adapters over one shared `SocketSttSession`. `TC-151` is enforced as a real
  `git grep`, so a provider id written into the trigger or a renderer fails the
  build rather than being caught in review.
- **Spec corrections made in the same change** (DoD 9):
  - `pricing.json` `llm` rows are keyed `providerId:modelId`, matching the `stt`
    block and `TC-156`'s wording. Section 7 had shown bare model ids.
  - `deepgram:nova-2` was in the registry table with no price row. Added.
    `TC-156` now also fails on a price row no model claims.
  - `supportsEndpointing` is defined as "the native signal fires at the user's
    configured gap", not "the provider has a signal". It was ambiguous for
    ElevenLabs and two engineers would have read it differently.
  - Three provider SDKs replaced by one `ws` transport (ADR-029). Section 8's
    runtime table and its stale `electron-audio-loopback` risk paragraph are
    rewritten.
  - Coverage no longer excludes `src/main/ai/**`. That exclusion was written
    before the directory existed and would have hidden an untested adapter.
    Only `ws-factory.ts`, which builds a real socket, stays excluded.
- **Design decision found during implementation.** The reconnect ladder resets
  only after a connection that stayed up for `HEALTHY_CONNECTION_MS`. Resetting
  on `open` alone lets a provider that accepts and immediately drops the socket
  reconnect forever, which is the unbounded retry ADR-024 rules out.
- **Deferred to TASK-013:** `openai:whisper-1` routes to the `batch` adapter
  table, which is empty, so it fails with a named reason rather than being
  silently handled by the streaming adapter. The test asserting this is the
  handoff.
- **Deferred to TASK-014:** health keyed by credential, and failover. The error
  classes and `retryable` flag this needs are in place and tested.
- **Deferred to TASK-042:** the Dashboard model picker that reads the registry.
  Selection is registry-driven at the model layer; no renderer exists yet.
**Verified by** TC-050, TC-051, TC-052, TC-053, TC-054, TC-056, TC-151, TC-152, TC-153, TC-155, TC-156, TC-159

### TASK-013 Non-streaming STT class and the Whisper adapter — COMPLETE
**Traces** FR-047, FR-049, NFR-017, ADR-022
**Depends on** TASK-012
**Acceptance criteria**
- `whisper-1` buffers 4000 ms of PCM, wraps it in a valid WAV container built in
  memory and posts one request per buffer.
- Emits `isFinal: true` only. Never an interim, never an endpoint.
- `streaming`, `supportsInterim` and `supportsEndpointing` are all `false` in the
  registry entry, and the trigger reads those flags rather than checking any
  provider id.
- A model whose entry says `streaming: false` is held to `NFR-017`, not
  `NFR-001`. Which budget applies is computed from the entry.
- The Dashboard badge text comes from the registry entry's `badge` field and
  names both the accuracy penalty and the latency penalty. No renderer file
  mentions Whisper by name.
- The WAV header is written by hand in `src/main/ai/stt/wav.ts`. The body is
  built in memory. No file stream and no path is ever passed to the HTTP client
  (ADR-019).
- **Result: complete.** `src/main/ai/stt/wav.ts` writes the 44-byte RIFF/WAVE
  header by hand and `whisper.ts` buffers `WHISPER_BUFFER_CHUNKS` (four 1000 ms
  chunks), posts each buffer as an in-memory `Blob` and emits `isFinal: true`
  only. `on('endpoint')` is accepted and never called. No path and no stream
  reaches the HTTP client (ADR-019, NFR-002).
- `latencyBudgetFor(model)` in the STT registry returns `NFR-001` or `NFR-017`
  from the entry's `streaming` flag, so which budget applies is computed, not
  looked up by provider name.
- The badge text now names both penalties, as `NFR-017` requires. It previously
  named only the latency cost.
- `TC-057`'s "no renderer names Whisper" half is enforced as a real `git grep`,
  verified by planting a violation in a renderer and watching it fail. Its
  Dashboard half waits on TASK-042, which builds the first model picker.
- `TC-150`'s registry half is covered here. The end-to-end latency harness
  needs the trigger and the LLM, so it lands with TASK-032; real numbers come
  from MW-11.
- Found while implementing: Whisper's `validateKey` was a copy of the realtime
  adapter's. Both now call one `validateOpenAiKey`, because one key serves both
  transports and two copies would drift (ADR-017).
**Verified by** TC-055, TC-057, TC-150

### TASK-014 Provider health and failover — COMPLETE
**Traces** FR-100, FR-104, ADR-009, ADR-010, ADR-017
**Depends on** TASK-012
**Acceptance criteria**
- One shared implementation serves both the STT and the LLM capability, keyed by
  credential (`deepgram`, `openai`, `anthropic`), not by capability. One probe
  timer per credential (ADR-017).
- A rejected OpenAI key produces one Dashboard badge naming every affected
  capability, not one badge per capability.
- An STT switch-back lands on a turn boundary with no audio in flight. It never
  closes the socket mid-utterance.
- Errors classify to `auth`, `rate-limit`, `network`, `timeout`, `server`,
  `client`. `auth` and `client` are `retryable: false`.
- Retry backoff is 250, 500, 1000 ms with up to 20 percent jitter, 3 attempts.
- An `auth` error skips the retry loop entirely and fails over immediately.
- After failover the adapter stays on the backup for the rest of the session.
- A probe runs against the primary every 60 s. Two consecutive passes return to
  the primary at the next clean boundary, not mid-stream.
- With no backup configured the no-backup path splits on `retryable` (ADR-024):
  a retryable failure enters `DEGRADED` and retries with backoff capped at 10 s;
  a non-retryable failure (`auth`, `client`) enters `CONFIG_REQUIRED`, terminal
  for that credential for the session, sending no further requests. A revoked key
  must not fire a doomed request every ten seconds for a whole interview.
  `CONFIG_REQUIRED` clears when the user saves a new key for that credential.
  The overlay is never touched in either state.
- `CH-202 state:providers` reflects every transition.
- **Result: complete.** `src/main/ai/health.ts` holds `CredentialHealth` (one
  machine per credential) and `ProviderHealthRegistry` (binding, projection,
  probes). `main/index.ts` binds it from settings, rebinds on a provider change,
  pushes `CH-202` on every transition and clears `CONFIG_REQUIRED` when a key is
  saved and validated.
- **Spec gaps found and closed in the same change** (DoD 9):
  - `hasBackup` was modeled as a property of the credential. It is a property of
    the capability binding: one OpenAI key can be the LLM primary with no backup
    and the STT backup at once, and the first version failed the LLM over to a
    backup that existed only for STT. Now passed per request.
  - `CONFIG_REQUIRED` is terminal for the credential, not for one capability. A
    revoked key stays flagged even where another capability routes around it.
  - `CH-202` is capability-shaped while the machine is credential-shaped. A
    capability now reports the worst state among every credential it depends on,
    including its backup. Without this `TC-143`'s own scenario (OpenAI as STT
    backup and LLM primary) left STT reading healthy.
  - "No audio in flight" is enforced: `noteCleanBoundary` takes the live chunk
    count and refuses above zero, holding the pending switch rather than
    cancelling it. `TC-144` was otherwise a convention.
- An unclassified failure is treated as retryable. Ending an interview on an
  error we could not classify is worse than one more attempt.
- **Deferred to TASK-040:** calling `noteCleanBoundary` at real turn boundaries,
  and routing live STT and LLM requests through `runFor`. The session manager
  owns both; the contract and its guards are in place and tested.
- **Deferred to TASK-042:** the Dashboard badge that groups by `credentialId`.
  The payload carries what it needs.
**Verified by** TC-100, TC-101, TC-102, TC-103, TC-143, TC-144, TC-162

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
- Deleting a profile removes the whole profile directory from disk: `kb/`,
  derived Markdown, chunk files, vectors and session transcripts. A test asserts
  the directory does not exist afterwards and that no transcript or document
  content survives anywhere under `userData` (FR-069).
- A delete interrupted partway must not leave content on disk with the profile
  record gone. The record is removed last.
**Verified by** TC-060, TC-061, TC-062, TC-063, TC-160

### TASK-021 Chunking
**Traces** FR-062, FR-063, ASM-001
**Depends on** TASK-020
**Acceptance criteria**
- Splits on `#`, `##`, `###`. `####` and deeper stay inside the parent chunk as
  body text.
- The token cap is read from the embedding model's `max_seq_length` (256 for
  MiniLM), not hard-coded. A test asserts no produced chunk exceeds it, so a
  model swap cannot silently reintroduce truncation (FR-062, ADR-023).
- `headerPath` is the ordered ancestor chain, for example
  `['Experience', 'Acme Corp']`.
- A section over the cap soft-splits on blank lines. A single paragraph over the
  cap is hard-split at the token boundary rather than dropped.
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
- With no network and no cached model, the document manager shows an explicit
  "embedding model not downloaded" state with a retry action. It does not hang
  and does not present the failure as a generic error. The `NFR-008` offline
  guarantee applies to an installation whose model is already cached (ADR-026).
- Vectors are L2-normalized before write, stored as a flat `Float32Array` in
  `<docId>.vectors.bin`.
- The cache key is `sha256(fileBytes):chunkerVersion:embeddingModelId`. An
  unchanged file is not re-embedded on relaunch.
- Changing `chunkerVersion` invalidates the cache with no manual purge.
**Verified by** TC-068, TC-069, TC-070, TC-071, TC-161

### TASK-023 Auto-tagging and user override
**Traces** FR-064, FR-079
**Depends on** TASK-020
**Acceptance criteria**
- Guesses `resume`, `company-notes` or `job-description` from filename and
  content, with a documented, deterministic rule set. It is not an LLM call.
- A user override sets `docTypeSource: 'user'`. Re-import or a file change never
  overwrites a user override.
- An override updates chunk metadata in place without re-embedding.
- An override can be reset to `auto`, which re-runs the guess.
- A document in `error` retries from the Dashboard without re-import (FR-079).
**Verified by** TC-072, TC-073, TC-074, TC-149

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
**Traces** FR-068, FR-077, FR-078
**Depends on** TASK-022
**Acceptance criteria**
- `chokidar` watches each profile's `kb/` folder with a 500 ms stability debounce.
- An add, change or unlink re-processes only that file.
- For a document at or below the supported ceiling of 2 MB and 200 chunks, a
  change is reflected in `query` results within 5 s of the file system settling.
  Above the ceiling the document still processes, the 5-second target does not
  apply, and the Dashboard shows progress. The ceiling is shown in the Dashboard
  (FR-068).
- A delete removes the document record, its chunks and its vectors.
- Rapid successive writes to one file cause exactly one re-embed.
- A file that appears in `kb/` outside `doc:import` is adopted: a record is
  created, auto-tagged and embedded, and it appears in the Dashboard (FR-077).
- A startup reconciliation pass runs before the watcher and resets any document
  in `pending`, `converting` or `embedding` to `pending` (FR-078).
- `chunks.json` and `vectors.bin` are written write-to-temp then rename. A row
  count mismatch at load discards both and re-embeds (FR-078).
**Verified by** TC-079, TC-140, TC-141, TC-163

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
- Structure is enforced at the buffer, not trusted to the prompt (FR-004,
  ADR-025): a forced flush wraps at a word boundary and never mid-word; a line
  over 120 characters after wrapping is truncated at a word boundary with an
  ellipsis; a card renders at most 5 lines and line 6 onward is never sent; a
  generation that emitted no newline is recorded as `nonconforming`. The overlay
  still shows what was salvaged and never an error (FR-076).
- A `SuggestionLine` is emitted per newline, plus a final flush of the
  remainder, plus a forced flush at 240 pending characters with no newline.
- A test feeds character-by-character deltas and asserts the number of
  `CH-208` messages equals the number of lines, not the number of characters.
- `AbortSignal` cancellation aborts the underlying HTTP request. A test asserts
  the request is aborted, not merely unsubscribed.
- No code path sends an error to the overlay. A static test asserts the overlay
  preload exposes no error channel.
**Verified by** TC-093, TC-094, TC-095, TC-096, TC-157

---

## Milestone 4 — Sessions, cost, UI

### TASK-040 Session manager and transcript
**Traces** FR-088, FR-101, FR-105, FR-106, FR-107, FR-108, ADR-003, ADR-013, ADR-018
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
- The Session Manager is the only component holding a session file handle. The
  Cost Meter hands usage over in memory (FR-106).
- Every entry carries a monotonic `seq` assigned at append time. A cancelled
  generation is appended, carrying the bullets already flushed, before the
  replacing generation's entry. The LLM layer awaits that append (FR-106).
- Each entry is one `write()` of one complete line. Compaction discards an
  unparseable final line and keeps the rest. When a `.json` and a `.ndjson`
  both exist, the `.json` wins (FR-107).
- A `session.lock` file enforces one session across restarts and a stale lock is
  cleared by the recovery pass (FR-108).
**Verified by** TC-104, TC-105, TC-106, TC-107, TC-134, TC-135

### TASK-041 Cost meter
**Traces** FR-103, FR-109, ASM-011
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
- Warnings are edge-triggered upward only. An estimate that decreases after a
  cancelled generation and crosses again does not warn twice (FR-109).
- The Cost Meter never writes to disk. It hands usage to the Session Manager
  (ADR-018).
**Verified by** TC-108, TC-109, TC-145

### TASK-042 Dashboard UI
**Traces** FR-023, FR-024, FR-025, FR-026, FR-027, FR-028, FR-029, FR-030, FR-031, FR-032, FR-038, FR-080, FR-087, FR-088, FR-110, NFR-010, NFR-014
**Depends on** TASK-003, TASK-004, TASK-014, TASK-025, TASK-041
**Acceptance criteria**
- All six sections exist: Provider Setup, Company Profiles, Session History,
  Hotkeys, Cost and Usage, Consent Reminder.
- Provider Setup offers a provider picker and a model picker for STT primary,
  STT backup, LLM primary and LLM backup, all populated from the registries.
- Each model row shows whether it streams and its price. Selecting a
  non-streaming model shows the `NFR-017` latency consequence before saving
  (FR-038).
- A backup from the same provider as the primary is rejected, because the
  credential and the service are the same (FR-025).
- Provider Setup states plainly that one OpenAI key serves OpenAI STT models and
  OpenAI LLM models alike.
- Session History states plainly that transcripts are unencrypted local files
  kept until deleted (FR-110).
- Key entry shows an inline pass or fail within 10 s and does not save a failing
  key.
- Company Profiles supports create, switch, delete and drag-and-drop import,
  with a doc-type override control per document row. Exactly one profile is
  active at a time and switching is disabled during a live session (FR-027,
  FR-028, ADR-013).
- Profile delete requires a confirmation that names the counts of documents and
  sessions to be deleted. Deleting the active profile activates another profile,
  or creates a default profile when none remains (FR-028).
- Exactly one profile is active at a time, and the active profile is shown
  unambiguously in the Dashboard header (FR-027).
- Session History groups by profile and supports view and delete.
- Cost and Usage shows the live timer and spend estimate during a session.
- Consent Reminder is editable with a one-action reset to default. The shipped
  default states that an unencrypted local text transcript is kept for the
  session (FR-007, FR-110).
- Every interactive element is reachable and operable by keyboard.
**Verified by** TC-120, TC-121, TC-122, TC-123, TC-124, TC-125, TC-154, TC-158

### TASK-043 Overlay UI
**Traces** FR-006, FR-007, FR-008, FR-076, FR-085, FR-090, FR-091, FR-092, FR-093, FR-094, FR-102, NFR-007, NFR-010
**Depends on** TASK-032, TASK-005
**Acceptance criteria**
- The renderer sends `overlay:ready` after mounting and rendering the consent
  reminder. The main process buffers suggestion messages until it arrives and
  drops nothing (FR-008).
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
**Verified by** TC-006, TC-110, TC-111, TC-112, TC-113, TC-114, TC-115, TC-116, TC-117, TC-138

---

## Milestone 5 — Hardening and release

### TASK-050 Global resilience
**Traces** NFR-001, NFR-002, NFR-004, NFR-005, NFR-008, NFR-009
**Depends on** all of Milestone 4
**Acceptance criteria**
- `process.on('uncaughtException')` and `process.on('unhandledRejection')` in
  main log and continue. A test injects a rejection during a session and
  asserts the session stays active.
- A 60-minute soak test with synthetic transcript events keeps main-process RSS
  under 600 MB with no upward trend over the last 30 minutes.
- A filesystem write monitor runs a synthetic session with Whisper active and
  asserts no write contains PCM. The app-owned temp directory is empty at
  session end (NFR-002, ADR-019).
- With the network disabled the app starts, manages profiles, imports documents
  and embeds. Session start warns that transcription is unavailable.
- App-side overhead on the turn-end to first-line path is under 150 ms with
  scripted fakes (TC-133). The end-to-end `NFR-001` budget (p50 under 2.5 s,
  p95 under 4.0 s) is measured and recorded by MW-06 before release.
**Verified by** TC-130, TC-131, TC-132, TC-133, TC-137, MW-06

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
  recorded before a tag is cut. Any single failure blocks the tag, MW-06 and
  MW-11 latency numbers included. MW-12 confirms a documented limitation and
  cannot fail the release.
**Verified by** TC-001, MW-01 to MW-13
