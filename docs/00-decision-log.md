# Interview CoPilot — Decision Log and Assumption Register

Status: Baseline for implementation. Version 1.0. Date 2026-09-15.

This document is the single source of truth for contested decisions. If another
document disagrees with this one, this one wins and the other document is a defect.

---

## 1. How to read the identifiers

| Prefix | Meaning | Defined in |
|---|---|---|
| `FR-nnn` | Functional requirement | `01-requirements.md` |
| `NFR-nnn` | Non-functional requirement | `01-requirements.md` |
| `ADR-nnn` | Architecture decision record | this document |
| `ASM-nnn` | Assumption, not yet confirmed by the product owner | this document |
| `CMP-nn` | Component | `02-architecture.md` |
| `CH-nnn` | IPC channel | `02-architecture.md` |
| `TASK-nnn` | Implementation task | `03-tasks.md` |
| `TC-nnn` | Test case | `04-test-strategy.md` |

Every `FR` traces to at least one `TASK` and at least one `TC`. The matrix is in
`05-traceability.md`.

---

## 2. Resolved contradictions

The source brief contained three conflicts. The product owner resolved all three
on 2026-09-15. The resolutions below are binding.

### ADR-001 — The overlay IS excluded from screen capture

**Conflict.** Brief section 0 required capture exclusion. Brief sections 8 and 11
forbade it.

**Decision.** The overlay window is excluded from screen share and screen
recording. The main process calls `overlayWindow.setContentProtection(true)`
before the window is shown, and never calls it with `false`.

**Reason.** The candidate may share a presentation or a business case during the
interview. An overlay that appears in the shared surface covers that content and
breaks the presentation. Consent is handled by the reminder step (ADR-002), not
by making the overlay visible to the capture pipeline.

**Consequences.**
- Brief section 8 bullet "Do not exclude it from screen capture" is deleted.
- Brief section 11 non-goal "No screen-capture or recording exclusion" is deleted.
- `setContentProtection` is a Windows and macOS API. On Windows 10 version 2004
  and later it maps to `WDA_EXCLUDEFROMCAPTURE`, which makes the window invisible
  to capture while still visible on the physical display. On older Windows 10
  builds it maps to `WDA_MONITOR`, which renders the window as a black rectangle
  in the capture. See `NFR-012` for the minimum supported build.
- Content protection is not a security control. It does not defeat a physical
  camera pointed at the screen. It is a presentation-integrity control.

### ADR-002 — Consent reminder is mandatory and non-skippable in flow

**Decision.** Every live session shows the consent reminder before the first
suggestion renders. The reminder is dismissible and non-blocking, meaning it does
not modally block the desktop, but the session cannot start without it being
displayed. It is not logged and not verified. There is no setting that turns it
off. This preserves the brief section 11 non-goal.

### ADR-003 — Session transcript is ON by default

**Conflict.** Brief section 0 implied opt-in persistence. Brief sections 8 and 10
specified default persistence.

**Decision.** Every live session writes a text transcript to Session History
automatically. The user deletes it from the Dashboard. There is no per-session
opt-out in v1.

**Reason.** Consistency with the consent reminder default copy, which already
states plainly that a local text transcript is kept for the session.

**Consequences.**
- Brief section 0 wording "only because the user chose to keep them" is corrected
  to "the user controls retention and can delete any transcript at any time".
- Audio is still never written to disk. That guardrail is unchanged (`NFR-002`).

### ADR-004 — Verification includes automated Electron end-to-end tests

**Decision.** Three test tiers. Vitest unit tests, Vitest integration tests with
faked providers, and Playwright Electron end-to-end tests on a Windows runner.
Audio device capture is not automated. It is covered by the manual Windows
release checklist.

**Reason.** The overlay, IPC and hotkey behavior carry most of the product risk
and are cheap to drive through Playwright's Electron support. Synthetic audio
injection through a virtual audio device was rejected as too costly for v1.

---

## 3. Architecture decisions

### ADR-005 — Audio capture runs in a hidden renderer, not in the main process

**Context.** The brief placed capture in `/src/main/audio.ts`. Neither WASAPI
loopback via `electron-audio-loopback` nor microphone access via `getUserMedia`
is available in the Electron main process. Both require a renderer with a
Chromium media stack.

**Decision.** A hidden `BrowserWindow` named the Audio Worker owns both
`MediaStream` objects and both `AudioWorklet` graphs. It posts PCM chunks to the
main process over IPC. `src/main/audio.ts` keeps the name from the brief and
becomes the main-process supervisor. It creates the worker, starts and stops
streams, tracks stream health, and re-emits tagged chunks to the STT layer.

**Consequences.** `CMP-03` splits into `CMP-03a` (main supervisor) and `CMP-03b`
(hidden renderer worker). The Audio Worker is never shown, has `show: false`,
`skipTaskbar: true`, and is excluded from capture as a precaution.

**Named fallback, decided now rather than mid-build.** `electron-audio-loopback`
is the highest-risk dependency in the project and the whole product depends on
it. If the `TASK-010` spike fails, the replacement is fixed in advance so the
schedule does not fork:

1. **First fallback.** `navigator.mediaDevices.getUserMedia` with
   `audio: { mandatory: { chromeMediaSource: 'desktop' } }`, driven by a
   `desktopCapturer` source id obtained in main and passed to the Audio Worker,
   with `session.setDisplayMediaRequestHandler(..., { audio: 'loopback' })`.
   This is the same Chromium loopback path the package wraps, without the
   package.
