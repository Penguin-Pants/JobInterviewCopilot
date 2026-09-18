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

### ADR-031 — `IDLE` is not pausable, and a failed generation reports `cancelled`

**Decided 2026-09-16 during Milestone 3.** Two points where `TASK-030` and
`TASK-032` met a specification that had one reading too few. Both are recorded
here rather than only in the task notes, because both change what a document
already says (DoD 9).

**Context 1.** `docs/02-architecture.md` section 5.3 writes the pause transition
as `any --Ctrl+Shift+P--> PAUSED`, and the resume transition as
`PAUSED --Ctrl+Shift+P--> LISTENING`. Read literally, pausing from `IDLE` and
then resuming puts the machine in `LISTENING` with no session behind it: no
audio, no STT socket, no profile bound. The trigger would then arm a turn-end
timer for a session that does not exist, and `session:start` would find the
machine already out of `IDLE`.

**Decision 1.** `IDLE` is not pausable. `any` means any **live** state:
`LISTENING`, `AWAITING_TURN_END`, `GENERATING`. Pressing the hotkey with no
session running is a no-op, not a state change. `FR-053` says the hotkey pauses
and resumes *the trigger*, and a trigger that is not running has nothing to
pause. Section 5.3 is corrected in the same change.

**Context 2.** `CH-209 suggestion:end` carries a status. `FR-076` forbids the
overlay ever showing an error card, so there is no error status to send when a
provider fails mid-generation. The architecture's section 4 table listed two
values, `complete` and `cancelled`; the code has carried three since Milestone
0, because `TranscriptEntry` needs `nonconforming` for `FR-004`.

**Decision 2.** The status is `'complete' | 'cancelled' | 'nonconforming'`, and
section 4 is corrected to say so. A **provider failure is not a status of its
own**. It reports `cancelled` when nothing was salvaged, which clears the card
and says nothing false, and reports the shape it actually produced when lines
did reach the overlay, because `FR-076` says the overlay still shows what was
salvaged. The failure itself is returned to the caller as a `ProviderError` and
reaches the user through the Dashboard badge (`CMP-12`, `FR-100`).

**Consequence.** `docs/02-architecture.md` sections 4, 5.3 and 11 are corrected
in the same change. Section 11 gains `ai/llm/sse.ts`, `ai/llm/index.ts` and
`overlay-gate.ts`, which the original layout did not anticipate.

**Added after the Codex review on the pull request.** `SttModelDescriptor` gains
`batchIntervalMs`, the audio window a batch model buffers before each request.
Two components need that number: the adapter sizes its buffer from it, and
`CMP-05` adds it to the turn-end gap. Two constants would have been two things
that drift, and the drift is invisible: `whisper-1` answers once per 4000 ms
window and never sends an interim, so an 800 ms gap measured from each answer
elapses while the interviewer is still speaking into the next window, and a long
question becomes a suggestion per fragment. The field is absent for every
streaming model, which reads as zero, so the gap stays exactly
`settings.trigger.turnEndGapMs` for all of them and `TC-159` is unaffected.
Sections 3.2, 5.1 and 5.3 carry the rest of that review's behavior changes.

### ADR-032 — A start refusal is a response, and a failure path must never fabricate a value

**Decided 2026-09-16 during TASK-040.** Two decisions from the review of the
Session Manager, both recorded here because both change what a document already
says (DoD 9).

**Context 1.** `FR-088` and `TC-104` require each of four start refusals to
return "its own distinct, named reason". The Session Manager raises a typed
`SessionStartRefused` carrying that reason, and the `session:start` handler
rethrew it. `CMP-10` catches every thrown handler error and replaces it with one
generic message, by design: a handler's internal failure is this app's bug, not
the caller's, and its detail belongs in the log rather than at the boundary. So
all four refusals arrived identical, and the acceptance criterion held only
inside the component nobody was asking.

**Decision 1.** A refusal is an **answer**, not a failure. `CH-112` returns
`{ sessionId }` or `{ refused, message }`, validated by the channel schema like
any other response. Only a genuine fault is thrown. This keeps `CMP-10`'s rule
intact rather than weakening it to let one component's errors through.

**Context 2.** Five of the ten defects found in review were the same mistake in
different places: a failure path that produced a plausible value instead of
stopping. `readNdjson` read every failure as an empty transcript, so a transient
`EACCES` became an empty `.json` and a deleted `.ndjson`. `readJsonSession` cast
rather than validated, so a half-written `{}` reached the code that reads
`entries.length` and took a whole profile's history with it. Crash recovery
filled a session's profile label with an empty string it had been handed. A
failed compaction left state saying "stopped" while the lock said "running".

**Decision 2.** On this path a failure stops and says so. Concretely: only
`ENOENT` means "no transcript"; a parsed session file is validated against the
schema before it is trusted; metadata a transcript cannot carry is written to a
sidecar rather than inferred; and `stop` clears its active state only once
compaction has succeeded, keeping the session retryable. The rule of thumb this
milestone adds: **the transcript is the user's interview, so on the writer's
paths, losing data must be louder than failing.**

**Consequence.** `docs/02-architecture.md` sections 2 and 2.5 and section 4's
`CH-112` row are corrected in the same change.

### ADR-033 — LLM usage is keyed by generation and replaced, and a missing price is labelled rather than guessed

**Decided 2026-09-16 during TASK-041.** Two decisions about what the Cost Meter
is allowed to make up, recorded here because both change what a document already
says (DoD 9).

**Context 1.** `FR-109` requires the cost warning to be edge-triggered upward
only, "including when the estimate decreases after a cancelled generation". A
meter that sums token counts by model has no decreasing case at all, so the
requirement's own example could not be built, let alone tested. Meanwhile
`TASK-040` carried a follow-up asking what a cancelled generation costs: an
aborted adapter returns without its terminal usage record, so the generation
accounts zero although the provider streamed.

**Decision 1.** Usage is accumulated per **generation id**, and a second report
for one id **replaces** the first rather than adding to it. One generation can
report usage more than once: a provider that sends an interim usage frame and
then a terminal one, and a cancelled generation whose outcome carries the
smaller figure the provider settled on. Summed, the same tokens would be billed
twice; replaced, a cancellation lowers the estimate, which is exactly the case
`FR-109` names. The warning guard is membership in a fired list, never a
comparison against a previous value, so no decrease can re-arm anything.

