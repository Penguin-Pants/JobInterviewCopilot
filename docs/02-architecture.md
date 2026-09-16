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
|  CMP-15 Live Session Loop   live.ts                           |
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
| CMP-15 | Live Session Loop | Joining capture, transcription, the trigger, retrieval, generation, the overlay gate, the transcript writer and the Cost Meter for the length of one session | Own a policy of its own, write a file, create a window, or import Electron (TASK-044, ADR-035) |
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
      <sessionId>.ndjson      append log during a live session, compacted on stop
      <sessionId>.meta.json   profile binding and start time, for crash recovery
session.lock                  one session across restarts, cleared by recovery
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

Three registries, `src/shared/registry/stt.ts`, `src/shared/registry/llm.ts` and
`src/shared/registry/embedding.ts`. They are data, and they are the only place a
provider or model is named. Adding a provider is one entry plus one adapter
(`FR-037`).

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

**Embedding registry** (added in TASK-022, ADR-030). Separate from the two above
because an embedding model carries no credential: it runs locally, which is why
ingestion survives every provider key being rejected and why `NFR-008` can
promise offline ingestion at all (`ADR-026`).

```ts
interface EmbeddingModelDescriptor {
  id: string;                   // 'Xenova/all-MiniLM-L6-v2', also the cache key's model part
  displayName: string;
  dimensions: number;           // 384, the row stride in <docId>.vectors.bin
  maxSeqLength: number;         // shipped default only, see below
  specialTokenCount: number;    // [CLS] and [SEP], subtracted from the chunk budget
  approximateDownloadMb: number;
}
```

`maxSeqLength` here is a **ceiling**, and a config on disk can only lower it.
`src/main/rag/embed.ts` reads `max_seq_length` from `sentence_bert_config.json`
and `model_max_length` from `tokenizer_config.json` and takes the smallest of
those and this value.

The asymmetry is forced, not a preference. `@xenova/transformers` fetches
`tokenizer.json`, `tokenizer_config.json` and `config.json`, and **never**
`sentence_bert_config.json`, which is the Python sentence-transformers artifact
where MiniLM's real 256 lives. Taking the smaller of whatever happens to be on
disk therefore resolved to the BERT backbone's 512, and the chunker produced
chunks of up to 510 word pieces that the model silently truncated at 256 (see
ADR-030). `ADR-023`'s intent still holds: a model swap carries its own registry
limit, and any config claiming less still wins.

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
`Float32Array` of `chunkCount * 384` values, L2-normalized at write time,
followed by a 32-byte ASCII `pairId` trailer. Row `i` belongs to chunk index `i`.
Normalizing at write time makes the query a plain dot product.

`chunks.json` is `{ pairId, chunks }` rather than a bare array, and a read that
finds two different `pairId`s discards both files and re-embeds. The row count
alone is not enough: the pair is committed with two `rename` calls, which is not
one atomic operation, and a crash between them leaves a new `chunks.json` beside
the old `vectors.bin`. Whenever the edit preserved the chunk count, and a typo
fix does, the counts agreed and retrieval ranked the new text by the old text's
vectors forever, with nothing reporting an error (ADR-030).

