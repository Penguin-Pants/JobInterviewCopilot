/**
 * ElevenLabs Scribe v2 Realtime adapter. No filesystem imports (NFR-002).
 *
 * `docs/02-architecture.md` section 3.1: input format `pcm_16000`, partial
 * transcripts to `isFinal: false`, committed segments to `isFinal: true` and to
 * `endpoint` (TC-153).
 *
 * The VAD commit strategy takes a silence threshold, so the user's chosen gap
 * is passed through here as it is for the other two (FR-050, TC-159).
 */
import type {
  AudioChunk,
  ProviderChoice,
  TranscriptSource,
  ValidationResult,
} from '../../../shared/types.js';
import { classifyStatus } from '../stt.js';
import type { SttProvider, SttSession, SttSessionOptions } from '../stt.js';
import type { ConnectSpec, SocketAdapterSpec, SocketFactory } from './socket-session.js';
import { SocketSttSession } from './socket-session.js';

export const ELEVENLABS_SOCKET_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
const ELEVENLABS_VALIDATE_URL = 'https://api.elevenlabs.io/v1/user';

export function elevenLabsConnectSpec(
  choice: ProviderChoice,
  key: string,
  options: SttSessionOptions,
): ConnectSpec {
  const params = new URLSearchParams({
    model_id: choice.modelId,
    // Raw little-endian signed 16-bit PCM at 16 kHz mono: exactly what the
    // Audio Worker emits, so there is no per-provider resampling.
    audio_format: 'pcm_16000',
    commit_strategy: 'vad',
    min_silence_duration_ms: String(options.turnEndGapMs),
  });
  return {
    url: `${ELEVENLABS_SOCKET_URL}?${params.toString()}`,
    headers: { 'xi-api-key': key },
  };
}

interface ElevenLabsFrame {
  type?: string;
  text?: string;
  transcript?: string;
}

export function elevenLabsAdapterSpec(
  choice: ProviderChoice,
  key: string,
  options: SttSessionOptions,
): SocketAdapterSpec {
  return {
    providerId: 'elevenlabs',
    connect: () => elevenLabsConnectSpec(choice, key, options),
    handleMessage: (raw, emit) => {
      const frame = JSON.parse(raw) as ElevenLabsFrame;
      const text = frame.text ?? frame.transcript ?? '';
      switch (frame.type) {
        case 'partial_transcript':
          if (text !== '') emit.transcript(text, false);
          return;
        case 'committed_transcript':
          if (text !== '') emit.transcript(text, true);
          // A commit is the turn end for this provider. It fires at the VAD
          // silence threshold, which is the user's configured gap.
          emit.endpoint();
          return;
        default:
          return;
      }
    },
    encode: (chunk: AudioChunk) => new Uint8Array(chunk.pcm),
    closeFrame: () => JSON.stringify({ type: 'close' }),
  };
}

export function createElevenLabsProvider(factory: SocketFactory): SttProvider {
  return {
    id: 'elevenlabs',
    open(
      choice: ProviderChoice,
      source: TranscriptSource,
      key: string,
      options: SttSessionOptions,
    ): Promise<SttSession> {
      const session = new SocketSttSession({
        source,
        choice,
        spec: elevenLabsAdapterSpec(choice, key, options),
        factory,
      });
      session.connect();
      return Promise.resolve(session);
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