2. **Second fallback.** Ask the user to install a virtual audio cable and select
   it as the interviewer input device. This degrades setup, not function.

Both fallbacks sit behind the same one-function seam,
`getLoopbackStream(): Promise<MediaStream>` in
`src/renderer/audio-worker/loopback.ts`. No other file changes. `TASK-010`
selects among the three and records which one, and no further ADR is needed.

### ADR-006 — Resample by forcing the AudioContext sample rate

**Decision.** Each stream gets its own `AudioContext({ sampleRate: 16000 })`.
Chromium resamples the device stream into that context. The `AudioWorklet`
receives Float32 frames already at 16 kHz, converts to signed 16-bit
little-endian PCM, and accumulates until the chunk duration threshold is met.

**Rejected alternative.** Manual decimation from 48 kHz in JavaScript. It needs a
low-pass filter to avoid aliasing and adds a defect surface for no benefit.

### ADR-007 — Chunk duration is 1000 ms, not a range

**Context.** The brief said "1 to 2 seconds". A range is not implementable
without a choice.

**Decision.** 1000 ms fixed for v1, exposed as a constant, not a user setting.
Rationale: the 700 to 900 ms turn-detection gap in `FR-050` cannot be observed
reliably when chunks are 2000 ms long.

### ADR-008 — Deepgram is the default STT primary, streaming is required

**SUPERSEDED by ADR-022 on 2026-09-15.** The reasoning below still holds for
Whisper REST. The conclusion that the choice is Deepgram or Whisper does not.

**Context.** OpenAI Whisper REST is not a streaming transcriber. Feeding it 1
second chunks produces poor accuracy because each request loses cross-chunk
context, and it cannot emit interim results.

**Decision.** Deepgram is the default and recommended STT primary. Whisper REST
is supported as a backup and as a primary for users without a Deepgram key, with
a documented accuracy and latency penalty. When Whisper is active, the adapter
buffers 4 seconds of audio per request and emits `isFinal: true` only. It never
emits interim results, and turn detection falls back to the silence-gap timer
because no provider endpointing signal is available.

**Consequence.** `FR-042` records the Whisper degraded mode explicitly. The
Dashboard shows an informational badge when Whisper is the active STT provider.

### ADR-009 — Failover is sticky for the session, with a health re-probe

**Decision.** On provider failure the adapter retries the same provider 3 times
with exponential backoff (250 ms, 500 ms, 1000 ms, each with up to 20 percent
jitter). If all attempts fail and a backup is configured, it switches to the
backup and stays on the backup for the rest of the session. A background health
probe runs against the primary every 60 seconds. If two consecutive probes pass,
the adapter switches back to the primary at the next clean boundary, meaning the
next turn for LLM and the next reconnect for STT.

**Reason.** Flapping between providers mid-interview produces inconsistent
suggestion style and wastes money. Sticky failover with a slow recovery path is
predictable.

### ADR-010 — Authentication errors do not trigger blind retry

**Decision.** An error classified as `auth` (HTTP 401 or 403) skips the retry
loop and fails over immediately if a backup exists. Retrying a rejected key
cannot succeed and burns latency.

### ADR-011 — Local model download is blocking for RAG only

**Decision.** The first run downloads `Xenova/all-MiniLM-L6-v2` (about 90 MB).
Document ingestion is blocked until it completes and shows a determinate
progress indicator. A live session may still start without the model. Retrieval
returns an empty chunk set, and the LLM prompt is built from the question and
candidate context alone.

### ADR-012 — Embedding cache key includes the model identifier

**Decision.** The cache key is `sha256(fileBytes) + ":" + chunkerVersion + ":" +
embeddingModelId`. A change to the chunking algorithm or the embedding model
invalidates the cache without a manual purge.

### ADR-013 — One session at a time

**Decision.** At most one live session exists at any moment. Starting a session
while one is active is rejected. The session is bound to exactly one company
profile, captured at session start. Switching the active profile during a live
session is disabled in the Dashboard.

### ADR-014 — The knowledge base folder is authoritative, and RAG state is reconciled at startup

**Context.** `profile.json` embeds `documents: DocumentRecord[]`, while the
watcher operates on the `kb/` folder. The two can disagree: a user drops a file
into `kb/` through Explorer, or the app is killed while a document is in
`converting` or `embedding`. Neither case had an owner.

**Decision.**
- The `kb/` folder is the source of truth for which documents exist.
  `profile.json` is a derived index, rebuilt from the folder when they disagree.
- A file that appears in `kb/` without going through `doc:import` is adopted:
  the watcher creates a `DocumentRecord` for it, auto-tags it and embeds it. It
  appears in the Dashboard like any imported document. There are no orphan files.
- A `DocumentRecord` whose entry disappears from `kb/` is removed, along with its
  chunks and vectors.
- On startup a reconciliation pass runs before the watcher starts. Any document
  found in a non-terminal state (`pending`, `converting`, `embedding`) is reset
  to `pending` and re-processed. A document cannot be stuck forever.
- `chunks.json` and `vectors.bin` are written as a pair through a write-to-temp
  then rename sequence. A mismatch between `chunkCount` and the vector row count
  at load time discards both and re-embeds.

