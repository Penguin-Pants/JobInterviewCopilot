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
| CMP-05 | Trigger | Turn-end state machine, candidate context ring, pause state, confidence gate, `CLASSIFYING` state (delegates the actual call to an injected `classify` callback) | Call an LLM provider directly |
| CMP-06 | RAG Engine | Ingest, convert, chunk, embed, cache, watch, query, startup reconciliation | Know about sessions. Only `rag.ts` is importable from outside, enforced by a lint rule against deep imports |
| CMP-07 | LLM Layer | Provider adapters, prompt assembly, line buffering, cancellation | Write to the transcript |
| CMP-08 | Session Manager | Session lifecycle, sole writer of the session file, `seq` assignment, consent gate, profile binding | Own provider retry logic |
| CMP-09 | Cost Meter | Token and audio-minute accounting, spend estimate, threshold warnings | Stop a session, or hold a session file handle (ADR-018) |
| CMP-10 | IPC Router | Channel registration and payload validation | Hold session or business state, or redact (redaction lives in the logger alone, FR-034) |
| CMP-11 | Hotkey Manager | Global shortcut registration, rebinding, conflict reporting | Interpret app state |
| CMP-12 | Provider Health | Failover state keyed by **credential**, backoff, background re-probe | Be keyed by capability (ADR-017) |
| CMP-15 | Live Session Loop | Joining capture, transcription, the trigger, retrieval, generation, the overlay gate, the transcript writer and the Cost Meter for the length of one session | Own a policy of its own, write a file, create a window, or import Electron (TASK-044, ADR-035) |
| CMP-13 | Dashboard renderer | All configuration and history UI | Hold authoritative state |
| CMP-14 | Overlay renderer | Idle card, single suggestion card, the hold buffer, consent reminder, font control | Fetch from any network |

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
  schemaVersion: 6;
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
  customPrompts: Array<{ id: string; name: string; systemPrompt: string }>;
  profilePromptIds: Record<string, string>; // missing = shipped default
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
    width: number | null;                  // 320 .. 1600, null = default 420
    height: number | null;                 // 180 .. 1200, null = default 260
    displayId: string | null;
    clickThrough: boolean;              // default true (FR-083)
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
  supportsConfidence: boolean;    // FR-112, ADR-046. Read the same way as supportsEndpointing:
                                   // off this entry, never off the provider id.
  audio: { encoding: 'linear16'; sampleRate: 16000; channels: 1 };
  pricePerAudioMinuteUsd: number;
  badge?: string;                 // shown in the Dashboard, e.g. the Whisper penalty text
}
```

**`supportsConfidence` (`FR-112`, `ADR-046`).** Only `deepgram`'s entries set
this `true` in this milestone: its wire protocol already carries
`channel.alternatives[0].confidence`, so wiring it costs a parsing change, not a
new request shape. `openai-realtime`, `elevenlabs` and `whisper-1` are `false` —
not because their audio is worse, but because exposing a comparable number costs
a request-shape change (OpenAI, ElevenLabs) or both a request-shape change and a
response-format change (`whisper-1`, whose `response_format: 'text'` carries no
structured data at all). A provider added after this milestone ships
`supportsConfidence: false` until its own adapter is wired; nothing else in the
trigger, the overlay or the session manager needs to change when that happens
(`TC-151`'s guarantee extends to this flag).

```ts

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
      status: 'complete' | 'cancelled' | 'nonconforming' | 'stale' }
);
// 'stale' is new (FR-114, ADR-048): a generation discarded for arriving too
// long after its turn fired, never sent to the overlay. It is distinct from
// 'cancelled' (a new turn interrupted it) so the two are not confused when a
// session is reviewed later.
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

`src/shared/types.ts`, alongside the persisted types in 2.1–2.5.

```ts
interface TranscriptEvent {
  source: 'interviewer' | 'candidate';
  text: string;
  isFinal: boolean;
  timestamp: number;        // epoch ms, chunk arrival time
  providerId: string;         // registry key, e.g. 'deepgram'
  confidence?: number;      // 0 to 1. Present only when supportsConfidence is
                             // true for the active model (FR-112, ADR-046).
                             // Absent, not fabricated, for every other model.
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

### 2.6a Overlay card state (`CMP-14`, not persisted)

Referenced by name throughout `TASK-043` and this milestone's §3.7/3.8 but
never previously written down here — added now rather than left for a reader
to reverse-engineer from task prose. Lives in `src/renderer/overlay/cards.ts`
(11).

```ts
export const MAX_LINES_PER_CARD = 5;   // FR-004

export interface CardLine {
  index: number;
  text: string;
}

export type CardStatus = 'streaming' | 'complete' | 'cancelled' | 'nonconforming';
// No 'stale': a stale generation (FR-114) never reaches the renderer, so this
// status union has no reachable use for it.

export interface SuggestionCard {
  cardId: string;
  generationId: string;
  question: string;
  lines: CardLine[];
  status: CardStatus;
}

export type CardEvent =
  | { kind: 'begin'; payload: PushPayload<'suggestion:begin'> }
  | { kind: 'line'; payload: PushPayload<'suggestion:line'> }
  | { kind: 'end'; payload: PushPayload<'suggestion:end'> }
  | { kind: 'reset' };

