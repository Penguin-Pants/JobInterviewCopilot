# Interview CoPilot — Test Strategy

Version 1.0. Baseline for implementation. Scope decided in ADR-004.

---

## 1. Tiers

| Tier | Runner | Where it runs | What it covers | Speed target |
|---|---|---|---|---|
| Unit | Vitest (node) | Linux and Windows CI, every PR | Pure logic with no Electron and no network | under 30 s total |
| Integration | Vitest (node) | Linux and Windows CI, every PR | Main-process modules wired together against fake providers and a temp `userData` | under 3 min |
| E2E | Playwright `_electron` | Windows CI runner, every PR | Real windows, real IPC, real preload, faked providers and faked audio source | under 10 min |
| Manual | Human checklist | Windows 10 and Windows 11 machines, before every release tag | Real audio devices, real screen share, real multi-monitor | one hour |

**Rule.** Any behavior that can be tested one tier lower must be tested one tier
lower. E2E is reserved for behavior that only exists when real windows exist.

---

## 2. Test doubles

Real provider calls are forbidden in CI. Three doubles, all in `tests/fakes/`:

- **FakeSttProvider** — satisfies `SttProvider`. Driven by a script of
  `{ atMs, text, isFinal }` entries, so turn timing is deterministic. Can be told
  to fail with a given `ErrorClass` at a given call index.
- **FakeLlmProvider** — satisfies `LlmProvider`. Yields a scripted delta
  sequence, optionally character by character, and records whether its
  `AbortSignal` fired. Reports a scripted `TokenUsage`.
- **FakeAudioSource** — replaces `CMP-03b`. Emits synthetic `AudioChunk` objects
  on a fake timer. Used everywhere except the manual tier, because ADR-004
  excludes real device capture from automation.

`vi.useFakeTimers()` is mandatory for every timing assertion. No test may use a
real `setTimeout` to wait for a gap, a backoff or a debounce.

**Determinism rule.** A test that fails intermittently is a defect in the test,
not a flake. It is fixed or deleted, never retried.

---

## 3. Test cases

`Level` is U (unit), I (integration) or E (E2E).

### 3.1 Build, windows and hardening

