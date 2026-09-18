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
import { classifyStatus, providerError } from '../stt.js';
import type { SttProvider, SttSession, SttSessionOptions } from '../stt.js';
import type { ConnectSpec, SocketAdapterSpec, SocketFactory } from './socket-session.js';
import { SocketSttSession } from './socket-session.js';

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

interface DeepgramFrame {
  type?: string;
  speech_final?: boolean;
  is_final?: boolean;
  channel?: { alternatives?: { transcript?: string; confidence?: number }[] };
}

export function deepgramAdapterSpec(
  choice: ProviderChoice,
  key: string,
  options: SttSessionOptions,
): SocketAdapterSpec {
  return {
    providerId: 'deepgram',
    connect: () => deepgramConnectSpec(choice, key, options),
    handleMessage: (raw, emit) => {
      const frame = JSON.parse(raw) as DeepgramFrame;
      if (frame.type && frame.type !== 'Results') return;
      const text = frame.channel?.alternatives?.[0]?.transcript ?? '';
      // Deepgram sends empty interim results constantly. Emitting them would
      // blank the overlay between words.
      if (text !== '')
        emit.transcript(
          text,
          frame.is_final === true,
          frame.channel?.alternatives?.[0]?.confidence,
        );
      // speech_final is the native turn end, fired at the `endpointing` gap.
      if (frame.speech_final === true) emit.endpoint();
    },
    encode: (chunk: AudioChunk) => new Uint8Array(chunk.pcm),
    closeFrame: () => JSON.stringify({ type: 'CloseStream' }),
  };
}

export function createDeepgramProvider(factory: SocketFactory): SttProvider {
  return {
    id: 'deepgram',
    open(
      choice: ProviderChoice,
      source: TranscriptSource,
      key: string,
      options: SttSessionOptions,
    ): Promise<SttSession> {
      const session = new SocketSttSession({
        source,
        choice,
        spec: deepgramAdapterSpec(choice, key, options),
        factory,
      });
      session.connect();
      return Promise.resolve(session);
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

// Re-exported so a caller that needs a typed error from this adapter does not
// have to reach past the adapter for it.
export const deepgramError = (cls: Parameters<typeof providerError>[1], message: string) =>
  providerError('deepgram', cls, message);