The follow-up's remaining half is answered by refusing it: a generation
cancelled before the provider reported anything accounts **zero** tokens. The
alternative is a local estimate from the text we received, and the meter would
then present a number we invented as a measurement. Under-accounting that is
labelled is better than over-confidence that is not, which is ADR-032's rule
applied to a number rather than to a file.

**Context 2.** `TC-156` fails the build when a registry model has no price row,
so there should be no unpriced model at runtime. "Should be" is not "is": a
hand-edited settings file can name one, and the meter would then quietly return
a dollar figure that understates the session.

**Decision 2.** `UsageRecord` gains `estimateIncomplete`. An unpriced model
still has its tokens and its seconds counted, contributes zero dollars, and sets
the flag; the Dashboard labels the estimate incomplete rather than showing a
bare number. The field is defaulted in the schema rather than required, so a
session written before the Cost Meter existed still parses.

**Consequence.** `docs/02-architecture.md` sections 2 and 7 carry the field and
the accounting rule.

---

### ADR-034 — The live session loop is its own task, not a section of the Dashboard task

**Decided 2026-09-16, before TASK-044.** A planning decision, recorded here
because restructuring the build plan is a DoD 9 event.

**Context.** `TASK-042` had grown to six Dashboard sections, eight acceptance
criteria of its own, **and** the whole live loop: starting capture, opening the
STT sessions, feeding the trigger, answering `onFire` with retrieval and
generation, and feeding the Cost Meter. The loop had arrived there by being
carried rather than by being chosen. `TASK-040` handed it on because the Session
Manager is the transcript's writer and not an orchestrator, and `TASK-041`
handed it on again because the Cost Meter counts and does not drive. Each hand-on
was right on its own and the effect of all of them was that the one piece of work
every other Milestone 4 task depends on had no task of its own and no acceptance
criteria of its own.

Two consequences followed. The loop would have been reviewed as a part of a
renderer task, against criteria written about renderer sections. And the first
end-to-end suggestion, question in, bullets out, would not have been provable
until a Dashboard existed to press Start, which puts the riskiest integration in
the project behind the largest untested surface in it.

**Decision.** The loop becomes `TASK-044 Live session loop`, depending on
`TASK-013`, `TASK-030`, `TASK-032`, `TASK-040` and `TASK-041`, and blocking
`TASK-042`. The three follow-ups parked on `TASK-042` that are really the loop
move with it, `TC-071`'s remaining half included, and `TASK-030`'s
`triggerConfigFrom` failover rebind joins them because the session is the
component that owns the failover boundary.

It is numbered **044** rather than inserted as a renumbered `042`. Renumbering
would rewrite task ids across `03-tasks.md`, `05-traceability.md`,
`06-verification-map.md`, the architecture and this log, and every one of those
edits is a chance to break a trace that currently holds. A gap-free numbering is
worth nothing; a trace that still points at the right task is worth a great deal.

**Consequence.** The loop is driven by a test harness rather than by a renderer,
so it is provable before `TASK-042` starts, and `TASK-042` shrinks back to the
Dashboard. `TC-164` is added as its end-to-end case. `docs/03-tasks.md`,
`docs/04-test-strategy.md` and `docs/06-verification-map.md` change in the same
commit, and `docs/05-traceability.md` regenerates from them.

---

### ADR-035 — The live loop is a component, and a failed retrieval abandons the turn

**Decided 2026-09-16 during TASK-044.** Three decisions the loop forced,
recorded here because each changes what a document already says (DoD 9).

**Context 1.** The loop has no component in the map. `CMP-01` is the only
candidate, and its own row forbids it: "must not contain business logic". The
work is real and has state of its own: the streams that are open, the model that
is serving, and the generation in flight.

**Decision 1.** `CMP-15 Live Session Loop`, `src/main/live.ts`. It owns no policy
of its own, writes no file and creates no window, and it imports neither Electron
nor `node:fs`, which is asserted rather than intended. Every collaborator is
injected, so the whole loop runs in a test with no Electron, no socket and no
model. `CMP-01` starts and stops it and owns nothing else about a session.

Audio bytes now pass through it, so it joins the reachable audio path in the
`NFR-002` lint ban and in section 9 of the architecture.

**Context 2.** `RagEngine.query` can fail: a torn `vectors.bin`, a transient
read error. The loop then has a question, no notes, and a working language
model. Generating anyway produces a card the overlay renders exactly like a
grounded one, and the user has no way to tell which they are reading during an
interview.

**Decision 2.** A failed retrieval **abandons the turn**. The failure is logged,
the trigger is told the generation settled so the machine is free for the next
question, and nothing reaches the overlay. This is ADR-032 applied to a
suggestion: an unanswered turn looks like silence, which `FR-102` says is not an
error, while an ungrounded suggestion is the plausible value that rule forbids.
`FR-076` leaves no third option, because the overlay has no error state.

**Context 3.** A model that is not in the registry, a credential with no key and
a missing adapter are **configuration** faults. Routed through `CMP-12`, each
arrives as a non-retryable `client` error, which sends the credential to
`CONFIG_REQUIRED` and blames a key that is perfectly good. That is the failure
`requireLlmProvider` already guards against inside the LLM facade, and it comes
straight back if the loop resolves a provider inside `runFor`.

**Decision 3.** Both the STT target and the LLM target are resolved **outside**
the health machine. `runFor` sees only what a provider actually did. The other
half of the same boundary: `runGeneration` returns a provider failure rather
than throwing it, because the overlay has no error state, so the loop rethrows
that failure inside `runFor` and keeps the salvaged outcome. Without the rethrow
a dead key would never fail over; without keeping the outcome, `FR-076`'s
salvage would be thrown away on the way past.

**Consequence.** `docs/02-architecture.md` sections 1, 5.1, 5.2, 9, 10 and 11
change in the same pull request. Section 5.1's ordering is corrected: `CMP-09`
starts before capture, because a meter that is not running discards the audio
handed to it.