A vector is zeroed if any component is `NaN` or `Infinity`, and a non-finite
score is dropped rather than ranked. A `NaN` score makes the comparator return
`NaN`, which is falsy, so the sort falls through to the id tie-break and one
poisoned chunk takes the whole top `k` for every question in that profile.

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
  estimateIncomplete: boolean;           // a model consumed had no price row (ADR-033)
  warningsIssued: ('cost' | 'time')[];   // at most one of each (FR-103)
}
```

Sessions are appended to disk as newline-delimited JSON during the session
(`<sessionId>.ndjson`) and compacted into `<sessionId>.json` on clean stop. Each
entry is one `write()` of one complete line ending in a newline, so a crash can
lose a line but cannot tear one. A `.ndjson` file found at startup means a crash.
It is compacted with `endReason: 'crash-recovered'`, discarding an unparseable
final line. When both a `.json` and a `.ndjson` exist for one session the `.json`
wins and the `.ndjson` is deleted. A `session.lock` file at the `userData` root
enforces one session at a time across restarts and is cleared by the same
recovery pass. This satisfies `FR-105`, `FR-107` and `FR-108`.

**Corrected during `TASK-040`.** This paragraph previously placed the lock "next
to the sessions folder". There is one such folder per profile, so that reading
permits one concurrent session *per profile*, while `FR-108` and `ADR-013` both
say one session, full stop. The lock is at the `userData` root.

**A start refusal is a response, not a thrown error.** `CH-112` returns
`{ refused, message }`, where `refused` is one of `session-active`,
`no-active-profile`, `stt-key-missing` or `llm-key-missing`. The router replaces
every thrown handler error with one generic message, so throwing would make all
four of `FR-088`'s cases identical at the boundary and leave `TC-104`'s
"distinct, named reason" true only inside `CMP-08`. Recorded in ADR-032.

**A crash-recovered session's metadata comes from a sidecar.** Every `.ndjson`
line is a transcript entry, so the bound profile, its name at the time and the
real start time are nowhere in the transcript. `<sessionId>.meta.json` is
written beside it at start and deleted on a clean stop. Without it every
recovered session reached Session History unlabeled and ordered by whenever its
first turn happened to be spoken.

Four further rules settled while implementing `TASK-040`:

- **Only the final line of an `.ndjson` may be discarded.** A torn tail is the
  crash signature. A malformed line anywhere else means the writer did not write
  whole lines, which is a defect rather than a crash, so it is raised rather
  than silently dropped.
- **Compaction writes the `.json` through a temporary file and renames it.** A
  crash between writing the `.json` and deleting the `.ndjson` would otherwise
  leave a half-written `.json` whose source had already gone. The rename is
  atomic, so one of the two files is always complete.
- **A session id is validated before it reaches a path.** `CH-115` and `CH-116`
  take it as an arbitrary string, and it also arrives from the user-editable
  `id` field of a file on disk. It must match a pattern carrying no dot and no
  separator, so no sequence of components can leave the sessions folder.
- **Only the recovery pass clears the lock, never `session:start`.** A lock held
  by a live process must refuse the start; clearing it there would silently
  overwrite a running session's transcript. Recovery runs when no session of
  ours exists, so any lock it finds is from a process that is gone.

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

**A stream that ends before its terminal marker is a failure, not a completion.**
A proxy or a dropped connection can close a 200 response cleanly without
Anthropic's `message_stop` or OpenAI's `[DONE]`. Reporting that as a success put
a truncated answer on the overlay with nothing to say it was cut short, and left
the health machine unaware. Both adapters throw a `ProviderError` when a
non-aborted stream ends without its marker; `CMP-07` still shows the lines that
did arrive (`FR-076`). An abort is not an early end.

**A model id is checked against the registry before dispatch**, exactly as
`openSttSession` checks it. `modelId` is a plain string in `Settings`, so a
stale choice can name a model belonging to the other provider, and sending it
returns a 4xx that classifies as a non-retryable `client` error, taking the
whole credential to `CONFIG_REQUIRED` and blaming a key that is fine.

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

Three details settled while implementing `TASK-032`, because rules 1 and 2 each
had a case the text did not decide:

- The ellipsis counts against the 120-character cap, so a capped line is never
  longer than 120 characters. A cap a rendered line can exceed is not a cap.
- A single word longer than the limit has no boundary to cut at. It is cut
  anyway: holding it would let one unbroken token grow the buffer without bound
  on a live path, and dropping it would lose the only content there is.
- A forced flush cuts even when the pending string ends exactly at 240
  characters, because that last word may be one the next delta continues.

A **provider failure is not a fifth rule and not a status of its own.** It
reports `cancelled` when nothing was salvaged, and otherwise reports the shape
that actually reached the overlay. The error goes to the caller and to the
Dashboard badge (`FR-076`, `ADR-031`).

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
| CH-110 | `doc:setType` | `{ docId, profileId, docType: DocType \| 'auto' }` | `DocumentRecord` |
| CH-111 | `doc:delete` | `{ docId, profileId }` | `{ ok: true }` |
| CH-112 | `session:start` | none | `{ sessionId }` or `{ refused, message }` |
| CH-113 | `session:stop` | none | `{ sessionId }` |
| CH-114 | `session:list` | `{ profileId }` | `SessionSummary[]` |
| CH-115 | `session:read` | `{ sessionId }` | `Session` |
| CH-116 | `session:delete` | `{ sessionId }` | `{ ok: true }` |
| CH-117 | `hotkey:rebind` | `{ action, accelerator }` | `{ ok } \| { error }` |
| CH-118 | `overlay:setInteractive` | `{ interactive }` | `{ ok: true }` |
| CH-119 | `overlay:savePosition` | `{ x, y, displayId }` | `{ ok: true }` |
| CH-120 | `consent:dismiss` | none | `{ ok: true }` |
| CH-121 | `overlay:reset` | none | `{ ok: true, x, y, displayId }` |
| CH-122 | `overlay:ready` | none | `{ ok: true }` |
| CH-123 | `doc:retry` | `{ docId, profileId }` | `DocumentRecord` |
| CH-124 | `model:ensure` | none | `ModelDownloadState` |

**Changes made in Milestone 2 (ADR-030, DoD 9).** `CH-121` and `CH-122` landed
in Milestone 0 and are recorded here for the first time. The rest are new:

- `CH-110` gains `'auto'`. `FR-079` requires a user override to be resettable to
  automatic, and the closed `DocType` union had no value that says so. A second
  channel would have given the Dashboard two ways to set one field.
- `CH-110`, `CH-111` and `CH-123` all carry `profileId` beside `docId`. A
  document id alone would make the main process scan every profile to find its
  owner, and `kb/` being authoritative means a stale id can outlive its record.
  Naming the profile makes the lookup one directory read and makes `FR-069`'s
  "exactly one profile" explicit at the boundary.
- `CH-123` `doc:retry` implements `FR-079`'s retry. Without it `doc:import` was
  the only way back from `error`, which would have made the user find the
  original file again.
- `CH-124` `model:ensure` is the retry action behind the "embedding model not
  downloaded" state (`ADR-026`, `TC-161`). `CH-214` pushes progress; this channel
  is how the renderer asks for an attempt and learns the outcome.

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
| CH-209 | `suggestion:end` | overlay | `{ generationId, status: 'complete' \| 'cancelled' \| 'nonconforming' }` |
| CH-210 | `overlay:consent` | overlay | `{ text }` |
| CH-211 | `overlay:theme` | overlay | theme subset of `Settings` |
| CH-212 | `overlay:mode` | overlay | `{ interactive, paused }` |
| CH-213 | `rag:progress` | dashboard | `{ docId, state, percent }` |
| CH-214 | `model:download` | dashboard | `ModelDownloadState` |
| CH-215 | `notice:captureFidelity` | overlay | `{ windowsBuild, message }` |

`CH-215` landed in Milestone 0 with `NFR-012`, the pre-19041 capture warning
shown once per session next to the consent reminder. It is recorded here for the
first time; the contract test now asserts the table and the code agree in both
directions, so a channel cannot be added in code and left undocumented again.

```ts
/** CH-124 and CH-214 both carry this (ADR-011, ADR-026, ADR-030). */
type ModelDownloadState =
  | { kind: 'not-downloaded' }
  | { kind: 'downloading'; percent: number }
  | { kind: 'ready' }
  | { kind: 'unavailable'; reason: string };
