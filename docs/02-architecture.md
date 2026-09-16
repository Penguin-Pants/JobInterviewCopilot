# Interview CoPilot — Technical Design

Version 1.0. Baseline for implementation.
Decisions referenced as `ADR-nnn` are in `00-decision-log.md`.

---

## 1. Process and component map

Electron gives three process kinds. This app uses four window contexts.

```
+-------------------------------------------------------------+
| MAIN PROCESS (Node)                                          |
|                                                              |
|  CMP-01 Bootstrap / Window Orchestrator   src/main/index.ts   |
|  CMP-02 Config + Secrets    config.ts, secrets.ts             |
|  CMP-03a Audio Supervisor   audio.ts                          |
|  CMP-04 STT Layer           ai/stt.ts + ai/stt/*.ts           |
|  CMP-05 Trigger             ai/trigger.ts                     |
|  CMP-06 RAG Engine          rag.ts + rag/*.ts                 |
|  CMP-07 LLM Layer           ai/llm.ts + ai/llm/*.ts           |
|  CMP-08 Session Manager     session.ts                        |
|  CMP-09 Cost Meter          cost.ts                           |
|  CMP-10 IPC Router          ipc/router.ts                     |
|  CMP-11 Hotkey Manager      hotkeys.ts                        |
|  CMP-12 Provider Health     health.ts                         |
+-------------------------------------------------------------+
        |                 |                  |
   preload bridge    preload bridge     preload bridge
        |                 |                  |
+---------------+  +---------------+  +---------------------+
| CMP-13        |  | CMP-14        |  | CMP-03b             |
| Dashboard     |  | Overlay       |  | Audio Worker        |
| renderer      |  | renderer      |  | hidden renderer     |
| React + TW    |  | React + TW    |  | no UI, AudioWorklet |
+---------------+  +---------------+  +---------------------+
```

### Component responsibilities

| ID | Name | Owns | Must not |
|---|---|---|---|
| CMP-01 | Window Orchestrator | App lifecycle, window creation, content protection, single-instance lock | Contain business logic |
| CMP-02 | Config and Secrets | Settings schema, defaults, migration, `safeStorage` key vault | Expose a raw key to any renderer |
| CMP-03a | Audio Supervisor | Audio Worker lifecycle, stream health, chunk fan-out | Touch WebAudio APIs directly (ADR-005) |
| CMP-03b | Audio Worker | Two `MediaStream`s, two `AudioContext`s at 16 kHz, PCM framing | Persist anything, render UI |
| CMP-04 | STT Layer | Provider adapters, per-stream sessions, normalized events | Decide when a turn ends |
| CMP-05 | Trigger | Turn-end state machine, candidate context ring, pause state | Call an LLM provider directly |
| CMP-06 | RAG Engine | Ingest, convert, chunk, embed, cache, watch, query, startup reconciliation | Know about sessions. Only `rag.ts` is importable from outside, enforced by a lint rule against deep imports |
| CMP-07 | LLM Layer | Provider adapters, prompt assembly, line buffering, cancellation | Write to the transcript |
| CMP-08 | Session Manager | Session lifecycle, sole writer of the session file, `seq` assignment, consent gate, profile binding | Own provider retry logic |
| CMP-09 | Cost Meter | Token and audio-minute accounting, spend estimate, threshold warnings | Stop a session, or hold a session file handle (ADR-018) |
| CMP-10 | IPC Router | Channel registration and payload validation | Hold session or business state, or redact (redaction lives in the logger alone, FR-034) |
| CMP-11 | Hotkey Manager | Global shortcut registration, rebinding, conflict reporting | Interpret app state |
| CMP-12 | Provider Health | Failover state keyed by **credential**, backoff, background re-probe | Be keyed by capability (ADR-017) |
| CMP-13 | Dashboard renderer | All configuration and history UI | Hold authoritative state |
| CMP-14 | Overlay renderer | Idle card, suggestion stack, consent reminder, font control | Fetch from any network |

**State ownership rule.** The main process is the single source of truth.
Renderers hold only derived view state and re-render from pushed events. A
renderer never persists anything.

---

## 2. Data model

All paths are relative to `app.getPath('userData')`.

```
settings.json                 electron-store, non-secret, schema-versioned
secrets.bin                   safeStorage ciphertext, one JSON blob
profiles/
  <profileId>/
    profile.json              profile metadata
    kb/                       watched knowledge base folder (user drops files here)
    derived/
      <docId>.md              converted Markdown for pdf/docx sources
      <docId>.chunks.json     chunk text + metadata
      <docId>.vectors.bin     Float32Array, 384 dims per chunk, row-major
    sessions/
      <sessionId>.json        transcript + suggestions + usage
models/
  Xenova/all-MiniLM-L6-v2/    downloaded on first run
logs/
  main.log                    rotated, secrets redacted
```

### 2.1 Settings (`settings.json`)

