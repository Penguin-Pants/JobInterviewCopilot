/**
 * Shared data model. Mirrors `docs/02-architecture.md` section 2.
 *
 * Implements the persisted and runtime shapes referenced by FR-020, FR-021,
 * FR-027, FR-063, FR-101 and FR-106. Renderers receive these types through the
 * preload bridge only; the main process is the single source of truth (CMP-01).
 */

/** A provider and model pair. Both are registry keys, not a closed union. (ADR-022) */
export interface ProviderChoice {
  providerId: string;
  modelId: string;
}

/** Vault key identifiers. One credential can serve several providers (ADR-017). */
export type CredentialId = 'deepgram' | 'openai' | 'anthropic' | 'elevenlabs';

/**
 * A registry entry. Generic over its model descriptor because STT and LLM
 * models carry different fields.
 *
 * Spec correction: `docs/02-architecture.md` section 2.1a wrote
 * `models: ModelDescriptor[]`, a type that section never defines. Made generic
 * here and corrected in the architecture document in the same change (DoD 9).
 */
export interface ProviderDescriptor<M> {
  id: string;
  displayName: string;
  credentialId: CredentialId;
  models: M[];
}

/** An STT model and the capabilities the rest of the app reads off it (FR-037). */
export interface SttModelDescriptor {
  id: string;
  displayName: string;
  /** false means the model is held to NFR-017, not NFR-001. */
  streaming: boolean;
  supportsInterim: boolean;
  supportsEndpointing: boolean;
  supportsConfidence: boolean;
  /**
   * For a batch model, the audio window it buffers before each request, in
   * milliseconds. Absent for a streaming model, which has no window.
   *
   * Two components need this number and it must be one number: the adapter
   * sizes its buffer from it, and `CMP-05` adds it to the turn-end gap, because
   * between two of a batch model's answers nothing arrives and the absence of
   * events is not silence (FR-050, ADR-022, NFR-017).
   */
  batchIntervalMs?: number;
  audio: { encoding: 'linear16'; sampleRate: 16000; channels: 1 };
  pricePerAudioMinuteUsd: number;
  /** Dashboard badge text, for example the non-streaming penalty (FR-049). */
  badge?: string;
}

/** An LLM model and its price (FR-071). */
export interface LlmModelDescriptor {
  id: string;
  displayName: string;
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
}

export type ThemeMode = 'light' | 'dark' | 'system';
export type OverlayTranslucency = 'acrylic' | 'opacity';

/** Non-secret settings, persisted by electron-store (FR-020). */
export interface Settings {
  schemaVersion: 3;
  activeProfileId: string;
  providers: {
    stt: { primary: ProviderChoice; backup: ProviderChoice | null };
    llm: { primary: ProviderChoice; backup: ProviderChoice | null };
  };
  theme: {
    mode: ThemeMode;
    accent: string;
    overlayTranslucency: OverlayTranslucency;
    overlayOpacity: number;
    overlayFontSizePx: number;
  };
  hotkeys: {
    toggleInteraction: string;
    togglePause: string;
  };
  trigger: {
    turnEndGapMs: number;
    minTurnWords: number;
    minTurnChars: number;
    candidateContextTurns: number;
    candidateContextChars: number;
  };
  thresholds: {
    costUsd: number;
    timeMinutes: number;
  };
  consentReminderText: string;
  /**
   * Where the overlay sits and how big it is (FR-081, FR-082).
   *
   * `width` and `height` are null until the user resizes, which means "use the
   * shipped default size". Storing the default as a number instead would freeze
   * whatever 420 by 260 happened to be on the day the file was written, so a
   * later change to the default could never reach a user who had already run
   * the app once.
   */
  overlayWindow: {
    x: number | null;
    y: number | null;
    width: number | null;
    height: number | null;
    displayId: string | null;
    /**
     * Whether the overlay passes clicks to whatever is behind it (FR-083).
     *
     * True, the shipped default, is the teleprompter behavior: the overlay is
     * visible and the application underneath still takes every click. False
     * makes it a solid window that blocks what it covers.
     *
     * It is a setting rather than only a hotkey because the overlay is always
     * on top: it hides part of the screen either way, and a user who is covering
     * browser toolbar buttons wants the thing that covers them to behave like a
     * window rather than like a decal. The hotkey still toggles it, and writes
     * the result here, so what the user last chose is what the next launch does.
     */
    clickThrough: boolean;
  };
  firstRun: { modelDownloaded: boolean };
}

/**
 * Plaintext shape before `safeStorage.encryptString` (FR-021).
 * This type never crosses IPC. `secrets:status` returns booleans only (FR-022).
 */
export interface SecretVault {
  deepgramApiKey?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  elevenlabsApiKey?: string;
}

