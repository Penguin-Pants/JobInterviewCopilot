# Interview CoPilot — Requirements

Version 1.0. Baseline for implementation.
Contested points are resolved in `00-decision-log.md`. That document wins.

## Conventions

- **Must** means the requirement is mandatory for v1.
- Every requirement is verifiable. Each one names the observable result.
- Numbering is grouped by brief section. `FR-0nn` maps to brief section `n`.

---

## 1. Actors and scope

| Actor | Description |
|---|---|
| Candidate | The only human user of the app. Runs it on their own Windows PC. |
| Interviewer | Speaks in the video call. Not a user. Audio reaches the app through system loopback. |
| STT provider | Deepgram or OpenAI Whisper. External service. |
| LLM provider | Anthropic or OpenAI. External service. |

The app is single-user, offline-capable for configuration and document
management, and online-dependent for transcription and suggestions.

---

## 2. Core product requirements

**FR-001** The app must be a native Windows desktop application built with
Electron and packaged with electron-builder.

**FR-002** The app must present two windows: a Dashboard for configuration and
history, and a Teleprompter overlay for live suggestions.

**FR-003** The app must generate suggestions only in response to interviewer
speech. Candidate speech must never trigger a suggestion.

**FR-004** Suggestions must be cue-form, meaning 3 to 5 short bullets of
keywords or STAR-method reminders. The app must instruct the model never to
return a scripted paragraph.

**FR-005** The overlay window must be excluded from screen capture and screen
recording. The main process must call `setContentProtection(true)` on the
overlay window before it is first shown and must never disable it. (ADR-001)

**FR-006** The app must display a consent reminder before the first suggestion
of every live session. The reminder must be dismissible and must not block
interaction with other applications. No setting may disable it. (ADR-002)

**FR-007** The consent reminder default text must state plainly that a local
text transcript of the session is kept.

**FR-008** Suggestion delivery must be gated on overlay readiness. The overlay
renderer sends `overlay:ready` after it has mounted and rendered the consent
reminder. Until then the main process must buffer `suggestion:begin`,
`suggestion:line` and `suggestion:end` rather than drop them. The buffer holds
one generation. A second generation while buffered discards the first, matching
`FR-054`. (ADR-016)

**FR-009** The Dashboard must provide a Reset Overlay action that returns the
overlay to the default position on the primary monitor, sets interactive mode and
re-registers both hotkeys. This is the escape hatch when a click-through overlay
sits off-screen and the toggle hotkey is unavailable.

---

## 3. Configuration (`FR-02n`)

**FR-020** Non-secret settings must persist through `electron-store` in a single
JSON file under `app.getPath('userData')`.

**FR-021** API keys must be encrypted with Electron `safeStorage` and stored in
a separate file from the `electron-store` JSON. A raw key must never appear in
the settings JSON, in logs, or in any IPC payload sent to a renderer.

**FR-022** If `safeStorage.isEncryptionAvailable()` returns false, the app must
refuse to save any key, must show an explanatory error in the Dashboard, and
must not fall back to plaintext storage.

**FR-023** The user must be able to select an STT primary provider and an
optional STT backup provider, independently of the LLM selection. Valid values:
`deepgram`, `whisper`.

**FR-024** The user must be able to select an LLM primary provider and an
optional LLM backup provider. Valid values: `anthropic`, `openai`.

**FR-025** The backup provider must not equal the primary provider. The
Dashboard must prevent the selection.

**FR-026** On key entry the app must run a live validation call against the
provider before saving, and must show an inline pass or fail result within 10
seconds. A failed key must not be saved.

**FR-027** The app must support multiple company profiles. Each profile holds a
name, a knowledge base folder, its documents and its session history.

**FR-028** Exactly one profile is active at a time. Deleting the active profile
must select another profile, or create a default profile if none remains.

**FR-029** Theme settings must include mode (`light`, `dark`, `system`), an
accent color, an overlay translucency mode (`acrylic`, `opacity`) and an overlay
opacity level from 0.30 to 1.00.

