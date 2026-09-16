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

**Status: COMPLETE, 2026-09-16.** All six tasks implemented and verified.
`npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run licenses`,
`npm run build`, `npm run smoke:main`, `python3 scripts/traceability.py` and 536
unit and integration tests all pass, and every CI job is green on Windows,
including `Electron E2E` and `Windows installer`. Line coverage over `src/main/rag/**` is
96.9 percent against an 80 percent floor; every file in the milestone clears the
floor on its own.

Four new runtime dependencies, each already in the dependency table in
`02-architecture.md` section 8: `pdf-parse`, `mammoth`, `@xenova/transformers`
and `chokidar`. `npm ls electron --omit=dev` is still empty.

Spec gaps found and closed in the same change, recorded as **ADR-030**: `CH-110`
gains `'auto'`, `CH-110`/`CH-111`/`CH-123` carry `profileId`, `CH-123 doc:retry`
and `CH-124 model:ensure` are new, and `CH-214` carries a state rather than a
percent.

**Not verifiable in the development container, deferred to the Windows runner:**

| Item | Why not here | Where it is proven |
|---|---|---|
| `electron-builder` accepts the `asarUnpack` entries and still produces the installer | Wine is not installed, so electron-builder cannot emit NSIS on Linux | **Verified:** `package` job on `windows-latest`, green on this branch |
| The unpacked modules actually **load** from the packaged app: `onnxruntime-node`'s `.node` binary and ESM-only `chokidar` | Nothing installs and runs the packaged app. The `package` job builds the installer and checks it exists; it never launches it, so a wrong `asarUnpack` path would still produce a green build | **Still open.** No manual check covers it either, so it is carried to TASK-051 below rather than treated as proven |
| A real MiniLM tokenizer and a real 384-dimension vector | The model is a 90 MB download from Hugging Face. CI must not depend on it, and `TC-068` measures this app's normalization, not the model's output | MW-12, and the `TC-071` E2E half below |

**Defects found by the pre-push review and fixed in this change.** Each one is
pinned by a test that was checked to fail without its fix:

| Defect | Why it mattered | Requirement |
|---|---|---|
| The chunk cap resolved to **512, not 256**, on every real install. `readMaxSeqLength` read `sentence_bert_config.json`, which `@xenova/transformers` never downloads: it fetches `tokenizer.json`, `tokenizer_config.json` and `config.json` only. The only limit on disk was the BERT backbone's 512, so chunks up to 510 word pieces were built and silently truncated at embed time | The exact failure `ADR-023` exists to prevent, and invisible: nothing errors. Every test covering this had hand-seeded the file that production never has | FR-062, ADR-023 |
| `doc:retry` and `model:ensure` were declared and handled but never added to the Dashboard preload allowlist | `FR-079`'s retry and `ADR-026`'s "model not downloaded, retry" did not exist end to end, and a fresh install could never obtain a model at all | FR-079, ADR-026, FR-086 |
| Two `renameSync` calls are not one atomic write. A crash between them left a new `chunks.json` beside the old `vectors.bin`; when the edit preserved the chunk count, the row-count guard saw nothing and retrieval ranked new text by old vectors forever | The pair now carries a `pairId` in both files, so identity and not only size is checked | FR-078, ADR-014 |
| A vector carrying `NaN` was stored unnormalized. Its dot product is `NaN`, `NaN` makes the comparator falsy, so the sort fell through to the id tie-break and **one bad chunk took the whole top 3 for every question in that profile** | `l2Normalize` zeroes a non-finite vector and `topK` drops a non-finite score | FR-065 |
| `splitOversizeWord` restarted its halving window per piece. A 2 MB whitespace-free word, which a pasted base64 data URI is, handed 5.8 billion characters to the tokenizer and froze the main process; the token memo then retained every giant slice for the life of the process | The window is carried forward, and the memo takes words only | NFR-009 |
| The same function sliced by UTF-16 code unit, splitting surrogate pairs and destroying emoji and CJK Extension B characters | Splits on code points now | FR-062 |
| `ensureHeadings` tested `#{1,6}` while the splitter honours `#{1,3}` outside fences, so three ordinary documents got `headerPath: []`: one whose headings all start at `####`, one whose only `#` is inside a code fence, and one saved with a byte-order mark | It now uses the splitter's own rule and its own fence tracking, and strips the mark | FR-063 |
| An ingest finishing after its profile was deleted recreated `profiles/<id>/derived/` and wrote the document's full text and vectors there, invisible to every UI | The store refuses a write for a profile with no index | FR-069 |
| An ingest published from a snapshot taken before three awaits, so a doc-type override set during a slow PDF reverted to the guess, and a document deleted mid-ingest reappeared as `ready` with no file behind it | The record is re-read before the final publish | FR-064, FR-077 |
| `setDocType` read the record, awaited, then wrote the stale copy back, sending a document that had just finished embedding back to `state: 'embedding'` with `chunkCount: 0` | Re-reads after the await | FR-079 |
| One unreadable entry in `kb/`, a dangling symlink being the common case, rejected out of `reconcile` and `start`, and bootstrap awaits `start` before registering `window-all-closed` and `will-quit` | One bad file left the app with no watchers, no shutdown cleanup and a zombie process holding the single-instance lock | FR-068, NFR-009 |
| `ingest` claimed never to throw; `publish`, `writeDerivedMarkdown` and the embed `catch` all sit outside their own try. An ENOSPC on the second of three files abandoned the third with no record at all | TASK-020's acceptance criterion and TC-063 | FR-060 |
| The chunk-set cache was invalidated only on success, so after a failed re-embed `query` kept answering from content the Dashboard showed as failed and which no longer existed on disk | Invalidated on every failure path | FR-065 |
| `KnowledgeBaseWatcher` kept a profile in `stopped` after a rejected factory call, so the next `watch` opened a watcher, closed it and reported success, leaving `kb/` silently unwatched. `closeAll` also missed a watcher whose start was in flight | FR-068, and a leaked chokidar instance past `stop()` | FR-068 |
| `readChunkSet` validated that the parsed value was an array but not that its rows were chunks, so a hand-edited file threw a `TypeError` out of `query`, past its try, onto the live-session IPC path | Rows are validated | FR-078 |
| The model gate retried per file: an offline import of five documents made five full download attempts with `doc:import` unresolved through all of them, and flapped `CH-214` five times | A failure is terminal until the user retries, and that retry also re-processes the documents it unblocked | NFR-008, ADR-026 |
| `query` called `embed`, which loads on demand, so a cleared model cache meant the **first question of a live interview started a 90 MB download** inside the question-to-suggestion budget | ADR-011 blocks ingestion on the model, never a session | ADR-011, NFR-001 |
| `config:set` accepts a whole `Settings` object and `activeProfileId` is a plain string, so a Dashboard replaying cached settings could restore a deleted profile as the active one | Only `profile:activate` may move it, and only to a profile that exists | FR-028 |
| `isModelCached` accepted `model.onnx` while `loadOnce` requests the quantized build, reporting a model ready that then failed to load | Offline that is a "ready" model the user can never use | ADR-026 |
| `copyFile` without `COPYFILE_EXCL` let two concurrent imports of one filename overwrite each other, the outcome `uniqueKbPath` exists to prevent | | FR-060 |
| Retry on a row whose file was never written deleted the row and returned a generic IPC error | The row now explains itself | FR-079 |
| A `profile.json` with no `documents` array made every later `.find` throw out of `reconcile`; one bad profile emptied the whole Dashboard list | `kb/` is the authority, so an empty index is rebuilt, not fatal | ADR-014 |
| The determinate download bar hit 99 percent on the 700 KB tokenizer and snapped back to 3 percent when the 90 MB weights announced themselves | Monotonic now | FR-066 |
| `CH-215` shipped in Milestone 0 and was never written into the IPC table. The contract test only checked documented-implies-implemented | The test now asserts both directions | DoD 9 |
| **The overlay was unreachable while its renderer loaded.** `overlayWindow` was assigned from `await createOverlayWindow(...)`, so it stayed null for the whole of that load, while the Dashboard was already interactive and the window was already in `BrowserWindow.getAllWindows()` | `overlay:reset` arriving in that window failed its `if (overlayWindow)` guard, moved nothing and **returned `ok`**, so the Dashboard rendered "Overlay reset" over a window that had not moved. Found by `TC-148` failing identically on two heads on the Windows runner, where the overlay's renderer is the slower of the two to load; reproduced on Linux by delaying that one assignment, and the fix verified against a deliberately slow overlay load. The window is now handed over through a callback before the load, and the handler throws rather than reporting success with nothing done. A Milestone 0 bug this milestone's timing made reproducible | FR-009 |
| Knowledge base startup was **awaited inside `bootstrap`**, between the windows being created and `window-all-closed` and `will-quit` being registered. Reconciling reads every file in every profile's `kb/`, and starting a watcher pulls chokidar in through a dynamic ESM import | A slow or wedged knowledge base left the app interactive with no shutdown wiring at all, and delayed everything after it. Found by `TC-148` failing on the Windows runner, which is sensitive to that timing: the overlay is created `show: false` and Windows re-applies the placement of a never-shown window when it is finally shown. Startup is now background work, registered last and not awaited, with the lifecycle handlers ahead of it | NFR-009 |

