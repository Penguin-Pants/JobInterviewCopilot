/**
 * ElevenLabs Scribe v2 Realtime adapter. No filesystem imports (NFR-002).
 *
 * `docs/02-architecture.md` section 3.1: input format `pcm_16000`, partial
 * transcripts to `isFinal: false`, committed segments to `isFinal: true` and to
 * `endpoint` (TC-153).
 *
 * The wire protocol follows the official SDK (`@elevenlabs/elevenlabs-js`,
 * `wrapper/realtime/connection.js`), ADR-056: every frame is JSON keyed by
 * `message_type`, audio goes up base64 inside an `input_audio_chunk` frame,
 * and an empty chunk with `commit: true` flushes the last segment.
 *
 * The VAD commit strategy takes a silence threshold, so the user's chosen gap
 * is passed through here as it is for the other two (FR-050, TC-159).
 */
import type {
  AudioChunk,
  ErrorClass,
  ProviderChoice,
  TranscriptSource,
  ValidationResult,
} from '../../../shared/types.js';
import { classifyStatus, providerError } from '../stt.js';
import type { SttProvider, SttSession, SttSessionOptions } from '../stt.js';
import type {
  ConnectSpec,
  Emitter,
  SocketAdapterSpec,
  SocketFactory,
  SocketSessionDeps,
} from './socket-session.js';
import { openSocketSession, optionalString, parseFrame } from './socket-session.js';

export const ELEVENLABS_SOCKET_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
const ELEVENLABS_VALIDATE_URL = 'https://api.elevenlabs.io/v1/user';

/** What the Audio Worker emits, so there is no per-provider resampling. */
const SAMPLE_RATE = 16000;

/** The range the SDK accepts for `vad_silence_threshold_secs`. */
export const VAD_SILENCE_MIN_SECS = 0.3;
export const VAD_SILENCE_MAX_SECS = 3.0;

export function elevenLabsConnectSpec(
  choice: ProviderChoice,
  key: string,
  options: SttSessionOptions,
): ConnectSpec {
  const params = new URLSearchParams({
    model_id: choice.modelId,
    // Raw little-endian signed 16-bit PCM at 16 kHz mono: exactly what the
    // Audio Worker emits.
    audio_format: 'pcm_16000',
    commit_strategy: 'vad',
    // The silence that ends a VAD segment, which is this provider's turn end.
    // `min_silence_duration_ms` is a different VAD knob and is not the gap.
    vad_silence_threshold_secs: String(vadSilenceThresholdSecs(options.turnEndGapMs)),
  });
  return {
    url: `${ELEVENLABS_SOCKET_URL}?${params.toString()}`,
    headers: { 'xi-api-key': key },
  };
}

/**
 * The gap in seconds, clamped to what the provider accepts. Outside the range
 * the provider refuses the session, which is worse than the nearest legal gap.
 */
export function vadSilenceThresholdSecs(turnEndGapMs: number): number {
  return Math.min(VAD_SILENCE_MAX_SECS, Math.max(VAD_SILENCE_MIN_SECS, turnEndGapMs / 1000));
}

/**
 * Error frames that end the session, and their class. The SDK forwards every
 * one of these as an error. Other error types are logged and the session goes
 * on: `commit_throttled` and `insufficient_audio_activity` describe a moment,
 * not a broken session, and a server that does end the session closes the
 * socket, which the reconnect ladder handles.
 */
const ERROR_CLASSES: Record<string, ErrorClass> = {
  auth_error: 'auth',
  // The account has not accepted the terms. Retrying cannot fix that.
  unaccepted_terms: 'auth',
  quota_exceeded: 'rate-limit',
  rate_limited: 'rate-limit',
  resource_exhausted: 'server',
  queue_overflow: 'server',
  transcriber_error: 'server',
  session_time_limit_exceeded: 'server',
  error: 'server',
  // A rejected payload, not a rejected credential. As `client` it was
  // non-retryable, so with no backup the key went to `config-required`, which a
  // new key cannot fix (ADR-024). As `server` the session is reopened and the
  // health machine retries and degrades instead.
  invalid_request: 'server',
  input_error: 'server',
  chunk_size_exceeded: 'server',
};

const NOTICES = new Set(['commit_throttled', 'insufficient_audio_activity']);

function readElevenLabsFrame(raw: string, emit: Emitter): void {
  const frame = parseFrame(raw);
  const type = optionalString(frame, 'message_type');
  if (type === undefined) return;

  if (type === 'session_started') {
    emit.ready();
    return;
  }
  if (type === 'partial_transcript') {
    const text = optionalString(frame, 'text') ?? '';
    if (text !== '') emit.transcript(text, false);
    return;
  }
  if (type === 'committed_transcript') {
    const text = optionalString(frame, 'text') ?? '';
    if (text !== '') emit.transcript(text, true);
    // A commit is the turn end for this provider. It fires at the VAD silence
    // threshold, which is the user's configured gap. It does not end the close
    // drain: the frame has no field that says which commit it answers (SDK
    // `CommittedTranscriptPayload`), so a VAD commit and the final commit
    // look the same.
    emit.endpoint();
    return;
  }

  const detail = optionalString(frame, 'error') ?? 'no detail';
  const errorClass = ERROR_CLASSES[type];
  if (errorClass !== undefined) {
    emit.error(providerError('elevenlabs', errorClass, `ElevenLabs ${type}: ${detail}`));
    return;
  }
  if (NOTICES.has(type)) emit.notice(`ElevenLabs ${type}: ${detail}`);
  // Anything else (timestamps, entities, edits) was not asked for.
}

function audioFrame(base64: string, commit: boolean): string {
  return JSON.stringify({
    message_type: 'input_audio_chunk',
    audio_base_64: base64,
    commit,
    sample_rate: SAMPLE_RATE,
  });
}

export function elevenLabsAdapterSpec(
  choice: ProviderChoice,
  key: string,
  options: SttSessionOptions,
): SocketAdapterSpec {
  return {
    providerId: 'elevenlabs',
    connect: () => elevenLabsConnectSpec(choice, key, options),
    awaitsSessionStart: true,
    handleMessage: readElevenLabsFrame,
    encode: (chunk: AudioChunk) => audioFrame(Buffer.from(chunk.pcm).toString('base64'), false),
    // An empty commit flushes whatever the VAD has not committed yet, so the
    // last words before Stop come back as a committed transcript.
    closeFrame: () => audioFrame('', true),
  };
}

export function createElevenLabsProvider(
  factory: SocketFactory,
  deps: SocketSessionDeps = {},
): SttProvider {
  return {
    id: 'elevenlabs',
    open(
      choice: ProviderChoice,
      source: TranscriptSource,
      key: string,
      options: SttSessionOptions,
    ): Promise<SttSession> {
      return openSocketSession({
        ...deps,
        source,
        choice,
        spec: elevenLabsAdapterSpec(choice, key, options),
        factory,
      });
    },
    async validateKey(key: string): Promise<ValidationResult> {
      try {
        const res = await fetch(ELEVENLABS_VALIDATE_URL, { headers: { 'xi-api-key': key } });
        if (res.ok) return { ok: true };
        const cls = classifyStatus(res.status);
        if (cls === 'auth') return { ok: false, reason: 'ElevenLabs rejected this key.' };
        if (cls === 'rate-limit') {
          return { ok: false, reason: 'ElevenLabs is rate limiting this key. Try again shortly.' };
        }
        return { ok: false, reason: 'ElevenLabs could not confirm this key.' };
      } catch {
        return { ok: false, reason: 'ElevenLabs could not be reached. Check your connection.' };
      }
    },
  };
}
