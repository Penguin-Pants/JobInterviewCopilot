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
 *
 * `pcm16` input must be 24 kHz (the official SDK's `TranscriptionSessionUpdate`
 * type), and the Audio Worker emits 16 kHz, so this adapter upsamples every
 * chunk before it goes on the wire (ADR-056).
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
import {
  FrameShapeError,
  openSocketSession,
  optionalString,
  parseFrame,
} from './socket-session.js';
import { createUpsampler16kTo24k } from './resample.js';

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

/**
 * The frame that configures the session. Sent once, immediately after open.
 * The shape is the SDK's `TranscriptionSessionUpdate`.
 */
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

/**
 * The class of an OpenAI `error` frame, or null for one the session survives.
 *
 * The SDK says most realtime errors are recoverable and leave the session
 * open, so only errors that make the session useless end it. `server_error`
 * is the SDK's own example type. The `code` values are the REST API's codes;
 * that the socket uses the same ones is an unverified assumption, so an
 * unknown code falls through to a logged notice rather than a teardown.
 */
export function openAiErrorClass(type: string, code: string): ErrorClass | null {
  if (type === 'server_error') return 'server';
  if (/invalid_api_key|authentication|unauthorized|permission/.test(`${type} ${code}`)) {
    return 'auth';
  }
  if (/insufficient_quota|rate_limit/.test(`${type} ${code}`)) return 'rate-limit';
  return null;
}

function readOpenAiError(frame: Record<string, unknown>, emit: Emitter): void {
  const error = frame.error;
  if (typeof error !== 'object' || error === null) {
    throw new FrameShapeError('"error" is not an object');
  }
  const details = error as Record<string, unknown>;
  const type = optionalString(details, 'type') ?? 'unknown';
  const code = optionalString(details, 'code') ?? '';
  const message = optionalString(details, 'message') ?? 'no detail';
  const errorClass = openAiErrorClass(type, code);
  const label = code === '' ? type : `${type}/${code}`;
  if (errorClass === null) {
    emit.notice(`OpenAI realtime error ${label}: ${message}`);
    return;
  }
  emit.error(providerError('openai', errorClass, `OpenAI realtime error ${label}: ${message}`));
}

function readOpenAiFrame(raw: string, emit: Emitter): void {
  const frame = parseFrame(raw);
  switch (optionalString(frame, 'type')) {
    case 'conversation.item.input_audio_transcription.delta': {
      const delta = optionalString(frame, 'delta');
      if (delta) emit.transcript(delta, false);
      return;
    }
    case 'conversation.item.input_audio_transcription.completed': {
      const transcript = optionalString(frame, 'transcript');
      if (transcript) emit.transcript(transcript, true);
      return;
    }
    case 'input_audio_buffer.speech_stopped':
      emit.endpoint();
      return;
    case 'conversation.item.input_audio_transcription.failed':
      // One item failed; the session goes on.
      emit.notice('OpenAI realtime could not transcribe one segment.');
      return;
    case 'error':
      readOpenAiError(frame, emit);
      return;
    default:
      return;
  }
}

export function openAiAdapterSpec(
  choice: ProviderChoice,
  key: string,
  options: SttSessionOptions,
): SocketAdapterSpec {
  // One upsampler per session, so its state follows one continuous stream.
  const upsample = createUpsampler16kTo24k();
  return {
    providerId: 'openai',
    connect: () => openAiConnectSpec(key),
    handshake: (send) => send(openAiHandshakeFrame(choice, options)),
    handleMessage: readOpenAiFrame,
    // The realtime socket takes audio as base64 inside a JSON frame, not as a
    // binary frame.
    encode: (chunk: AudioChunk) => {
      const samples = upsample(chunk.pcm);
      return JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString(
          'base64',
        ),
      });
    },
    closeFrame: () => null,
  };
}

/**
 * Shared by both OpenAI adapters. One key serves the realtime socket, the REST
 * transcription endpoint and GPT, so there is one check rather than one per
 * transport (ADR-017).
 */
export async function validateOpenAiKey(key: string): Promise<ValidationResult> {
  try {
    const res = await fetch(OPENAI_VALIDATE_URL, { headers: { Authorization: `Bearer ${key}` } });
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
}

export function createOpenAiRealtimeProvider(
  factory: SocketFactory,
  deps: SocketSessionDeps = {},
): SttProvider {
  return {
    id: 'openai',
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
        spec: openAiAdapterSpec(choice, key, options),
        factory,
      });
    },
    validateKey: validateOpenAiKey,
  };
}