function reduceCards(cards: SuggestionCard[], event: CardEvent): SuggestionCard[];
```

**Post-`ADR-047`, `reduceCards` holds at most one card.** `MAX_CARDS` is not a
constant this module exports any more — the cap of 1 is load-bearing, not a
configured value (`TASK-063`). A `'begin'` event for a new `cardId` replaces
whatever card is held; `depthOpacity` and every multi-card branch this module
and `SuggestionCardView` (11) once carried are deleted, not defaulted to a cap
of 1. A `'reset'` event (a session boundary) empties the held card.

**A `'cancelled'` `'end'` removes the card, not just its `status` field —
corrected during a fifth round of spec review (`ADR-047`).** Before this
milestone, `reduceCards`'s `'end'` case only ever overwrote the matching
card's `status`; nothing removed it from the array. Under the pre-milestone
3-card cap that went unnoticed in practice because a cancelled card was
pushed off the front by the next three `begin`s soon enough, but with the
cap now 1 (above) a cancelled card **is** the only card, and nothing evicts
it if the next `suggestion:begin` is delayed or never comes (the interviewer
moves to small talk the actionability filter now suppresses, `ADR-045`, or
the interview simply ends there). `FR-054`'s "the cancelled partial output
must be removed from the overlay" predates this milestone and was never
actually implemented by eviction alone. Fixed now: `reduceCards`'s `'end'`
case, when `event.payload.status === 'cancelled'`, removes the matching card
from the array entirely instead of updating its `status` in place — so
`shouldShowIdle` sees zero cards and the overlay falls back to its idle card
immediately, the same as after a `'reset'` or a pause. `'complete'` and
`'nonconforming'` are unchanged: both are terminal states `FR-076`/`FR-102`
already require to stay visible until replaced or held, and this milestone
does not touch either branch.

---

## 3. Key interfaces

### 3.1 STT adapter (`CMP-04`)

```ts
interface SttSession {
  readonly source: 'interviewer' | 'candidate';
  readonly choice: ProviderChoice;
  push(chunk: AudioChunk): void;
  readonly sentBytes?: number;                 // PCM actually put on the wire
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

**Two properties of this interface, added in TASK-044 and recorded as ADR-036.**

`open` resolving does **not** mean the provider accepted the connection. Every
streaming adapter asks its socket to connect and returns; a refused, revoked or
dropped connection arrives later on the `error` event, after the adapter's own
reconnect ladder. The caller must therefore treat that event as the provider
failing, not as a line for the log: `CMP-15` raises it into `CMP-12` and
re-opens the pair on whatever the machine then serves. Without that, a dead
primary never failed over, because the open had already been recorded a success.

`sentBytes` is what the session has actually put on the wire, and it is optional.
`SocketSttSession` drops queued chunks during an outage rather than buffering
without bound (ADR-027), so only the adapter knows what really went; the Cost
Meter's "audio actually sent to a provider" is read from here. An adapter that
sends everything it is handed has nothing to correct and omits it, and the
caller bills the chunk it handed over.

`close` on a **batch** adapter posts its remaining buffer and answers from it,
so a caller must stay routable until `close` resolves. Clearing the route first
discarded the last thing said before Stop.

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
  /** New (FR-111, TASK-060). When present, buildMessages (prompt.ts) uses
   *  this system prompt and these parameters INSTEAD OF the fixed
   *  SYSTEM_PROMPT/GENERATION_PARAMS section 6 specifies, and ignores
   *  `question`, `candidateContext` and `chunks` entirely — the override
   *  carries the complete user message itself. Used only by the
   *  actionability classifier (3.6a); a real suggestion generation never
   *  sets this, and section 6's prompt is exactly as unchanged as it looks. */
  promptOverride?: {
    system: string;
    user: string;
    maxTokens: number;
    temperature: number;
  };
}
```

The adapter yields raw deltas. Line buffering is done above the adapter in
`CMP-07`, so both providers get identical overlay behavior (`FR-074`). This
branch on `promptOverride` lives inside the one shared `buildMessages`
(`prompt.ts`), not duplicated inside either adapter — the same reason line
buffering itself lives above the adapters rather than inside each one.

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

**Empty and failed are different answers** (ADR-036, corrected in TASK-044).
`[]` means the notes were searched and nothing matched, or there was nothing to
search: an empty question, an unknown profile, a profile with no ready document.
A failure to *reach* notes that do exist throws `RetrievalUnavailableError`:
the embedding model is gone although ready documents were embedded with it, or
the question could not be embedded.

`TASK-024` collapsed both onto `[]`, so that a failure could not throw into a
session. It reached `CMP-15` as "no relevant notes", and the loop then built a
suggestion the overlay renders identically to a grounded one. The loop abandons
the turn on the throw, which is neither a crash nor a fabricated answer
(ADR-032, ADR-035).

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

### 3.6 Confidence gate and actionability classifier (`CMP-05`, `FR-111`, `FR-113`, `ADR-045`, `ADR-046`)

`ActionabilityVerdict` and `classifyHeuristically` are declared in
`src/main/ai/actionability.ts` (11); `classifyWithLlm` is declared there too
but is imported only by `live.ts`, never by `trigger.ts` (3.6's own point).
`TriggerOptions.classify` is declared in `src/main/ai/trigger.ts` alongside
the interface it extends.

**Order matters: confidence, then actionability.** The confidence gate is one
free, local comparison; the actionability classifier can cost a network round
trip. Checking confidence first means a turn garbled enough to fail it is
never also paid for with a classification call that would only be thrown away.

**Confidence gate (`FR-113`).** One comparison, evaluated right after the
`FR-051` guard passes: when `FR-112`'s `supportsConfidence` is `true` for the
active model, a turn whose **last final segment received before the turn-end
gap elapsed** carries `confidence` under `CONFIDENCE_THRESHOLD` (0.55,
`ASM-016`) is treated exactly as a guard failure. When `supportsConfidence` is
`false`, the comparison is not evaluated at all — there is no default
confidence to compare, and treating a missing value as low confidence would
silently gate every model that cannot report one.

**Actionability classifier (`FR-111`).** `CMP-05` may not call an `LlmProvider`
directly (section 1). `TriggerOptions` — the pure trigger module's existing
constructor options, `ai/trigger.ts`, `TASK-030` — gains one more injected
dependency, alongside the existing `onFire`:

```ts
type ActionabilityVerdict = 'actionable' | 'non-actionable';

interface TriggerOptions {
  // ...existing fields (config, onFire, onStateChange, timers, newGenerationId)
  classify: (text: string, signal: AbortSignal) => Promise<ActionabilityVerdict>;
}
```

`classify` is constructed once in `CMP-15` (`live.ts`), the same place
`LlmProvider` is already legitimately called for real generations, and wired
into the trigger at startup — the identical pattern `onFire` already is.
`CMP-05` itself never imports an LLM adapter. `live.ts`'s implementation of
`classify` also reports the call's own token usage to the Cost Meter before
resolving (3.6a) — the trigger only ever sees the verdict.

```ts
/** Fixed seed lexicons (ASM-015). Growing either is a data change, not an
 *  architecture change. Lives beside the trigger, but has no network
 *  import — CMP-05 calls classifyHeuristically directly, never
 *  `classify`'s real, LlmProvider-backed implementation. */
const NON_ACTIONABLE_PHRASES: readonly string[];
// 'thanks for joining', 'nice to meet you', 'how are you', 'welcome',
// 'okay', 'great', 'got it', 'sounds good', 'perfect', 'sure', 'no problem'

const ACTIONABLE_LEADS: readonly string[];
// 'who', 'what', 'when', 'where', 'why', 'how', 'tell me', 'describe',
// 'walk me through', 'can you', 'could you', 'would you', 'give an example'

/** Checked in this order — the exact-match rule FIRST:
 *  1. Trim the text, then strip any run of trailing '?', '.', '!', ','
 *     characters from the end of the trimmed text. A case-insensitive match
 *     of that punctuation-stripped, whole-trimmed text against
 *     NON_ACTIONABLE_PHRASES — exact, not prefix — resolves
 *     'non-actionable'. The strip happens ONLY for this comparison — the
 *     original text (with its punctuation) is what step 2 and
 *     classifyWithLlm still see.
 *  2. A '?' anywhere in the (unstripped) text, or a case-insensitive match
 *     at the START of the trimmed text against ACTIONABLE_LEADS, resolves
 *     'actionable'.
 *  3. Neither: null.
 *  Order matters, found during a second round of spec review: the seed
 *  NON_ACTIONABLE_PHRASES entry "how are you" also starts with "how", an
 *  ACTIONABLE_LEADS entry. Checking the exact, whole-turn match first means
 *  a real question can never accidentally match it (a real question is
 *  never exactly equal to a five-word acknowledgement), while an
 *  acknowledgement that happens to share a lead word never reaches the
 *  prefix check at all. The reverse order was tried first and misclassified
 *  "how are you" as actionable.
 *  The punctuation strip in step 1 was added during a fourth round of spec
 *  review: without it, "How are you?" fails the exact match (the lexicon
 *  entry has no '?'), falls through to step 2, and its own trailing '?'
 *  misclassifies it 'actionable' — a canonical greeting fired a suggestion.
 *  Stripping only for the step-1 comparison, and only trailing runs (never
 *  interior punctuation), keeps "what's the risk, really?" fully intact for
 *  step 2. */