/** Which credentials are present. The only secret-shaped thing a renderer sees. */
export type SecretStatus = Record<CredentialId, boolean>;

export type DocType = 'resume' | 'company-notes' | 'job-description';
export type DocumentState = 'pending' | 'converting' | 'embedding' | 'ready' | 'error';

/** A company profile. The kb/ folder is authoritative, this is a derived index (ADR-014). */
export interface Profile {
  id: string;
  name: string;
  createdAt: string;
  kbPath: string;
  documents: DocumentRecord[];
}

export interface DocumentRecord {
  id: string;
  profileId: string;
  originalFileName: string;
  originalPath: string;
  sourceFormat: 'md' | 'pdf' | 'docx';
  derivedMarkdownPath: string | null;
  docType: DocType;
  /** A user override is never re-guessed (FR-064). */
  docTypeSource: 'auto' | 'user';
  contentHash: string;
  /** sha256(fileBytes):chunkerVersion:embeddingModelId (ADR-012). */
  embeddingKey: string;
  chunkCount: number;
  state: DocumentState;
  errorMessage: string | null;
  extractionQuality: 'native' | 'best-effort';
  updatedAt: string;
}

export interface Chunk {
  id: string;
  docId: string;
  profileId: string;
  index: number;
  text: string;
  headerPath: string[];
  docType: DocType;
  sourceFile: string;
  tokenCount: number;
}

export type TranscriptSource = 'interviewer' | 'candidate';

/**
 * One transcript entry. `seq` is monotonic and assigned by the Session Manager
 * at append time; order is seq order, not file order (ADR-018, FR-106).
 */
export type TranscriptEntry = { seq: number } & (
  | { kind: 'turn'; source: TranscriptSource; text: string; at: string }
  | {
      kind: 'suggestion';
      forQuestion: string;
      bullets: string[];
      model: string;
      providerId: string;
      at: string;
      status: 'complete' | 'cancelled' | 'nonconforming' | 'stale';
    }
);

export interface UsageRecord {
  sttAudioSeconds: { interviewer: number; candidate: number };
  llmInputTokens: number;
  llmOutputTokens: number;
  estimatedUsd: number;
  priceTableVersion: string;
  /**
   * A model consumed during the session had no price row, so `estimatedUsd`
   * understates spend and the Dashboard must label it incomplete rather than
   * show a bare number (ASM-011).
   */
  estimateIncomplete: boolean;
  /** At most one of each per session (FR-103, FR-109). */
  warningsIssued: ('cost' | 'time')[];
}

export interface Session {
  id: string;
  /** Bound at start and immutable (ADR-013). */
  profileId: string;
  profileNameSnapshot: string;
  startedAt: string;
  endedAt: string | null;
  entries: TranscriptEntry[];
  usage: UsageRecord;
  endReason: 'user' | 'crash-recovered' | null;
}

export interface SessionSummary {
  id: string;
  profileId: string;
  profileNameSnapshot: string;
  startedAt: string;
  endedAt: string | null;
  entryCount: number;
  estimatedUsd: number;
  endReason: 'user' | 'crash-recovered' | null;
}

/** Normalized STT output. Identical shape for every provider (FR-048). */
export interface TranscriptEvent {
  source: TranscriptSource;
  text: string;
  isFinal: boolean;
  timestamp: number;
  providerId: string;
  confidence?: number;
}

/**
 * One second of PCM. Never written to disk (NFR-002).
 *
 * The buffer is copied, not transferred: Electron IPC accepts only a MessagePort
 * in a transfer list. ADR-027 measured the copy at 31 KiB and 0.08 ms and found
 * it is not the risk; unbounded retention is. So the enforceable property is
 * that nobody holds a reference after handing the chunk on (FR-043).
 */
export interface AudioChunk {
  source: TranscriptSource;
  pcm: ArrayBuffer;
  timestamp: number;
  sequence: number;
}

/** One completed bullet, flushed per line and never per token (FR-074). */
export interface SuggestionLine {
  generationId: string;
  cardId: string;
  line: string;
  index: number;
}

export type StreamState = 'idle' | 'starting' | 'running' | 'error';

/**
 * How a provider failure is classified. `retryable` follows from the class:
 * false for 'auth' and 'client', true for the rest (ADR-024).
 */
export type ErrorClass = 'auth' | 'rate-limit' | 'network' | 'timeout' | 'server' | 'client';

export interface ProviderError extends Error {
  class: ErrorClass;
  providerId: string;
  retryable: boolean;
}

/** Health is keyed by credential, never by capability (ADR-017). */
export type HealthState =
  | { kind: 'using-primary' }
  | { kind: 'retrying'; attempt: number }
  | { kind: 'using-backup' }
  | { kind: 'degraded'; reason: string }
  | { kind: 'config-required'; credentialId: CredentialId; reason: string };

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}