**Defects found by the Codex review on the pull request, all eight verified and
fixed.** Three were regressions introduced by fixes earlier in this same branch,
which is the part worth remembering: a fix is not free, and each one needs its
own adversarial pass.

| Defect | Why it mattered | Requirement |
|---|---|---|
| A document deleted during its **first** ingest came back. The cancel was gated on the snapshot taken before the pipeline started, which is null for a new document, so the check could never fire on a first ingest | The document republished as `ready` with its `kb/` file already gone and its chunks queryable. The earlier fix only ever covered re-ingests | FR-077 |
| Reconciliation trusted a `ready` document because its chunk pair merely **loaded**, never comparing the bytes | A file edited while the app was shut down served its pre-edit chunks forever, because the watcher starts with `ignoreInitial` and no change event arrives. It also defeated ADR-012 entirely: bumping the chunker version or the model no longer invalidated anything on relaunch | FR-067, ADR-012 |
| An entry `stat` could not answer for was treated as deleted, dropping its record, chunks, vectors and derived Markdown. **A regression from this branch's own bootstrap-crash fix** | An EACCES file or an antivirus lock is not a deletion, and `ignoreInitial` meant a file that was still there might never come back. Only `ENOENT` counts as gone now | FR-077 |
| A profile whose `profile.json` was unreadable vanished from `list` entirely | Its `kb/` was never scanned or watched, `ensureActiveProfile` quietly selected another, and every document in it became invisible. This directly contradicted ADR-014, which this milestone's own comments quote: `profile.json` is derived, `kb/` is the authority. It is rebuilt from the folder now | ADR-014, FR-077 |
| The determinate download bar parked at 99 percent for the entire real download. **A regression from this branch's own monotonic-progress fix** | The tokenizer loads before the 90 MB weights, so one shared byte ratio hit 99 on a few hundred kilobytes and the monotonic clamp then suppressed every honest update from the weights. Each phase gets its own slice of the range now | FR-066 |
| Prose before a document's first heading produced `headerPath: []` | `hasSplittingHeading` was true, so no synthetic wrapper was added, and the preamble flushed with an empty stack. The milestone's own "every chunk has a header path" test had no preamble shape in it | FR-063 |
| A fenced block closed on any delimiter, so a ``` block ended at an inner `~~~` and a ```` block at an inner ``` | The `#` lines after the false close were read as headings, corrupting every following `headerPath`. CommonMark closes only on the same character, at least as long | FR-062, FR-063 |
| The license gate identified BSD-4-Clause as BSD-3-Clause | A BSD-4-Clause text contains the whole three-clause text including the non-endorsement sentence the gate matched on, so a dependency declaring the ambiguous bare `BSD` resolved to an allowed license and passed. The advertising clause is checked first now | NFR-015 |

**Found while fixing TC-148, deliberately not fixed here.** `wireOverlayWindow`
registers a `did-finish-load` listener, and it used to run *after*
`createOverlayWindow` had already awaited that load, so on first launch the
listener was attached to an event that had already fired and the overlay's theme
and consent text were never pushed. Moving the wiring into the creation callback
puts the listener in place before the load, which fixes it as a side effect. It
is called out here rather than left silent because it changes Milestone 0
behavior: `FR-008`'s consent text now actually reaches the overlay on first
launch. `TASK-043` owns proving that end to end, since no overlay UI exists yet
to assert against.

**Follow-up work carried out of Milestone 2**, each with an owner rather than a
vague intention:

| Item | Why it is not done here | Owner |
|---|---|---|
| `TC-071`'s "`session:start` still succeeds during the download" half | `session:start` does not exist yet. The ingestion-blocking half and the determinate-progress half are covered now, in `tests/integration/rag-model-gate.test.ts` | TASK-044 |
| Calling `RagEngine.query` from the prompt builder | The trigger and the prompt do not exist yet. `query(profileId, text, k=3)` is the contract they will call | TASK-031 |
| The Dashboard's document manager: the best-effort hover, the doc-type picker, the error retry button, the "model not downloaded" state, and the `2 MB / 200 chunks` ceiling text `FR-068` requires on screen | No renderer exists. `KB_CEILING`, `withinReembedCeiling`, `CH-123` and `CH-124` are the API it consumes | TASK-042 |
| Prove the unpacked modules load from the **installed** app, not just that the installer builds | The `package` job builds the installer and asserts the `.exe` exists, which it does with or without a correct `asarUnpack` path: nothing launches the packaged app. A `.node` binary cannot be `dlopen`ed from inside an asar and Electron's asar shim does not cover Node's ESM loader, so both failures appear only at runtime. Needs either a packaged smoke launch in the `package` job or a new manual check; `MW-01` to `MW-13` cover none of it | TASK-051 |
| `readChunkSet` reads one `readFloatLE` per value | Measured at 19 ms for a full 5000-chunk profile against a 2500 ms `NFR-001` p50, loaded once per profile per process and then cached. A typed-array copy is 4.2 ms but adds an endianness branch. Not a defect, so not fixed under a "fix now" heading | TASK-050 |
| `reconcile` rewrites `profile.json` once per removed record | O(N) writes when a user deletes many files at once. Correct, just wasteful | TASK-050 |
| A document's bytes are read twice and hashed twice per ingest, and a PDF is held in memory three times over | `rag.ts` reads the file, `convert.ts` reads it again, and `new Uint8Array(buffer)` copies it a third time. Correct, and a 200 MB PDF costs about 600 MB of RSS before pdfjs allocates anything | TASK-050 |
| `doc:import` takes an unbounded array of renderer-supplied absolute paths | There is no main-process `showOpenDialog` yet, so file selection is renderer-trusted. `basename` already stops the target escaping `kb/`; what is missing is the main-process dialog that should be choosing the paths | TASK-042 |
| The `RULES` table in `autotag.ts` gives each doc type exactly one filename pattern, so the `break` guarding a second match is unreachable | Harmless, and the guard is correct if a second pattern is ever added | TASK-050 |

### TASK-020 Document import and conversion — COMPLETE
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
- **Result: complete.** `src/main/rag/convert.ts` maps the extension to a format,
  reads `.md` as-is and writes `derived/<docId>.md` for `.pdf` and `.docx`.
  `src/main/rag/store.ts` owns `profiles/<id>/{profile.json,kb,derived,sessions}`
  and the cascade delete. `src/main/rag.ts` orchestrates import and ingest.