```ts
interface Settings {
  schemaVersion: 1;
  activeProfileId: string;
  providers: {
    stt: {
      primary: ProviderChoice;              // default { providerId:'deepgram', modelId:'nova-3' }
      backup: ProviderChoice | null;
    };
    llm: {
      primary: ProviderChoice;              // default { providerId:'anthropic',
                                            //           modelId:'claude-haiku-4-5-20251001' }
      backup: ProviderChoice | null;
    };
  };
  theme: {
    mode: 'light' | 'dark' | 'system';
    accent: string;                        // hex, '#6366F1'
    overlayTranslucency: 'acrylic' | 'opacity';
    overlayOpacity: number;                // 0.30 .. 1.00, default 0.85
    overlayFontSizePx: number;             // 16 .. 32, default 22
  };
  hotkeys: {
    toggleInteraction: string;             // default 'Control+Shift+I'
    togglePause: string;                   // default 'Control+Shift+P'
  };
  trigger: {
    turnEndGapMs: number;                  // 500 .. 1500, default 800
    minTurnWords: number;                  // default 3
    minTurnChars: number;                  // default 12
    candidateContextTurns: number;         // default 2
    candidateContextChars: number;         // default 400
  };
  thresholds: {
    costUsd: number;                       // default 2.00
    timeMinutes: number;                   // default 60
  };
  consentReminderText: string;
  overlayWindow: {
    x: number | null;
    y: number | null;
    displayId: string | null;
  };
  firstRun: { modelDownloaded: boolean };
}

/** A provider and model pair. Both are registry keys, not a closed union. */
interface ProviderChoice { providerId: string; modelId: string; }

type CredentialId = 'deepgram' | 'openai' | 'anthropic' | 'elevenlabs';
```

### 2.1a Provider registries (ADR-022)

Two registries, `src/shared/registry/stt.ts` and `src/shared/registry/llm.ts`.
They are data, and they are the only place a provider is named. Adding a provider
is one entry plus one adapter (`FR-037`).

```ts
/**
 * Generic over its model descriptor, because STT and LLM models carry different
 * fields. This originally read `models: ModelDescriptor[]`, a type this document
 * never defined; corrected during TASK-002 when the types were implemented.
 */
interface ProviderDescriptor<M> {
  id: string;                     // 'deepgram', 'openai', 'elevenlabs', 'anthropic'
  displayName: string;
  credentialId: CredentialId;     // which vault key it uses
  models: M[];
}

interface SttModelDescriptor {
  id: string;                     // 'nova-3', 'gpt-4o-transcribe', 'scribe-v2-realtime', 'whisper-1'
  displayName: string;
  streaming: boolean;             // false => held to NFR-017, not NFR-001
  supportsInterim: boolean;
  supportsEndpointing: boolean;
  audio: { encoding: 'linear16'; sampleRate: 16000; channels: 1 };
  pricePerAudioMinuteUsd: number;
  badge?: string;                 // shown in the Dashboard, e.g. the Whisper penalty text
}

interface LlmModelDescriptor {
  id: string;
  displayName: string;
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
}
```

**v1 STT registry contents.**

| Provider | Model | Streaming | Interim | Endpointing | Transport |
|---|---|---|---|---|---|
| `deepgram` | `nova-3` (default), `nova-2` | yes | yes | native | WebSocket |
| `openai` | `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` | yes | yes | server VAD | realtime transcription WebSocket |
| `elevenlabs` | `scribe-v2-realtime` | yes | partial then committed | committed segments | WebSocket, `pcm_16000` |
| `openai` | `whisper-1` | **no** | no | no | REST, 4 s buffers |

Every streaming model above accepts 16 kHz, 16-bit, mono linear PCM, which is
exactly what `FR-041` produces. No per-provider resampling is needed.

**v1 LLM registry contents.** `anthropic` with `claude-haiku-4-5-20251001`
(default), `openai` with `gpt-4o-mini`. No new providers in v1.

### 2.2 Secrets (`secrets.bin`)

Plaintext shape before `safeStorage.encryptString`:

```ts
interface SecretVault {
  deepgramApiKey?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  elevenlabsApiKey?: string;
}
```

Keys are keyed by `CredentialId`, and a provider names the credential it uses.
The OpenAI key serves OpenAI STT models and OpenAI LLM models alike. There is one
OpenAI key, not two. The Dashboard must state this, and `CMP-12` keys health by
credential for exactly this reason (ADR-017).

### 2.3 Profile and documents

**Authority rule (ADR-014, FR-077).** The `kb/` folder is the source of truth for
which documents exist. `profile.json` is a derived index. A file that appears in
`kb/` outside `doc:import` is adopted, not ignored. A file that disappears takes
its record, chunks and vectors with it. A startup reconciliation pass runs before
the watcher starts and resets any document left in a non-terminal state.

```ts
interface Profile {
  id: string;            // uuid v4
  name: string;
  createdAt: string;     // ISO 8601
  kbPath: string;        // absolute
  documents: DocumentRecord[];
}

interface DocumentRecord {
  id: string;                  // uuid v4
  profileId: string;
  originalFileName: string;
  originalPath: string;        // inside kb/
  sourceFormat: 'md' | 'pdf' | 'docx';
  derivedMarkdownPath: string | null;   // null when sourceFormat === 'md'
  docType: DocType;
  docTypeSource: 'auto' | 'user';       // a user override is never re-guessed
  contentHash: string;                  // sha256 of original bytes
  embeddingKey: string;                 // ADR-012
  chunkCount: number;
  state: 'pending' | 'converting' | 'embedding' | 'ready' | 'error';
  errorMessage: string | null;
  extractionQuality: 'native' | 'best-effort';  // 'best-effort' for pdf
  updatedAt: string;
}

type DocType = 'resume' | 'company-notes' | 'job-description';
```