| ID | Level | Case | Pass condition |
|---|---|---|---|
| TC-001 | I | Clean build and package | `npm ci && npm run typecheck && npm run lint && npm run build && npm run licenses` all exit 0 |
| TC-002 | U | IPC payload validation | A payload failing its `zod` schema is rejected, logged and not forwarded to the handler |
| TC-003 | U | Contract type test | `expectTypeOf` proves the preload bridge and the main handlers share one type per channel |
| TC-004 | U | Content protection never disabled | A source scan finds zero occurrences of `setContentProtection(false)` under `src/` |
| TC-005 | E | Overlay window flags | Overlay reports `transparent`, frameless, `alwaysOnTop`, `skipTaskbar`, not resizable, and content protection enabled before first show |
| TC-006 | E | Consent reminder precedes the first suggestion | The consent element is in the DOM before the first `suggestion:line` renders, in every session |
| TC-007 | E | Renderer isolation | Every renderer reports `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and `window.require` is undefined |
| TC-008 | E | Navigation and CSP lockdown | `will-navigate` to an external URL is blocked, `window.open` is denied, CSP has no `unsafe-eval` |
| TC-009 | E | Single instance | A second launch focuses the existing Dashboard and creates no second window set |

### 3.2 Configuration and secrets

| ID | Level | Case | Pass condition |
|---|---|---|---|
| TC-020 | I | Keys are encrypted and separate | After `secrets:set`, `settings.json` contains no key substring and `secrets.bin` is `safeStorage` ciphertext |
| TC-021 | I | No plaintext fallback | With `isEncryptionAvailable()` stubbed false, `secrets:set` returns an error and writes nothing |
| TC-022 | U | Status channel leaks nothing | `secrets:status` response type and runtime value contain only booleans |
| TC-023 | U | Redaction | A key passed to the logger and a key embedded in an `Error.message` both emit masked |
| TC-024 | I | Validate before save | A rejected key returns the provider reason and is not persisted. A valid key is persisted |
| TC-025 | U | Primary and backup differ | Setting backup equal to primary is rejected at the config layer, not only in the UI |
| TC-030 | U | Defaults | Fresh settings match every default in `02-architecture.md` section 2.1 exactly |
| TC-031 | I | Corrupt settings | A malformed file is replaced with defaults and renamed to `settings.corrupt-<epochMillis>.json`. The original content survives. The generated name contains no colon and creates successfully on Windows, where an ISO 8601 name would throw |
| TC-032 | U | Migration chain | A stubbed version 0 file runs the chain and lands on `schemaVersion: 1` |
| TC-033 | U | Clamping | `overlayOpacity` 5.0 clamps to 1.00, `overlayFontSizePx` 4 clamps to 16, `turnEndGapMs` 99 clamps to 500 |
| TC-034 | I | Hotkey conflict | A rebind that `globalShortcut.register` rejects returns an error and the previous accelerator is still registered |
| TC-035 | E | Hotkey rebind live | After a rebind the new accelerator works and the old one does nothing, with no restart |
| TC-036 | I | Overlay position persistence | Position and `displayId` round-trip. With the stored display absent, the overlay lands at the default position on the primary display |

### 3.3 Audio

| ID | Level | Case | Pass condition |
|---|---|---|---|
| TC-040 | U | PCM framing | The worklet converter turns a known Float32 input into the expected Int16 LE bytes. A full chunk is exactly 32000 bytes |
| TC-041 | I | Buffer handoff | After `CH-303`, the worker holds no reference to the chunk it sent. **Rewritten: the original asserted `byteLength` is 0 after a transfer, which Electron cannot do (OQ-003). The exact assertion is settled by TASK-011 when OQ-003 is answered.** |
| TC-042 | U | No filesystem across the whole audio path | The ESLint rule fails a fixture importing `fs` under `src/renderer/audio-worker/**`, in `src/main/audio.ts`, in `src/main/ai/stt.ts` and under `src/main/ai/stt/**`. A rule covering only the first two fails this test |
| TC-043 | I | Loopback failure | With loopback rejected, the mic stream still starts, interviewer state is `error`, and `session:start` is refused with a named reason |
| TC-044 | I | Stream restart | An unexpected stream end retries exactly 3 times, then sets an error badge |
| TC-045 | I | Teardown | After `session:stop`, both contexts are closed, all tracks stopped and the worker window destroyed |

### 3.4 Transcription

| ID | Level | Case | Pass condition |
|---|---|---|---|
| TC-050 | U | Normalized event | Every adapter emits `{ source, text, isFinal, timestamp, providerId }` and nothing else |
| TC-051 | I | Per-stream isolation | Two sessions run concurrently. A final on one never mutates the other's interim state |
| TC-052 | U | Deepgram parameters | The connection URL carries `encoding=linear16`, `sample_rate=16000`, `channels=1`, `interim_results=true`, `endpointing=800` |
| TC-053 | I | Endpoint event | A Deepgram speech-final message emits an `endpoint` event |
| TC-054 | I | Socket reconnect | A dropped socket reconnects and the session stays active |
| TC-055 | U | Non-streaming buffering | `whisper-1` posts one request per 4000 ms of audio with a valid WAV header built in memory, and emits only `isFinal: true` |
| TC-056 | U | Capability flags come from the registry | The trigger reads `supportsEndpointing` off the selected model's registry entry, never a provider id. A fake provider with `supportsEndpointing: true` gets endpoint handling regardless of its id |
| TC-057 | E | Non-streaming badge | With `whisper-1` active, the Dashboard shows the badge text from the registry entry, naming both the accuracy and the latency penalty. The text is not hard-coded to Whisper anywhere in the renderer |

### 3.5 Knowledge base

| ID | Level | Case | Pass condition |
|---|---|---|---|
| TC-060 | I | Format ingest | `.md` ingests unchanged. `.pdf` and `.docx` produce `derived/<docId>.md` |
| TC-061 | U | Synthetic heading | A body with no heading is wrapped in exactly one `# Document` section |
| TC-062 | I | Best-effort label | A `.pdf` import sets `extractionQuality: 'best-effort'` |
| TC-063 | I | Failure isolation | A corrupt file in a 3-file batch sets `state: 'error'` on that row only. The other two reach `ready` |
| TC-064 | U | Header splitting | `#`, `##`, `###` create chunks. `####` stays inside the parent chunk |
| TC-065 | U | Header path | A nested document produces `headerPath` equal to the ordered ancestor chain |
| TC-066 | U | Token cap at the model limit | The cap is read from the model's `max_seq_length` (256), not hard-coded. A 1200-token section soft-splits on blank lines. A single 700-token paragraph hard-splits and loses no text. No produced chunk exceeds the cap, so nothing is silently truncated at embed time |
| TC-067 | U | Determinism | Chunking the same bytes twice produces a deeply equal array |
| TC-068 | U | Vector shape | Each vector has 384 dimensions and an L2 norm within 1e-6 of 1.0 |
| TC-069 | I | Cache hit | A second ingest of an unchanged file performs zero embedding calls |
| TC-070 | I | Cache invalidation | Bumping `chunkerVersion` forces a re-embed with no manual purge |
| TC-071 | E | Model download gate | During download, ingestion is blocked with determinate progress and `session:start` still succeeds |
| TC-072 | U | Auto-tag rules | A fixture set of 12 filenames and bodies produces the documented tag for each, deterministically |
| TC-073 | I | Override persistence | After a user override, a file change re-embeds but keeps `docTypeSource: 'user'` and the chosen tag |
| TC-074 | I | Override without re-embed | Changing the tag alone performs zero embedding calls and updates chunk metadata |
| TC-075 | I | Retrieval scoping | With two profiles populated, `query` returns only chunks from the requested profile |
| TC-076 | U | No doc-type weighting | Two chunks with identical similarity and different doc types produce identical scores |
| TC-077 | U | Empty profile | `query` on a profile with no ready documents returns `[]` and does not throw |
| TC-078 | U | Retrieval performance | 5000 synthetic chunks return the top 3 in under 50 ms |
| TC-079 | I | Watcher behavior | A change is visible in `query` within 5 s. Five rapid writes cause exactly one re-embed. A delete removes the record, chunks and vectors |

### 3.6 Trigger

All trigger tests run on fake timers with the pure state-machine module.

| ID | Level | Case | Pass condition |
|---|---|---|---|
| TC-080 | U | Turn end fires | An interviewer final followed by `turnEndGapMs` of silence fires exactly one `generate-suggestion` |
| TC-081 | U | Timer reset | A new interim at `gap - 1 ms` resets the timer. Total elapsed before firing exceeds one gap |
| TC-082 | U | Endpoint bypass | A provider `endpoint` event fires immediately, before the gap elapses |
| TC-083 | U | Short-turn guard | "Okay" (1 word, 5 chars) does not fire. "Tell me about yourself" does |
| TC-084 | U | Candidate never triggers | 100 candidate finals produce zero `generate-suggestion` events and zero state changes |
| TC-085 | U | Context ring | After 5 candidate turns, the ring holds the last 2, truncated to 400 characters, oldest content dropped first |
| TC-086 | U | Cancel on new turn | A turn end during `GENERATING` fires the in-flight `AbortSignal` before the new generation starts |
| TC-087 | I | Pause | Pausing aborts the in-flight generation, pushes the overlay idle state, and leaves both STT sessions open and both audio streams running |
| TC-088 | U | Resume | Resuming returns to `LISTENING` and the next turn fires normally |

### 3.7 Suggestions

| ID | Level | Case | Pass condition |
|---|---|---|---|
| TC-090 | U | System prompt fidelity | The built system prompt is byte-identical to `02-architecture.md` section 6 |
| TC-091 | U | User message template | Empty candidate context renders `(nothing yet)`. Zero chunks omits the notes section entirely rather than emitting an empty heading |
| TC-092 | U | Generation parameters | Both adapters send `max_tokens: 200` and `temperature: 0.3` |
| TC-093 | U | Line buffering | A 300-character, 4-line response delivered one character at a time produces exactly 4 `CH-208` messages |
| TC-094 | U | Forced flush | 240 characters with no newline flush once, and the stream continues |
| TC-095 | I | Real abort | Cancellation aborts the underlying request. The fake provider records `signal.aborted === true` |
| TC-096 | U | No overlay error channel | The overlay preload surface contains no channel that can carry an error to the overlay |

### 3.8 Session, cost and failover

| ID | Level | Case | Pass condition |
|---|---|---|---|
| TC-100 | U | Retry then failover | Three failures produce backoffs of 250, 500 and 1000 ms within jitter bounds, then a switch to the backup |
| TC-101 | U | Auth short-circuit | A 401 fails over immediately with zero retry attempts |
| TC-102 | U | Sticky backup and recovery | After failover the adapter stays on the backup. Two consecutive passing probes 60 s apart return it to the primary, and the switch happens at a turn boundary, not mid-stream |
| TC-103 | I | Degraded mode | With no backup, retries continue with backoff capped at 10 s, the Dashboard badge is set, and the overlay receives no message |
| TC-104 | I | Start refusals | Each of: active session, no active profile, missing STT key, missing LLM key, returns its own distinct named reason |
| TC-105 | I | Transcript durability | Each entry is on disk within 2 s of being produced |
| TC-106 | I | Crash recovery | An orphan `.ndjson` at startup compacts to `<sessionId>.json` with `endReason: 'crash-recovered'` and appears in Session History |
| TC-107 | U | Writer cannot take audio | `TranscriptEntry` has no variant that can carry binary audio. A type-level test asserts it |
| TC-108 | I | Cost accounting | Token counts come from the provider usage fields. `estimatedUsd` matches a hand-computed value, and the price table version is reported |
| TC-109 | I | Warnings and no cutoff | Each threshold warns exactly once. Crossing back and forth does not re-warn. The session is never stopped by the meter |

### 3.9 Overlay

| ID | Level | Case | Pass condition |
|---|---|---|---|
| TC-110 | E | Idle card | The standing-by card shows before the first suggestion and whenever paused |
| TC-111 | E | Card stack cap | After 4 suggestions, exactly 3 cards remain and the oldest has exited |
| TC-112 | E | Reveal granularity | DOM mutations equal the bullet count, not the character count. No per-word reveal element exists |
| TC-113 | E | Font size | Default 22 px. The in-overlay control and the Dashboard control both move it within 16 to 32 px, and the value persists across relaunch |
| TC-114 | U | Contrast | A computed contrast check over every theme and opacity combination returns at least 4.5 to 1 |
| TC-115 | E | Reduced motion | With `prefers-reduced-motion: reduce`, the slide transform is absent and the fade remains |
| TC-116 | E | Live theme apply | Changing theme mode, translucency mode and opacity updates the overlay with no restart |
| TC-117 | E | Mode affordance | Click-through and interactive modes render a visually distinguishable state |

### 3.10 Dashboard

| ID | Level | Case | Pass condition |
|---|---|---|---|
| TC-120 | E | Sections present | All six sections from `FR-087` render |
| TC-121 | E | Provider constraints | Selecting the same provider for primary and backup is blocked, and the single-OpenAI-key notice is visible |
| TC-122 | E | Delete confirmation | Profile delete shows a confirmation naming the document count and the session count |
| TC-123 | E | Session history | Sessions group by profile, open for viewing and delete |
| TC-124 | E | Keyboard navigation | Every interactive element is reachable by Tab and operable by Enter or Space |
| TC-125 | E | Live usage | During a session the timer and spend estimate update at least once per second |

### 3.11 Resilience and performance

| ID | Level | Case | Pass condition |
|---|---|---|---|
| TC-130 | I | Unhandled rejection | An injected unhandled rejection during a session is logged and the session stays active |
| TC-131 | I | Soak | A 60-minute synthetic session keeps main-process RSS under 600 MB with no upward trend over the last 30 minutes |
| TC-132 | I | Offline with a cached model | With the network disabled **and the model already cached**, the app starts, imports documents and embeds. `session:start` warns that transcription is unavailable |
| TC-133 | I | Latency harness | With scripted fakes at fixed delays, the measured turn-end to first-line path adds under 150 ms of app-side overhead. Real end-to-end `NFR-001` numbers come from MW-06 |

### 3.12 Added from independent review

| ID | Level | Case | Pass condition |
|---|---|---|---|
| TC-134 | I | Transcript ordering under cancellation | A turn end during `GENERATING` appends the cancelled entry, carrying the bullets already flushed, before the replacing generation's entry. `seq` is strictly increasing with no gaps |
| TC-135 | I | Torn write and lock recovery | A `.ndjson` whose final line is truncated mid-object compacts successfully, keeping every complete line. With both a `.json` and a `.ndjson` present, the `.json` wins and the `.ndjson` is deleted. A stale `session.lock` from a killed process is cleared and does not block the next session |
| TC-136 | U | Chunk duration is exactly 1000 ms | The chunker emits at exactly 16000 frames. A 999 ms or 1001 ms chunk fails the test |
| TC-137 | I | No audio reaches the filesystem | A filesystem write monitor wrapping `fs` records every write during a synthetic session with Whisper active. No write contains PCM, and the app-owned temp directory is empty at session end |
| TC-138 | E | Overlay ready gate | With the overlay renderer start delayed, a suggestion generated before `overlay:ready` is buffered and delivered after the consent reminder renders. Nothing is dropped. A second generation while buffered discards the first |
| TC-139 | U | Redaction covers non-IPC paths | A key leaked into a health-probe error, a path that never crosses IPC, is masked in the log line. Redaction exists in exactly one module |
| TC-140 | I | Adoption and reconciliation | A file copied into `kb/` outside `doc:import` gets a `DocumentRecord`, a tag and embeddings, and appears in the listing. A document left in `converting` or `embedding` is reset to `pending` at startup and re-processed |
| TC-141 | I | Chunk and vector integrity | A `vectors.bin` whose row count disagrees with `chunkCount` causes both to be discarded and re-embedded, with no partial results served from `query` |
| TC-142 | E | Acrylic mode switch | Switching translucency mode recreates the overlay window and preserves position, monitor, click-through state and the card stack. Switching opacity alone does not recreate it. On a simulated Windows 10 build the acrylic option is disabled with a note |
| TC-143 | I | Credential-keyed health | With OpenAI as STT backup and LLM primary, one rejected OpenAI key produces one Dashboard badge naming both capabilities, and exactly one probe timer runs |
| TC-144 | I | STT switch-back boundary | A recovery switch-back never closes the STT socket mid-utterance. The switch lands on a turn boundary with no audio in flight, and no transcript text is lost across it |
| TC-145 | U | Cost warning is edge-triggered upward | A threshold warns once. An estimate that decreases after a cancelled generation and then crosses again does not warn a second time |
| TC-146 | U | Vendored license coverage | A fixture file under `src/renderer/**/vendor/` with no `VENDORED.md` entry fails the check |
| TC-147 | I | Retention caps | `main.log` rotates at 5 MB keeping 3 files. A fourth `settings.corrupt-*.json` deletes the oldest |
| TC-148 | E | Reset Overlay | With the overlay click-through and positioned off-screen, Reset Overlay returns it to the primary monitor default position, sets interactive mode and re-registers both hotkeys |
| TC-149 | I | Document recovery paths | A document in `error` retries from the Dashboard without re-import. A user doc-type override resets to `auto` and re-runs the guess |
| TC-151 | I | Registry drives everything | Adding a fake provider with one model to the STT registry makes it selectable in the Dashboard and usable end to end, with no edit to the trigger, session manager, cost meter or any renderer file (`FR-037`) |
| TC-152 | I | OpenAI realtime adapter | The transcription session is configured with the chosen model and server VAD. Deltas map to `isFinal: false`, completed items to `isFinal: true`, the VAD stop event to `endpoint` |
| TC-153 | I | ElevenLabs adapter | The socket is opened with input format `pcm_16000`. Partial transcripts map to `isFinal: false`, committed segments to `isFinal: true` and to `endpoint` |
| TC-154 | E | Model picker | Each model shows its streaming capability and price. Selecting a non-streaming model shows the `NFR-017` latency consequence before the choice is saved. A backup from the same provider as the primary is rejected |
| TC-155 | I | Fourth credential | The ElevenLabs key encrypts into the vault, validates on entry, and health is keyed to it like every other credential |
| TC-156 | U | Price table coverage | Every model in both registries has a matching `providerId:modelId` row in `pricing.json`. A registry entry with no price row fails the test |
| TC-157 | U | Cue-form shape is enforced | A provider returning one 900-character paragraph with no newline produces lines wrapped at word boundaries, never mid-word, at most 5 lines on the card, each truncated at a word boundary before 120 characters, and the generation recorded as `nonconforming`. No overlay error is sent |
| TC-158 | E | Profile lifecycle | Create, switch and delete work. Exactly one profile is active. Deleting the active profile activates another, or creates a default when none remains. Switching is disabled during a live session |
| TC-159 | U | Endpointing uses the configured gap | With `turnEndGapMs` set to 1400, the Deepgram connection sends `endpointing=1400`. A hard-coded 800 fails this test. A provider that cannot accept the value has native endpointing disabled and uses the local timer |
| TC-160 | I | Profile deletion cascade | After deleting a populated profile, the profile directory does not exist, and a recursive scan of `userData` finds no chunk, vector, derived Markdown, original document or transcript belonging to it. A delete interrupted before the record is removed leaves no content orphaned |
| TC-161 | I | Fresh install, no network, no model | The app starts and manages profiles. The document manager shows the "embedding model not downloaded" state with a retry action. It does not hang and does not show a generic error |
| TC-162 | U | Non-retryable is terminal without a backup | With no backup, an `auth` failure enters `CONFIG_REQUIRED` and sends zero further requests for the rest of the session. A `network` failure enters `DEGRADED` and keeps retrying with backoff capped at 10 s. Saving a new valid key clears `CONFIG_REQUIRED` |
| TC-163 | I | Re-embed SLA is bounded | A document within the 2 MB and 200-chunk ceiling is queryable within 5 s of settling. A document above the ceiling still completes, is exempt from the 5 s target, and reports progress |
| TC-150 | I | Non-streaming latency harness | With a non-streaming model active and scripted fakes at fixed delays, the measured path is inside the `NFR-017` budget. Which budget applies is read from the registry entry. Real numbers come from MW-11 |

---

## 4. Coverage policy

| Area | Minimum line coverage | Note |
|---|---|---|
| `src/main/**` excluding adapters | 85 percent | Core logic |
| `src/main/ai/stt/*`, `src/main/ai/llm/*` | no number | Covered by integration tests with fakes |
| `src/shared/**` | 90 percent | Small and pure |
| `src/renderer/**` | no number | Covered by E2E |

CI fails on a coverage drop against the previous commit, not only on an absolute
floor.

---

## 5. CI pipeline

On every pull request, in order, fail fast:

1. `npm ci`
2. `npm run typecheck`
3. `npm run lint`
4. `npm run licenses`
5. `npm run test:unit` with coverage
6. `npm run test:integration`
7. `npm run test:e2e` on a `windows-latest` runner
8. `npm run build`

Nightly, additionally: `npm run test:soak` (TC-131) and `npm run package`.

---

## 6. Manual Windows release checklist

Run on one Windows 10 machine (build 19041 or later) and one Windows 11 machine.
Record the result against the release tag. A failure blocks the release.

| ID | Check | Expected |
|---|---|---|
| MW-01 | Share the screen in Zoom, Teams and Google Meet with the overlay visible | The overlay does not appear in the shared view on any of the three. It stays visible on the physical display |
| MW-02 | Loopback capture with real system audio | Interviewer speech from a browser tab transcribes correctly |
| MW-03 | Microphone capture with a real headset and with a laptop array mic | Candidate speech transcribes correctly on both |
| MW-04 | Both streams at once with the interviewer and candidate speaking over each other | Transcripts stay separated by source. No cross-contamination |
| MW-05 | Full interview rehearsal, 20 minutes | Suggestions are cue-form, arrive per bullet, and no overlay error ever appears |
| MW-06 | Latency measurement over 20 turns | p50 under 2.5 s and p95 under 4.0 s from turn end to first bullet (`NFR-001`) |
| MW-07 | Drag the overlay across two monitors with different DPI, then relaunch | Position and monitor are restored. Text stays crisp |
| MW-08 | Both hotkeys while another application has focus | Interaction toggle and pause both work from any focused app |
| MW-09 | Unplug the network mid-session | The Dashboard badge turns red, the overlay stays idle with no error card, and the session continues when the network returns |
| MW-10 | Kill the process mid-session, relaunch | The transcript up to the last flushed entry appears in Session History as `crash-recovered`. No torn line breaks recovery, and the next session starts without a stale lock |
| MW-11 | Non-streaming rehearsal with `whisper-1`, 20 turns | Latency is inside `NFR-017` (p50 under 7.0 s, p95 under 10.0 s) and the badge states the latency cost |
| MW-13 | Rehearsal on each streaming STT provider, 10 turns each: Deepgram `nova-3`, OpenAI `gpt-4o-transcribe`, ElevenLabs `scribe-v2-realtime` | All three transcribe real interviewer speech correctly and all three stay inside `NFR-001` |
| MW-12 | Play music and fire a desktop notification during a session | Both are transcribed onto the interviewer stream, as `ADR-021` predicts. The session-prep note advising the user to close other audio sources is present. This check confirms the documented limitation, it does not fail on it |

---

## 7. What is deliberately not tested automatically

| Gap | Reason | Compensating control |
|---|---|---|
| Real WASAPI loopback capture | No virtual audio device in CI. Rejected as too costly in ADR-004 | MW-02, MW-04 |
| Real screen-capture exclusion | Cannot be asserted from inside the process. `setContentProtection` is the only observable | TC-004, TC-005, MW-01 |
| Real provider accuracy and cost | Non-deterministic and paid | MW-05, MW-06, and the price table version label |
| Multi-DPI rendering | No multi-monitor CI runner | MW-07 |
| Real acrylic rendering | `backgroundMaterial` needs real Windows 11 compositing | TC-142 covers the window lifecycle, MW-01 and MW-07 cover the look |
| Interviewer-only audio isolation | Impossible with WASAPI loopback. Not a v1 goal | ADR-021, MW-12 |
| Installer on a clean machine | No clean-VM CI stage in v1 | TASK-051 acceptance criteria |