**Reason.** Sessions already had a crash-recovery story. Documents did not, and a
candidate restarting after a crash needs their notes to work immediately.

### ADR-015 — Acrylic is Electron's native `backgroundMaterial`, and switching modes recreates the overlay

**Context.** `overlayTranslucency: 'acrylic' | 'opacity'` was a user-facing
setting with no named implementation anywhere. "A native Windows blur module" is
a hedge, not a decision.

**Decision.** Acrylic uses Electron's built-in
`BrowserWindow({ backgroundMaterial: 'acrylic' })`. No third-party native module
is added.

**Consequences, and they are not small.**
- `backgroundMaterial` and `transparent: true` are mutually exclusive in
  Electron. The acrylic overlay is built with `transparent: false` and the
  flat-opacity overlay with `transparent: true`. The two modes are therefore two
  different window constructions.
- Changing the translucency mode destroys and recreates the overlay window,
  preserving position, monitor, click-through state and the current card stack.
  Changing the opacity level alone applies live with no recreation. `FR-085`
  ("applies without a restart") means without restarting the application. It does
  not promise without recreating the window.
- `backgroundMaterial: 'acrylic'` needs Windows 11. On Windows 10 the setting is
  disabled in the Dashboard with an explanatory note, and the overlay uses flat
  opacity.
- CSS `backdrop-filter` is explicitly rejected as a substitute. It is not the
  same effect and it behaves differently on a transparent, content-protected
  window.

### ADR-016 — Suggestions are gated on overlay readiness

**Context.** `session:start` brings up the overlay, the audio pipeline and the
STT connections in parallel. If the interviewer speaks immediately and the
overlay renderer has not finished its first paint, a suggestion could be
generated with nowhere to go, and the consent reminder could lose the race it is
required to win.

**Decision.** The overlay renderer sends `overlay:ready` once it has mounted and
rendered the consent reminder. Until the main process has received it,
`suggestion:begin`, `suggestion:line` and `suggestion:end` are buffered in the
main process, not dropped. The buffer holds one generation. If a second
generation starts while still buffered, the first is discarded, matching the
cancel-and-restart rule in `FR-054`.

**Reason.** "The consent reminder was shown" must be a fact the main process can
assert, not a DOM ordering that happens to hold. Buffering makes it structural.

### ADR-017 — Health state is keyed by credential, not by capability

**Context.** One OpenAI key serves both Whisper STT and GPT LLM. Two independent
health state machines watching the same credential would probe it twice, fail
over at different moments and recover at different moments.

**Decision.** `CMP-12` keys its state by credential (`deepgram`, `openai`,
`anthropic`), not by capability (`stt`, `llm`). An `auth` failure on the OpenAI
key marks that credential unhealthy for every capability using it, immediately
and once. There is one probe timer per credential.

**Consequence for the Dashboard.** The status badge is rendered per credential,
not per capability, and names which capabilities it affects. A revoked OpenAI key
produces one badge reading "OpenAI key rejected, affects STT backup and LLM
primary", not two unrelated badges the user has to correlate.

### ADR-018 — The Session Manager is the only writer of the session file

**Context.** Two problems found in review. First, `CMP-09` recomputes spend into
`Session.usage` while `CMP-08` appends transcript entries, and both appeared to
write the same file. Second, a cancelled generation and the next generation could
interleave, so the transcript order would not match what happened.

**Decision.**
- `CMP-08` is the only component that opens, writes or closes a session file.
  `CMP-09` holds usage in memory and hands it to `CMP-08`. `CMP-09` has no file
  handle.
- Every `TranscriptEntry` carries a monotonic `seq` assigned by `CMP-08` at
  append time. Order is the `seq` order, not the file order.
- A cancelled generation is appended as a `status: 'cancelled'` entry carrying
  the bullets already flushed, and that append happens before the entry for the
  replacing generation is appended. `CMP-07` awaits the cancel append before it
  starts the new stream. The cancel path is therefore serialized by construction,
  not by timing.
- Each entry is written as one `write()` of one complete line ending in `\n`.
  A crash can lose a line, it cannot tear one.
- Compaction tolerates a torn final line: an unparseable last line is discarded
  and the rest is recovered. A crash between compaction and the `.ndjson` delete
  leaves both files. The `.json` wins and the `.ndjson` is deleted.

### ADR-019 — The audio-on-disk guarantee is scoped to code this project controls

**Context.** `NFR-002` claimed "no code path may write audio bytes to disk", but
the verification was an ESLint import ban over two files. PCM leaves those files
and enters `@deepgram/sdk` and `openai`, and the Whisper adapter builds a
multipart body that an HTTP client could spool to a temp file.

**Decision.** The guarantee is stated honestly and verified dynamically.
- This project's own code never writes audio bytes to disk. Enforced by the lint
  ban, and by an integration test that monitors every `fs` write during a
  synthetic session and asserts no write contains PCM.
- Third-party spooling is handled rather than assumed away. The Whisper adapter
  builds the request body in memory and sets an explicit in-memory body, never a
  file stream or a path. The test above runs with Whisper active, so a spool to
  a temp file would be caught.
- The app sets `TMPDIR` and `TEMP` for its own child processes to a directory it
  owns and asserts it is empty at session end.

**Reason.** A guarantee this central must be provable, not asserted. Saying "our
code" and proving it beats saying "no code path" and proving less.

