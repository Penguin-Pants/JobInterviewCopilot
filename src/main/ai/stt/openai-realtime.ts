/**
 * OpenAI realtime transcription adapter. No filesystem imports (NFR-002).
 *
 * `docs/02-architecture.md` section 3.1: a transcription session on the
 * realtime WebSocket, configured with the chosen model and server VAD. Deltas
 * map to `isFinal: false`, completed items to `isFinal: true`, the VAD stop
 * event to `endpoint` (TC-152).
 *
 * Server VAD takes `silence_duration_ms`, so the user's chosen gap is passed
 * through here exactly as Deepgram's `endpointing` is (FR-050, TC-159).
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

export const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
const OPENAI_VALIDATE_URL = 'https://api.openai.com/v1/models';

export function openAiConnectSpec(key: string): ConnectSpec {
  return {
    url: OPENAI_REALTIME_URL,
    headers: {
      Authorization: `Bearer ${key}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  };
}

/** The frame that configures the session. Sent once, immediately after open. */
export function openAiHandshakeFrame(choice: ProviderChoice, options: SttSessionOptions): string {
  return JSON.stringify({
    type: 'transcription_session.update',
    session: {
      input_audio_format: 'pcm16',
      input_audio_transcription: { model: choice.modelId },
      turn_detection: {
        type: 'server_vad',
        silence_duration_ms: options.turnEndGapMs,
      },
    },
  });
}

interface OpenAiFrame {
  type?: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string };
}

export function openAiAdapterSpec(
  choice: ProviderChoice,
  key: string,
  options: SttSessionOptions,
): SocketAdapterSpec {
  return {
    providerId: 'openai',
    connect: () => openAiConnectSpec(key),
    handshake: (send) => send(openAiHandshakeFrame(choice, options)),
    handleMessage: (raw, emit) => {
      const frame = JSON.parse(raw) as OpenAiFrame;
      switch (frame.type) {
        case 'conversation.item.input_audio_transcription.delta':
          if (frame.delta) emit.transcript(frame.delta, false);
          return;
        case 'conversation.item.input_audio_transcription.completed':
          if (frame.transcript) emit.transcript(frame.transcript, true);
          return;
        case 'input_audio_buffer.speech_stopped':
          emit.endpoint();
          return;
        default:
          return;
      }
    },
    // The realtime socket takes audio as base64 inside a JSON frame, not as a
    // binary frame. This is the one v1 provider that does not take raw bytes.
    encode: (chunk: AudioChunk) =>
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: Buffer.from(chunk.pcm).toString('base64'),
      }),
    closeFrame: () => null,
  };
}

export function createOpenAiRealtimeProvider(factory: SocketFactory): SttProvider {
  return {
    id: 'openai',
    open(
      choice: ProviderChoice,
      source: TranscriptSource,
      key: string,
      options: SttSessionOptions,
    ): Promise<SttSession> {
      const session = new SocketSttSession({
        source,
        choice,
        spec: openAiAdapterSpec(choice, key, options),
        factory,
      });
      session.connect();
      return Promise.resolve(session);
    },
    async validateKey(key: string): Promise<ValidationResult> {
      try {
        const res = await fetch(OPENAI_VALIDATE_URL, {
          headers: { Authorization: `Bearer ${key}` },
        });
        if (res.ok) return { ok: true };
        const cls = classifyStatus(res.status);
        if (cls === 'auth') return { ok: false, reason: 'OpenAI rejected this key.' };
        if (cls === 'rate-limit') {
          return { ok: false, reason: 'OpenAI is rate limiting this key. Try again shortly.' };
        }
        return { ok: false, reason: 'OpenAI could not confirm this key.' };
      } catch {
        return { ok: false, reason: 'OpenAI could not be reached. Check your connection.' };
      }
    },
  };
}