- `ensureHeadings` lives in `chunk.ts` and is applied to every format, not only
  to converted ones: a hand-written `.md` with no heading has the same problem,
  one unlabeled chunk with an empty `headerPath`. The original file is never
  rewritten, so `.md` is still ingested as-is (`TC-061`).
- **Found while implementing: `pdf-parse` v2 is a different library.** The
  dependency table names `pdf-parse`, and v1's `pdfParse(buffer)` function no
  longer exists; v2 ships a `PDFParse` class that owns a pdfjs worker and must be
  destroyed, or the worker keeps the process alive after the user closes the app.
- **Found while implementing: `TextResult.text` carries page chrome.** v2 appends
  `-- 1 of 3 --` separators to the concatenated string but not to a page's own
  text. Embedding those would put the separator in a vector and in a chunk the
  user reads, so per-page text is preferred and `stripPageSeparators` guards the
  fallback.
- **Found while implementing: a PDF has no blank lines to lose.** A blank line
  draws no glyphs, so pdfjs never reports one, and the chunker's soft split on
  paragraph breaks had nothing to split on. `pdfTextToMarkdown` rejoins hard
  wraps and treats a line that ends a sentence as ending a paragraph.
- **Bug found in review: a heading absorbed the line under it.** The rejoin
  treated a heading as an open line, so `# Experience` swallowed `Acme Corp` and
  the section boundary the chunker splits on was destroyed. Fixed and pinned by a
  case in `tests/unit/convert.test.ts`.
- **Deferred to TASK-042:** the Dashboard row that shows `extractionQuality:
  'best-effort'` with its hover explanation. The record carries the field and
  `TC-062` asserts it; no renderer exists yet.
**Verified by** TC-060, TC-061, TC-062, TC-063, TC-160

### TASK-021 Chunking — COMPLETE
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
- **Result: complete.** `src/main/rag/chunk.ts` is pure: no clock, no filesystem,
  no random source, which is what lets `CHUNKER_VERSION` participate in the cache
  key at all. If chunking were not a function of its input, a cache hit would not
  mean the chunks are the ones the vectors were built from.
- The cap is a parameter, sourced from the downloaded model's config by
  `readMaxSeqLength`, never a literal. `TC-066` drives three different caps
  through the same input and asserts no chunk exceeds any of them, so the "not
  hard-coded" half of `ADR-023` is proven rather than asserted in prose.
- **Design decision found during implementation: the token counter is per word,
  not per string.** A BERT-family tokenizer pre-tokenizes on whitespace and
  punctuation and then runs WordPiece inside each piece, so a text's count is the
  sum of its words' counts. A per-string counter would re-tokenize the whole
  accumulated candidate once per added word, making a 2 MB document quadratic.
  Counts are memoized per distinct word on top of that.
- A single word that alone exceeds the cap, which a long URL or a base64 blob can
  be, is split by characters rather than emitted over the cap. Emitting it would
  put a silently truncated chunk back in the store, which is the whole point of
  `ADR-023`.
- A heading inside a fenced code block does not open a section.
**Verified by** TC-064, TC-065, TC-066, TC-067

### TASK-022 Local embeddings and cache — COMPLETE
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
- **Result: complete.** `src/main/rag/embed.ts` holds `l2Normalize`,
  `embeddingKeyFor`, `readMaxSeqLength`, `isModelCached` and `XenovaEmbedder`.
  Vectors are L2-normalized by this app rather than by asking the library for
  normalized output, because the normalization is what makes retrieval a plain
  dot product and it is worth owning and testing (`TC-068`).
- **Design decision found during implementation: the library is injected.** The
  adapter takes a `loadLibrary` function, exactly as the STT adapters take a
  socket factory. Without it the whole class was unreachable from a test without
  a 90 MB download, and coverage over `embed.ts` sat at 56 percent. It is 93
  percent now, and only the one `import()` that reaches the real package is out
  of a unit test's reach.
- **Design decision found during implementation: `max_seq_length` has two
  sources and they disagree.** `sentence_bert_config.json` carries the
  sentence-transformers limit, 256 for MiniLM, while `tokenizer_config.json`
  carries the backbone's 512. The smaller wins, because exceeding either one
  truncates. A sentinel such as `1e30`, which means "no limit set", is ignored.
- **Design decision found during implementation: the model gate is on the
  `Embedder` interface, not an `instanceof` check.** `isReady()` and
  `ensureReady()` let the engine have one path and let a test drive the
  `unavailable` branch with no network (`TC-161`).
- Determinate progress sums bytes across every file rather than reporting the
  current file's percent, and caps byte-driven progress at 99 so the bar cannot
  finish before loading does.
- **Partly deferred:** the `asarUnpack` entry for `onnxruntime-node`. A `.node`
  binary cannot be loaded from inside an asar archive. The entry is in
  `electron-builder.yml` and the `package` job proves the installer still builds
  with it, but nothing launches the packaged app, so that the binary really loads
  from the unpacked path is unproven and carried to TASK-051.
- **Deferred to TASK-042:** the "embedding model not downloaded" UI and its retry
  button. `CH-124` and `CH-214` carry what it needs and `TC-161` asserts the
  states.
**Verified by** TC-068, TC-069, TC-070, TC-071, TC-161

### TASK-023 Auto-tagging and user override — COMPLETE
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
- **Result: complete.** `src/main/rag/autotag.ts` is a documented, deterministic
  scoring rule set: filename 10, heading 4, body 1 each capped at 6, ties broken
  in `TIE_BREAK_ORDER`. Not first-match: a file named `notes.md` whose body is
  plainly a resume should not be tagged from its uninformative name.
- `company-notes` heads the tie-break because it is the catch-all of the three. A
  miscategorized note costs a retrieval the user fixes with one override, while
  defaulting to `resume` would put arbitrary text where the prompt expects the
  candidate's own history.
- An override rewrites `chunks.json` and leaves `vectors.bin` untouched, because
  `docType` is metadata carried alongside the vector and not an input to it.
  `TC-074` asserts zero embedding calls and byte-equal vectors.
- **Spec gap closed (ADR-030):** `FR-079` requires the override to be resettable
  to automatic and `CH-110` was typed over the closed `DocType` union, which has
  no value that says so.
**Verified by** TC-072, TC-073, TC-074, TC-149

### TASK-024 Retrieval — COMPLETE
**Traces** FR-065, ASM-006
**Depends on** TASK-022
**Acceptance criteria**
- `query(profileId, text, k=3)` returns the top 3 chunks by dot product over
  normalized vectors, scoped to that profile only.
- No doc-type weighting exists in the code. A test asserts that two chunks with
  equal similarity and different doc types tie.
- A profile with no ready documents returns an empty array without throwing.
- A profile with 5000 chunks returns in under 50 ms.
- **Result: complete.** `topK` in `src/main/rag/store.ts` is a brute-force dot
  product over L2-normalized vectors. `RagEngine.query` reads only the requested
  profile's directory, so scoping is by construction rather than by a predicate
  that could be forgotten (`TC-075`).
- No doc-type weighting exists (`ASM-006`). Equal similarity ties, and the
  tie-break is chunk id, so the order is stable across runs rather than depending
  on directory iteration order.
- `TC-078` measures 5000 chunks at 384 dimensions against a 50 ms budget. It
  asserts the **fastest of five** readings, not one. A single wall-clock reading
  on a shared runner is the intermittent failure the test strategy's determinism
  rule calls a defect in the test: the scan costs 2 to 3 ms, and one CI reading
  came back at 54.9 ms, which measured the runner being descheduled rather than
  the code. A second case pins the property the budget is really about, that the
  scan is linear in the corpus, and it was checked to fail on a deliberately
  quadratic scan.
- `TC-078`'s budget is met with roughly twenty times the headroom, so the
  score-then-sort implementation stands. A bounded top-k selection was written
  and measured at about 20 percent faster, then discarded: it returned a
  different result, because its tie-break disagreed with the documented one. Chunk
  sets are memoized per profile and invalidated on every ingest, so reading 5000
  chunks off disk is not inside the question-to-suggestion budget (`NFR-001`).