### ADR-020 — Whisper-primary has its own, worse, latency budget

**SUPERSEDED by ADR-022 on 2026-09-15.** The budget survives, generalized from
"Whisper" to "any non-streaming STT model".

**Context.** `NFR-001` is measured with Deepgram. Whisper-primary is a supported
configuration that buffers 4 seconds per request and has no interim results, so
`NFR-001` cannot apply to it. A supported configuration with no stated latency
target is a configuration nobody can fail a release on.

**Decision.** `NFR-017` sets the Whisper-primary budget at p50 under 7.0 s and
p95 under 10.0 s. The Dashboard degraded-mode badge states the latency cost in
plain words, not only the accuracy cost.

### ADR-021 — Loopback captures all system audio, and that is a documented limitation

**Context.** WASAPI loopback captures everything the machine plays, not only the
interviewer. Music, notifications and a second call all land on the
`interviewer` stream and are transcribed as if the interviewer said them.

**Decision.** This is inherent to loopback and is not engineered around in v1.
- The app does not attempt per-application audio capture.
- The consent reminder step also shows a one-line session-prep note advising the
  user to close other audio sources.
- The `interviewer` label in Session History reads "system audio", so a
  transcript never claims a notification chime was the interviewer.
- Per-process loopback capture (`ActivateAudioInterfaceAsync` with a process
  loopback mode) is recorded as the v2 fix. Do not build it into v1.

### ADR-022 — STT is a provider registry with per-model selection, not a two-way choice

**Supersedes** ADR-008 and ADR-020. Decided by the product owner on 2026-09-15.

**Context.** The brief offered Deepgram or Whisper REST. That framing is out of
date. OpenAI shipped `gpt-4o-transcribe` and `gpt-4o-mini-transcribe` with a
realtime transcription WebSocket in March 2025, and ElevenLabs ships Scribe v2
Realtime with roughly 150 ms latency over a WebSocket accepting `pcm_16000`,
which is exactly the format `FR-041` already produces. Hard-coding two providers
into a union type would need a code change in the config layer, the UI, the
health layer and the cost table every time a provider is added.

**Decision.** STT and LLM both become data-driven registries.

- A provider is a registry entry: id, display name, credential id, and a list of
  models. Each model declares `streaming`, `supportsInterim`,
  `supportsEndpointing`, its audio format needs and its price.
- The user picks a **provider and a model**, for primary and for optional backup,
  independently for STT and LLM.
- Adding a provider means one registry entry plus one adapter. The trigger, the
  session manager, the cost meter and the Dashboard need no change. This is
  testable: a fake provider added to the registry must appear in the UI and work
  end to end with no other edit.

**v1 STT registry.**

| Provider | Models shipped | Streaming | Interim | Endpointing |
|---|---|---|---|---|
| `deepgram` | `nova-3`, `nova-2` | yes | yes | yes, native |
| `openai` | `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` | yes, realtime WebSocket | yes | yes, server VAD |
| `elevenlabs` | `scribe-v2-realtime` | yes | yes, partial then committed | committed segments |
| `openai` | `whisper-1` | **no**, REST, 4 s buffering | no | no |

`deepgram` with `nova-3` stays the shipped default. `whisper-1` is kept as a
clearly labeled non-streaming option, no longer OpenAI's default and no longer
the only OpenAI choice.

**Consequences.**
- `SttProviderId` is no longer a closed union of two. It is a registry key.
- ElevenLabs is a third credential in the vault.
- The latency budget is a property of the selected model, not of a provider
  name. A streaming model is held to `NFR-001`. A non-streaming model is held to
  `NFR-017`, and the Dashboard says so before the user picks it.
- The v1 LLM registry adds no new providers. It gets the same shape so that
  adding one later costs a registry entry, not a refactor.

**Sources checked 2026-09-15:** OpenAI realtime transcription models and
WebSocket transcription sessions, ElevenLabs Scribe v2 Realtime WebSocket with
`pcm_16000` input.

### ADR-023 — Chunk cap is 256 tokens, the model's real input limit

**Supersedes the 500-token figure in ASM-001.**

**Context.** `all-MiniLM-L6-v2` has a maximum sequence length of 256 word pieces
and silently truncates anything longer. A 500-token chunk would embed its first
256 tokens only. The tail would be stored, displayed and retrievable by keyword
in the UI, but it would contribute nothing to the vector. A question matching
only the tail could never retrieve the chunk, and nothing would look broken.

**Decision.** The chunk cap is 256 tokens measured with the MiniLM tokenizer.
Multi-window embedding with mean pooling was considered and rejected for v1: it
doubles the embedding cost and blurs the vector, and 256 tokens is already a
reasonable retrieval granularity for resume and notes content.

**Consequence.** A test asserts no chunk exceeds the model's
`max_seq_length`, read from the model config rather than hard-coded, so a model
swap cannot silently reintroduce truncation.

### ADR-024 — A non-retryable error with no backup is terminal, not a retry loop

**Context.** The `DEGRADED` state retried the primary forever with backoff capped
at 10 s, for every error class. `ProviderError.retryable` is false for `auth` and
`client`, and ADR-010 already says a rejected key must not be retried blindly. A
user with a revoked key and no backup would have fired a doomed request every ten
seconds for the whole interview.

**Decision.** Split the no-backup path.
- A **retryable** failure (`network`, `timeout`, `server`, `rate-limit`) enters
  `DEGRADED` and retries with backoff capped at 10 s, as before.
