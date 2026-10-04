/**
 * Deepgram streaming adapter. No filesystem imports (NFR-002).
 *
 * `docs/02-architecture.md` section 3.1: `encoding=linear16`,
 * `sample_rate=16000`, `channels=1`, `interim_results=true`, and `endpointing`
 * taken from `settings.trigger.turnEndGapMs` (TC-052, TC-159).
 */
import type {
  AudioChunk,
  ProviderChoice,
  TranscriptSource,
  ValidationResult,
} from '../../../shared/types.js';
import { classifyStatus } from '../stt.js';
import type { SttProvider, SttSession, SttSessionOptions } from '../stt.js';
import type {
  ConnectSpec,
  Emitter,
  SocketAdapterSpec,
  SocketFactory,
  SocketSessionDeps,
} from './socket-session.js';
import {
  FrameShapeError,
  openSocketSession,
  optionalString,
  parseFrame,
} from './socket-session.js';

export const DEEPGRAM_SOCKET_URL = 'wss://api.deepgram.com/v1/listen';
const DEEPGRAM_VALIDATE_URL = 'https://api.deepgram.com/v1/projects';

/**
 * Built as a function rather than a constant so the gap is read at connect
 * time. A hard-coded 800 fails TC-159.
 */
export function deepgramConnectSpec(
  choice: ProviderChoice,
  key: string,
  options: SttSessionOptions,
): ConnectSpec {
  const params = new URLSearchParams({
    model: choice.modelId,
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    interim_results: 'true',
    endpointing: String(options.turnEndGapMs),
  });
  return {
    url: `${DEEPGRAM_SOCKET_URL}?${params.toString()}`,
    // Deepgram accepts the key as a subprotocol, which keeps it out of the URL
    // and therefore out of any proxy or error log that records the target.
    protocols: ['token', key],
  };
}

/**
 * Reads one Deepgram frame. Only `Results` frames carry a transcript; the
 * others (`Metadata`, `SpeechStarted`, `UtteranceEnd`) are ignored.
 *
 * Deepgram reports a refused key or a bad parameter by refusing the upgrade or
 * closing the socket, which `SocketSttSession` classifies from the HTTP status
 * or the close code. No in-band error frame is relied on here: none is
 * documented in this repository or exercised by a fixture (ADR-056).
 */
function readDeepgramFrame(raw: string, emit: Emitter): void {
  const frame = parseFrame(raw);
  const type = optionalString(frame, 'type');
  if (type !== undefined && type !== 'Results') return;

  const alternative = firstAlternative(frame.channel);
  const text = alternative ? (optionalString(alternative, 'transcript') ?? '') : '';
  const confidence = alternative?.confidence;
  if (confidence !== undefined && typeof confidence !== 'number') {
    throw new FrameShapeError('"confidence" is not a number');
  }
  // Deepgram sends empty interim results constantly. Emitting them would
  // blank the overlay between words.
  if (text !== '') emit.transcript(text, frame.is_final === true, confidence);
  // speech_final is the native turn end, fired at the `endpointing` gap.
  if (frame.speech_final === true) emit.endpoint();
}

function firstAlternative(channel: unknown): Record<string, unknown> | null {
  if (channel === undefined) return null;
  if (typeof channel !== 'object' || channel === null) {
    throw new FrameShapeError('"channel" is not an object');
  }
  const alternatives = (channel as { alternatives?: unknown }).alternatives;
  if (alternatives === undefined) return null;
  if (!Array.isArray(alternatives)) throw new FrameShapeError('"alternatives" is not an array');
  const first: unknown = alternatives[0];
  if (first === undefined) return null;
  if (typeof first !== 'object' || first === null) {
    throw new FrameShapeError('an alternative is not an object');
  }
  return first as Record<string, unknown>;
}

export function deepgramAdapterSpec(
  choice: ProviderChoice,
  key: string,
  options: SttSessionOptions,
): SocketAdapterSpec {
  return {
    providerId: 'deepgram',
    connect: () => deepgramConnectSpec(choice, key, options),
    handleMessage: readDeepgramFrame,
    encode: (chunk: AudioChunk) => new Uint8Array(chunk.pcm),
    // Deepgram answers CloseStream with its last results and then closes the
    // socket, which ends the session's close drain.
    closeFrame: () => JSON.stringify({ type: 'CloseStream' }),
  };
}

export function createDeepgramProvider(
  factory: SocketFactory,
  deps: SocketSessionDeps = {},
): SttProvider {
  return {
    id: 'deepgram',
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
        spec: deepgramAdapterSpec(choice, key, options),
        factory,
      });
    },
    async validateKey(key: string): Promise<ValidationResult> {
      try {
        const res = await fetch(DEEPGRAM_VALIDATE_URL, {
          headers: { Authorization: `Token ${key}` },
        });
        if (res.ok) return { ok: true };
        return { ok: false, reason: validationReason(classifyStatus(res.status)) };
      } catch {
        return { ok: false, reason: 'Deepgram could not be reached. Check your connection.' };
      }
    },
  };
}

function validationReason(errorClass: ReturnType<typeof classifyStatus>): string {
  if (errorClass === 'auth') return 'Deepgram rejected this key.';
  if (errorClass === 'rate-limit') return 'Deepgram is rate limiting this key. Try again shortly.';
  return 'Deepgram could not confirm this key.';
}