### 2.4 Chunks and vectors

```ts
interface Chunk {
  id: string;            // `${docId}#${index}`
  docId: string;
  profileId: string;
  index: number;
  text: string;
  headerPath: string[];  // e.g. ['Experience', 'Acme Corp']
  docType: DocType;
  sourceFile: string;    // originalFileName
  tokenCount: number;
}
```

Vectors are stored separately in `<docId>.vectors.bin` as a flat
`Float32Array` of `chunkCount * 384` values, L2-normalized at write time. Row
`i` belongs to chunk index `i`. Normalizing at write time makes the query a plain
dot product.

### 2.5 Session and transcript

```ts
interface Session {
  id: string;               // uuid v4
  profileId: string;        // bound at start, immutable (ADR-013)
  profileNameSnapshot: string;
  startedAt: string;
  endedAt: string | null;
  entries: TranscriptEntry[];
  usage: UsageRecord;
  endReason: 'user' | 'crash-recovered' | null;
}

type TranscriptEntry = { seq: number } & (
  | { kind: 'turn'; source: 'interviewer' | 'candidate'; text: string; at: string }
  | { kind: 'suggestion'; forQuestion: string; bullets: string[];
      model: string; providerId: string; at: string;
      status: 'complete' | 'cancelled' | 'nonconforming' }
);
// `seq` is monotonic and assigned by CMP-08 at append time. Order is seq order,
// not file order. A cancelled generation is appended, carrying the bullets
// already flushed, before the replacing generation's entry. (ADR-018, FR-106)

interface UsageRecord {
  sttAudioSeconds: { interviewer: number; candidate: number };
  llmInputTokens: number;
  llmOutputTokens: number;
  estimatedUsd: number;
  priceTableVersion: string;
  warningsIssued: ('cost' | 'time')[];   // at most one of each (FR-103)
}
```

Sessions are appended to disk as newline-delimited JSON during the session
(`<sessionId>.ndjson`) and compacted into `<sessionId>.json` on clean stop. Each
entry is one `write()` of one complete line ending in a newline, so a crash can
lose a line but cannot tear one. A `.ndjson` file found at startup means a crash.
It is compacted with `endReason: 'crash-recovered'`, discarding an unparseable
final line. When both a `.json` and a `.ndjson` exist for one session the `.json`
wins and the `.ndjson` is deleted. A `session.lock` file next to the sessions
folder enforces one session at a time across restarts and is cleared by the same
recovery pass. This satisfies `FR-105`, `FR-107` and `FR-108`.

### 2.6 Runtime events (not persisted)

```ts
interface TranscriptEvent {
  source: 'interviewer' | 'candidate';
  text: string;
  isFinal: boolean;
  timestamp: number;        // epoch ms, chunk arrival time
  providerId: string;         // registry key, e.g. 'deepgram'
}

interface AudioChunk {
  source: 'interviewer' | 'candidate';
  pcm: ArrayBuffer;         // 16 kHz, 16-bit LE, mono, 1000 ms => 32000 bytes
  timestamp: number;
  sequence: number;         // per-source monotonic, gap detection
}

interface SuggestionLine {
  generationId: string;
  cardId: string;
  line: string;             // one completed bullet
  index: number;
}
```

---

## 3. Key interfaces

### 3.1 STT adapter (`CMP-04`)

```ts
interface SttSession {
  readonly source: 'interviewer' | 'candidate';
  readonly choice: ProviderChoice;
  push(chunk: AudioChunk): void;
  close(): Promise<void>;
  on(e: 'transcript', h: (t: TranscriptEvent) => void): void;
  on(e: 'endpoint', h: () => void): void;      // provider-native turn end
  on(e: 'error', h: (err: ProviderError) => void): void;
}