- A **non-retryable** failure (`auth`, `client`) enters `CONFIG_REQUIRED`, a
  terminal state for that credential for the rest of the session. No further
  requests are sent. The Dashboard badge says the credential was rejected and
  what to do about it.
- `CONFIG_REQUIRED` clears when the user saves a new key for that credential,
  which already runs live validation (`FR-026`).
- The overlay is still never touched. `FR-076` is unchanged.

### ADR-025 — Cue-form output is enforced, not merely requested

**Context.** `FR-004` requires 3 to 5 short bullets and forbids a scripted
paragraph, but the only mechanism was a line-buffer rule that split a run-on
response into arbitrary 240-character fragments. A provider that ignored the
prompt would have had its prose rendered into the overlay as if it were cues.
The prohibition was a request to the model, not a property of the system.

**Decision.** Structure is enforced at the line buffer.
- The forced flush wraps at the last word boundary before 240 characters, never
  mid-word.
- A card renders at most 5 lines. Lines beyond the fifth are dropped, not shown.
- A line longer than 120 characters after wrapping is treated as prose, not a
  cue, and is truncated at the last word boundary before 120 characters with a
  trailing ellipsis.
- A generation that produced no newline at all is recorded in the transcript with
  `status: 'nonconforming'` for diagnostics. The overlay still shows what was
  salvaged, because `FR-076` forbids an error card and a degraded cue beats a
  blank card mid-interview.

### ADR-026 — The offline guarantee is scoped to an installation that has its model

**Context.** `NFR-008` promised that with no network the app could still import
documents and compute embeddings. `ADR-011` blocks ingestion until a roughly
90 MB model download completes. On a fresh install with no network, both cannot
be true, and `TC-132` could only have passed by quietly pre-seeding the cache.

**Decision.** The offline guarantee applies to an installation whose embedding
model is already cached. Stated in `NFR-008` rather than implied by a test
fixture. A fresh install with no network starts, manages profiles and shows an
explicit "embedding model not downloaded" state on the document manager with a
retry action. It does not hang and it does not look broken. `TC-132` runs the
cached case and `TC-161` runs the fresh-install case.

**Rejected.** Packaging the model in the installer. It would add about 90 MB to
every download to serve the first run of an offline machine.

### ADR-027 — Accept the PCM copy, and bound retention instead

**Resolves OQ-003.** Decided 2026-09-15 at the start of Milestone 1.

**The constraint.** Electron cannot transfer an `ArrayBuffer` across IPC. Both
`ipcRenderer.postMessage` and `MessagePortMain.postMessage` accept only
`MessagePort` values in a transfer list, so every buffer is structured-cloned.
The mechanism exists in JavaScript (a real transfer does neuter the sender, and
`structuredClone(buf, { transfer: [buf] })` proves it) but Electron does not
expose it for buffers. `SharedArrayBuffer` does not help either, because the main
process and the worker are separate OS processes.

**The measurements.** One second of 16 kHz, 16-bit mono PCM is 32,000 bytes.

| Quantity | Value |
|---|---|
| Chunk | 31.3 KiB per stream per second |
| Both streams | 62.5 KiB per second |
| Structured clone cost | 0.082 ms per chunk |
| Share of the 1000 ms chunk budget | 0.008 percent |
| Accumulated over a 60-minute session **if nothing is released** | 220 MiB |

**The decision.** Take candidate 1 from OQ-003: accept the copy.

The extra copy costs 31 KiB and 0.08 ms. Candidate 2, keeping PCM in the worker
and streaming to the provider from there, would trade that for putting network
access inside a renderer, which contradicts `CMP-14`'s rule and weakens the
security boundary to save nothing that matters: the bytes live in memory either
way, just in a different process. Candidate 3 avoids a process hop, not a copy.
Paying a real security cost to avoid an imaginary privacy cost is the wrong
trade.

**The correction that matters.** The last row of that table is the real finding.
The number of copies is not what threatens `FR-043` and `NFR-002`. **Retention
is.** A pipeline that copies a chunk four times and releases all four is safe; a
pipeline that copies once and holds the reference in a growing array leaks a
quarter of a gigabyte of interview audio into memory over one session, which is
exactly the kind of thing a "no audio on disk" guarantee is meant to prevent
being casual about.

So the invariant is not "do not copy". It is:

> Every PCM reference is released once its chunk has been handed on, and any
> deliberate buffering is bounded by a declared constant.

Deliberate buffering exists and is legitimate: the non-streaming Whisper adapter
buffers 4000 ms, which is 4 chunks, by design (ADR-022). That is bounded and
declared. An unbounded accumulation is not.

**Consequences.**
- `TC-041` is rewritten from "the worker-side `byteLength` is 0 after send",
  which is unachievable, to a retention assertion: after a chunk is handed on,
  neither the worker nor the supervisor holds a reference, and across a long run
  the count of live chunks never exceeds the declared bound.
- `FR-043` gains the bounded-retention wording explicitly, so the requirement
  states the property that is actually enforceable.
- `NFR-002` is unchanged. Nothing here writes to disk, and the lint ban plus the
  runtime filesystem-write monitor (`TC-137`) remain what prove it.
- The audio path must expose its live-chunk count so the assertion can be made
  from outside, rather than inferred.