### ADR-036 — Eight boundaries the live loop got wrong, and what each one is now

**Decided 2026-09-16 during TASK-044**, from the Codex review on the pull
request. All eight findings were real. They are recorded together because they
are one mistake with eight faces: **the loop trusted what a collaborator's
signature implied rather than what the collaborator actually does.**

**1. A resolved `open` is not a connected socket.** Every streaming adapter asks
its socket to connect and returns; a refused or revoked connection arrives later
on the `error` event, after the adapter's own reconnect ladder. `runFor` had
therefore already recorded the open as a success, so an unavailable primary
never retried and never failed over, and the session simply transcribed nothing
for the rest of the interview. That event is now raised **into** the health
machine and the pair is re-opened on whatever the machine then serves. This also
answers the follow-up TASK-044 was going to carry, that a socket dying
mid-session was logged and never reopened.

**2. `[]` from retrieval is not "nothing matched".** `RagEngine.query` returned
`[]` when the embedding model was gone and when embedding threw, which TASK-024
chose so that a failure could not throw into a session. ADR-035 had just decided
that a failed retrieval must abandon the turn, and the two cannot both hold: the
failure arrived as "no relevant notes" and the loop generated from them, which
is the ungrounded suggestion ADR-035 exists to prevent. `query` now throws
`RetrievalUnavailableError` when notes that exist cannot be reached, and still
answers `[]` when there is genuinely nothing to search. Neither a crash nor a
fabricated answer.

**3. A live session is not a state machine with one thread.** `session:start`
tells the renderers the session is live before awaiting the loop, so Stop can
arrive while capture or a socket is still coming up. The teardown ran, and the
start's own continuation then opened the pair again and started the trigger,
leaving sockets live against a transcript the Session Manager had compacted.
`stop` now waits for the bring-up it interrupts rather than tearing it down
from underneath.

**4. `close` on a batch adapter is where its last answer comes from.** Whisper
posts its remaining buffer inside `close`. The loop cleared its stream map first,
so that answer was dropped; and `close` set `closed` before the request came
back, so `transcribe` discarded the response as well. The last thing said before
Stop was posted, paid for, answered, and thrown away, on every session recorded
with a batch model. The streams stay routable until `close` resolves, and
`close` waits for its own requests. A separate `closing` flag keeps *chunks* out
of a socket that is going away, which is what the early clear was really for.

**5. A configured backup is not a usable backup.** The health machine's binding
says a backup exists; whether it can be used (a key, a registry entry, an
adapter) is the loop's question, and it can answer no. Falling back to the
primary there re-ran the provider that had just failed while the machine
recorded `using-backup`, so the Dashboard named a backup that never answered a
request. An unusable backup now fails the backup attempt explicitly.

**6. A chunk handed to an adapter is not a chunk sent.** `SocketSttSession`
drops queued chunks during an outage rather than buffering without bound
(ADR-027). Billing what the supervisor passed on charged an outage as though it
had been transcribed, which contradicts the meter's own "actually sent to a
provider" rule. `SttSession` gains an optional `sentBytes`, counted at the one
place a chunk reaches the socket, and the meter reads that.

**7. One generation is not one billable request.** A retry or a failover sends
the question again. ADR-033's replacement by `generationId` is right within one
request, which can report usage twice, and wrong across two, which are both
billable and possibly at different rates. Each attempt is accounted under
`<generationId>#n`.

**8. A card the gate holds is not scoped to a session.** `noteClosed` keeps the
card on purpose, so a generation streaming through a translucency rebuild is
replayed in full to the new renderer (ADR-016). Across a session boundary that
is exactly wrong: the card outlived the interview, and the next rebuild replayed
the previous interview's suggestion to a session that had not produced one. The
gate is cleared at both ends of a session.

**Consequence.** `docs/02-architecture.md` sections 3.1, 3.4, 7 and 10 carry the
corrected contracts. One of TASK-044's declared follow-ups is closed by finding
1 and another by finding 6; both are struck through in `03-tasks.md`. Every fix
is pinned by a test checked to fail without it.

---

### ADR-037 — Where a document's path comes from, and how a key check is bounded

**Status.** Accepted, TASK-042.

**Context.** Two things the Dashboard needs had no home in the contract.

1. `TASK-042`'s acceptance criteria require drag-and-drop import. No `FR-`
   requires it; `FR-063` is about chunk metadata and does not apply. `File.path`
   was removed from Electron's renderer, so a dropped file has no path unless
   the preload calls `webUtils.getPathForFile`, which is reachable from a
   preload only.
2. Milestone 2 carried a follow-up into this task: `doc:import` takes an
   unbounded array of absolute paths the renderer supplies, and there was no
   main-process dialog choosing them.
3. `FR-026` requires an inline pass or fail **within 10 seconds**. No adapter
   carries a deadline, so a wedged connection left the Dashboard with a
   spinner and no answer at all.

**Decision.**

- The Dashboard preload exposes `pathForFile(file): string`, wrapping
  `webUtils.getPathForFile`. It is optional on `CopilotBridge` and absent from
  the overlay preload: a window that accepts no drops has no reason to resolve
  a path. It returns an empty string for a drop that is not a file on disk, so
  one text selection in a multi-item drop does not abandon the whole drop.
- `CH-125` `doc:pickFiles` runs `dialog.showOpenDialog` in the main process
  **and** imports what was chosen, in one channel. Returning the paths to the
  renderer so it could call `doc:import` would put them straight back under
  renderer control and would close nothing.
- `doc:import` keeps taking renderer-supplied paths, because drag and drop
  cannot work any other way. What bounds that path is the extension allowlist
  in `CMP-06`, **not** `basename`: `basename` decides the name the copy lands
  under inside `kb/`, it does not decide what may be read. Milestone 2's
  follow-up said `basename`, which was the wrong reason for a true conclusion
  and would have misled whoever closed it. A compromised renderer can still ask
  for any Markdown, PDF or Word file on the disk, which is why the remainder is
  carried to TASK-050 rather than declared closed.
- The 10-second deadline sits in the main process, in front of the save, not in
  the renderer. A renderer timeout cannot stop the in-flight call from saving a
  key the user has already been told was refused; a deadline in front of the
  save can, and a validation that does not answer in time saves nothing and
  reports a named failure.