interface SttProvider {
  readonly id: string;
  open(choice: ProviderChoice, source: 'interviewer' | 'candidate',
       key: string): Promise<SttSession>;
  validateKey(key: string, modelId: string): Promise<ValidationResult>;
}
```

Capability flags come from the **registry entry for the selected model**, never
from the provider id. `CMP-05` reads `supportsEndpointing` off the descriptor, so
a new streaming provider needs no trigger change (`FR-037`, `TC-056`).

`supportsEndpointing: true` means one thing: this model's native turn-end signal
fires at `settings.trigger.turnEndGapMs`, the gap the user chose. It does not
mean "the provider has some endpoint signal". A provider that commits on its own
schedule is `false`, and `CMP-05` runs the local timer instead, so a native
signal can never preempt the user's value (`FR-050`, `TC-159`). Clarified during
`TASK-012`, where the flag was otherwise ambiguous for ElevenLabs.

All three v1 streaming providers take the gap as a parameter, so all three are
`true`. Each adapter passes it to a differently named field:

| Model | Field carrying `turnEndGapMs` |
|---|---|
| `deepgram:nova-*` | `endpointing` on the socket URL |
| `openai:gpt-4o*-transcribe` | `turn_detection.silence_duration_ms`, server VAD |
| `elevenlabs:scribe-v2-realtime` | `min_silence_duration_ms`, VAD commit strategy |

`openai:whisper-1` has no turn signal at all and is `false`.

Adapter notes:
- `deepgram`: WebSocket with `encoding=linear16`, `sample_rate=16000`,
  `channels=1`, `interim_results=true`, and
  `endpointing=<settings.trigger.turnEndGapMs>`. The configured gap is passed
  through, never hard-coded, so a native signal cannot preempt the user's chosen
  value (`FR-050`). A provider that cannot accept the value has native
  endpointing disabled and falls back to the local timer.
- `openai` streaming: realtime transcription WebSocket, a transcription session
  configured with the chosen model and server VAD. Deltas map to
  `isFinal: false`, completed items to `isFinal: true`, the VAD stop event to
  `endpoint`. Audio goes up base64-encoded inside an
  `input_audio_buffer.append` frame; this is the one v1 provider that does not
  take raw binary frames.
- `elevenlabs`: Scribe v2 Realtime WebSocket, input format `pcm_16000`, commit
  strategy `vad`. Partial transcripts map to `isFinal: false`, committed
  segments to `isFinal: true` and to `endpoint`.
- `openai` `whisper-1`: the one non-streaming model. Buffers 4000 ms, posts an
  in-memory WAV body, emits one final event per request, never an interim, never
  an endpoint. Held to `NFR-017`. (ADR-022)

### 3.2 LLM adapter (`CMP-07`)

```ts
interface LlmProvider {
  readonly id: string;              // registry key
  generate(req: GenerationRequest, signal: AbortSignal):
    AsyncIterable<{ delta: string } | { usage: TokenUsage }>;
  validateKey(key: string): Promise<ValidationResult>;
}

interface GenerationRequest {
  generationId: string;
  question: string;
  candidateContext: string;
  chunks: RetrievedChunk[];   // up to 3
  choice: ProviderChoice;     // provider + model from the LLM registry
}
```

The adapter yields raw deltas. Line buffering is done above the adapter in
`CMP-07`, so both providers get identical overlay behavior (`FR-074`).

### 3.3 Line buffer rule (`FR-074`)

Accumulate deltas into a pending string. Flush a `SuggestionLine` when the
pending string contains `\n`, splitting on it. Flush the remainder when the
stream completes.

Structure is enforced here, not left to the prompt (`FR-004`, ADR-025):

1. **Forced flush.** If the pending string reaches 240 characters with no
   newline, flush up to the last word boundary before 240. Never mid-word. The
   remainder stays pending.
2. **Line cap.** A flushed line longer than 120 characters is prose, not a cue.
   Truncate it at the last word boundary before 120 and append an ellipsis.
3. **Card cap.** A card renders at most 5 lines. Line 6 and beyond are dropped,
   never sent.
4. **Diagnostics.** A generation that completed without ever emitting a newline
   is recorded in the transcript with `status: 'nonconforming'`. The overlay
   still shows the salvaged lines. It never shows an error, per `FR-076`.

### 3.4 Retrieval (`CMP-06`)

```ts
function query(profileId: string, text: string, k = 3): Promise<RetrievedChunk[]>;

interface RetrievedChunk { chunk: Chunk; score: number; }
```

Cosine similarity over L2-normalized vectors, so a dot product. Brute force over
the profile's vectors. At an expected ceiling of 5000 chunks per profile a brute
force scan is under 5 ms. No vector index in v1.

### 3.5 Provider health and failover (`CMP-12`, ADR-009, ADR-010)

```ts
type ErrorClass = 'auth' | 'rate-limit' | 'network' | 'timeout' | 'server' | 'client';

interface ProviderError extends Error {
  class: ErrorClass;
  providerId: string;
  retryable: boolean;     // false for 'auth' and 'client'
}
```

State machine per **credential** (`deepgram`, `openai`, `anthropic`), not per
capability, because one OpenAI key serves both Whisper and GPT (ADR-017):

```
USING_PRIMARY
  |  failure
  v
RETRYING (attempt 1..3, backoff 250/500/1000 ms +/-20% jitter)
  |  success -> USING_PRIMARY
  |  auth error -> skip straight to next state (ADR-010)
  |  3 failures
  v
USING_BACKUP (sticky for the session)            -- if a backup is configured
  |  probe primary every 60s, 2 consecutive passes
  v
USING_PRIMARY (at next clean boundary)
       clean boundary = the next turn for LLM, and for STT the next turn
       boundary with no audio in flight. An STT provider switch never
       happens mid-utterance.