**What that count does and does not prove.** Corrected after code review on
PR #4. `chunksInFlight` measures concurrency: how many chunks have been handed
to the consumer and not yet finished with. It cannot detect a consumer that
returns promptly and keeps the buffer, which is the retention this ADR is about.
Retention is proved by the direct-reference assertions in `TC-041` and by
`TC-137`'s runtime filesystem-write monitor. The count is still worth asserting,
as a bound on how much audio can be outstanding at once, but it is not the
retention proof and this document no longer implies it is.

An async consumer is not finished when it returns its promise. The count is
released when the promise settles, or the bound would read as one while several
requests were genuinely outstanding.

### ADR-028 — Acquire loopback with the platform API, not a third-party package

**TASK-010 spike result. Confirmed on Windows 2026-09-15; the gate is closed.**

**What the spike asked.** `electron-audio-loopback` was the project's
highest-risk dependency: one maintainer, 19.5 kB, last published a year ago, and
the entire product depends on interviewer capture. `TASK-010` exists to prove it
works before the audio pipeline is built on it.

**What reading it showed.** It is a wrapper of roughly sixty lines. Its main
half calls `session.setDisplayMediaRequestHandler` and answers with
`audio: 'loopback'`. Its renderer half calls `ipcRenderer.invoke` twice, purely
to switch that handler on and off around one `getDisplayMedia` call.

That renderer half cannot run in our audio worker. `FR-086` requires every
renderer to have `sandbox: true` and `contextIsolation: true`, and such a
renderer has no `ipcRenderer`. Using the package as published would mean
weakening the sandbox on the one window that handles raw audio.

**What the spike measured.** A hidden renderer with `sandbox: true`,
`contextIsolation: true` and `nodeIntegration: false`, calling only
`navigator.mediaDevices.getDisplayMedia`, with main owning the handler for the
session:

| Observation | Linux | Windows |
|---|---|---|
| Stream acquired in a sandboxed renderer | yes | yes |
| Audio track present | 1, `System audio`, `deviceId: loopback` | yes |
| `AudioContext({ sampleRate: 16000 })` | reported 16000 | reported 16000 |
| Non-silent samples within 3 s | yes | yes |
| Microphone processing defaults on | yes | yes |
| Verdict | works-with-audio | **works-with-audio** |

Windows is the target platform (`NFR-011`), so that column is the one that
closes the gate. The findings are published as step names and conclusions on the
`loopback-spike` job, because job logs and artifacts need authentication and a
spike whose answer cannot be read without signing in is not an answer.

**Decision.** Acquire loopback through the platform API directly. Main owns
`setDisplayMediaRequestHandler` for the life of a session and answers with
`audio: 'loopback'`; the audio worker calls `getDisplayMedia` and immediately
stops the video track. `electron-audio-loopback` is not used.

This removes the highest-risk dependency, keeps the audio worker fully
sandboxed, and leaves roughly ten lines of code we own in place of a wrapper we
cannot configure. ADR-005's "first fallback" turns out to be the same mechanism
the package implements, so nothing is being invented here.

**Two details the spike turned up that the design would otherwise have missed.**

1. `setDisplayMediaRequestHandler` needs `{ useSystemPicker: false }`, and its
   callback must be called on every path. Returning without calling it leaves
   `getDisplayMedia` pending forever, which would present as an audio pipeline
   that never starts and never errors.
2. The loopback track arrives with `autoGainControl`, `echoCancellation` and
   `noiseSuppression` all **true**. Those are microphone processing defaults and
   they are wrong for a loopback stream: they will pump levels and suppress
   parts of the interviewer's speech before it ever reaches the transcriber.
   `TASK-011` must request them off explicitly. This is a transcription-quality
   bug that would have been extremely hard to diagnose from bad suggestions.

**A third cost, found while removing it.** Declaring the package as a production
dependency pulled `electron` into the production dependency tree: it lists
`electron` as a peer dependency and npm auto-installs peers. electron-builder
treats `electron` outside `devDependencies` as an error, so this was a real cost
of the package independent of its maintenance risk.

It is now a test: `npm ls electron --omit=dev` must report an empty production
tree, verified by reinstalling the package and watching the test fail naming the
offender.

**Correction.** This was first written up as the cause of the Windows installer
failure. It was not. Removing the package did not fix that job, and the real
cause turned out to be unrelated (see the note under `package` in the CI
workflow: electron-builder was attempting an implicit GitHub Release publish).
The peer-dependency problem is genuine and worth guarding against, but it was
diagnosed from a plausible story rather than from the log, and the story was
wrong.

**Status.** Confirmed on Windows and closed. The package is removed, and the
spike's own harness never imported it, so its result stands on its own.

Had Windows contradicted the Linux result, the fallback was to reinstate the
package, accept a non-sandboxed audio worker, record the deviation from
`FR-086`, and rework the dependency so the production tree stayed clean. Three
costs avoided, which is the measure of what the direct path was worth.

---

## 3a. Open questions

OQ-001 and OQ-002 were put to the product owner on 2026-09-15 and answered.
OQ-003 was found while implementing Milestone 0 and is resolved by ADR-027.
No open questions remain.

### OQ-003 — Audio buffers cannot be transferred across Electron IPC — RESOLVED by ADR-027

Found while implementing Milestone 0 and answered at the start of Milestone 1.
The reasoning and the measurements are in `ADR-027`. In short: the copy is real,
it is also irrelevant, and the property worth testing is retention rather than
copy count.