**FR-030** Both hotkeys must be rebindable in the Dashboard. A binding that
fails to register (already taken by another application) must be rejected with
an inline error and the previous binding must be restored.

**FR-031** The user must be able to set a session cost threshold in USD and a
session time threshold in minutes.

**FR-032** The consent reminder text template must be editable in the Dashboard.
Resetting to the shipped default must be possible in one action.

**FR-034** Secret redaction must have exactly one implementation, applied inside
the logger and inside the error serializer. No other layer may redact, and no
layer that produces log output may bypass it. A key that reaches a log line from
a path that never crosses IPC, for example a health probe error, must still be
masked. (NFR-003)

**FR-035** `logs/main.log` must rotate at 5 MB, keeping 3 files. Older files are
deleted.

**FR-036** At most 3 `settings.corrupt-*.json` files are kept. The oldest is
deleted when a fourth is created.

**FR-033** Settings must be validated against a schema on load. An invalid or
corrupt settings file must be replaced with defaults, and the corrupt file
renamed to `settings.corrupt-<timestamp>.json` rather than deleted.

---

## 4. Audio capture (`FR-03n`)

**FR-040** The app must capture two independent audio streams and must never mix
them: the interviewer stream from WASAPI loopback (system audio) and the
candidate stream from the default microphone.

**FR-041** Each stream must be converted independently to 16 kHz, 16-bit signed
little-endian, mono linear PCM. (ADR-006)

**FR-042** Each stream must emit chunks of 1000 ms. Every chunk must carry a
source tag of `interviewer` or `candidate`. (ADR-007)

**FR-043** Raw audio must never be written to disk. Buffers exist in memory only
and must be released once the chunk is handed to the STT layer.

**FR-044** If the loopback stream cannot start (no capture device, permission
denied), the app must start the candidate stream anyway, must show a Dashboard
error badge naming the failed stream, and must not start a session in a state
where the interviewer stream is silently dead.

**FR-045** If a stream ends unexpectedly mid-session, the app must attempt to
restart it up to 3 times, then surface a Dashboard error badge.

**FR-046** Stopping a session must tear down both `MediaStream` objects, close
both `AudioContext` instances and destroy the Audio Worker window.

---

## 5. Transcription (`FR-04n`)

**FR-047** One STT adapter interface must serve both providers. It must be
instantiated once per stream, so each stream keeps its own connection and its
own interim and final transcript state.

**FR-048** Every transcript event must be normalized to
`{ source, text, isFinal, timestamp, providerId }`.

**FR-049** When OpenAI Whisper REST is the active STT provider, the adapter must
buffer 4 seconds of audio per request, must emit only `isFinal: true` events,
and the Dashboard must show an informational badge naming the accuracy and
latency penalty. (ADR-008)

---

## 6. Turn detection and trigger (`FR-05n`)

**FR-050** A turn end on the interviewer stream is detected when a final
transcript segment is followed by a silence gap of `turnEndGapMs`
(default 800 ms, range 500 to 1500 ms), or when the provider emits a native
endpointing signal, whichever comes first. (ASM-007)

**FR-051** A detected turn must not fire a suggestion when the accumulated
interviewer text for that turn is shorter than 3 words or 12 characters.
(ASM-008)

**FR-052** The trigger must keep a rolling context of the last 2 candidate
turns, capped at 400 characters total, passed to the LLM as context only.
(ASM-009)

**FR-053** The `Ctrl+Shift+P` hotkey must pause and resume the trigger. Pausing
must not stop audio capture, must not close STT connections and must not end
the session. While paused, the overlay must show the idle card.

**FR-054** When a new turn end is detected while a generation is still
streaming, the in-flight generation must be cancelled and a new one started for
the newest question. The cancelled partial output must be removed from the
overlay. (ASM-004)

**FR-055** The trigger must never fire from the candidate stream.

---

## 7. RAG (`FR-06n`)