```

`CH-214` was `{ percent, done }`, which can say "not finished" but cannot say
"failed, here is why, you may retry". `TC-161` requires exactly that third
message, so the push now carries the same state `CH-124` returns and the two
cannot describe the same model differently.

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
CMP-09     starts the timer, begins accounting
CMP-15     CMP-03a creates the Audio Worker, sends CH-301
CMP-03b    acquires loopback + mic, builds two 16 kHz contexts
CMP-15     CMP-04 opens one SttSession per stream, under CMP-12
CMP-05     enters LISTENING
Dashboard  receives CH-201 state:session { active: true }
```

**Correction, made in TASK-044.** `CMP-09` starts **before** capture, not last.
The Cost Meter clears every accumulator in `start()`, so a second of audio
handed to it before it is running is discarded rather than counted, and the loop
begins sending audio the moment capture comes up. The two lines are swapped
above rather than left to be rediscovered.

**`CMP-15` is the caller of all of this.** The lines above name the component
doing the work; the component asking for it is the live session loop, added by
TASK-044 and recorded as ADR-035. `CMP-01` starts and stops it and owns nothing
else about a session.

If the consent card has not been dismissed when the first suggestion is ready,
the suggestion still renders. The reminder is non-blocking (ADR-002). What is
mandatory is that it was shown.

