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

---

## 4. Assumption register

These were chosen without a direct product decision. Each is implemented as
specified but can be changed cheaply before build starts.

| ID | Assumption | Where it binds | Cost to change |
|---|---|---|---|
| ASM-001 | RAG chunk cap is 500 tokens, measured with the MiniLM tokenizer, soft-split on paragraph breaks | `FR-062` | Low, one constant |
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
| ASM-012 | Session History retains transcripts indefinitely until the user deletes them. No auto-purge, no size cap | `FR-101` | Medium, adds retention UI |
| ASM-013 | The app ships unsigned for v1. Code signing is a release-engineering follow-up | `NFR-013` | High, needs a certificate |
| ASM-014 | English only. No localization layer in v1 | `NFR-014` | High |

Any change to an `ASM` row requires an update to this table, to the bound
requirement, and to the affected test cases in the same change.

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