**FR-060** The app must ingest `.md` natively and must convert `.pdf` and
`.docx` to Markdown on import, using `pdf-parse` and `mammoth`.

**FR-061** The app must warn the user that PDF text extraction is best-effort.
When no heading structure is detected in a converted document, the app must wrap
the whole body in a single synthetic `# Document` section.

**FR-062** Markdown must be chunked by `#`, `##` and `###` headers. A chunk must
be capped at 500 tokens measured with the MiniLM tokenizer, soft-split on
paragraph breaks when a section exceeds the cap. (ASM-001)

**FR-063** Each chunk must carry `{ sourceFile, headerPath, docType, profileId }`.

**FR-064** Each document must be auto-tagged as `resume`, `company-notes` or
`job-description`, guessed from filename and content. The user must be able to
override the tag in the Dashboard. An override must not require re-embedding.

**FR-065** The v1 query must be plain cosine similarity, returning the top 3
chunks, scoped to the active profile. Doc-type weighting must not be
implemented. (ASM-006)

**FR-066** Embeddings must be computed locally with `@xenova/transformers` using
`Xenova/all-MiniLM-L6-v2`. The first run must show a determinate download
progress indicator. (ADR-011)

**FR-067** Embeddings must be cached to disk and keyed per ADR-012. An unchanged
file must not be re-embedded on relaunch.

**FR-068** Each profile's knowledge base folder must be watched. An add, edit or
delete must re-embed only the affected file, and the change must be reflected in
query results within 5 seconds of the file system settling.

**FR-069** Every document must belong to exactly one profile. Deleting a profile
must delete its documents, its chunks, its cached embeddings and its session
history, after an explicit confirmation naming what will be deleted.

**FR-077** The `kb/` folder is authoritative for which documents exist.
`profile.json` is a derived index. A file that appears in `kb/` without going
through `doc:import` must be adopted: a `DocumentRecord` is created, auto-tagged
and embedded, and it appears in the Dashboard. A file removed from `kb/` must
remove its record, chunks and vectors. There must be no orphan files and no
records without files. (ADR-014)

**FR-078** A reconciliation pass must run at startup, before the watcher starts.
Any document in `pending`, `converting` or `embedding` is reset to `pending` and
re-processed. `chunks.json` and `vectors.bin` must be written as a pair through
write-to-temp then rename. A mismatch between `chunkCount` and the vector row
count at load must discard both and re-embed. (ADR-014)

**FR-079** A document in `error` must be retryable from the Dashboard without
re-import. A user doc-type override must be resettable to `auto`, which
re-runs the guess.

---

## 8. LLM suggestions (`FR-07n`)

**FR-070** One LLM adapter interface must serve Anthropic and OpenAI, with the
same primary and backup failover behavior as the STT layer. (ADR-009)

**FR-071** The default model must be configurable per provider. Shipped defaults
are `claude-haiku-4-5-20251001` and `gpt-4o-mini`. (ASM-003)

**FR-072** The prompt must be built from the interviewer question, the candidate
context window (`FR-052`) and the top 3 RAG chunks with their doc-type labels.

**FR-073** The system prompt must require 3 to 5 short bullets of keywords or
STAR-method reminders and must forbid a scripted paragraph.

**FR-074** Tokens must be buffered in the main process and flushed to the
overlay once per completed bullet or line. Per-token and per-character delivery
to the overlay is forbidden.

**FR-075** A generation must be cancellable. Cancellation must abort the
provider request, not merely stop reading it.

**FR-076** The overlay must never show an error card. Provider failures are
reported only through the Dashboard status badge. (`FR-100`)

---

## 9. Windows and IPC (`FR-08n`)

**FR-080** The Dashboard window must be a standard resizable window that follows
the theme mode setting.

**FR-081** The overlay window must be created with `transparent: true`,
`frame: false`, `alwaysOnTop: true`, `skipTaskbar: true`, `resizable: false`,
and content protection enabled. (`FR-005`, ASM-005)