### OQ-001 — Transcript encryption at rest — RESOLVED: plaintext, stated plainly

Session transcripts contain verbatim interview content: names, employers,
compensation talk, sometimes personal disclosures. They stay plaintext JSON under
`userData`, retained until the user deletes them.

**Decision.** No encryption at rest in v1, and no retention window. In exchange
the app must not be quiet about it. The Dashboard Session History section and the
default consent reminder text both state that transcripts are unencrypted local
files kept until deleted. This is `FR-110`.

**Reason.** Simplicity, and the data never leaves the machine. The user chose a
stated tradeoff over a hidden one.

### OQ-002 — Whisper as STT primary — RESOLVED: replaced by a provider registry

**Decision.** The question is obsolete. The user is not choosing between Deepgram
and Whisper. The user chooses a provider and a model from a registry that ships
with Deepgram, OpenAI and ElevenLabs. See `ADR-022`.

---

## 4. Assumption register

---

## 4. Assumption register

These were chosen without a direct product decision. Each is implemented as
specified but can be changed cheaply before build starts.

| ID | Assumption | Where it binds | Cost to change |
|---|---|---|---|
| ASM-001 | RAG chunk cap is **256** tokens, the MiniLM input limit, soft-split on paragraph breaks. Was 500, corrected in ADR-023 because the model truncates beyond 256 | `FR-062` | Low, one constant |
| ASM-002 | Default hotkeys are `Ctrl+Shift+I` (interaction toggle) and `Ctrl+Shift+P` (pause trigger) | `FR-084` | Low, defaults only |
| ASM-003 | Default LLM models are `claude-haiku-4-5-20251001` for Anthropic and `gpt-4o-mini` for OpenAI | `FR-071` | Low, config default |
| ASM-004 | A new turn cancels an in-flight generation | `FR-054` | Medium, changes trigger state machine |
| ASM-005 | Overlay uses `skipTaskbar: true` | `FR-081` | Low |
| ASM-006 | Doc-type-weighted retrieval is deferred to v2 | `FR-065` | Low for v1, it is an omission |
| ASM-007 | Turn-end silence gap defaults to 800 ms, user-adjustable 500 to 1500 ms | `FR-050` | Low |
| ASM-008 | A turn shorter than 3 words or 12 characters does not fire a suggestion | `FR-051` | Low |
| ASM-009 | Candidate context window is the last 2 candidate turns, capped at 400 characters | `FR-052` | Low |
| ASM-010 | Overlay holds 3 suggestion cards, oldest fades out on the 4th | `FR-091` | Low |
| ASM-011 | Cost estimates use a hard-coded price table shipped with the app, versioned and shown with an "estimate" label | `FR-103` | Medium, needs a table per provider |
| ASM-012 | Session History retains transcripts indefinitely until the user deletes them. No auto-purge, no size cap, and the files are plaintext JSON. Transcripts are the most sensitive user data in the product and get less protection than the API keys. Escalated to **OQ-001** | `FR-101` | Medium, adds retention UI. High if encryption at rest is added |
| ASM-013 | The app ships unsigned for v1. Code signing is a release-engineering follow-up | `NFR-013` | High, needs a certificate |
| ASM-014 | English only. No localization layer in v1 | `NFR-014` | High |

Any change to an `ASM` row requires an update to this table, to the bound
requirement, and to the affected test cases in the same change.

### ADR-029 — One `ws` transport for all three streaming STT adapters

**TASK-012.** Section 8 listed `@deepgram/sdk`, `openai` and
`@elevenlabs/elevenlabs-js` as the runtime dependencies for streaming speech to
text, with "a raw `ws` client is the fallback if the ElevenLabs SDK does not
expose the realtime STT socket cleanly".

**Decision.** Use one `ws` client for all three streaming adapters. The SDKs are
still the right choice where they add something: Whisper REST (`TASK-013`) and
the LLM adapters (`TASK-032`) keep them.

**Why.**
- **The tests the plan demands are wire-level.** `TC-052` asserts the query
  string on the connection URL, `TC-159` asserts the gap inside it, `TC-153`
  asserts the audio format. Each SDK builds its socket internally, so asserting
  what it put on the wire means reaching past the SDK's own abstraction, which
  tests the reach rather than the adapter.
- **Reconnect must behave identically on all three.** `TC-054` requires a
  dropped socket to come back without ending the session. Three SDKs means three
  reconnect policies, three backoff ladders and three definitions of "gave up".
  `SocketSttSession` gives one, tested once.
- **Two of the three authenticate with a request header.** The platform
  `WebSocket` constructor cannot set one, so a Node client is needed regardless.
- **Three SDKs are three production dependencies on the critical audio path.**
  The `electron-audio-loopback` lesson (ADR-028) is that a dependency on this
  path has to earn its place. `npm ls electron --omit=dev` staying empty is a
  guard the project already runs; fewer production packages keeps it easy.

**Cost.** Protocol changes at any of the three providers land on us rather than
on an SDK release. Accepted: each adapter is under 120 lines, the frame handling
is a switch on a message type, and the fake-socket tests make a protocol change
a visible failure rather than a silent one.

**Consequence.** Section 8's runtime table is corrected in the same change.

---

### ADR-030 — Document channels name their profile, and the model gate is a state, not a percent