- `query` returns `[]` rather than throwing for an empty question, an unknown
  profile, a profile with no ready documents, and a failed query embedding. A
  live session is allowed to run with no model, and an empty chunk set is the
  documented behavior (`ADR-011`).
**Verified by** TC-075, TC-076, TC-077, TC-078

### TASK-025 Knowledge base watcher — COMPLETE
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
- **Result: complete.** `src/main/rag/watch.ts` holds `IngestQueue` and
  `KnowledgeBaseWatcher`; `RagEngine.reconcile` and `RagEngine.start` own the
  startup pass and the ordering.
- **Design decision found during implementation: the debounce and the coalescing
  are ours, not chokidar's.** `awaitWriteFinish` collapses the write events of
  one save, but it does not stop a second save arriving while the first is still
  embedding, and that is the case "five rapid writes cause exactly one re-embed"
  actually turns on. Owning the queue also makes the timing testable with fake
  timers, which a dependency's internal polling is not.
- **Found while implementing: chokidar 5 is ESM-only.** The main process bundles
  to CommonJS, so it is reachable only through a dynamic `import()`, and it must
  be unpacked from the asar archive because Electron's asar integration patches
  CommonJS `require` and not Node's ESM loader.
- **Bug found in review: two concurrent ingests of one path made two records.**
  `importDocuments` and `reconcile` call `processFile` directly and bypass the
  queue, so a large PDF whose parse outlasts the watcher's 500 ms debounce
  produced two `DocumentRecord`s for one file, and `query` returned every chunk
  twice. Reproduced, fixed with an in-flight map keyed by path, and pinned by
  three cases in `tests/integration/rag-watcher.test.ts`.
- **Bug found in review: a path spelled differently read as a different file.**
  `reconcile` compares `originalPath` against `readdir`, and the watcher reports
  a third spelling. On Windows those can differ in case and in separators while
  naming the same file, and a false mismatch is not a small bug there: reconcile
  reads it as "the file is gone" and re-embeds the whole knowledge base on every
  launch. `normalizePath` now folds all three, case-folding only on win32.
- **Bug found in review: a fallback profile was never watched.** Deleting the
  last profile created a replacement through `store.create`, which makes the
  record without starting a watcher, so a file dropped into its `kb/` was never
  adopted (`FR-077`). It now goes through `RagEngine.createProfile`.
- **Bug found in review: `dispose` could hang an awaited `drain`.** The promise
  settles only at the end of a run, which dispose guarantees will never start.
- The `TC-079` timing half is driven through an injected watcher rather than real
  chokidar: what the case asserts is what the engine does with an event, and the
  debounce and coalescing are unit-tested with fake timers, as the test
  strategy's determinism rule requires.
**Verified by** TC-079, TC-140, TC-141, TC-163

---

## Milestone 3 — Trigger and suggestions

**Status: COMPLETE, 2026-09-16.** All three tasks implemented and verified.
`npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run licenses`,
`npm run build`, `npm run smoke:main`, `python3 scripts/traceability.py` and 658
unit and integration tests all pass. Line coverage over the milestone's own
files is 97 percent or better on every one of them against an 80 percent floor,
and 95.9 percent overall.

**No new runtime dependency.** Both LLM adapters stream SSE over the platform
`fetch`, so the dependency table in `02-architecture.md` section 8 is unchanged
and `npm ls electron --omit=dev` is still empty.

**Files added.** `src/main/ai/trigger.ts` (`CMP-05`), `src/main/ai/prompt.ts`,
`src/main/ai/llm.ts` (`CMP-07`), `src/main/ai/llm/{anthropic,openai,lineBuffer,sse,index}.ts`
and `src/main/overlay-gate.ts`. `02-architecture.md` section 11 is corrected to
list the three the original layout did not anticipate (DoD 9).

**Spec gaps found and closed in the same change, recorded as ADR-031:**

| Gap | What it said | What it says now |
|---|---|---|
| Section 5.3 writes the pause transition as `any -> PAUSED` | Read literally, pausing from `IDLE` and resuming puts the machine in `LISTENING` with no session behind it: no audio, no socket, no profile bound, and a turn-end timer armed for a session that does not exist | `any` means any **live** state. `IDLE` is not pausable |
| Section 4 typed `CH-209`'s status as `'complete' \| 'cancelled'` | The code has carried a third value since Milestone 0, because `TranscriptEntry` needs `nonconforming` for `FR-004`. The table and the schema disagreed | Three values, and the table says so |
| Section 3.3 left three cases undecided | Whether the ellipsis counts against the 120-character cap, what to do with one unbroken word longer than a limit, and whether a pending string ending exactly at 240 may be flushed whole | All three settled in section 3.3, each with the reason |

**What the milestone deliberately does not do.** There is no `session:start`
yet, so nothing drives the trigger from a live stream and nothing answers a
firing turn with a generation. The three components are complete and tested as
units and against each other; `TASK-040` is where they are joined to a session.
Rather than stub that, the trigger's `onFire` logs a turn it has no consumer
for, so a detected turn is visible instead of looking like a trigger that never
fired.

**Defects found by the pre-push review and fixed in this change.** Each one is
pinned by a test that was checked to fail without its fix:

| Defect | Why it mattered | Requirement |
|---|---|---|
| A generation cancelled by a newer turn reported **`complete`** and flushed its half-written bullet. `runGeneration` tested `signal.aborted` only at the top of each loop iteration, and an adapter that notices the abort first ends its stream cleanly, so the loop finished with no error and no further iteration to test the signal on | The overlay got one more line on a card that was about to be replaced, and the transcript would have recorded a cancelled generation as a completed one. Found by `TC-095` | FR-054, FR-075 |
| A guard failure during `GENERATING` moved the machine to `LISTENING` while a generation was still streaming | A one-word interjection during a suggestion ("Okay") left the state saying `LISTENING` under a live stream, so the stream's own end arrived against a state that had already moved on | FR-051, FR-054 |
| `setOverlayInteractive` pushed `CH-212` with `paused: false` hard-coded | Harmless while the pause hotkey only logged. Now that it pauses the trigger, pressing `Ctrl+Shift+I` while paused told the overlay it was running and would have taken the idle card off the screen | FR-053 |
| A rebuilt overlay was told its theme and its consent text, never its mode | A translucency change rebuilds the window (`ADR-015`), so a pause survived the rebuild in the main process while the overlay stopped showing the idle card | FR-053, ADR-015 |
| **The two overlay recreate paths reintroduced Milestone 2's null-window bug.** `applyThemeChange` and `reopenWindows` both assigned `overlayWindow` from the promise `createOverlayWindow` returns, so it stayed null for the whole of the renderer load, and the `did-finish-load` listener fired against a null window | The rebuilt overlay received **no theme, no consent text and no mode**: every push in that listener silently no-opped. Milestone 2 fixed this in `bootstrap` and left the two recreate paths behind, where it was invisible because nothing pushed to them until now. Both use the callback form now | FR-008, FR-053, FR-085 |
| One keypress pushed `CH-212` twice on pause: once from the trigger's idle callback, once from the hotkey handler | Two messages for one state change, and two places that could disagree about it | FR-053 |
| The forced flush could cut mid-word when the pending string ended exactly at 240 characters | `cutAtWordBoundary` returned the whole string when it was not *longer* than the limit, so a word the next delta continued was split across two bullets. `FR-004` says never mid-word | FR-004 |
| The line cap could produce a 121-character line | The ellipsis was appended after truncating at 120. A cap a rendered line can exceed is not a cap | FR-004 |
| `validateCredential` refused every Anthropic key | Correct in Milestones 0 to 2, where no adapter claimed that credential and `FR-026` forbids saving a key that has not passed live validation. Left in place it would have meant the LLM primary could never be configured at all | FR-026 |
| `TC-151`'s provider-id guard did not know about `src/main/ai/llm/` | The rule allows a provider id inside its own adapter file, which is what an adapter *is*. Extending the allowlist to the LLM adapters keeps the rule's meaning rather than weakening it | FR-037 |