**Rejected.** A `showOpenDialog`-only channel returning paths: it adds a dialog
without changing who is trusted. Reading the dropped bytes in the renderer and
sending them over IPC: it would put document contents on the IPC bus for no
gain, since the main process already opens the file. A renderer-side validation
timeout: it can report a failure the main process is about to contradict.

**Consequence.** `docs/02-architecture.md` section 4 carries `CH-125` and the
preload member. The follow-up Milestone 2 carried about renderer-trusted paths
is closed for the button path and explicitly left open for drag and drop, which
is where it is unavoidable. The dialog's file filter is read from
`SUPPORTED_EXTENSIONS`, re-exported from the `CMP-06` facade: a private copy in
the handler had already drifted and hid `.markdown` from the picker while drag
and drop accepted it.

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
| ASM-010 | ~~Overlay holds 3 suggestion cards, oldest fades out on the 4th~~ **Superseded by `ADR-047`.** The overlay holds exactly 1 card; a new suggestion replaces it | `FR-091` | Low, the reducer's existing cap collapses to this behavior at `MAX_CARDS = 1` |
| ASM-011 | Cost estimates use a hard-coded price table shipped with the app, versioned and shown with an "estimate" label | `FR-103` | Medium, needs a table per provider |
| ASM-012 | Session History retains transcripts indefinitely until the user deletes them. No auto-purge, no size cap, and the files are plaintext JSON. Transcripts are the most sensitive user data in the product and get less protection than the API keys. Escalated to **OQ-001** | `FR-101` | Medium, adds retention UI. High if encryption at rest is added |
| ASM-013 | The app ships unsigned for v1. Code signing is a release-engineering follow-up | `NFR-013` | High, needs a certificate |
| ASM-014 | English only. No localization layer in v1 | `NFR-014` | High |
| ASM-015 | The actionability lexicon (`ACTIONABLE_LEADS`, `NON_ACTIONABLE_PHRASES`) is a seed list, not exhaustive. A pattern it does not recognize falls to the LLM-confirm path rather than being misclassified | `FR-111` | Low, a lexicon entry is a one-line addition |
| ASM-016 | Confidence gate threshold defaults to 0.55 on Deepgram's 0 to 1 scale, chosen below typical clear-speech confidence and above typical garbled-audio confidence, pending calibration against real session data | `FR-113` | Low, one constant, but wrong until calibrated |
| ASM-017 | Stale-suggestion discard threshold defaults to 20000 ms measured from `firedAt`, chosen well above both latency budgets it must not trip during normal operation (`NFR-001` p95 4.0 s streaming, `NFR-017` p95 10.0 s non-streaming) | `FR-114` | Low |
| ASM-018 | Minimum card-hold floor defaults to 1500 ms | `FR-115` | Low |

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

### ADR-038 — Which window sees a notice, and how the Dashboard learns what the machine can do

**Status.** Accepted, TASK-043.

**Context.** Two gaps, one of them a three-way disagreement that had stood
since Milestone 0.

1. `CH-215 notice:captureFidelity` was written into the IPC table with
   **overlay** as its target, implemented as a push to the **Dashboard**, and
   left out of the overlay preload's allowlist. `NFR-012` says the pre-19041
   warning is shown "alongside the consent reminder", which is the overlay, so
   the one window the requirement is about could never show it. `TASK-032`'s
   `TC-096` found the inconsistency while enumerating the overlay's surface and
   carried it here, because `NFR-012` decides it and this is the task that owns
   the overlay's UI.
2. `FR-089` requires the acrylic option to be **disabled in the Dashboard with
   an explanatory note** on Windows 10. Nothing carried a build number to the
   Dashboard except `CH-215`, which fires only when capture fidelity is
   degraded. A Windows 10 machine on build 19045 has exact capture exclusion
   and no acrylic, so it received nothing at all and the option stayed enabled
   over a mode the window cannot render. `TASK-042` carried this with the same
   reasoning and named this task as its owner.

**Decision.**

- `CH-215`'s target is **both**, and it is pushed to both windows. The overlay
  renders it inside the consent card, which is where `NFR-012` puts it. The
  Dashboard keeps it, because `FR-089` reads its build number and because the
  overlay card is dismissible, so the Dashboard is where the sentence can still
  be found afterwards.
- `CH-216 notice:platform` is new, carries `{ windowsBuild, acrylicSupported }`
  and goes to both windows on every renderer load. The Dashboard disables the
  acrylic option from `acrylicSupported` and names the build in the note.
- The overlay receives it too, for a reason that is not `FR-089`'s.
  `overlayWindowOptions` silently builds a **transparent** window when acrylic
  is selected on a build that cannot render it, so the stored translucency and
  the window that exists can disagree. The renderer resolves the effective mode
  from `acrylicSupported` and styles the window it got rather than the one that
  was asked for, which is what its contrast depends on.
- The Dashboard gates on the pushed boolean, never on its own comparison
  against a build number. A second implementation of `supportsAcrylic` in a
  renderer could disagree with the main process about a machine; a copied
  constant can only ever put the wrong number in a sentence, and a guardrail
  pins the two together.

**Consequences.** Both notices are pushed on `did-finish-load` rather than once
at bootstrap, because either window can be rebuilt: the overlay on a
translucency change (ADR-015), the Dashboard by being closed and reopened. The
old one-shot push at the end of bootstrap left every rebuilt window without the
warning, which was a second, quieter bug in the same code. Each notice goes to
**the window that just loaded**, not to both from either handler, so one load
does not tell a window twice.

That last point uncovered a third. `wireDashboardWindow` was called after
`await createDashboardWindow(...)`, and `loadFile` resolves from **inside**
`did-finish-load`, so every replay listener it installed was attached to an
event that had already been emitted. It had never fired, since `TASK-042`.
While `reportPlatform` pushed to both windows the overlay's handler masked it;
pushing per window made it load-bearing, and a Dashboard that cannot hear its
own load would have had the acrylic option permanently disabled on Windows 11.
`createDashboardWindow` now takes the `onCreated` callback `createOverlayWindow`
already had, for the reason `createOverlayWindow`'s own comment gives, and
`model:download`, `state:providers` and `state:session` are replayed again as a
result.