function classifyHeuristically(text: string): ActionabilityVerdict | null;
```

Called from `CMP-05` after the confidence gate passes, so a turn either guard
already rejects never reaches the classifier. `classifyHeuristically` decides
immediately, with no network call. `null` calls `this.options.classify(text,
signal)` and awaits it before firing or returning to `LISTENING`; any error,
timeout, or a settled value that is not cleanly one verdict resolves to
`'actionable'` (`ADR-045`). A non-actionable turn produces no `TurnFired` — the
trigger's existing `AWAITING_TURN_END → LISTENING` path (`TASK-030`) is reused,
not duplicated.

**An aborted classification's eventual settlement is a stale settle report,
not a classifier failure (`ADR-045`).** `signal` firing (a newer turn's
guard-pass superseded this one, 3.6's own abort-at-guard-pass rule above)
does not itself mean `classify`'s promise settles synchronously — an
in-flight LLM call notices the abort on its own schedule. When it does
resolve or reject after the fact, the trigger checks it against its current
in-flight marker (the same marker `noteGenerationSettled`, `TASK-030`,
already keys generation settlements against) before acting: if the marker no
longer names this classification, the settlement is discarded outright,
exactly as a stale generation settlement already is. It is never treated as
an `'actionable'` fallback, and never turned into a `TurnFired` for a turn
the trigger has already moved past. Only a classification that is still the
current in-flight operation when it settles can produce a verdict or fall
back to `'actionable'`.

**The `classify` call is a single best-effort attempt, not routed through
`CMP-12`'s retry/failover machinery (`ADR-045`).** `live.ts`'s implementation
of `classify` reads the LLM primary credential's current health state —
`CredentialHealth.current.kind` (`src/main/ai/health.ts`), a plain property
read, never a `run`/`runFor` attempt — before calling. **The call is
attempted only when that read is exactly `'using-primary'`.** Every other
`HealthState.kind` — `'retrying'`, `'using-backup'`, `'degraded'`,
`'config-required'` — skips the call entirely and fails open to
`'actionable'` immediately, with no network attempt and no effect on the
health state either way. This is corrected from an earlier, finer-grained
version of this rule that tried to distinguish `DEGRADED` "not yet due for
its next retry" from `DEGRADED` that is due: `CredentialHealth` exposes no
such eligibility query (`DEGRADED`'s backoff is slept inside its own retry
attempt, not tracked as a separately readable deadline), so that version
could not actually be implemented against `CMP-12` as it exists, and adding
a new query to answer it would be a needless widening of `CMP-12`'s public
surface for a check this narrow. Checking only `.current.kind` against the
single value `'using-primary'` needs nothing `CMP-12` does not already
expose, and it is also more correct than the version it replaces: that
version's `CONFIG_REQUIRED`/`DEGRADED`-only skip would have kept calling
`llm.generate` against a primary that real generations had already stopped
using while `'using-backup'` or `'retrying'`, hitting a failed-over-from or
still-recovering credential on every ambiguous turn. Otherwise exactly one
attempt is made against `llm.generate`, using the *primary*'s
`ProviderChoice` (never the backup's — `'using-backup'` skips per the rule
above, so this call never needs its own target-selection logic), under an
800ms client-side timeout (`ASM-020`) local to the classification call,
distinct from and shorter than any retry-driven timeout `runFor` applies to
a real generation. A timeout or any other failure resolves to `'actionable'`
(`ADR-045`, same fallback as above) and is never itself reported to `CMP-12`
as a probe outcome — classification calls observe health state, they never
drive it.

**The `CLASSIFYING` state carries the wait, and `firedAt`/the abort both
happen before it, not inside it (5.3).** The moment `FR-051`'s guard passes —
before the confidence gate or the classifier run — the trigger stamps
`firedAt` (3.7) and aborts whatever async operation (a previous
classification or generation) is currently in flight, unconditionally
(`FR-054`). Only after that does the confidence gate run, and only if it
passes does the turn enter `CLASSIFYING`. `signal` above is the
`AbortController` created at that same guard-pass moment, shared by the
classification call and, if it fires, the eventual generation: there is one
in-flight async operation per turn, not two independently-tracked ones. Doing
the abort this early, before the new turn's own outcome is known, is what
keeps "a turn suppressed by the confidence gate or the classifier returns to
`LISTENING` exactly as a guard failure does" true without qualification: by
the time either check resolves, there is never a competing in-flight
operation left to reconcile, because it was already dealt with at guard-pass.
A turn that instead *fails* `FR-051`'s guard (too short to count as a new
turn) stamps nothing and aborts nothing, exactly as before this milestone
(`TC-086`).

`CLASSIFYING` behaves exactly like `GENERATING` already did for a pending
successor: a pending turn survives its predecessor (new text accumulates and
arms its own gap timer), and a new turn's gap elapsing while a previous turn
is still `CLASSIFYING` runs the same guard-pass sequence described above
before the guard chain restarts for the new text.

### 3.6a Actionability classification prompt (`FR-111`, `CMP-15`)

Fixed, not user-editable, the same discipline section 6 holds the suggestion
prompt to. Uses `GenerationRequest.promptOverride` (3.2) so the classification
call can go through `LlmProvider.generate` — "the existing interface," per
`TASK-060` — without the fixed interview-cue system prompt and
`GENERATION_PARAMS` that `buildMessages`/`prompt.ts` otherwise always apply.

**The request's other fields, for a classification call specifically.**
`promptOverride.user` already carries the complete, literal user message, so
`question`, `candidateContext` and `chunks` are inert — ignored by
`buildMessages` whenever `promptOverride` is set (3.2) — but the interface
still requires them, and this is what `classifyWithLlm` puts there: `question`
is the turn text (redundant with `promptOverride.user`, but harmless);
`candidateContext` is `''`; `chunks` is `[]`. `generationId` is **not**
synthesized separately — it is the same `classificationId` described below,
so one identifier serves both the request shape's required field and the
Cost Meter key, rather than inventing two.

System prompt, verbatim:

```
You classify whether an interviewer's spoken turn in a job interview requires
the candidate's AI assistant to prepare a suggestion. Respond with exactly one
word: ACTIONABLE or NON_ACTIONABLE.

ACTIONABLE means the turn asks the candidate a question, or otherwise expects
a substantive response. NON_ACTIONABLE means the turn is small talk, a
greeting, an acknowledgement, or other content that needs no prepared
response.