**Whether a backup exists is a property of the capability binding, not of the
credential.** One OpenAI key can be the LLM primary with no backup and the STT
backup at the same time, so the two capabilities disagree about whether there is
anywhere to fail over to. The machine is therefore told per request, and a
capability never falls to a backup that belongs to the other one. Clarified
during `TASK-014`, where the shared-credential case otherwise had two answers.

**`CONFIG_REQUIRED` is terminal for the credential, not for one capability.** A
revoked key stays revoked even where another capability routes around it, so
nothing but a newly saved, validated key moves the machine out of that state.

**Projecting credential health onto `CH-202`.** The state machine is keyed by
credential; `CH-202` is keyed by capability. A capability reports the worst
state among every credential it depends on, its backup included. `TC-143` is the
reason: there OpenAI is the STT *backup* and the LLM primary, so reading the
primary alone would leave STT looking healthy while the key it would fail over
to is revoked. Both capabilities report the same `config-required` naming the
same `credentialId`, and the Dashboard groups by that id to render one badge
naming both capabilities rather than two badges saying the same thing.

**A clean boundary for STT requires no audio in flight.** The switch-back takes
the live chunk count and refuses while it is above zero, so `TC-144` is enforced
by the code rather than by the caller remembering. The pending switch is held,
not cancelled.

If no backup is configured, the path splits on `retryable` (ADR-024):

DEGRADED         -- retryable failure (network, timeout, server, rate-limit).
                    Keep retrying the primary with backoff capped at 10 s.
                    Dashboard badge visible, overlay unchanged (FR-076).

CONFIG_REQUIRED  -- non-retryable failure (auth, client). Terminal for that
                    credential for the rest of the session. No further requests
                    are sent, so a revoked key does not fire a doomed request
                    every ten seconds for the whole interview. The Dashboard
                    badge names the credential and the remedy. The state clears
                    when the user saves a new key for that credential, which
                    runs live validation (FR-026). Overlay unchanged.
```

---

## 4. IPC contract

All channels are declared in one file, `src/shared/ipc.ts`, and typed on both
sides. Payloads are validated with `zod` at the router (`CMP-10`). An invalid
payload is rejected and logged, never passed through.

### Renderer to main, request/response (`ipcRenderer.invoke`)

| ID | Channel | Payload | Returns |
|---|---|---|---|
| CH-101 | `config:get` | none | `Settings` (never secrets) |
| CH-102 | `config:set` | `Partial<Settings>` | `Settings` |
| CH-103 | `secrets:set` | `{ provider, key }` | `ValidationResult` (validates then saves, `FR-026`) |
| CH-104 | `secrets:status` | none | `{ deepgram: boolean, openai: boolean, anthropic: boolean }` |
| CH-105 | `profile:list` | none | `Profile[]` |
| CH-106 | `profile:create` | `{ name }` | `Profile` |
| CH-107 | `profile:delete` | `{ id }` | `{ ok: true }` |
| CH-108 | `profile:activate` | `{ id }` | `{ ok: true }` |
| CH-109 | `doc:import` | `{ profileId, paths[] }` | `DocumentRecord[]` |
| CH-110 | `doc:setType` | `{ docId, docType }` | `DocumentRecord` |
| CH-111 | `doc:delete` | `{ docId }` | `{ ok: true }` |
| CH-112 | `session:start` | none | `{ sessionId }` or error |
| CH-113 | `session:stop` | none | `{ sessionId }` |
| CH-114 | `session:list` | `{ profileId }` | `SessionSummary[]` |
| CH-115 | `session:read` | `{ sessionId }` | `Session` |
| CH-116 | `session:delete` | `{ sessionId }` | `{ ok: true }` |
| CH-117 | `hotkey:rebind` | `{ action, accelerator }` | `{ ok } \| { error }` |
| CH-118 | `overlay:setInteractive` | `{ interactive }` | `{ ok: true }` |
| CH-119 | `overlay:savePosition` | `{ x, y, displayId }` | `{ ok: true }` |
| CH-120 | `consent:dismiss` | none | `{ ok: true }` |

### Main to renderer, push (`webContents.send`)

| ID | Channel | Target | Payload |
|---|---|---|---|
| CH-201 | `state:session` | both | `{ active, sessionId, profileName, startedAt, paused }` |
| CH-202 | `state:providers` | dashboard | `{ stt: HealthState, llm: HealthState }` |
| CH-203 | `state:audio` | dashboard | `{ interviewer: StreamState, candidate: StreamState }` |
| CH-204 | `state:usage` | dashboard | `UsageRecord + { elapsedSeconds }` |
| CH-205 | `usage:warning` | dashboard | `{ kind: 'cost' \| 'time', value, threshold }` |
| CH-206 | `transcript:live` | dashboard | `TranscriptEvent` |
| CH-207 | `suggestion:begin` | overlay | `{ generationId, cardId, question }` |
| CH-208 | `suggestion:line` | overlay | `SuggestionLine` |
| CH-209 | `suggestion:end` | overlay | `{ generationId, status: 'complete' \| 'cancelled' }` |
| CH-210 | `overlay:consent` | overlay | `{ text }` |
| CH-211 | `overlay:theme` | overlay | theme subset of `Settings` |
| CH-212 | `overlay:mode` | overlay | `{ interactive, paused }` |
| CH-213 | `rag:progress` | dashboard | `{ docId, state, percent }` |
| CH-214 | `model:download` | dashboard | `{ percent, done }` |

### Audio Worker channels (`CMP-03b`)

| ID | Channel | Direction | Payload |
|---|---|---|---|
| CH-301 | `audio:start` | main to worker | `{ streams: ('interviewer'\|'candidate')[] }` |
| CH-302 | `audio:stop` | main to worker | none |
| CH-303 | `audio:chunk` | worker to main | `AudioChunk` (transferable `ArrayBuffer`) |
| CH-304 | `audio:streamState` | worker to main | `{ source, state, error? }` |

**Correction, found while implementing Milestone 0 (OQ-003).** `CH-303` was
specified to transfer the `ArrayBuffer` so the worker's reference is neutered on
send, "enforcing `FR-043` by construction". Electron cannot do that. Both
`ipcRenderer.postMessage` and `MessagePortMain.postMessage` accept only
`MessagePort` values in their transfer list, so every buffer crossing Electron
IPC is structured-cloned, which means copied.

`FR-043` and `NFR-002` still hold: a copy in memory is never written to disk.
What is gone is the "by construction" part. The guarantee rests on the ESLint ban
across the whole reachable audio path and on the runtime filesystem-write monitor
(`TC-137`).

**Resolved by ADR-027.** The copy is accepted: 31 KiB and 0.08 ms per chunk, or
0.008 percent of the chunk budget. The property that is enforced instead is
bounded retention, because unbounded accumulation, not copying, is what would put
220 MiB of interview audio in memory over one session. `CH-303` therefore sends
by copy, every reference is released once its chunk is handed on, and deliberate
buffering is bounded by a declared constant.

---

## 5. Critical sequences

### 5.1 Session start

```
Dashboard  -> CH-112 session:start
CMP-08     validates: a profile is active, no session is running,
           at least an STT primary key and an LLM primary key exist