**Defects found by the Codex review on the pull request, all eight verified and
fixed.** Two of them only exist because a question is asked while the previous
answer is still being spoken, which is the case a milestone about turn detection
has to get right and which none of its own tests had reached.

| Defect | Why it mattered | Requirement |
|---|---|---|
| **A turn was stranded when its generation settled first.** Q2's final arriving during Q1's stream arms the gap and leaves the machine in `GENERATING`. If Q1's stream then ended before the gap elapsed, `noteGenerationSettled` dropped the machine to `LISTENING`, and the timer fired into a state `evaluateTurn` refused | Q2 was never asked, and its text stayed in the buffer, so Q3 was appended to it and the model was handed two questions as one. `noteGenerationSettled` now returns to `AWAITING_TURN_END` when a turn is pending, and `evaluateTurn` refuses only `IDLE` and `PAUSED`, the two states that clear the gap on the way in | FR-050, FR-054 |
| **Whisper's 4000 ms batches were each read as a completed turn.** `whisper-1` emits one `isFinal` per batch and never an interim or an endpoint, so an 800 ms gap measured from each batch elapses while the interviewer is still speaking into the next one | A long question became a suggestion per fragment. The batch window is now declared once in the registry as `batchIntervalMs` and added to the gap, so the timer means "a whole batch went by with no new text", the only silence evidence a batch source can give. The adapter sizes its buffer from the same field, so the two cannot disagree | FR-050, ADR-022, NFR-017 |
| **A cancelled generation's late `suggestion:end` discarded its replacement.** The two run concurrently, so gen-1's end arrives after gen-2's begin. Keyed on "the last generation id seen", that stale end replaced the buffered card | gen-2's begin was dropped and its lines then arrived at the overlay with no card to render them on. The gate is keyed on a card now: only a `suggestion:begin` starts one, and a message for any other generation is ignored | FR-008, FR-054 |
| **A rebuilt overlay received the tail of a generation with no begin.** `noteClosed` dropped everything already delivered, so a translucency change mid-generation left the new renderer with later lines and an end it could not reconstruct a card from | The card is kept and its delivery count reset, so the whole generation is replayed to the new renderer | FR-008, ADR-015 |
| **Every candidate `isFinal` segment became a ring turn.** A streaming provider emits several segments for one spoken answer, Deepgram sending `is_final` per segment and `speech_final` separately | `FR-052`'s "last 2 candidate turns" held the last two *segments* of one answer and evicted everything said before them. Segments are grouped into a turn on the same silence gap the interviewer stream uses, and the turn still being spoken counts toward the context | FR-052, ASM-009 |
| **A native endpoint was ignored unless the machine was in `AWAITING_TURN_END`.** A second question's final arrives while the first generation streams, so the state is `GENERATING` when the provider reports the silence | The user waited out a full local gap after the provider had already seen the turn end, which is the delay `FR-050` names native endpointing to avoid. An endpoint now evaluates a pending turn in any live state. An endpoint arriving *before* its text, which is the order OpenAI's server VAD uses, is held for the next final rather than discarded | FR-050 |
| **A stream ending before its terminal marker was reported as a success.** A proxy or a dropped connection closes a 200 response cleanly without `[DONE]` or `message_stop`, and the loop exited normally | A truncated answer reached the overlay with nothing to say it was cut short, and the health machine never saw a failure. Both adapters now throw when a non-aborted stream ends without its marker, and the facade still shows the lines that did arrive (`FR-076`) | FR-070, FR-076 |
| **`requireLlmProvider` validated the provider id but not the model id.** Settings type `modelId` as a plain string, so a stale or hand-edited choice can name a model belonging to the other provider | The request reached the provider and came back 4xx, which classifies as a non-retryable `client` error and takes the whole credential to `CONFIG_REQUIRED`, blaming a key that is perfectly good. It mirrors `openSttSession` and checks `findLlmModel` first | FR-037, ADR-024 |

**Follow-up work carried out of Milestone 3**, each with an owner rather than a
vague intention:

| Item | Why it is not done here | Owner |
|---|---|---|
| Drive the trigger from the live STT sessions, answer `onFire` with `RagEngine.query` plus `runGeneration`, and push `CH-207`/`CH-208`/`CH-209` through the overlay gate | `session:start` does not exist. `TurnFired` and `runGeneration` are the contract it will call | TASK-044 |
| ~~Report a cancelled generation's token usage~~ **Answered in TASK-041.** The meter records what the provider reported and invents nothing, so a generation cancelled before any usage frame accounts zero (ADR-033) | An adapter that is aborted returns without yielding its terminal usage record, so a cancelled generation currently accounts zero tokens although the provider streamed some. The Cost Meter is where that decision belongs | TASK-041 |
| `triggerConfigFrom` reads `supportsEndpointing` off the STT **primary**, even when health has failed over to the backup | The two models can disagree about native endpointing. Harmless today because nothing fails over yet: the trigger is never fed. The rebind belongs with the session that owns the failover boundary | TASK-044 |
| Prove the overlay renders the idle card while paused, and that a suggestion buffered before `overlay:ready` reaches it | There is no overlay UI to assert against. `TC-087`'s integration half proves the main-process side; the renderer half needs `Overlay.tsx` | TASK-043 |
| `CH-215 notice:captureFidelity` is documented as targeting the overlay, is pushed to the Dashboard, and is not in the overlay preload's allowlist | A Milestone 0 inconsistency, found by this milestone's `TC-096` test while enumerating the overlay surface. Not this milestone's to change: `NFR-012` decides which window should show it | TASK-043 |
| A retrieved chunk's text is interpolated into the user message unescaped | The notes are the user's own documents, so this is not an injection path from a third party. A document containing a line like `CANDIDATE NOTES:` would still confuse the section structure | TASK-050 |

### TASK-030 Trigger state machine — COMPLETE
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

### TASK-031 Prompt assembly — COMPLETE
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

### TASK-032 LLM adapters and line buffering — COMPLETE
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

**Status: IN PROGRESS.** `TASK-040`, `TASK-041` and `TASK-044` are complete.
`TASK-044` is the live loop, split out of `TASK-042` by `ADR-034`. `TASK-042`
and `TASK-043` are not started.

### TASK-040 Session manager and transcript — COMPLETE
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

**Completed 2026-09-16.** `src/main/session.ts` (`CMP-08`), 38 new tests, and
the five session channels wired into bootstrap. `npm run typecheck`,
`npm run lint`, `npm run format:check`, `npm run build`, `npm run smoke:main`,
`python3 scripts/traceability.py` and 696 unit and integration tests all pass.

**Design decisions worth recording:**

| Decision | Why |
|---|---|
| **An append is awaitable and writes immediately**, rather than being queued for a flush timer | `FR-105` asks for an entry on disk within 2 seconds, and `FR-106` requires the LLM layer to *await* the cancelled generation's append before its replacement starts. A timer satisfies neither cleanly: it can be outlived by the very crash it exists for, and it gives the caller nothing to await. Writing now makes "within 2 s" trivially true |
| **Every append goes on one promise chain** | Two callers can append concurrently, which is exactly what a cancelled generation racing its replacement does. The chain makes disk order equal `seq` order without a lock (`FR-106`, TC-134) |
| **The compacted `.json` is written to a temporary file and renamed** | A crash between writing the `.json` and deleting the `.ndjson` would otherwise leave a half-written `.json` whose source had already gone. The rename is atomic, so one of the two files is always complete |
| **Only the *final* line of an `.ndjson` may be discarded** | A torn tail is the crash signature. A malformed line anywhere else means the writer did not write whole lines, which is a defect rather than a crash, so it throws instead of being silently dropped (`FR-107`) |
| **`start` never clears a lock; only `recover` does** | A lock held by a live process must refuse the start. Clearing it on the start path would silently overwrite a running session's transcript. Recovery runs when no session of ours exists, so any lock it finds is from a process that is gone (`FR-108`) |