**Decided 2026-09-16 during Milestone 2.** Three gaps found while implementing
`TASK-020` to `TASK-025`, all closed in the same change as the documents they
correct (DoD 9).

**Context.** `FR-079` requires two things the IPC contract had no way to express:
a doc-type override "resettable to `auto`", and a document in `error` that
"retries from the Dashboard without re-import". `CH-110` typed its payload over
the closed `DocType` union, which has no value meaning automatic, and no channel
carried a retry at all, so the only way back from `error` was `doc:import`, which
would have made the user find the original file again.

Separately, `ADR-026` promises a fresh install with no network an explicit
"embedding model not downloaded" state with a retry action, and `TC-161` asserts
it. `CH-214` carried `{ percent, done }`, which can say "not finished" but cannot
say "failed, here is why, you may retry".

**Decision.**
- `CH-110` accepts `DocType | 'auto'`. One channel sets the field, in both
  directions. A second channel for the reset would have given the Dashboard two
  ways to set one thing.
- `CH-110`, `CH-111` and the new `CH-123 doc:retry` all carry `profileId` beside
  `docId`. A document id alone forces the main process to scan every profile to
  find its owner, and `kb/` being authoritative (`ADR-014`) means a stale id can
  outlive its record. Naming the profile makes the lookup one directory read and
  makes `FR-069`'s "exactly one profile" explicit at the boundary.
- `CH-214` carries a `ModelDownloadState` discriminated union, and the new
  `CH-124 model:ensure` returns the same type. A push and a request that describe
  the same model must not be able to disagree.
- The embedding model gets its own registry, `src/shared/registry/embedding.ts`,
  separate from the STT and LLM registries. It carries no `credentialId`, because
  it runs locally, and that is the property `NFR-008` and `ADR-026` rest on.

**Also found and fixed while implementing.**
- `Profile.createdAt` alone did not order the profile list. Two profiles created
  in the same millisecond share a timestamp, and the tie-break was a random
  uuid, so the Dashboard's list reordered itself between launches. `create` now
  stamps `createdAt` strictly later than every existing profile's.
- The license gate could not read three of the four new dependencies' licenses.
  `pako` declares `(MIT AND Zlib)` and the checker only split on `OR`;
  `flatbuffers` declares `SEE LICENSE IN LICENSE.txt`; `duck` declares a bare
  `BSD`, which names a family and not a license. The gate now evaluates `AND` as
  well as `OR` and resolves a file-or-family declaration by reading the package's
  own license text, rather than being widened to let the three through on trust.
  `BSD-3-Clause` is matched before `BSD-2-Clause`, because the 3-clause text
  contains the whole 2-clause text.

**Consequence.** `docs/02-architecture.md` section 2.1a, section 4 and section 11
are corrected in the same change. `CH-121`, `CH-122` and `CH-215`, which landed
in Milestone 0, are recorded in section 4's table for the first time.

**Corrected during the pre-push review, same change.** Two of these change what a
document already says, so they are recorded here rather than only in the task
notes.

- **`ADR-023`'s cap is enforced by the registry, and lowered by the model.** The
  first implementation read the limit only from the model's files, which is what
  `ADR-023` asks for, and it resolved to **512** on every real install.
  `@xenova/transformers` fetches `tokenizer.json`, `tokenizer_config.json` and
  `config.json`; it never fetches `sentence_bert_config.json`, which is the
  Python sentence-transformers artifact holding MiniLM's real 256. The only limit
  on disk was therefore the BERT backbone's 512, so chunks of up to 510 word
  pieces were produced and silently truncated at embed time: exactly the failure
  `ADR-023` exists to prevent. The descriptor's `maxSeqLength` is now a ceiling
  and a config on disk can only lower it. `ADR-023`'s intent survives, because a
  model swap carries its own registry limit and a stricter config still wins.
- **`CH-214` is pushed once at startup.** There is no read-only model-state
  channel, and `CH-214` only fires on a change, so a fresh install could not
  render `ADR-026`'s "embedding model not downloaded" state without invoking
  `model:ensure`, which would begin a 90 MB download unprompted on every launch.
  The main process pushes the initial state once the Dashboard exists.
- **A failed model attempt is terminal until the user retries.** Ingestion
  consults the gate per file, and retrying automatically made an offline import
  of five documents attempt five full downloads, each waiting out the library's
  own network timeout with `doc:import` unresolved: the hang `NFR-008` and
  `ADR-026` forbid. `model:ensure` carries `userInitiated`, and a retry that
  succeeds also re-processes the documents it unblocked, since nothing else
  revisits a `pending` document before the next launch.

---

## 5. Out of scope for v1

Carried forward from product discovery. Do not add without a new decision.

- No hidden or silently skippable consent step. (ADR-002)
- No persistent audio recording of either stream under any setting. (`NFR-002`)
- No doc-type-weighted retrieval. (ASM-006)
- No cloud sync of profiles, documents, transcripts or settings.
- No macOS or Linux build. Windows only. (`NFR-011`)
- No automatic session start from calendar or meeting detection.
- No multi-user or team features.
- No hard cost cutoff. The threshold produces a warning only. (`FR-103`)
- No per-application audio capture. Loopback takes all system audio. (ADR-021)
- No transcript encryption at rest. Transcripts are plaintext JSON and the Dashboard says so. (OQ-001)