**Why neither notice breaks `FR-076`.** `FR-076` bars an **error card**:
"Provider failures are reported only through the Dashboard status badge."
Neither of these is a provider failure. One says the operating system cannot
hide a window from screen capture, which `NFR-012` requires next to the consent
reminder in so many words; the other describes the machine. Neither carries a
severity, a retry or a reason, and no code path can put a provider failure into
either.

---

### ADR-039 — The overlay card carries an alpha floor, so `FR-093`'s contrast is true at every opacity

**Status.** Accepted, TASK-043.

**Context.** `FR-093` requires suggestion text to hold at least 4.5 to 1
"against the card background", and `TASK-043` requires it "in both themes at
**every** supported opacity level". `SETTINGS_LIMITS.overlayOpacity.min` is
0.3.

The overlay floats over an unknown desktop, so the card background is not a
colour until the card is composited over whatever is behind it. Two readings
were available and only one of them is worth testing:

- **The card's own colour, alpha ignored.** Passes for any palette at any
  opacity, including a card nobody can read. `TC-114` would assert nothing.
- **The worst case the card can be read on:** composited over pure white and
  over pure black, which bound every desktop between them. This is what the
  user actually sees.

Under the second reading a dark card at 0.3 over a white desktop composites to
about 70 percent grey, and white text on that is roughly 2 to 1. No single text
colour clears 4.5 to 1 against both bounds at that alpha, in either theme.

**Decision.** The **card surface** has an alpha floor, computed from the
palette rather than chosen: the smallest alpha at which every colour held to
the target still clears it over both bounds. The user's opacity setting moves
the surface between that floor and fully opaque. Below the floor the setting
still does something visible: the frame, the shadow and the idle card follow
the raw value, because no text is read off them.

The floor is the lowest alpha from which **every** alpha up to 1 clears the
target, not the first alpha that happens to clear it. Worst-case contrast is not
monotonic in alpha: the minimum over the two backdrops rises while the card
covers the hostile one, then falls back toward the card's own contrast at alpha
1, so the passing set is an interval rather than a suffix of [0, 1]. A search
that stopped at the first pass could return a floor with a failing band above
it, and `cardSurfaceAlpha` hands back any user opacity at or above the floor.
The scan therefore runs downward from 1 and stops at the first failure, which
makes the band safe by construction rather than by assumption.

`TC-114` drives every theme and every opacity step the slider can produce, and
asserts separately that the raw minimum **would** fail, that one held colour
already fails a step below the floor, that every alpha from the floor to 1
clears the target, and that a deliberately non-monotonic palette does not get a
floor with a failing band above it. Without those the floor could be removed, or
set well clear of the boundary, and the suite would stay green.

The colours held to the target are the card's text **and** its muted colour,
because the muted one renders a card's question line and the idle message and a
user reads those the same way they read a bullet. It is also the binding one:
both floors are set by `muted`, not by `text`.

**Consequences.** A user who sets 0.3 gets a card more opaque than 0.3. That is
the cost of the requirement as written, and it is paid on the setting chosen by
someone who wants the overlay unobtrusive, which is exactly when they can least
afford to squint at it. The alternative is a requirement that is false in the
product and true in the test.

---

### ADR-041 — Readiness is answered per session, and the one write the overlay can reach is rate limited

**Status.** Accepted, TASK-043, after the Codex review on the pull request.

**Context.** Two properties this task's own criteria rest on were narrower in
the code than in the requirement.

1. `FR-006` asks for the consent reminder before the first suggestion of
   **every** live session, and `FR-008` gates delivery on the renderer having
   rendered it. The renderer reported `overlay:ready` once, behind a latching
   ref, and `OverlayGate.reset()` cleared the card at a session boundary while
   leaving the gate **open**. So the question "has the reminder been rendered"
   was answered once, at the first load, and that answer stood for the life of
   the window. The reminder is dismissible, so by the second interview it was
   off screen, and the renderer re-shows it on a `state:session` push that React
   processes asynchronously.
2. `CH-126 overlay:setFontSize` is the one write an overlay renderer can reach.
   Its schema bounds the value and the handler drops a write that changes
   nothing, but a renderer alternating 16 and 32 defeats that guard and each
   call lands a **synchronous** `config.set` on the same event loop as the live
   audio and STT loop.

**Decision.**

- `reset()` clears readiness as well as the card, and the renderer reports
  again once the renewed reminder has painted, keyed on a session epoch rather
  than a latching ref. Until it does, the next interview's suggestions buffer,
  which is what the gate does at every other closed moment.
- `overlay:setFontSize` goes through a leading-edge throttle with a trailing
  commit (`src/main/write-throttle.ts`). The first press writes at once, any
  number of calls inside the window cost one write, and the last value asked
  for is the one stored. Its timers are injected, so the behaviour is driven
  with fake timers rather than waited for, which `src/main/index.ts` being
  outside coverage makes necessary rather than merely tidy.
- The overlay keeps a **draft** of the size it has asked for. Coalescing means
  the stored value no longer moves on every press, and without a draft each
  press would step from a stale rendered number: three quick presses from 26
  would all ask for 28.

A third followed from the same review round, found by CI rather than by reading:
the renderer detected a new interview by watching `active` go false and back to
true on `CH-201`. Two pushes delivered close enough together land in one React
batch, so `active` is true before and after, React bails out of the render and
the effect never runs. The boundary is keyed on the **session id** now, which is
what a session is and therefore cannot be missed, while a re-push carrying the
same id is still not a boundary and so cannot wipe a card mid-interview.

**Consequences.** The first defect was not practically reachable: a suggestion
needs an interviewer turn plus two round trips, while the re-render is two React
commits. That is the point. `ADR-016` exists so that ordering does not depend on
the renderer being fast enough, and a gate that relied on winning a race was not
the guarantee `FR-008` states, however comfortably it was winning.

The second is a threat-model correction rather than a bug report: the allowlist
was narrowed so a compromised overlay renderer could not write settings, rebind
hotkeys or replace credentials, and an unbounded call rate into a synchronous
write handed back a way to stall an interview instead. A capability is only as
narrow as its worst call pattern.