**FR-082** The overlay must be draggable to any position on any connected
monitor. Its last position and monitor must persist. On relaunch, if the stored
monitor is no longer present, the overlay must be placed on the primary monitor
in its default position.

**FR-083** The overlay must default to click-through using
`setIgnoreMouseEvents(true, { forward: true })`.

**FR-084** The `Ctrl+Shift+I` hotkey must toggle between click-through mode and
interactive mode. The overlay must show a clear visual state difference between
the two modes. (ASM-002)

**FR-085** Overlay translucency mode and opacity must come from the theme
settings and must apply without a restart.

**FR-086** The renderer must run with `contextIsolation: true`,
`nodeIntegration: false` and `sandbox: true`. All main-process access must go
through a typed preload bridge.

**FR-087** The Dashboard must expose these sections: Provider Setup, Company
Profiles, Session History, Hotkeys, Cost and Usage, Consent Reminder.

**FR-088** The Dashboard must have an explicit Start Session and Stop Session
control. A session must never start implicitly. Only one session may be active.
(ADR-013)

**FR-089** Acrylic translucency must use Electron's built-in
`backgroundMaterial: 'acrylic'`. No third-party native blur module may be added.
Because `backgroundMaterial` and `transparent: true` are mutually exclusive, the
two translucency modes are two different window constructions, and changing the
mode must destroy and recreate the overlay window, preserving position, monitor,
click-through state and the current card stack. Changing the opacity level alone
must apply live with no recreation. On Windows 10 the acrylic option must be
disabled in the Dashboard with an explanatory note. CSS `backdrop-filter` must
not be used as a substitute. (ADR-015)

---

## 10. Overlay UX (`FR-09n`)

**FR-090** The idle state must be a small translucent card with a standing-by
message, shown before the first suggestion and whenever the trigger is paused.

**FR-091** The active state must show a stack of the 3 most recent suggestion
cards. A new card entering must fade the oldest out through Framer Motion
`AnimatePresence`. (ASM-010)

**FR-092** Each completed bullet must reveal with a fade plus a slight upward
slide over 200 to 300 ms. Per-word reveal is forbidden.

**FR-093** Suggestion text must default to 22 px, must meet a contrast ratio of
at least 4.5 to 1 against the card background in both themes, and must be
adjustable from 16 px to 32 px from the Dashboard and from an in-overlay
control.

**FR-094** Overlay cards must be built from Magic UI components on Tailwind,
styled from the theme tokens in `FR-029`.

---

## 11. Failure handling, logging and cost (`FR-10n`)

**FR-100** STT and LLM failures must retry silently, must fail over to the
backup when one is configured, and must be reported only through a quiet
Dashboard status badge. (ADR-009, ADR-010)

**FR-101** Every live session must write a text transcript containing
interviewer turns, candidate turns and generated suggestions, grouped under the
session's company profile. Audio must never be written. The transcript is kept
until the user deletes it. (ADR-003, ASM-012)

**FR-102** An extended silence must not be treated as an error. The idle card
persists.

**FR-103** During a live session the Dashboard must show a running timer and an
estimated spend at all times. Crossing either configured threshold must produce
exactly one warning per session per threshold. The session must never be stopped
automatically. (ASM-011)

**FR-104** A previously valid key that starts failing mid-session must be
handled as a provider failure per `FR-100`, not as a configuration error.

**FR-105** A crash or force-close during a live session must leave the
transcript recoverable up to the last flushed entry. Transcript entries must be
appended to disk within 2 seconds of being produced, not held until session end.

**FR-106** The Session Manager must be the only writer of a session file. The
Cost Meter holds usage in memory and hands it over. Every `TranscriptEntry`
carries a monotonic `seq` assigned at append time. A cancelled generation must be
appended, carrying the bullets already flushed, before the entry for the
replacing generation is appended. (ADR-018)