Respond with the one word and nothing else.
```

User message template: `TURN:\n${text.trim()}`. Parameters: `maxTokens: 5`
(one word, with margin for tokenization), `temperature: 0`.

`classifyWithLlm(text, classificationId, choice, llm, signal)` builds this
request and calls `llm.generate(req, signal)`. `classificationId` and
`choice: ProviderChoice` are passed in by the caller (`live.ts`'s `classify`
closure below), not invented inside this function — `GenerationRequest`
requires both (`generationId`, `choice`, 3.2) and `LlmProvider` (the `llm`
argument) exposes only a registry `id: string`, not a `ProviderChoice`, so
this function has no way to synthesize either on its own. `choice` is always
the LLM primary's own `ProviderChoice` (never the backup's), matching the
health-check rule above.

It drains the whole iterable before deciding anything — concatenating every
`{ delta }` item into one string and keeping the terminal `{ usage }` item —
not just the first delta: `maxTokens: 5` caps the response to about one word,
so draining to completion is near-instant, and only a fully-drained response
can be checked reliably at all. **The accumulated string is trimmed and
checked for exact, case-insensitive equality to one of the two verdict
words — never substring containment.** `NON_ACTIONABLE` (exact) resolves
`'non-actionable'`; `ACTIONABLE` (exact) resolves `'actionable'`. This is
corrected from an earlier version that checked whether the accumulated
string *contained* `NON_ACTIONABLE` or `ACTIONABLE` (ordered to dodge
`"ACTIONABLE"` being a substring of `"NON_ACTIONABLE"`): a response like
`"NON_ACTIONABLE because this is small talk"` or one naming both words
still contains `NON_ACTIONABLE` under that scheme and would have resolved
`'non-actionable'` even though it is not cleanly one verdict, contradicting
`FR-111`'s own "not cleanly one verdict fails open" rule. Exact equality
after trimming has no such gap, and needs no check-order dependency either
(two disjoint exact strings cannot collide the way a substring scan can).
Anything else — extra words, both tokens together, an empty response, a
stream that ends without a recognizable token, or the same
non-aborted-stream-ends-early failure 3.2 already defines as a
`ProviderError` — resolves to `'actionable'` (`ADR-045`).

**Cost accounting.** `live.ts`'s `classify` closure generates its own fresh
`classificationId` each time it is called, independently of the trigger (the
trigger's own `newGenerationId()` is for `TurnFired.generationId`, a
different id for a different purpose) — not threaded through
`TriggerOptions.classify`'s signature at all, which stays exactly
`(text, signal) => Promise<ActionabilityVerdict>`; the trigger has no need to
know this id exists. The closure wraps the call in a `try`/`finally`:
whether it resolves with a verdict or the promise rejects (including on
`signal` abort, `FR-054`), the `finally` reports whatever `TokenUsage` was
captured — zero if the call was aborted before any usage arrived, matching
section 7's general "a generation cancelled before any usage is reported
accounts zero tokens" rule — to `cost.noteGeneration` under the key
`` `classify:${classificationId}` ``, which cannot collide with any real
generation's `<generationId>#<attempt>` scheme (`ADR-036`) because no real
`generationId` is ever prefixed `classify:`. This same `classificationId` is
also what the request's own `generationId` field (3.2) is set to, so nothing
extra needs inventing for that field either.

**Session teardown must wait for this accounting, not just for a real
generation's.** `LiveSessionLoop.stop()` (`CMP-15`, `src/main/live.ts`)
already tracks one in-flight generation in a `generation: Promise<void> |
null` field and awaits it before closing streams and letting the Session
Manager compact the session file. It has no equivalent for a classification:
a classification aborted by `trigger.stop()` (itself called at the top of
`stop()`) can still be inside the `try`/`finally` above, reporting usage,
after `stop()` has already returned and usage has already been snapshotted.
`LiveSessionLoop` gains a second tracked field, `classification: Promise<void>
| null`, set by the `classify` closure the moment it is invoked and cleared
once the closure's own `try`/`finally` completes; `stop()` awaits it
alongside `generation`, in the same step, before proceeding to close streams.

### 3.7 Staleness check (`FR-114`, `CMP-15`, `ADR-048`)

`TurnFired` is declared in `src/main/ai/trigger.ts`, the module that
constructs it. `CONFIDENCE_THRESHOLD` (3.6) lives beside it there;
`STALE_DISCARD_MS` lives in `src/main/live.ts`, the module that reads it.

```ts
interface TurnFired {
  generationId: string;
  question: string;
  candidateContext: string;
  signal: AbortSignal;
  firedAt: number;          // epoch ms. New (FR-114). Captured once, when
                             // the turn-end gap elapses and FR-051's guard
                             // passes (the moment 3.6's guard chain begins),
                             // NOT when GENERATING is finally entered — it
                             // must include whatever the confidence gate and
                             // the classifier themselves cost.
}

// 'stale' does NOT go on GenerationStatus (ai/llm.ts). That type is also the
// exact type GenerationEvents.onEnd's payload carries, i.e. CH-209's wire
// status — adding 'stale' there would add it to the wire in the same stroke.
// GenerationStatus is untouched by this milestone. 'stale' instead goes on:
//  - TranscriptEntry's 'suggestion' variant (src/shared/types.ts) — the
//    transcript-facing status, a plain inline literal union, not an alias of
//    GenerationStatus;
//  - sessionSchema's matching z.enum(...) on the 'suggestion' branch of
//    transcriptEntry (src/shared/ipc.ts) — the PERSISTED schema. The other
//    z.enum(...) in the same file, on CH-209's own payload schema, is a
//    separate declaration and stays exactly as it is;
//  - SessionManager.appendSuggestion's parameter type (src/main/session.ts).
// CardStatus (2.6a) does not gain 'stale': a generation caught at checkpoint
// 1 below never reaches the renderer at all, and one caught at checkpoint 2
// reaches it labeled 'cancelled', the existing wire value, never a new one.
```

**Two checkpoints, not one.** `CMP-15` compares `Date.now() - firedAt`
against `STALE_DISCARD_MS` (20000, `ASM-017`) at two points, not one:

1. **Before the first `onSuggestion` call for `suggestion:begin`.** Over the
   threshold here: no `onSuggestion` call is made for any of `begin`, `line`
   or `end`; the transcript entry is appended with `status: 'stale'`
   (the transcript-facing type above, not `GenerationStatus`).