---

### ADR-040 — Magic UI could not be vendored, and what was built instead

**Status. SUPERSEDED by ADR-042.** The premise below is wrong: Magic UI's
source **is** reachable from this environment, and it is now vendored. The
record is kept rather than deleted, because how the wrong conclusion was
reached is worth more than the conclusion was.

**What was wrong.** "Unreachable" was concluded from four probes, none of
which was the one that works. `magicui.design`, `cdn.jsdelivr.net` and
`unpkg.com` are genuinely refused by the egress proxy, and the two npm
packages genuinely carry no component source. But the fourth probe was
`curl https://api.github.com/repos/magicuidesign/magicui`, the GitHub **API**,
which is gated per session and answered:

> GitHub access to this repository is not enabled for this session. Use
> `add_repo` to request access.

That answer names its own remedy, and it was read as a refusal instead. A plain
`git clone` of a public repository is served by this session's git proxy and
always was; `add_repo` confirms it in one call. Four probes that all fail can
still be the wrong four, and an error message that tells you what to do next is
evidence, not a verdict.

**Status (original).** Accepted with a carried remainder, TASK-043.

**Context.** `FR-094` says overlay cards "must be built from Magic UI
components on Tailwind, styled from the theme tokens in `FR-029`". The
architecture's dependency table records Magic UI as code **copied into the
repository**, not an npm dependency, and `NFR-016` requires every vendored file
to carry its source URL, the version or commit copied, and its license in
`VENDORED.md`. `VENDORED.md` has carried a placeholder row naming this task
since Milestone 0.

Magic UI's source could not be obtained in this environment. `magicui.design`,
`raw.githubusercontent.com`, `cdn.jsdelivr.net` and `unpkg.com` are all refused
by the network egress proxy, and the two Magic UI packages on npm
(`@magicuidesign/cli`, `@magicuidesign/mcp`) are thin clients that fetch the
component registry from `magicui.design` at run time and embed no component
source.

**Decision.** The Tailwind half of `FR-094` is implemented: the cards are built
on Tailwind, styled from the `FR-029` theme tokens through the custom
properties `theme.ts` computes, and `tailwindcss` compiles the stylesheet at
build time. The card, the reveal and the idle card are written as first-party
components under `src/renderer/overlay/components/`, occupying the roles Magic
UI's `MagicCard` and `BlurFade` would.

Nothing is vendored, and `VENDORED.md` records that rather than a row. A
provenance row naming a source URL, a version and a license for code that was
not copied from there would be a false statement in the one file `NFR-016`
exists to make trustworthy, and `scripts/check-licenses.mjs` reads that file as
input. A wrong row is worse than no row.

**Consequences.** `FR-094` is **partially met** and the remainder is carried to
`TASK-051` with its reason, rather than being recorded as done. `TC-146`, which
verifies `NFR-016`, is unaffected: it drives the checker against a fixture, so
it does not need a real vendored file. Swapping the first-party components for
Magic UI's later is a contained change: they are four small components behind
the props `Overlay.tsx` already passes.

---

### ADR-042 — Which Magic UI component the overlay uses, and which it does not

**Status.** Accepted, TASK-043 follow-up. Supersedes ADR-040.

**Context.** `FR-094` requires overlay cards to be "built from Magic UI
components on Tailwind, styled from the theme tokens in `FR-029`". With the
source in hand, the question stops being whether Magic UI can be obtained and
becomes which of its 79 components actually serve this overlay.

**Decision.**

- **`BlurFade` is vendored and is the bullet reveal.** It is the canonical
  fade-plus-offset reveal and its default shape is exactly what `FR-092`
  specifies. It lives at `src/renderer/overlay/vendor/blur-fade.tsx` with its
  source, commit and MIT license in `VENDORED.md`, and is byte-identical to
  upstream apart from four marked lines: the import is rewritten to
  `framer-motion`, and three type widenings describe what the body already does
  but that this repository's stricter compiler rejected. It is driven through
  its public props only, so the file can be refreshed by re-copying it.
- **`MagicCard` is deliberately not used**, and the reasons are this
  application's requirements rather than anything wrong with the component. It
  is a pointer-tracking hover gradient, and the overlay is click-through by
  default and forwards mouse events to whatever is behind it (`FR-083`), which
  is the mode a user spends an entire interview in. It draws its surface from
  shadcn tokens rather than the `FR-029` tokens `theme.ts` computes, and those
  carry the alpha floor `FR-093`'s contrast depends on (ADR-039). It imports
  `next-themes` and a shadcn `@/lib/utils`. Its orb mode animates a large
  blurred element against `NFR-007`'s 60 fps on integrated graphics.
- **`AnimatedList` is not used either.** It reveals children on a `setTimeout`
  interval, whereas the stack is driven by `CH-207` arriving over IPC, and its
  `scale: 0` entry and exit would move text a user may be halfway through
  reading.
- **Both variants are supplied to `BlurFade` explicitly**, rather than
  inheriting its defaults. `blur="0px"` stops the filter being *animated* but
  the default variants still set `filter: blur(0px)` on the element, which
  promotes a compositing layer per bullet for no visible effect; measured on the
  built renderer, a computed `filter` was present on every bullet. Supplying
  both variants also leaves exactly one difference between the motion modes, the
  slide, which is the one `NFR-010` names.

**Consequences.** `FR-094` is **substantially met**: the reveal is Magic UI, the
cards are on Tailwind, and the colours are the `FR-029` tokens. What remains is
a product judgement rather than an obstacle: whether the card surface should be
`MagicCard` despite the four objections above. That is carried to `TASK-051` as
a decision to confirm, not as work that was blocked.

`TC-146` proved itself on the way in. The first vendored file in the
repository's history was rejected by the license gate for having no
`VENDORED.md` row, which is exactly what `NFR-016` asks of it.

### ADR-043 — A warning the user cannot see is not a warning

**Context.** `TASK-050` asked for "session start warns that transcription is
unavailable" (`NFR-008`). The warning existed: `CMP-15` produces the sentence
whenever no speech-to-text model can be opened, and `live.ts` carried a comment
saying the user is told rather than left with a session that silently never
suggests anything. They were not told. `index.ts` wired the loop's `onError` to
`getLogger().error` and nothing else, so every fault `CMP-15` survives, that one
included, reached `main.log` and stopped there.