CMP-08     creates sessionId, opens <id>.ndjson
CMP-01     shows overlay, setContentProtection(true) already applied
CMP-14     receives CH-210 overlay:consent, renders the reminder card
CMP-03a    creates the Audio Worker, sends CH-301
CMP-03b    acquires loopback + mic, builds two 16 kHz contexts
CMP-04     opens one SttSession per stream
CMP-05     enters LISTENING
CMP-09     starts the timer, begins accounting
Dashboard  receives CH-201 state:session { active: true }
```

If the consent card has not been dismissed when the first suggestion is ready,
the suggestion still renders. The reminder is non-blocking (ADR-002). What is
mandatory is that it was shown.

### 5.2 Turn to suggestion

```
CMP-03b  CH-303 audio:chunk (interviewer, 1000 ms)
CMP-03a  fan-out to the interviewer SttSession
CMP-04   CH-206 transcript:live (interim, then final)
CMP-05   final received -> start turnEndGapMs timer
         any new interim/final restarts the timer
         Deepgram endpoint event -> fire immediately
CMP-05   timer elapses -> guard FR-051 (>=3 words, >=12 chars)
         if a generation is in flight -> abort it, CH-209 status 'cancelled'
CMP-06   query(activeProfileId, questionText, 3)
CMP-07   build prompt, call provider, CH-207 suggestion:begin
CMP-07   buffer deltas, flush per line -> CH-208 suggestion:line (xN)
CMP-07   stream ends -> CH-209 suggestion:end 'complete'
CMP-08   append the suggestion TranscriptEntry
CMP-09   add token usage, recompute spend, maybe CH-205 usage:warning
```

### 5.3 Trigger state machine (`CMP-05`)

```
states: IDLE, LISTENING, AWAITING_TURN_END, GENERATING, PAUSED

IDLE            --session:start-->            LISTENING
LISTENING       --interviewer final-->        AWAITING_TURN_END
AWAITING_TURN_END --new interim/final-->      AWAITING_TURN_END (timer reset)
AWAITING_TURN_END --gap elapsed, guard fail-->LISTENING
AWAITING_TURN_END --gap elapsed, guard pass-->GENERATING
GENERATING      --stream end-->               LISTENING
GENERATING      --new turn end-->             GENERATING (abort old, start new)
any             --Ctrl+Shift+P-->             PAUSED
PAUSED          --Ctrl+Shift+P-->             LISTENING
PAUSED          --entering-->                 abort in-flight, overlay idle card
any             --session:stop-->             IDLE
```

Candidate-stream finals only append to the context ring. They never cause a
state change. This is the mechanical guarantee behind `FR-003` and `FR-055`.

---

## 6. Prompt specification (`FR-072`, `FR-073`)

System prompt, fixed, not user-editable in v1:

```
You are a live interview memory aid for a candidate who has consented to
using this tool. Answer with 3 to 5 very short bullets. Each bullet is at
most 12 words. Use keywords, concrete facts from the candidate's notes,
or STAR-method reminders (Situation, Task, Action, Result).

Never write a paragraph. Never write a sentence the candidate could read
aloud verbatim. You are producing cues, not a script.