**FR-107** Each transcript entry must be written as one call of one complete line
ending in a newline. Compaction must discard an unparseable final line and
recover the rest. When both a `.json` and a `.ndjson` exist for one session, the
`.json` wins and the `.ndjson` is deleted. (ADR-018)

**FR-108** A session lock file must prevent a second session across process
restarts. A stale lock from a crashed process must be detected and cleared during
crash recovery, not left to block the next session.

**FR-109** The cost and time warnings are edge-triggered upward only. Once a
threshold has warned, it never re-arms for that session, including when the
estimate decreases after a cancelled generation. (`FR-103`)

---

## 12. Non-functional requirements

**NFR-001** *(Latency)* From interviewer turn end to the first bullet appearing
in the overlay, the p50 must be under 2.5 seconds and the p95 under 4.0 seconds,
measured with Deepgram STT and a Haiku-class model on a 25 Mbit/s connection.

**NFR-002** *(Audio privacy)* No code in this project may write audio bytes to
disk. Enforced three ways: an ESLint ban on filesystem imports in the audio path,
an integration test that monitors every filesystem write during a synthetic
session and asserts none contains PCM, and an assertion that the app's own
temporary directory is empty at session end. The Whisper adapter must build its
request body in memory and must never pass a file stream or a path, so a
third-party spool to a temp file is caught by the same test. (ADR-019)

**NFR-003** *(Secret handling)* No API key may appear in a log line, a crash
report, an IPC payload to a renderer, or the settings JSON. Secrets must be
redacted in all error objects.

**NFR-004** *(Memory)* Steady-state main-process resident memory during a
60-minute session must stay under 600 MB, with no upward trend across the last
30 minutes.

**NFR-005** *(CPU)* Average CPU across all processes must stay under 15 percent
of one core on a 4-core machine during a live session, excluding the first-run
model download.

**NFR-006** *(Startup)* The Dashboard must be interactive within 3 seconds of
launch on a warm start.

**NFR-007** *(Overlay frame rate)* Card animations must hold 60 fps on
integrated graphics. No animation may run while the overlay is idle.

**NFR-008** *(Offline behavior)* With no network, the app must still start,
manage profiles, ingest documents and compute embeddings. A session start must
warn that transcription is unavailable.

**NFR-009** *(Resilience)* No unhandled promise rejection or uncaught exception
may terminate a live session. The main process must install global handlers that
log and continue.

**NFR-010** *(Accessibility)* The Dashboard must be fully keyboard navigable and
must respect `prefers-reduced-motion` by disabling the slide component of the
overlay reveal.

**NFR-011** *(Platform)* Windows 10 and Windows 11, x64 only.

**NFR-012** *(Capture exclusion fidelity)* True capture exclusion requires
Windows 10 build 19041 (version 2004) or later. On older builds the app must
detect the build number at startup and warn **once per session**, alongside the
consent reminder, that the overlay will appear as a black rectangle in screen
shares rather than being invisible. A once-per-install warning is not enough: a
user who dismisses it on first launch must not be surprised months later.

**NFR-013** *(Signing)* v1 ships unsigned. The installer must be reproducible
from a clean checkout with one documented command. (ASM-013)

**NFR-014** *(Language)* English only. (ASM-014)

**NFR-016** *(Vendored components)* Code copied into the repository rather than
installed, Magic UI in particular, is invisible to the npm license check. Every
vendored component must be listed in `VENDORED.md` with its source URL, the
commit or version copied, and its license. CI must fail when a file under
`src/renderer/**/vendor/` is not covered by an entry.

**NFR-017** *(Whisper-primary latency)* With Whisper as the STT primary, turn end
to first bullet must be p50 under 7.0 s and p95 under 10.0 s. `NFR-001` does not
apply to this configuration. The Dashboard degraded-mode badge must state the
latency cost, not only the accuracy cost. (ADR-020)

**NFR-015** *(Licensing)* Every runtime dependency must carry an MIT, Apache-2.0,
BSD or ISC license. A license check must run in CI and must fail the build on a
copyleft runtime dependency.