**The readiness gate holds a card, not a queue** (`FR-008`, ADR-016). Only a
`suggestion:begin` starts a held generation; a line or an end naming any other
generation is ignored. Two cases require that. A cancelled generation's
`suggestion:end` arrives *after* its replacement's `suggestion:begin`, because
the two run concurrently, and keying on the last generation id seen let that
stale end discard the replacement. And a rebuilt overlay (a translucency change,
ADR-015) has a renderer that never saw the begin, so the whole card is replayed
to it rather than its tail alone.

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
CMP-15   onFire -> CMP-06 query(boundProfileId, questionText, 3)
CMP-07   build prompt, call provider, CH-207 suggestion:begin
CMP-07   buffer deltas, flush per line -> CH-208 suggestion:line (xN)
CMP-07   stream ends -> CH-209 suggestion:end 'complete'
CMP-08   append the suggestion TranscriptEntry
CMP-09   add token usage, recompute spend, maybe CH-205 usage:warning
```

Three rules `CMP-15` adds to that sequence, each from a case the diagram does
not show. All three are asserted by `TC-164` and the cases beside it.

- **The profile is the one bound at start**, never `settings.activeProfileId`
  read again at turn time (ADR-013). A profile switch mid-session would
  otherwise answer this interview out of another interview's notes.
- **A failed retrieval abandons the turn.** Generating from no notes produces a
  suggestion the overlay renders identically to a grounded one, which is the
  plausible value ADR-032 forbids. An unanswered turn is silence, and `FR-102`
  says silence is not an error.
- **The replacement of a cancelled generation awaits its predecessor.** The
  trigger aborts the old generation before firing the new one, and the new one
  waits for the old one's transcript entry before appending its own, which is
  what makes `FR-106`'s ordering a mechanism rather than a race that usually
  goes the right way.

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
any live state  --Ctrl+Shift+P-->             PAUSED
PAUSED          --Ctrl+Shift+P-->             LISTENING
PAUSED          --entering-->                 abort in-flight, overlay idle card
any             --session:stop-->             IDLE
```

"Any live state" means `LISTENING`, `AWAITING_TURN_END` or `GENERATING`. `IDLE`
is **not** pausable: there is no session to pause, and resuming out of it would
put the machine in `LISTENING` with no audio, no STT socket and no profile
bound. Clarified during `TASK-030` and recorded as `ADR-031`.

Three further rules, each from a case the diagram does not show. All were found
by the review on `TASK-030`'s pull request and are recorded here because they
change what the machine does, not only how it is written.

- **A pending turn survives its predecessor.** Q2's final can arrive while Q1 is
  still streaming: the gap is armed and the state stays `GENERATING`. If Q1's
  stream then ends first, the machine returns to `AWAITING_TURN_END`, not to
  `LISTENING`. Dropping to `LISTENING` stranded Q2 and appended Q3 to it.
- **A native endpoint is honored in any live state**, not only in
  `AWAITING_TURN_END`, so the second question of a pair does not wait out a
  local gap the provider has already observed. An endpoint arriving *before* the
  text it ends, which is the order OpenAI's server VAD uses, is held for the
  next final rather than discarded.
- **The gap a batch model is measured against is the user's gap plus the
  model's `batchIntervalMs`.** A batch model has no interims and no endpoint: it
  answers once per window, and between two answers nothing arrives. The absence
  of events is not silence there, so the timer has to mean "a whole window went
  by with no new text". `batchIntervalMs` is zero for every streaming model, so
  `TC-159`'s "a hard-coded 800 fails this test" is unaffected.

**A candidate turn is a group of segments, not one segment.** A streaming
provider emits several `isFinal` segments for one spoken answer. `FR-052`'s
"last 2 candidate turns" means answers, so segments are accumulated and closed
on the same silence gap, and the answer still being spoken counts toward the
context.

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
that model, and sets `estimateIncomplete` so the Dashboard labels the estimate
rather than showing a number that silently understates spend (ADR-033).

**Accounting is per model, and LLM usage is keyed per generation** (ADR-033).
Audio seconds and tokens are accumulated against the model that produced them,
never as one session total, because a failover moves a stream to a model at a
different price and a total recomputed at the end would bill the whole session
at the last model's rate. LLM usage is stored by `generationId` and a second
report for one id **replaces** the first: a provider can send an interim usage
frame and then a terminal one, and a cancelled generation's outcome can carry a
smaller figure than the interim already charged. That is the decrease `FR-109`
names, and the warning guard is membership in a fired list, so no decrease can
re-arm a threshold.