If the notes do not cover the question, say so in one bullet and give
structural cues instead of invented facts. Never invent an employer,
a date, a metric or a project that is not in the notes.
```

User message template:

```
INTERVIEWER QUESTION:
{question}

WHAT THE CANDIDATE ALREADY SAID (do not repeat this):
{candidateContext or "(nothing yet)"}

CANDIDATE NOTES:
[1] ({docType} / {headerPath joined by " > "}) {chunkText}
[2] ...
[3] ...
```

Generation parameters: `max_tokens: 200`, `temperature: 0.3`. Low temperature
because the goal is factual recall, not creativity.

---

## 7. Cost model (`CMP-09`, ASM-011)

A versioned price table ships with the app at `src/main/pricing.json`, keyed by
`providerId:modelId` so a new registry entry needs a price row and nothing else.
The numbers below are placeholders to be confirmed against each provider's
published pricing at build time:

```json
{
  "version": "2026-09-15",
  "llm": {
    "anthropic:claude-haiku-4-5-20251001": { "inputPerMTok": 1.00, "outputPerMTok": 5.00 },
    "openai:gpt-4o-mini":                  { "inputPerMTok": 0.15, "outputPerMTok": 0.60 }
  },
  "stt": {
    "deepgram:nova-3":              { "perAudioMinute": 0.0043 },
    "deepgram:nova-2":              { "perAudioMinute": 0.0043 },
    "openai:gpt-4o-mini-transcribe":{ "perAudioMinute": 0.0030 },
    "openai:gpt-4o-transcribe":     { "perAudioMinute": 0.0060 },
    "elevenlabs:scribe-v2-realtime":{ "perAudioMinute": 0.0067 },
    "openai:whisper-1":             { "perAudioMinute": 0.0060 }
  }
}
```

Both blocks are keyed `providerId:modelId`. This paragraph previously showed the
`llm` block keyed by bare model id, which `TC-156` never accepted and which
breaks the moment two providers ship a model of the same name. Corrected during
`TASK-012`, along with the missing `deepgram:nova-2` row. `TC-156` now fails on a
price row no registry model claims, as well as on a model with no row, so the
table cannot drift in either direction.

Selection is restricted to priced models: the Dashboard only offers models that
exist in a registry, and `TC-156` fails the build if a registry model has no
price row. There is therefore no unknown-model path at runtime. If a price row is
ever missing anyway, the meter counts the tokens, contributes zero dollars for
that model, and the Dashboard labels the estimate "incomplete" rather than
showing a number that silently understates spend.

`estimatedUsd = sum(llm token cost) + sum(stt minutes * rate)` across both
streams. The UI labels it "estimate" and shows the price table version. The
table is not fetched at runtime. A stale table is a known, bounded inaccuracy and
is preferable to a network call during an interview.

---

## 8. Dependencies

### Runtime

| Package | Purpose | Requirement | Risk |
|---|---|---|---|
| `electron` | Shell. Pin to a stable line with `setContentProtection` on Windows | FR-001, FR-005 | Low |
| `electron-store` | Non-secret settings | FR-020 | Low |
| *(none)* | Loopback capture uses the platform API: main owns `setDisplayMediaRequestHandler({ useSystemPicker: false })` and answers `audio: 'loopback'`, the audio worker calls `getDisplayMedia`. `electron-audio-loopback` was evaluated and removed (ADR-028): its renderer half needs `ipcRenderer` inside the renderer, which `FR-086` forbids, and declaring it made `electron` a production dependency, which breaks electron-builder | FR-040, ADR-028 | Low, about ten lines we own |
| `ws` | The single WebSocket transport behind all three streaming STT adapters. Two of the three authenticate with a request header, which the platform `WebSocket` constructor cannot set, and one transport means one reconnect policy to test (ADR-029) | FR-047, FR-048, ADR-029 | Low |
| `openai` | Whisper REST and GPT. **Not** the realtime transcription socket, which is an adapter over `ws` | FR-049, FR-070 | Low |
| `@anthropic-ai/sdk` | Claude | FR-070 | Low |
| `@xenova/transformers` | Local embeddings | FR-066 | Medium, model download and ONNX runtime size |
| `pdf-parse` | PDF to text | FR-060 | Medium, best-effort output |
| `mammoth` | DOCX to Markdown | FR-060 | Low |
| `chokidar` | Knowledge base folder watch | FR-068 | Low |
| `zod` | IPC and settings validation | FR-033, CMP-10 | Low |
| `react`, `react-dom` | Both renderers | FR-002 | Low |
| `tailwindcss` | Styling | FR-094 | Low |
| `framer-motion` | Card animation | FR-091 | Low |
| Magic UI | Card components, copied into the repo, not an npm dependency. Listed in `VENDORED.md` with source, version and license, because the npm license check cannot see it | FR-094, NFR-016 | Medium, invisible to CI licensing without `VENDORED.md` |
| *(none)* | Acrylic translucency uses Electron's built-in `backgroundMaterial`. No native blur module is added | FR-089 | Low |
| *(none)* | The Whisper WAV container is written by hand in `src/main/ai/stt/wav.ts`, about 44 bytes of header. No encoder package | FR-049 | Low |

### Build and test

`typescript`, `vite`, `electron-vite`, `electron-builder`, `vitest`,
`@playwright/test` (Electron driver), `eslint`, `prettier`,
`license-checker-rseidelsohn` (NFR-015).

### Dependency risk mitigation

`electron-audio-loopback` was the project's highest-risk dependency and is gone
(ADR-028). Loopback is acquired through the platform API in about ten lines we
own, so there is no package to break.

The remaining concentrations of risk:

- **`ws` carries all three streaming STT adapters** (ADR-029). A protocol change
  at any provider lands on us rather than on an SDK release. Contained by
  `SocketSttSession`, which owns every part that is not provider-specific, so an
  adapter is a connect URL, a handshake frame and a switch on a message type.
  The fake-socket tests make a protocol change a visible failure.
- **`@xenova/transformers`** brings an ONNX runtime and a model download
  (`TASK-022`). Its size and first-run behavior are the risk, not its API.

`npm ls electron --omit=dev` must return empty. A package that declares
`electron` as a peer dependency pulls it into the production tree, which breaks
`electron-builder`. This is asserted in CI, not assumed.

---

## 9. Security and privacy design

| Control | Mechanism | Verified by |
|---|---|---|
| Keys never in plaintext on disk | `safeStorage` DPAPI, separate file, refuse to save if unavailable | TC-021, TC-022 |
| Keys never reach a renderer | `secrets:status` returns booleans only. No channel returns a key | TC-023, code review |
| Keys never in logs | A redaction function runs on every log argument and every serialized error | TC-024 |
| No audio on disk | The only `ArrayBuffer` is transferred, never passed to `fs`. The lint rule covers the whole reachable audio path: `src/renderer/audio-worker/**`, `src/main/audio.ts`, `src/main/ai/stt.ts` and `src/main/ai/stt/**`. A runtime filesystem write monitor covers what lint cannot | TC-041, TC-042, TC-137 |
| Renderer isolation | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, preload allowlist | TC-086 |
| No remote code in renderers | CSP without `unsafe-eval`, `will-navigate` and `setWindowOpenHandler` both deny | TC-087 |
| Overlay hidden from capture | `setContentProtection(true)` at creation, never disabled | TC-005, manual MW-01 |
| Audio never spooled by a dependency | Whisper body built in memory, app-owned temp dir asserted empty at session end | TC-137 |
| Transcript ordering under cancellation | Single writer, monotonic `seq`, cancel append awaited before the next begin | TC-134 |
| Torn write survivability | One line per `write()`, unparseable final line discarded on compaction | TC-135 |

---

## 10. Error handling policy

| Error origin | User-visible result | Silent |
|---|---|---|
| STT provider failure | Dashboard badge only | Overlay unchanged |
| LLM provider failure | Dashboard badge only | Overlay unchanged |
| Loopback device missing | Dashboard error badge, session start refused | No |
| Mic device missing | Dashboard warning badge, session continues | No |
| RAG document conversion failure | Document row shows `error` with the message | No |
| Embedding model download failure | Dashboard error, retry button, session still startable | No |
| Hotkey registration conflict | Inline Dashboard error, previous binding kept | No |
| Settings file corrupt | Defaults loaded, corrupt file renamed, one-time notice | No |
| Unhandled rejection in main | Logged, session continues (NFR-009) | Yes |

The overlay has exactly two states, idle and suggestions. It has no error state.
This is a hard rule from `FR-076` and it is why every row above resolves to the
Dashboard.

---

## 11. Repository layout

```
src/
  main/
    index.ts           CMP-01
    config.ts          CMP-02
    secrets.ts         CMP-02
    audio.ts           CMP-03a
    session.ts         CMP-08
    cost.ts            CMP-09
    health.ts          CMP-12
    hotkeys.ts         CMP-11
    pricing.json
    ipc/router.ts      CMP-10
    ai/
      stt.ts           CMP-04 facade
      stt/deepgram.ts
      stt/openaiRealtime.ts
      stt/elevenlabs.ts
      stt/whisper.ts
      stt/wav.ts
      trigger.ts       CMP-05
      llm.ts           CMP-07 facade
      llm/anthropic.ts
      llm/openai.ts
      llm/lineBuffer.ts
      prompt.ts
    rag.ts             CMP-06 facade
    rag/convert.ts
    rag/chunk.ts
    rag/embed.ts
    rag/store.ts
    rag/watch.ts
    rag/autotag.ts
  preload/
    dashboard.ts
    overlay.ts
    audioWorker.ts
  renderer/
    dashboard/         CMP-13
    overlay/           CMP-14
      Overlay.tsx
    audio-worker/      CMP-03b
      index.ts
      loopback.ts
      pcm-worklet.ts
  shared/
    registry/stt.ts    ADR-022 STT provider + model registry
    registry/llm.ts    ADR-022 LLM provider + model registry
    ipc.ts             channel ids + zod schemas
    types.ts           the data model in section 2
tests/
  unit/
  integration/
  e2e/
docs/
```