**Spec gap found and closed, recorded in the architecture document (DoD 9).**
`ADR-018` places `session.lock` "next to the sessions folder", and there is one
such folder per profile, which would permit one concurrent session **per
profile**. `FR-108` and `ADR-013` both say one session, full stop. The lock is
at the `userData` root.

**Not done here, and deliberately.** `session:start` does not yet start audio
capture or open the STT sessions, so the trigger listens to a stream that does
not exist and fires nothing. Wiring the capture path, the `RagEngine.query` call
and `runGeneration` into a live loop is the rest of this milestone's integration
and is carried below rather than half-built here.

**Defects found by the Codex review on the pull request, all ten verified and
fixed.** Five were rated P1. The pattern across them is one mistake made in
several places: a failure path that quietly produced a *plausible* value
instead of stopping.

| Defect | Why it mattered | Requirement |
|---|---|---|
| **Crash recovery raced `session:start`.** Recovery runs in the background so a slow knowledge base cannot delay the windows, but the IPC handlers are registered before it finishes | A session started in that window had its **live** `.ndjson` treated as an orphan: compacted, deleted, and its lock removed from under the open handle. `session:start` now awaits recovery | FR-105, FR-108 |
| **`readNdjson` treated every read failure as an empty transcript.** Only `ENOENT` may mean that | A transient `EACCES` or `EIO` made compaction write an empty `.json` and then delete the `.ndjson` that still held every entry. Permanent loss from a temporary fault. Anything but `ENOENT` now aborts and preserves the source | FR-101, FR-105 |
| **One failed write poisoned the append chain.** Each write was attached to the *success* branch of its predecessor | After a single `ENOSPC`, every later append skipped its callback, so the rest of the interview, and every later session in the process, wrote nothing even once the disk recovered. The chain continues from a *settled* predecessor now, while the caller still sees its own write's failure | FR-105, FR-106 |
| **A session id from a renderer went straight into a path.** `CH-115` and `CH-116` take it as an arbitrary string, and it also comes from the user-editable `id` field of a file on disk | Deleting a session whose id is `../../../settings` would have removed `settings.json` at the `userData` root. Ids are validated against a pattern with no dot and no separator, so no sequence of components can leave the sessions folder | NFR-003 |
| **The bound profile could be deleted mid-session.** `profile:delete` removes the folder the live `.ndjson` lives in | The open transcript was unlinked, the lock left behind, and a clean stop made impossible, losing the session being recorded at that moment. Refused while a session is bound to it | FR-101, ADR-013 |
| **A failed compaction wedged the app.** `stop` cleared its active state before compaction succeeded | `stop` then saw no session and refused to retry, while `start` was refused by the lock the failure had left, so neither worked until a restart. State clears only after compaction succeeds, and the handle is re-opened for append so a retry can still add to the transcript | FR-107 |
| **Every crash-recovered session had a blank profile label.** The transcript carries entries and nothing else, so the bound profile, its name at the time and the real start time are nowhere in it | Session History showed recovered sessions unlabeled and ordered by whenever the first turn happened to be spoken, or by the recovery itself for a session that crashed before anyone said anything. A `<sessionId>.meta.json` sidecar is written at start and deleted on a clean stop | FR-101 |
| **A merely parseable `.json` took out the whole profile's history.** `readJsonSession` cast rather than validated | A hand-edited or half-written `{}` reached `listSessions`, where reading `entries.length` threw and lost every valid session in that profile alongside it. Parsed against the session schema now, and an invalid file is skipped | FR-101 |
| **The named start refusal never reached the renderer.** The router replaces every thrown handler error with one generic message | All four of `TC-104`'s cases were identical at the boundary, so the acceptance criterion held only inside the Session Manager. A refusal is an answer rather than a failure, so `CH-112` returns it. Recorded in the architecture document | FR-088, TC-104 |
| **`CH-201` was pushed only on a transition.** A Dashboard reopened mid-session, or an overlay rebuilt for a translucency change, missed every earlier push and has no channel to ask | Either would render the session as inactive until the next start, stop or pause. Both renderers are sent the current state when they load | FR-088, ADR-015 |

**Follow-up work carried out of TASK-040:**

| Item | Why it is not done here | Owner |
|---|---|---|
| Start audio capture and the STT sessions on `session:start`, feed `CH-206` into the trigger, and answer `onFire` with `RagEngine.query` plus `runGeneration` through the overlay gate | The Session Manager is the file writer, not the orchestrator. The loop is a task of its own, so that the first end-to-end suggestion is provable before any renderer exists (ADR-034) | TASK-044 |
| `TC-071`'s "`session:start` still succeeds during the model download" half, carried out of Milestone 2 | `session:start` exists now, but the assertion belongs with the live-session harness rather than with a manager that has no audio behind it. Re-carried by TASK-041 for the same reason | TASK-044 |
| ~~Usage is an in-memory snapshot the Session Manager stores and writes at compaction. Nothing sets it yet~~ **Done in TASK-041.** `CMP-09` calls `noteUsage` on every tick and once more at stop | `noteUsage` is the contract the Cost Meter calls | TASK-041 |
| `session:read` and `session:delete` scan every profile to find a session by id | The channels name a session but not its profile. One directory read per profile is correct and bounded; carrying `profileId` on the payload would be the faster fix and is a contract change | TASK-042 |
| Profile switching is not yet disabled in the Dashboard during a live session | `ADR-013` binds the profile at start and the main process already snapshots it, so the transcript is safe. The control that must be disabled is a renderer that does not exist | TASK-042 |

### TASK-041 Cost meter — COMPLETE
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

**What landed.** `src/main/cost.ts` is `CMP-09`: one class, a clock and an
interval injected, no Electron import and no filesystem import. It accumulates
audio seconds and tokens, prices them from the bundled table, pushes `CH-204`
once per second, and raises `CH-205` at most once per threshold per session.
`src/main/index.ts` starts it on `session:start`, rebinds its thresholds on
`config:set`, and hands its record to `CMP-08` on `session:stop` and on quit.
`UsageRecord` gains `estimateIncomplete`.

Covered by `tests/unit/cost.test.ts` (36 cases), `tests/integration/cost-session.test.ts`
(7 cases, the meter joined to a real Session Manager and a real temporary
`userData`) and four guardrails in `tests/unit/guardrails.test.ts`.

**Design decisions taken here, with the alternatives rejected:**

| Decision | Alternative rejected | Why |
|---|---|---|
| LLM usage is keyed by `generationId` and a second report **replaces** the first | Summing token counts by model | A provider can report usage twice for one generation, and summing bills the same tokens twice. Replacing also makes `FR-109`'s decreasing-estimate case real rather than hypothetical. Recorded as ADR-033 |
| A generation cancelled before the provider reported anything accounts **zero** tokens | Estimating from the text received | The meter would present a number it invented as a measurement. This resolves TASK-040's carried follow-up by answering it, not by deferring it again (ADR-033) |
| Audio seconds and tokens are accumulated **per model** | One session total priced at the chosen model | A failover moves a stream to a model at a different rate, and a total recomputed at the end bills the whole session at the last one |
| A missing price row sets `estimateIncomplete` and contributes zero dollars | Dropping the model, or guessing a rate | `TC-156` makes this unreachable in a shipped build, and "should be unreachable" is not "is". A labelled under-estimate beats an unlabelled one |
| The session timer runs on `performance.now()` | `Date.now()` | An NTP correction mid-interview would fire the time warning early, and `FR-109` gives no way to take a warning back. Pinned by a guardrail |
| Dollars are rounded to six decimals before being reported **and** before being compared to the threshold | Rounding only the displayed value | An unrounded comparison against a rounded display warns at a number the Dashboard is not showing yet |
| A threshold of zero or less is "not set" | Treating every threshold as live | Zero would otherwise fire on the first tick of every session |
| `start()` throws on an already-running meter | Restarting silently | A silent restart discards the running session's spend, which is the fabricated-value failure ADR-032 names |
| `CH-205` is logged and pushed, and nothing else | Any automatic stop or throttle | `FR-103` is explicit. A guardrail asserts `cost.ts` calls `.stop(` on nothing |