A generation cancelled before the provider reported any usage accounts zero
tokens. The meter has no token counter of its own and does not estimate one from
the text received: a number we invented would be presented as a measurement
(ADR-033).

A usage report carrying a non-finite value is **refused** at the meter's
boundary and sets `estimateIncomplete`. The adapters cast provider JSON onto
`TokenUsage` without validating it, so a malformed frame can arrive as
`Infinity` or `NaN`; recorded, it makes `estimatedUsd` non-finite, which the
`CH-204` schema rejects and which `JSON.stringify` writes into the session file
as `null`, and that file then fails `sessionSchema` on read. One bad frame would
cost the user the whole interview, which is the failure ADR-032 exists to
prevent.

The meter counts, and `CMP-08` writes (ADR-018). `CMP-09` imports no filesystem
module, holds no path, and has no way to stop a session: `FR-103` is explicit
that a threshold is reported and never acted on. `CH-204` is pushed once per
second and once more at stop, so the final figures on screen are the figures
that went into the transcript. The session timer runs on a monotonic clock, not
on the wall clock, because a clock adjustment mid-interview would fire the time
warning early and `FR-109` gives no way to take a warning back.

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
| No audio on disk | The only `ArrayBuffer` is copied in memory, never passed to `fs` (ADR-027). The lint rule covers the whole reachable audio path: `src/renderer/audio-worker/**`, `src/main/audio.ts`, `src/main/audio-host.ts`, `src/main/live.ts`, `src/main/ai/stt.ts` and `src/main/ai/stt/**`. A runtime filesystem write monitor covers what lint cannot | TC-041, TC-042, TC-137 |
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
| STT session cannot be opened | Dashboard badge, session runs with no transcription | Overlay unchanged |
| Retrieval fails on a turn | Logged, the turn is left unanswered | Overlay unchanged |
| Mic device missing | Dashboard warning badge, session continues | No |
| RAG document conversion failure | Document row shows `error` with the message | No |
| Embedding model download failure | Dashboard error, retry button, session still startable | No |
| Hotkey registration conflict | Inline Dashboard error, previous binding kept | No |
| Settings file corrupt | Defaults loaded, corrupt file renamed, one-time notice | No |
| Unhandled rejection in main | Logged, session continues (NFR-009) | Yes |

The overlay has exactly two states, idle and suggestions. It has no error state.
This is a hard rule from `FR-076` and it is why every row above resolves to the
Dashboard.

**One row is not yet implemented.** "Loopback device missing, session start
refused" needs a fifth named refusal on `CH-112`, and capture only starts
*inside* `session:start`, after `CMP-08` has already created the transcript and
taken the lock. Today a dead interviewer stream shows on the `CH-203` badge and
the session runs. Carried by TASK-044 to TASK-050 rather than half-built, and
`AudioSupervisor.canStartSession` is the verdict it will read.

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
    live.ts            CMP-15, TASK-044, the live session loop
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
      trigger.ts       CMP-05, TASK-030, pure with injected timers
      llm.ts           CMP-07 facade, the adapter table and runGeneration
      llm/anthropic.ts TASK-032
      llm/openai.ts    TASK-032
      llm/lineBuffer.ts TASK-032, FR-004 and FR-074 enforced once
      llm/sse.ts       TASK-032, the shared SSE transport and framing
      llm/index.ts     TASK-032, adapter registration
      prompt.ts        TASK-031, section 6 assembled once for both providers
    overlay-gate.ts    FR-008, ADR-016, the overlay readiness buffer
    rag.ts             CMP-06 facade
    rag/convert.ts     TASK-020, pdf-parse and mammoth to Markdown
    rag/chunk.ts       TASK-021, pure and deterministic
    rag/embed.ts       TASK-022, @xenova/transformers, cache key, model gate
    rag/store.ts       TASK-020/022/024, profiles, chunks, vectors, the top-k scan
    rag/watch.ts       TASK-025, chokidar and the coalescing ingest queue
    rag/autotag.ts     TASK-023, the deterministic rule set
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