2. **Before the first `onSuggestion` call for `suggestion:line`** (i.e.
   before this generation's first real content would reach the overlay),
   but only reached if checkpoint 1 already passed and `begin` already went
   out. Over the threshold here: no further `suggestion:line` is forwarded,
   and exactly one `suggestion:end` is forwarded with the existing wire
   status `'cancelled'` — never `'stale'`, which is not a wire value — so
   the already-shown card is removed via the same path `2.6a`'s `'cancelled'`
   removal rule already provides. The transcript entry is still appended
   with the true outcome, `status: 'stale'` — the overlay and the transcript
   are allowed to disagree here, the same way `ai/llm.ts`'s
   `GenerationOutcome.error` already lets a failed generation be shown as
   `'cancelled'` while the real failure is recorded and surfaced elsewhere.

At both checkpoints, the underlying generation still runs to completion in
the background regardless of outcome — the cost of one wasted LLM call is
cheaper than an early-abort path this milestone does not build (`ADR-048`).

**Why checkpoint 1 alone is not enough, corrected during a fifth round of
spec review.** `runGeneration` (`src/main/ai/llm.ts`) calls `events.onBegin`
**before** it starts iterating `provider.generate` — synchronously, before
any part of the LLM's own response has arrived. A checkpoint placed only
"before begin," as this section originally specified, is therefore evaluated
at essentially `firedAt` plus retrieval time, regardless of how long the LLM
itself goes on to take — a provider whose first token takes 25 seconds
passes checkpoint 1 immediately and then streams its now-obsolete answer to
the overlay in full, exactly the failure this check exists to prevent.
Checkpoint 2 catches that case; checkpoint 1 alone could not, no matter how
the "once streaming begins, length is bounded" reasoning below is read.

**Once past checkpoint 2, no further checkpoint is needed.** The reasoning
that originally justified "one checkpoint" still holds for everything after
checkpoint 2: once real content has started arriving, total length is
already bounded by `GENERATION_PARAMS.maxTokens` (200) and the line buffer's
own caps (3.3), so an unbounded slow drip *between* lines is not a failure
mode anything else in this architecture produces either. The correction
above is about *where* the meaningful checkpoint sits relative to the first
byte of real output, not about needing a third one.

**Both checkpoints are evaluated once per generation, not once per
attempt.** A single `generationId` can be billed across several attempts
when the health machine retries or fails over (`ADR-036`: each attempt
accounted under `<generationId>#<attempt>`), and `onSuggestion` for
`suggestion:begin` (checkpoint 1) and the first `suggestion:line`
(checkpoint 2) are each still called at most once for that `generationId` —
on whichever attempt finally produces output. Each checkpoint sits at its
one call site, so each is checked exactly once regardless of how many
attempts preceded it, and the elapsed time both measure already includes
every attempt before the one that succeeded — a generation that burned
through the full retry ladder before finally going out is exactly the case
checkpoint 1 is meant to catch.

### 3.8 Card hold buffer (`FR-115`, `CMP-14`, `ADR-049`)

```ts
interface HoldBufferOptions {
  minHoldMs: number;          // 1500, ASM-018
  now?: () => number;         // injected for fake-timer tests
}

/** Sits in front of reduceCards (2.6a). Not a change to reduceCards's
 *  'begin'/'line'/'reset' handling or the tests already describing them;
 *  reduceCards's 'end' case does change, per 2.6a's cancelled-card-removal
 *  fix (ADR-047) — a change orthogonal to this buffer, made by TASK-063,
 *  not by this task. */
interface HoldBuffer {
  onEvent(event: CardEvent): void;   // dispatches immediately, or queues
  onPause(): void;                   // CH-212's pause transition; not a CardEvent
  dispose(): void;
}
```

`onPause` exists because `CH-212`'s pause transition does not arrive as a
`CardEvent` at all — `reduceCards` and the buffer both react to it through a
separate call, not a fourth member of the `CardEvent` union — yet the buffer
must still observe it to implement the clear-and-discard rule below. The
overlay renderer calls `onPause()` wherever it currently handles `CH-212`,
alongside (not instead of) whatever `reduceCards` already does for a pause.

Every `CardEvent` the overlay receives over IPC passes through the buffer
before it reaches `useReducer(reduceCards, ...)`, with three exceptions to the
general dispatch-or-queue rule below: a `'reset'` event (a session boundary)
always bypasses the buffer and dispatches immediately, clearing anything
queued — a session boundary is never held, the same way `reduceCards` itself
treats it as unconditional (2.6a); and `CH-212`'s pause transition, delivered
to the buffer through `onPause()` above rather than as a `CardEvent`, both
clears the buffer's notion of "a card is currently shown" **and** discards
every event currently queued, regardless of that generation's eventual
status — a generation that finished streaming while queued, waiting out the
hold, must not surface once the session resumes, the same as one that was
mid-stream when the pause arrived.

For an ordinary `CardEvent` (`'begin'`, `'line'`, `'end'`), the hold gates
**replacement by a different generation, never an event belonging to the
generation already on screen.** This distinction is load-bearing, not a
restatement:

- **An event whose `generationId` matches the currently shown card's**
  dispatches immediately, regardless of how long that card has been visible.
  This is what lets a fast-completing card's own later lines keep triggering
  `FR-092`'s per-bullet reveal as they stream in — they are not held just
  because the card itself is under `minHoldMs` old — and, more importantly,
  what lets `FR-054`'s "the cancelled partial output must be removed from the
  overlay" apply without delay: a `suggestion:end` with `status: 'cancelled'`
  for the **currently shown** card's own `generationId` clears it immediately,
  never queued, because the whole point of cancellation is that nothing about
  the interrupted question should linger on screen a moment longer.
- **An event for any other `generationId`** — a candidate to replace the
  shown card — is what the hold actually applies to: with no card shown, or
  the shown card visible at least `minHoldMs`, it dispatches immediately (it
  becomes the new shown card). Otherwise it queues, replayed once the hold
  elapses — in arrival order **and at the spacing the events originally
  arrived in**, not flushed simultaneously, so a held card's bullets still
  trigger their own per-bullet reveal once promoted. A `suggestion:end` with
  `status: 'cancelled'` for a `generationId` **still queued** (never shown)
  discards that generation's queued entries instead of flushing them once the
  hold elapses — a card superseded before it was ever shown must not be shown
  after the fact.
- **The buffer holds at most one not-yet-shown candidate at a time.** If a
  `'begin'` for a third `generationId` arrives while a different one is
  already queued (waiting out the hold), the newly queued one **replaces**
  the previously queued one outright — its entries are discarded, not
  appended behind the new arrival. This is the same one-held-slot rule
  `OverlayGate` (`ADR-016`) already applies to a comparable race ("one held
  generation, second `begin` discards first"); the hold buffer reuses it
  rather than inventing a multi-item pending queue, so there is never more
  than one shown card and one queued candidate to reason about at once.

The first card shown with no card currently on screen — a session's first
suggestion, or the first one after a pause — bypasses the hold (there is
nothing to protect the reading time of).

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
| CH-125 | `doc:pickFiles` | `{ profileId }` | `DocumentRecord[]` |
| CH-126 | `overlay:setFontSize` | `{ px }` | `{ ok: true }` |
| CH-127 | `overlay:setSize` | `{ width, height }` | `{ ok: true }` |
| CH-128 | `overlay:setPointerOverControls` | `{ over }` | `{ ok: true }` |
| CH-132 | `dashboard:setPromptDirty` | `{ dirty }` | `{ ok: true }` |

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

**Changes made in Milestone 4 (ADR-037, DoD 9).**

- `CH-125` `doc:pickFiles` runs the file dialog in the **main** process and
  imports what was chosen, so the Add documents button never hands the main
  process a path a renderer picked. It answers `[]` when the dialog is
  cancelled, which is not an error. `CH-109` `doc:import` still takes renderer
  supplied paths, because drag and drop is the one case where only the renderer
  knows what was dropped. What bounds that path is the extension allowlist in
  `CMP-06`, not `basename`: `basename` decides the name the copy lands under
  inside `kb/`, it does not decide what may be read.
- The Dashboard preload gains one non-channel member,
  `pathForFile(file): string`, which wraps Electron's `webUtils.getPathForFile`.
  `File.path` no longer exists in a renderer, so a drop has no other way to name
  a file on disk, and `webUtils` is reachable from a preload only. It is
  optional on `CopilotBridge` and absent from the overlay preload, which accepts
  no drops.

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
| CH-215 | `notice:captureFidelity` | both | `{ windowsBuild, message }` |
| CH-216 | `notice:platform` | both | `{ windowsBuild, acrylicSupported }` |
| CH-217 | `notice:session` | dashboard | `{ sessionId, message }` |
| CH-218 | `state:llmCatalog` | dashboard | Completed lazy model-catalog refresh result. |

`CH-215` landed in Milestone 0 with `NFR-012`, the pre-19041 capture warning
shown once per session next to the consent reminder. It is recorded here for the
first time; the contract test now asserts the table and the code agree in both
directions, so a channel cannot be added in code and left undocumented again.

**Changes made in Milestone 4 by `TASK-043` (ADR-038, DoD 9).**

- `CH-215`'s target is **both**, and it is now pushed to both windows. It was
  written down as `overlay`, implemented as dashboard-only, and left out of the
  overlay preload's allowlist, so all three disagreed. `NFR-012` decides it:
  the warning belongs "alongside the consent reminder", which is the overlay.
  The Dashboard keeps it because `FR-089` needs the build number there and
  because a user who has dismissed the overlay card can still read it.
- `CH-216` `notice:platform` is new. `FR-089` requires the acrylic option to be
  disabled on Windows 10 with a note, and no channel carried the build number
  to the Dashboard except `CH-215`, which fires only when capture fidelity is
  degraded. A Windows 10 machine on build 19045 therefore got no build number
  at all. It is pushed to both windows on every load: the overlay needs
  `acrylicSupported` to know whether the acrylic it asked for is the window it
  actually got, because `overlayWindowOptions` silently falls back to a
  transparent window when it cannot be rendered.
- `CH-217` `notice:session` is new (TASK-050). `CMP-15` reports every failure it
  survives through `onError`, and all of it went to `main.log` and stopped
  there. One of those failures must not: a session that starts with no usable
  speech-to-text model runs, records and bills while transcribing nothing.
  `NFR-008` requires a session start with no network to **warn**, and a log file
  the user will never open is not a warning. It is not on the health badges,
  which `ADR-017` keys by credential and which describe a provider that is
  failing; a model missing from the registry and a key that was never saved
  never reach a provider, and routing them through `runFor` would take a good
  key to `CONFIG_REQUIRED` (`ADR-024`). Dashboard only: the overlay never shows
  a failure (`FR-076`). The payload names its session so the renderer shows it
  only while that session is live, which is what keeps it clear of the session
  boundary: `session:start` pushes `CH-201` before it brings the loop up, so a
  clear-on-boundary effect would race the notice and wipe it.
- `CH-126` `overlay:setFontSize` is new. `FR-093` requires the overlay's text
  size to be adjustable from an in-overlay control and to persist. `config:set`
  cannot be the way: the overlay's invoke allowlist exists so a compromised
  overlay renderer cannot write settings, rebind hotkeys or replace
  credentials (`FR-086`). One channel that changes one number, range-checked by
  its own schema, keeps that boundary intact.

**Changes made in TASK-052.**

- `CH-127` `overlay:setSize` is new, and `schemaVersion` moves to `2` to carry
  the overlay's stored size. `FR-081` was amended: the overlay is resizable now,
  because the fixed 420 by 260 window could not show three cards (`FR-091`) of
  five lines (`FR-004`) at the text sizes `FR-093` allows, and clipped the
  difference away. The window carries `resizable: true`, which is enough for
  the acrylic mode's native edges; the renderer carries a grip driving this
  channel, which is what makes resizing work on the `transparent` window the
  flat-opacity mode builds and behave identically in both. It exists rather
  than `config:set` for the same reason `CH-126` does.
- `CH-128` `overlay:setPointerOverControls` is new, and it writes nothing. The
  consent reminder has to be clickable (`FR-006`) and a `BrowserWindow` is a
  rectangle, so making its dismiss button reachable makes the whole overlay
  reachable and intercepts clicks meant for the application behind it. The
  window follows the pointer instead: clickable over the card, click-through
  everywhere else. `setIgnoreMouseEvents`'s `forward: true` is what makes this
  possible, because an ignoring window still delivers move events to its
  renderer. It fails safe: each reminder starts clickable, so a renderer that
  never reports leaves the button working rather than dead.

**Changes made in TASK-053.**

- `schemaVersion` moves to `3` for `overlayWindow.clickThrough`. `FR-083` made
  click-through the default and `FR-084` gave it a hotkey, but nothing made it a
  setting, so an overlay covering part of the screen took no clicks and the user
  had no control to point at. It is persisted now, written by the hotkey and by
  the Dashboard toggle alike, and read back at bootstrap.
- `CH-128` widens from the consent card to any overlay control. The resize grip
  shipped gated on interactive mode, which made it reachable only through a
  hotkey nothing on screen mentions, so the overlay was resizable in principle
  and fixed in place in practice. The grip is always rendered now, and the hit
  test is what keeps the rest of the window click-through around it.

**Changes made in `TASK-062`.** `CH-209`'s wire schema is unchanged
(`FR-114`, `ADR-048`): a generation discarded for arriving after its threshold
never reaches `CH-207`/`208`/`209` at all, so there is no wire value to add.
`'stale'` exists only on the shared `GenerationStatus` type and the
`TranscriptEntry` record it is written to (2.5) — code that switches on
`CH-209`'s payload never needs to name it, because it can never arrive.

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

### 4.4 Runtime LLM catalog channels

| ID | Channel | Direction | Purpose |
|---|---|---|---|
| CH-130 | `llmCatalog:get` | Dashboard to main | Return cached normalized model catalogs and lazily refresh stale providers. |
| CH-131 | `llmCatalog:refresh` | Dashboard to main | Force independent provider refreshes and return the retained catalogs. |
| CH-132 | `dashboard:setPromptDirty` | Dashboard to main | Report whether the prompt editor holds unsaved changes, so main can confirm before closing the window. |

**CH-129 `catalog:stt`** — Dashboard to main. Payload `{ force: boolean }`; response is the validated normalized STT provider catalog. `force` bypasses the 28-day age check. Credentials remain in main.

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
         Deepgram endpoint event -> fire immediately, same guard chain below
           (a native endpoint only removes the wait for turnEndGapMs to
           elapse; it is the same "new turn end" trigger as a gap-elapse,
           entering the guard/firedAt/abort/confidence/classify sequence
           below identically, never a separate or older path, 5.3)
CMP-05   timer elapses, or a native endpoint fires -> guard FR-051 (>=3 words, >=12 chars)
         guard fail -> return to LISTENING, nothing stamped, nothing aborted
           (too short to be "a new turn end", FR-054 does not apply, TC-086)
         guard pass -> firedAt = Date.now() (FR-114)
         guard pass -> abort whatever async op (a previous classification or
           generation) is in flight, unconditionally, before this turn's own
           checks run (FR-054); CH-209 status 'cancelled' for an aborted
           generation
         guard pass -> confidence gate FR-113, only when supportsConfidence is true
         confidence below threshold -> return to LISTENING, firedAt discarded,
           nothing fires
         confidence passes (or does not apply) -> enter CLASSIFYING (5.3)
         classify FR-111: heuristic, else one LLM-confirm call
         non-actionable -> return to LISTENING, nothing fires
         actionable, or the call errors/times out and fails open (ADR-045)
           -> enter GENERATING, TurnFired carries the firedAt stamped above
CMP-15   onFire -> CMP-06 query(boundProfileId, questionText, 3)
CMP-07   build prompt, call provider
CMP-15   staleness checkpoint 1 (FR-114): Date.now() - firedAt > threshold?
         over threshold -> no CH-207/208/209 at all, TranscriptEntry 'stale',
           generation still runs to completion in the background (usage
           still accounted), stops here
         within threshold -> CH-207 suggestion:begin
CMP-07   provider.generate begins iterating (events.onBegin above already
           fired BEFORE this line, synchronously, not gated on the first
           delta - checkpoint 1 above is evaluated at ~firedAt+retrieval
           time, not at "first token ready"; that gap is exactly what
           checkpoint 2 below exists to cover)
CMP-15   staleness checkpoint 2 (FR-114): first real delta ready ->
           Date.now() - firedAt > threshold?
         over threshold -> no CH-208 ever sent for this generation; exactly
           one CH-209 suggestion:end 'cancelled' sent instead (wire status,
           not 'stale'); TranscriptEntry still 'stale', not 'cancelled';
           generation still runs to completion in the background, stops here
         within threshold -> proceed normally, no further checkpoint
CMP-07   buffer deltas, flush per line -> CH-208 suggestion:line (xN)
CMP-07   stream ends -> CH-209 suggestion:end 'complete'
CMP-14   hold buffer FR-115: dispatch now, or queue until minHoldMs elapses
CMP-08   append the suggestion TranscriptEntry
CMP-09   add token usage, recompute spend, maybe CH-205 usage:warning
```

**The staleness check sits between retrieval and the first push, not before
retrieval — and has a second checkpoint at the first real delta, not only
before `begin` (3.7, corrected during a fifth round of spec review).**
Checking `firedAt` before `CMP-06` even runs would save a wasted RAG query on
a turn already stale, but retrieval is fast (`FR-065`'s 50 ms ceiling at the
documented scale) next to an LLM round trip, so checkpoint 1 sits after
retrieval, immediately before the overlay could show anything from
`suggestion:begin`. That checkpoint alone is not enough, because
`runGeneration`'s `events.onBegin` fires synchronously before
`provider.generate` is even iterated — before any part of the LLM's own
response exists — so a slow-to-first-token provider passes checkpoint 1
regardless of how long it goes on to take. Checkpoint 2, at the first real
delta, is what actually bounds that wait; see 3.7 for the full reasoning and
why the two together (rather than moving checkpoint 1 later) keep the
common, fast-answering case showing its card immediately.

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
states: IDLE, LISTENING, AWAITING_TURN_END, CLASSIFYING, GENERATING, PAUSED

IDLE            --session:start-->            LISTENING
LISTENING       --interviewer final-->        AWAITING_TURN_END
AWAITING_TURN_END --new interim/final-->      AWAITING_TURN_END (timer reset)

-- A "new turn end" is the SAME transition regardless of which state it fires
   from (AWAITING_TURN_END, CLASSIFYING or GENERATING) AND regardless of what
   fires it: a local turnEndGapMs timer elapsing and a provider's native
   endpoint signal (5.2) are both just ways of reaching "the gap has ended"
   -- the endpoint only removes the wait for the timer, it does not skip or
   shortcut any of the three steps below. Either way FR-051's guard is
   checked next. It always does these three things, in order, before
   anything about the new turn's own actionability is known:

any of {AWAITING_TURN_END, CLASSIFYING, GENERATING}
   --new turn's gap elapses, guard fail--> (no transition: too short to be
     "a new turn end", nothing stamped, nothing aborted, TC-086)
   --new turn's gap elapses, guard pass-->
       1. firedAt = Date.now() (FR-114)
       2. abort whatever async op (a previous classification or generation)
          is in flight, unconditionally (FR-054); CH-209 'cancelled' if it
          was a generation
       3. confidence gate FR-113, only when supportsConfidence is true
   --confidence gate fails--> LISTENING (firedAt discarded)
   --confidence gate passes (or does not apply)--> CLASSIFYING

CLASSIFYING     --new interim/final-->        CLASSIFYING (new text accumulates,
                                               its own gap timer arms, same
                                               pending-turn rule as GENERATING —
                                               its own "new turn end" still
                                               follows the rule above)
CLASSIFYING     --resolved non-actionable-->  LISTENING
CLASSIFYING     --resolved actionable, or
                   classifier times out/
                   errors (genuine failure,
                   still THIS turn's own
                   in-flight op)-->           GENERATING (fail open, ADR-045)
CLASSIFYING     --classifier's signal aborted
                   because a NEWER turn's
                   guard-pass superseded it--> (no transition from here: the
                                               machine is already wherever the
                                               newer turn's own guard-pass
                                               sequence put it; this
                                               settlement is discarded as
                                               stale, ADR-045)
GENERATING      --stream end-->               LISTENING
any live state  --Ctrl+Shift+P-->             PAUSED
PAUSED          --Ctrl+Shift+P-->             LISTENING
PAUSED          --entering-->                 abort in-flight (classification
                                               or generation), overlay idle card
any             --session:stop-->             IDLE
```

"Any live state" means `LISTENING`, `AWAITING_TURN_END`, `CLASSIFYING` or
`GENERATING`. `IDLE` is **not** pausable: there is no session to pause, and
resuming out of it would put the machine in `LISTENING` with no audio, no STT
socket and no profile bound. Clarified during `TASK-030` and recorded as
`ADR-031`.

**`CLASSIFYING` is new, added by `TASK-060` and recorded as `ADR-045`.** It
carries the actionability classifier's await (3.6) — the one state transition
here that is not synchronous. Stamping `firedAt` and aborting whatever was in
flight both happen at guard-pass, **before** the confidence gate or the
classifier run, not folded into `CLASSIFYING` itself — a correction found
during a second round of spec review, needed for two reasons together: it is
the only way `firedAt` can include the confidence gate's own cost, as
`ADR-048` requires, and it is what makes "a turn the confidence gate or the
classifier suppresses returns to `LISTENING` exactly as a guard failure does"
(`FR-111`, `FR-113`) true without qualification — by the time either check
resolves, whatever was previously in flight is already gone, so there is
nothing left to reconcile. `trigger.ts`'s existing `abortInFlight` is generic
over "the one in-flight async op for this turn," not specific to a
generation — this is a correction to how the milestone was first specified,
not a new mechanism: `inFlight` was always described as one slot, and
`CLASSIFYING` is a second kind of thing that can occupy it. A pending turn
survives its predecessor exactly as it always did for `GENERATING`: new
speech arms its own gap timer without disturbing whatever is currently in
flight.

**The two arrows out of `CLASSIFYING` above are not one arrow — corrected
during a fifth round of spec review.** An earlier version of this diagram
drew a single transition, "resolved actionable, or classifier fails/aborts
→ `GENERATING`." Read literally that sends every abort to `GENERATING`,
including the one case 3.6's "aborted classification's eventual settlement
is a stale settle report" rule exists specifically to prevent: a
classification aborted because a *newer* turn's own guard-pass already
superseded it. That abort is not this diagram's transition to draw at all —
by the time it settles, the trigger's current in-flight marker no longer
names it, and the newer turn's own guard-pass sequence has already decided
where the machine is. Only a genuine failure or timeout on the
classification that is still the turn the trigger considers current fails
open to `GENERATING`; a superseded abort is discarded, full stop, per 3.6.

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
  next final rather than discarded. Once honored, it is the identical "new
  turn end" trigger described above — same guard, same `firedAt` stamp, same
  abort, same confidence gate, same classifier — never a shortcut around any
  of them; the only thing a native endpoint changes is not having to wait out
  `turnEndGapMs` first.
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

**What was one guard is now three checks in a fixed order, added by
`TASK-060`/`TASK-061` and recorded as `ADR-045`/`ADR-046`.** A turn that fails
any of the three still returns to `LISTENING` exactly as a `FR-051` guard
failure always has, and the existing `TASK-030` tests for that path describe
real behavior for all three, not only the original one. The order is
deliberate, cheapest first:

1. `FR-051`'s word/character guard (unchanged, synchronous).
2. `FR-113`'s confidence gate (new, synchronous): only evaluated when the
   active model's registry entry sets `supportsConfidence: true`. Checked
   before the classifier so a garbled turn is never also paid for with a
   classification call that would only be thrown away.
3. `FR-111`'s actionability classification (new, the only one of the three
   that can be async): heuristic first, one LLM-confirm call only when the
   heuristic cannot resolve it, carried by the new `CLASSIFYING` state above.

---

## 6. Prompt specification (`FR-072`, `FR-073`)

The shipped default system prompt is below. It is always available and cannot
be modified or deleted. A profile may instead select one of up to five custom
system prompts. The selection and exact saved text are captured at session
start and used by both primary and backup models for that session:

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

A custom system prompt replaces the wording above, never its grounding and
output-shape rules. `composeSystemPrompt` appends those rules to every custom
prompt, so a preset that only names a house style cannot license invented
facts, a readable script or a paragraph (`FR-004`, `FR-073`).

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

**One generation can be several billable requests** (ADR-036, TASK-044). A retry
or a failover sends the question again, and both requests are billable, possibly
at different rates. Replacement by `generationId` is right *within* one request
and wrong across two, so `CMP-15` accounts each attempt under `<generationId>#n`
and every attempt is summed. The transcript still records the outcome the
overlay showed, which is the last attempt's.

**Audio seconds are read from the adapter, not from the chunk handed to it**
(ADR-036). `SocketSttSession` drops queued chunks during an outage rather than
buffering without bound (ADR-027), so billing the chunk the supervisor passed on
would charge an outage as though it had been transcribed. `SttSession.sentBytes`
is the measurement.

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
| `framer-motion` | Card animation and `AnimatePresence`, which `FR-091` names | FR-091, FR-092 | Low |
| *(build only)* | `tailwindcss` and `@tailwindcss/vite` are **devDependencies**, not runtime ones: they compile the overlay's stylesheet into a static CSS asset at build time and nothing of them reaches the shipped bundle. That is also why the license gate, which scans `--production`, does not see their `lightningcss` (MPL-2.0) — the same scope that already excludes `vite`, `electron-builder` and `typescript` (TASK-043, DoD 6) | FR-094 | Low |
| Magic UI | Vendored, not an npm dependency. `BlurFade` is copied into `src/renderer/overlay/vendor/blur-fade.tsx` and is the bullet reveal `FR-092` specifies; its source, commit and MIT license are in `VENDORED.md`, which `scripts/check-licenses.mjs` enforces. `MagicCard` and `AnimatedList` were evaluated and deliberately not used, for reasons in ADR-042: a pointer-hover effect is dead on a click-through window (`FR-083`), shadcn tokens are not the `FR-029` tokens the contrast floor is computed from (`FR-093`, ADR-039), and a timer-driven list is not an IPC-driven stack | FR-094, NFR-016 | Low, one file with a recorded upstream commit |
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

**`TASK-060`'s actionability classifier adds no runtime dependency.** The
LLM-confirm path (`FR-111`) is a `GenerationRequest`-shaped call through the
existing `LlmProvider` interface (3.2) against the already-configured LLM
primary, not a separate model, library or provider. A lexicon is data, not a
dependency.

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
| An open STT socket fails terminally | Raised into `CMP-12`: retry, failover, and the pair re-opened on whichever target it then serves | Overlay unchanged |
| Retrieval fails on a turn | Logged, the turn is left unanswered. Never answered from no notes (ADR-035, ADR-036) | Overlay unchanged |
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
      actionability.ts TASK-060, FR-111, the lexicon and classifyHeuristically
                       (pure, no network import — trigger.ts's only import
                       from this file). classifyWithLlm, the LlmProvider-backed
                       half, is called only from live.ts, never from trigger.ts
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
      main.tsx         mount only
      App.tsx          the shell, the header and the section order
      state.ts         one hook per push channel, no second copy of main's state
      call.ts          the one invoke wrapper, so an IpcError cannot be ignored
      format.ts        timer, money and size formats
      styles.css       theme tokens, light and dark
      sections/        ProviderSetup, CompanyProfiles, SessionHistory,
                       Hotkeys, CostAndUsage, ConsentReminder, OverlayAppearance
    overlay/           CMP-14
      Overlay.tsx
      cards.ts         TASK-043, reduceCards and the card state (2.6a)
      holdBuffer.ts    TASK-064, FR-115, sits in front of cards.ts's reducer
      theme.ts         TASK-043, the contrast-floor computation (FR-093)
      styles.css
      components/      ConsentReminder, IdleCard, SuggestionCardView,
                       FontSizeControl, ResizeGrip
      vendor/          blur-fade.tsx, Magic UI, VENDORED.md (NFR-016)
    audio-worker/      CMP-03b
      index.ts
      loopback.ts
      pcm-worklet.ts
  shared/
    registry/stt.ts    ADR-022 STT provider + model registry
    registry/llm.ts    ADR-022 LLM provider + model registry
    registry/selection.ts  TASK-042, the Dashboard's selection rules, pure
    ipc.ts             channel ids + zod schemas
    types.ts           the data model in section 2
tests/
  unit/
  integration/
  e2e/
docs/
```

## Runtime STT catalog boundary

`SttCatalogService` is the single discovery, compatibility, normalization, sorting, and cache boundary. The validated `catalog:stt` IPC channel carries descriptors to Provider Setup; it never carries keys. OpenAI's authenticated Models API supplies account-visible identifiers but not transport capabilities, pricing, or lifecycle state, so results are conservatively intersected with verified adapter policy. Deepgram's project model metadata is not an entitlement list and ElevenLabs' general model response does not reliably identify realtime STT compatibility; both therefore use labelled shipped fallback metadata. The cache is `userData/stt-catalog.json`, schema version 1, written by temporary-file rename. Each cached account result carries an opaque random rotation marker whose current value lives with the encrypted credential; a mismatch makes the entry stale after restart without storing a key fingerprint or any reversible credential identifier. A credential replacement invalidates only its STT entry; OpenAI retains its single shared credential ownership.