**Defects found in the local review of this task and fixed before pushing:**

| Defect | Consequence | Fix |
|---|---|---|
| **The meter was stopped before compaction.** `session:stop` called `cost.stop()` and passed the result to `noteUsage`, then awaited `sessions.stop()` | `sessions.stop()` can throw on a compaction failure and deliberately leaves the session live and retryable (ADR-032). The meter was already stopped, so that live session had a frozen timer and no `CH-204` | The record is handed over before compaction and the meter is stopped only after the manager confirms the session ended. Pinned by an ordering guardrail |
| **No `CH-204` at stop.** The panel froze on the last tick | The final figures on screen could disagree with the figures written to the session file by up to a second of spend | `stop()` pushes one last snapshot, and a test asserts it equals the record `stop()` returns |
| **The session timer read the wall clock** | A clock adjustment mid-interview moves the timer and can fire the time warning early, which `FR-109` makes permanent | Monotonic by default, pinned by a guardrail that also bans `Date.now` from the file |
| `CostMeterOptions` had no TSDoc | DoD 8 | Documented |

**Defects found in the Codex review of this task, all three real and all fixed:**

| Defect | Consequence | Fix |
|---|---|---|
| **A non-finite token count was recorded rather than refused.** The LLM adapters cast provider JSON onto `TokenUsage` with no runtime validation, so a malformed frame (JSON `1e400`) arrives as `Infinity`, and a wrong-shaped one as `NaN`. `Math.max` preserves both | `estimatedUsd` goes non-finite. The `CH-204` schema rejects it, so the panel silently freezes, and `JSON.stringify` writes it into the session file as `null`, which then fails `sessionSchema` on read: **the whole interview disappears from history**. One bad provider frame, the user's transcript gone. Exactly the failure ADR-032 exists to prevent | Refused at the boundary in `noteGeneration` and `noteAudio`, and the refusal sets `estimateIncomplete` so it is visible rather than silent. An integration test drives a real session through a non-finite frame and asserts the saved file is still readable |
| **`stop` froze the meter without a last threshold check.** An interval callback can be delayed | A session ended just past its time threshold crossed it with no tick left to notice, so the crossing reached neither `CH-205` nor the `warningsIssued` the transcript keeps | `check()` runs once more while the meter is still running, before `stoppedAtMs` is set |
| **Reported: `setThresholds` warns when the user lowers a threshold below current spend.** Codex read this as level-triggered on configuration changes rather than upward-edge-triggered | Kept, deliberately, and now documented and pinned by a test. `FR-109`'s upward edge is the **estimate's**. Under the other reading, a user who sets a limit they have already passed is told nothing about cost for the rest of the session: a limit that is silently dead the moment it is set is the worse failure, and this still warns exactly once and never re-arms | Comment in `setThresholds` and a test asserting both the warning and the "exactly once" that follows it |

**Follow-up work carried out of TASK-041:**

| Item | Why it is not done here | Owner |
|---|---|---|
| Nothing calls `noteAudio` or `noteGeneration` yet: the meter is wired to the session lifecycle but not to a live loop, so a real session accounts zero | The feed is audio capture, the STT sessions and the generation loop, which is the live-loop work TASK-040 carried and which is now a task of its own (ADR-034) | TASK-044 |
| `TC-071`'s "`session:start` still succeeds during the model download" half, carried from Milestone 2 and then from TASK-040 | Still the same reason: the assertion belongs with a live-session harness, and there is still no audio behind `session:start` | TASK-044 |
| The Dashboard's Cost and Usage panel: the live timer, the spend estimate, the price table version beside it and the `estimateIncomplete` label | No renderer exists. `CH-204`, `CH-205` and `estimateIncomplete` are the API it consumes | TASK-042 |
| Usage accounted after `cost.stop()` and before the next `start()` is kept in the maps rather than refused | Harmless: `start()` clears every accumulator, and the only caller that could do it is an in-flight generation the trigger has already aborted. Refusing it would silently lose a late report instead | TASK-050 |
| `estimate()` is recomputed up to three times per tick | O(models consumed), which is at most four, once a second. Measurably free, and caching it adds an invalidation rule to get wrong | TASK-050 |

### TASK-044 Live session loop — COMPLETE
**Traces** FR-008, FR-046, FR-047, FR-050, FR-051, FR-052, FR-053, FR-054, FR-055, FR-072, FR-075, FR-076, FR-100, FR-101, FR-102, FR-103, FR-105, FR-106
**Depends on** TASK-013, TASK-030, TASK-032, TASK-040, TASK-041
**Blocks** TASK-042

Split out of `TASK-042` by `ADR-034`. Every part this task joins already exists
and is unit-tested; what does not exist is the thing that joins them, so a real
`session:start` today opens no socket, feeds the trigger nothing, and accounts
zero spend.

**Acceptance criteria**
- `session:start` starts audio capture and opens exactly one `SttSession` per
  stream, both on the credential health is currently serving (`FR-047`,
  `FR-100`).
- Every transcript event is pushed on `CH-206 transcript:live` and handed to the
  trigger. Every final reaches `SessionManager.appendTurn`, interviewer and
  candidate alike (`FR-101`, `FR-105`).
- `onFire` answers with `RagEngine.query(profileId, question, 3)` and then
  `runGeneration`, pushing `CH-207`, `CH-208` and `CH-209` through the overlay
  readiness gate rather than straight at the window (`FR-008`, `FR-072`).
- Each generation's outcome reaches `appendSuggestion`, carrying the bullets
  actually sent and the status the generation ended with.