The failure mode this leaves is the worst one the app has. A session with no
usable model starts, runs, records a transcript and bills for the audio it
hands to nobody, and the only signal is an absence: no cues ever appear. The
user cannot tell that from a quiet interviewer.

**Decision.** `CH-217` `notice:session` carries a session-level fault to the
Dashboard, and `index.ts` pushes it alongside the log line.

- Dashboard only. The overlay never shows a failure (`FR-076`).
- Not on the health badges. `ADR-017` keys those by credential and they describe
  a provider that is failing. A model missing from the registry and a key that
  was never saved never reach a provider, and `ADR-024` already establishes that
  routing them through `runFor` would take a good key to `CONFIG_REQUIRED`.
- The payload names its session, and the Dashboard renders it only while that
  session is the live one. Clearing on a session boundary instead would race:
  `session:start` pushes `CH-201` before it brings the loop up, so the clear and
  the notice arrive in that order and the clear would wipe the message it was
  sent to replace.
- The detail stays in the log. It is a provider error object and the renderer
  has no use for one it cannot act on (`FR-034`, `NFR-003`).

**Reason.** `NFR-008` says warn. A log file the user will never open is not a
warning, and a requirement verified by a test that only reads the log would have
passed while the product failed.

### ADR-044 — The global handlers left `index.ts`, and `ADR-019`'s temp directory arrived

**Context.** Two `TASK-050` criteria could not be met where their code lived.

`TC-130` asks for a test that injects a rejection during a session and asserts
the session stays active. The handlers were two lines inside `bootstrap` in
`index.ts`, which cannot be imported without an Electron app and which is the
one file excluded from coverage. The criterion was unverifiable by construction.

`ADR-019` states that the app sets `TMPDIR` and `TEMP` for its own child
processes to a directory it owns and asserts it is empty at session end. Nothing
had ever implemented it. `TC-137`'s "the app-owned temp directory is empty"
would have been an assertion about a directory nothing ever wrote to, which is
the one answer that cannot fail.

**Decision.** `src/main/resilience.ts` holds both, and `bootstrap` calls them.

- `installGlobalHandlers` takes the emitter and the log sink, so a test drives
  it on an emitter of its own. It swallows a sink that throws: a throw inside an
  `uncaughtException` listener is what terminates a process, so a logging defect
  must not become the session loss `NFR-009` guards against.
- `useAppOwnedTempDir` points `TMPDIR`, `TEMP` and `TMP` at `userData/tmp`
  before anything that could spool a request body runs. `TC-137` sets it on the
  real environment for the length of the test, so `os.tmpdir()` genuinely
  resolves there and a dependency's spool would land where the assertion looks.
- `appOwnedTempEntries` rethrows anything that is not `ENOENT`. A missing
  directory means nothing was spooled; an unreadable one reported as empty would
  make the same assertion unfailable a second way.

The module imports no Electron and no logger. `index.ts` owns the logger
singleton and passes a sink in, which is what keeps the module testable.

**Reason.** A criterion whose code cannot be reached from a test is not a
criterion. Both moves are the smallest change that makes the stated check real.

### ADR-045 — The actionability filter is heuristic-first, LLM-confirm second, not one or the other

**Context.** `FR-051`'s guard (`passesTurnGuard`, 3 words or 12 characters) was
the entire filter between an interviewer utterance and a generation. It cannot
tell "thanks so much for having me today" from "tell me about a time you led a
project": both clear the same two numbers. The UX review that motivated this
milestone found this to be the largest source of suggestions that should not
have appeared at all.

**Decision.** A turn that passes `FR-051`'s guard is classified before it is
allowed to fire:
- A fixed, exported lexicon (`ACTIONABLE_LEADS`, `NON_ACTIONABLE_PHRASES`, see
  `FR-111`) resolves the common cases with no network call: a `?` or an
  interrogative lead word fires immediately; an exact small-talk or
  acknowledgement match suppresses immediately.
- Anything the lexicon does not resolve gets exactly one classification call to
  the already-configured LLM primary, capped at a few output tokens, before the
  turn is allowed to fire.
- A classifier failure (timeout, provider error) resolves to **fire**, never to
  suppress. `NFR-009`'s resilience policy already fails a live session toward
  continuing, not toward silence induced by a broken dependency; a suggestion
  that should not have appeared costs a glance, a missing one that should have
  costs the candidate an unaided answer to a question this tool exists to help
  with.

**Reason.** Heuristic-only was rejected: a fixed lexicon cannot cover a
paraphrased question ("so what would you say is, like, your biggest gap"), and
suppressing anything the lexicon does not clearly recognize as actionable would
drop real questions, the worse of the two failure directions. LLM-only was
rejected on latency grounds: it puts a network round trip in front of every
turn, including the common, unambiguous case that already worked, which fights
the streaming-latency budget `NFR-001` protects. Hybrid keeps the fast path fast
and spends the round trip only where the fast path cannot decide.

**Consequence.** `FR-111` and `NFR-018` are new. `TASK-060` implements it. The
lexicon is a starting point (`ASM-015`), not a closed list; growing it does not
change the architecture.

### ADR-046 — Confidence gating rides the existing capability-flag pattern, wired for one provider

**Context.** No `TranscriptEvent` carries a confidence score (`FR-048`), so a
badly transcribed question is indistinguishable from a clean one by the time it
reaches the trigger. The project already solves an analogous problem —
providers vary in what they can do — with a capability flag read off the
model's registry entry rather than a check on provider id
(`supportsEndpointing`, `FR-037`, `TC-056`, `TC-151`). More STT providers are
expected after this milestone, so whatever gates on confidence must not need
editing every time one is added.

**Decision.** `SttModelDescriptor` gains `supportsConfidence: boolean`, read
the same way `supportsEndpointing` is. `TranscriptEvent` gains an optional
`confidence?: number`. Only `deepgram` is wired to populate it in this
milestone: its wire protocol already carries
`channel.alternatives[0].confidence` and the adapter simply was not reading it.
`openai-realtime`, `elevenlabs` and `whisper-1` keep `supportsConfidence: false`
and emit no `confidence`, exactly as if the field did not exist for them, until
a follow-up milestone wires each in turn.