- Each generation's usage reaches `cost.noteGeneration(generationId, choice,
  usage)`, keyed by the choice that answered rather than the configured one.
- Audio seconds **actually sent to a provider** reach `cost.noteAudio`. A stream
  whose session is not open bills nothing while the session timer runs on.
- A new turn during `GENERATING` aborts the in-flight generation before the
  replacement starts, and the cancelled entry, carrying the bullets already
  flushed, is appended **before** the replacement's entry (`FR-106`, TC-134).
- `session:stop` tears the loop down in an order that cannot append to a closed
  handle: the trigger stops, the in-flight generation is awaited, the STT
  sessions close, then capture stops, and only then does the Session Manager
  compact (`FR-046`, `FR-107`).
- No provider failure reaches the overlay. An STT open failure, an LLM failure
  and a retrieval failure are each logged and reported through the Dashboard
  badge, and the overlay keeps its idle card (`FR-076`, `FR-102`).
- The trigger's `supportsEndpointing` and `batchIntervalMs` are read from the
  model that is **actually serving the session**, not from the configured
  primary, and are rebound when the session starts.

**Verified by** TC-071, TC-080, TC-086, TC-087, TC-088, TC-164

**Inherited follow-ups this task closes**

- `triggerConfigFrom` reading `supportsEndpointing` off the STT primary even
  when health has failed over to the backup, carried out of TASK-030.
- `TC-071`'s "`session:start` still succeeds during the model download" half,
  carried out of Milestone 2, then TASK-040, then TASK-041.
- Nothing calling `noteAudio` or `noteGeneration`, carried out of TASK-041.
- Routing live STT and LLM requests through `CMP-12`'s `runFor`, deferred by
  TASK-014 to "the session manager".

**Completed 2026-09-16.** `src/main/live.ts` is `CMP-15`: one class, every
collaborator injected, no Electron import and no filesystem import. It starts
capture, opens one `SttSession` per stream under the health machine, pushes
`CH-206`, appends every final, answers `onFire` with `RagEngine.query` and
`runGeneration` through the overlay gate, appends each outcome, feeds the Cost
Meter from both audio and generations, and tears the whole thing down in an
order that cannot append to a closed handle. `src/main/index.ts` constructs it
and starts and stops it from `CH-112` and `CH-113`; it holds nothing else about
a session.

Covered by `tests/integration/live-session.test.ts` (13 cases, every component
below the loop real and only the audio worker, the STT transport and the LLM
transport faked), `tests/unit/live-loop.test.ts` (20 failure-path cases) and
seven wiring guardrails in `tests/unit/guardrails.test.ts`. `npm run typecheck`,
`npm run lint`, `npm run format:check`, `npm run licenses`, `npm run build`,
`npm run smoke:main`, `npm run trace` and 786 unit and integration tests all
pass. Line coverage on `live.ts` is 98.6 percent.

**Design decisions taken here, with the alternatives rejected:**

| Decision | Alternative rejected | Why |
|---|---|---|
| The loop is its own component, `CMP-15` | Putting it in `CMP-01` | `CMP-01`'s own row in the component table forbids business logic, and the loop has state of its own: the open streams, the serving model and the generation in flight. Recorded as ADR-035 |
| A **failed retrieval abandons the turn** | Generating from no notes | A card built without the knowledge base renders identically to one built with it, and the user cannot tell them apart mid-interview. That is the plausible value ADR-032 forbids. An unanswered turn looks like silence, and `FR-102` says silence is not an error |
| The STT and LLM targets are resolved **outside** `runFor` | Resolving inside, where the target is known | A model that is not in the registry, a missing key and a missing adapter are configuration faults. Through `CMP-12` each arrives as a non-retryable `client` error and takes a perfectly good credential to `CONFIG_REQUIRED` (ADR-024). That is the failure `requireLlmProvider` already guards against inside the LLM facade |
| A provider failure is **rethrown inside** `runFor`, and the salvaged outcome is kept outside it | Letting `runGeneration`'s returned outcome stand | `runGeneration` returns a provider failure rather than throwing it, because the overlay has no error state (`FR-076`). Without the rethrow a dead key would never fail over; without keeping the outcome, `FR-076`'s salvage would be discarded on the way past |
| Both streams open under **one** `runFor` | One call per stream | Two streams on two models would give the trigger two answers about native endpointing and the Cost Meter two rates for one session. A partially opened pair is closed rather than kept, because one stream transcribing and one silently not reads as a provider that cannot hear the candidate |
| `noteAudio` is called where a chunk is **handed to a provider** | Counting the session timer, or counting at capture | Seconds are what the provider bills. A stream whose socket never opened bills nothing while the timer runs on, which is the honest number |
| Seconds come from `byteLength / (sampleRate * 2)`, with the rate read off the model's registry entry | A `1000 ms per chunk` constant | A short final chunk costs what it is, and a model shipped at another sample rate needs no edit in this file (ADR-022). A rate of zero contributes zero rather than `Infinity`, which would reach the transcript as `null` and fail the session schema |
| Only the **interviewer** session gets an `endpoint` listener | Wiring both, as the transcript listener is wired | A candidate endpoint reaches `handleEndpoint`, which evaluates the **interviewer's** pending turn and fires it early. That is a candidate event causing a suggestion, which is exactly what `FR-055` forbids. Found by writing the test, pinned by it |
| The replacement of a cancelled generation **awaits its predecessor's promise** | Relying on the append chain's own ordering | The chain orders two appends that have both been issued. It says nothing about which is issued first, and a cancelled generation's unwind can outlive its replacement's whole stream. Awaiting is what makes `FR-106` a mechanism (TC-134) |
| `cost.start()` runs **before** capture, not after it as section 5.1 lists | Following the sequence as written | `start()` clears every accumulator, so audio handed over before the meter runs is discarded rather than counted. The correction is recorded in section 5.1 |
| The session state is pushed **before** the loop comes up | Pushing once everything is live | Capture and two sockets take long enough that a Dashboard told afterwards renders the session as inactive for the whole of it, while the session is already live and already writing (`FR-088`) |

**Defects found in the local two-pass review and fixed before pushing:**

| Defect | Consequence | Fix |
|---|---|---|
| **A closed STT session that emits was still routed.** Handlers are registered on the provider session and are not detached by `close()` | A late final pushed `CH-206` to a Dashboard whose session had ended, and offered an append to a writer that had already compacted and closed. Teardown order was resting on the writer refusing rather than on the loop not asking | An event whose stream is no longer open is ignored. Pinned by a test that asserts the late event changes nothing: no push, no error and no transcript entry |
| **A turn could become an unhandled rejection.** Nothing awaits the stored generation promise between one turn and the next | `NFR-009` would log it only after it had escaped, and the next turn would then await a rejected chain | The `catch` is attached to the stored promise, so the chain a later turn awaits can never reject. Pinned by a test that makes the machine throw and then answers another turn |
| **`CH-201` was pushed after the loop came up** | The Dashboard rendered the session as inactive for as long as capture and both sockets took to start | Pushed as soon as the manager accepts, and pinned by a wiring guardrail |

**Follow-up work carried out of TASK-044:**

| Item | Why it is not done here | Owner |
|---|---|---|
| `FR-044`'s "must not start a session in a state where the interviewer would not be heard", and section 10's "loopback device missing, session start refused" | Capture starts **inside** `session:start`, after `CMP-08` has created the transcript and taken the lock, so the verdict is not available when the refusal would have to be made. A fifth named refusal on `CH-112` is a contract change with no acceptance criterion in this task, and rolling back a created session to refuse it is the transcript-deleting path ADR-032 exists to prevent. `AudioSupervisor.canStartSession` is the verdict it will read. Today a dead interviewer stream shows on the `CH-203` badge and the session runs | TASK-050 |
| `noteCleanBoundary` at real turn boundaries, so a recovered primary is switched back to | Honoring it for STT means closing both sockets and reopening them on the new target at a boundary with no audio in flight. Calling it without that reopen would leave the machine reporting `using-primary` while the sockets are on the backup, which is the plausible-but-wrong state ADR-032 names. The LLM half needs no reopen and comes free with it | TASK-050 |
| An STT socket that dies mid-session is logged, and not reopened | `FR-100`'s retry and failover cover a **request**. A streaming socket that closes after it opened is a different lifecycle, and `MAX_STREAM_RESTARTS` covers the audio stream beneath it rather than the transcription above it | TASK-050 |
| A prompt-assembly failure inside an adapter is classified as a provider failure | `buildMessages` runs inside `provider.generate`, so a malformed retrieved chunk surfaces as a generation error and spends the whole retry ladder against a healthy credential. Pre-existing in `runGeneration`; the loop only made it reachable | TASK-050 |
| A batch STT model's final buffer is billed although it is never posted | Seconds are counted when a chunk is handed to the adapter, which is the boundary that means "sent". A batch adapter holding up to its window at session end over-counts by at most that window, once per session | TASK-050 |
| Profile switching is not disabled in the Dashboard during a live session | The loop binds `profileId` at start and answers every turn from it, so the transcript and the retrieval are both safe. The control that must be disabled is a renderer that does not exist | TASK-042 |

### TASK-042 Dashboard UI
**Traces** FR-023, FR-024, FR-025, FR-026, FR-027, FR-028, FR-029, FR-030, FR-031, FR-032, FR-038, FR-080, FR-087, FR-088, FR-110, NFR-010, NFR-014
**Depends on** TASK-003, TASK-004, TASK-014, TASK-025, TASK-041, TASK-044
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