**Reason.** Blocking this fix on parity across all four current adapters
(rejected) would hold a real defect hostage to the slowest provider to expose
the data, and a fifth provider arriving next quarter would still need its own
wiring regardless of which choice is made here. A capability flag makes "not
yet wired" and "will never be wired" the same code path with a different data
value, so a new provider that never exposes confidence is not a special case,
it is the default.

**Consequence.** `FR-112` (registry and event shape) and `FR-113` (the gate
itself) are new. `TASK-061` implements it. `ASM-016` records the threshold as a
starting value pending calibration.

### ADR-047 — The overlay shows one card, not a stack, and the code for a stack is removed

**Context.** `FR-091`/`ASM-010` specified a 3-card stack with depth-based
dimming (`TASK-043`). The UX review argues that distinguishing "which of these
three is current" is exactly the kind of judgment call a candidate mid-interview
has no attention to spare for, and recommends a single card that is replaced
rather than appended to. The alternative considered was keeping `MAX_CARDS` as a
setting defaulting to 1, preserving the multi-card path for a possible future
panel-interview mode.

**Decision.** `MAX_CARDS` is removed as a concept; the overlay shows at most one
suggestion card. `depthOpacity`, the eviction-fade transition, and the
multi-card layer of `SuggestionCardView` are deleted rather than kept behind a
cap of 1, because a depth function that can only ever be called with
`depth = 0` and an eviction animation that can only ever fire for a card
nothing else is stacked on are code with no reachable second branch — the
standard this project already holds itself to (`ADR-044`: "a criterion whose
code cannot be reached from a test is not a criterion").

**Reason.** A configurable cap defaulting to 1 was rejected because it keeps
exactly the code this decision means to remove, on the promise of a future need
that is not yet a requirement. Restoring multi-card support later, if testing
of a panel-interview mode shows a real need for it, is a new decision with its
own requirement, not a flag flip on dead code kept warm on spec.

**Consequence.** `FR-091` is amended in place (`01-requirements.md` section 10).
`TC-111` is redefined in place for the single-card behavior, the same way
`TC-041` was once redefined rather than retired and replaced. `ASM-010` is
corrected in the same change (DoD 9). `TASK-063` implements it.

### ADR-048 — Staleness is measured from when the turn fired, not from a count of turns

**Context.** Nothing today stops a slow generation from surfacing an answer to
a question the interviewer has since moved past without asking anything else
that would count as a new turn under `FR-111` — small talk, a comment, or plain
silence do not restart the trigger, so the old answer would otherwise still
land. The alternative considered was counting subsequent interviewer turns
rather than measuring elapsed time.

**Decision.** `TurnFired` gains `firedAt: number` (epoch ms, set when the turn
fires). Immediately before a generation would become visible — the point at
which `CMP-15` would otherwise call `onSuggestion` for `suggestion:begin` —
`CMP-15` checks `Date.now() - turn.firedAt` against a fixed threshold. Over it,
the generation is not sent to the overlay at all: no `suggestion:begin`, no
lines, no `suggestion:end`. It is recorded in the transcript with a new status,
`'stale'`, distinct from `'cancelled'` (a new turn interrupted it), so the two
are not confused when a session is reviewed later.

**Reason.** A turn-count signal was rejected because it does nothing when the
interviewer says nothing else — the exact silence-after-the-real-question case
this decision exists for — and because it would need the trigger to expose a
running count to a component (`CMP-15`) that today only consumes `TurnFired`
once per turn, a larger seam than one timestamp comparison. A time signal is
one field and one comparison, and it degrades the same way whether the
interviewer stays silent or moves on to something else.

Checking only once, right before `suggestion:begin`, rather than also aborting
a stale-but-still-generating request early, is deliberate for this milestone:
the cost of letting an already-started generation finish is one wasted LLM
call, and adding an early-abort path is `TASK-062`'s stretch scope, not its
floor.

**Consequence.** `FR-114` is new. `GenerationStatus` and `TranscriptEntry`'s
`'suggestion'` variant gain `'stale'`; `CardStatus` does **not**, because a
stale generation never reaches the renderer. `CH-209`'s payload enum gains
`'stale'`. `ASM-017` records the threshold. `TASK-062` implements it.

### ADR-049 — The minimum-hold floor is renderer-side, in front of the reducer, not a delay in the main process

**Context.** Cutting to one card (`ADR-047`) means a fast reply can replace what
the candidate is reading before they have had a chance to read it. The UX
review recommends a floor: a card must have been visible for a minimum
duration before a new one can replace it. Two places could hold a ready
`suggestion:begin` back: `CMP-15` in the main process before it pushes the
channel, or the overlay renderer before it dispatches the pushed event into the
card reducer.

**Decision.** The hold lives in the renderer, in front of `reduceCards`, not in
`CMP-15`. A small buffer keyed by `generationId` receives every
`suggestion:begin`/`suggestion:line`/`suggestion:end` as it arrives over IPC; if
a card is currently shown and it became visible less than `MIN_HOLD_MS` ago,
the buffer holds the incoming events and replays them once the hold elapses, in
arrival order. If a `suggestion:end` with `status: 'cancelled'` arrives for a
`generationId` still sitting in the buffer, the buffer discards everything
queued for it instead of replaying a card that was itself superseded.

**Reason.** A main-process delay was rejected because "became visible" is a
renderer fact — the main process does not know when a push actually painted,
only when it sent it — and because `CMP-15` already has one buffering
responsibility at this boundary (`OverlayGate`, `ADR-016`) built around a
different invariant (has the renderer mounted at all, not has enough time
passed since the last paint). Reusing that gate for a second, unrelated purpose
would make one component responsible for two questions that fail independently.
`reduceCards` itself is untouched and every existing test of it still describes
real behavior; the hold is a component in front of it, not a change to it.

**Consequence.** `FR-115` is new. `ASM-018` records the default. `TASK-064`
implements it, depending on `TASK-063`.

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
