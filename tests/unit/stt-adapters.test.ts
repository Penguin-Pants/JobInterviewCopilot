/**
 * TASK-012. The three streaming adapters, driven through a fake socket so the
 * wire format and the reconnect path are asserted rather than assumed.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioChunk, ProviderError, TranscriptEvent } from '../../src/shared/types.js';
import {
  classifyStatus,
  clearSttProviders,
  getSttProvider,
  isRetryable,
  openSttSession,
  registerSttProvider,
} from '../../src/main/ai/stt.js';
import type { ConnectSpec, SocketLike } from '../../src/main/ai/stt/socket-session.js';
import {
  HEALTHY_CONNECTION_MS,
  MAX_QUEUED_CHUNKS,
  RECONNECT_BACKOFF_MS,
  SocketSttSession,
} from '../../src/main/ai/stt/socket-session.js';
import { createDeepgramProvider, deepgramConnectSpec } from '../../src/main/ai/stt/deepgram.js';
import {
  createOpenAiRealtimeProvider,
  openAiHandshakeFrame,
} from '../../src/main/ai/stt/openai-realtime.js';
import {
  createElevenLabsProvider,
  elevenLabsConnectSpec,
} from '../../src/main/ai/stt/elevenlabs.js';

/** A socket we drive by hand. Records every frame the adapter sends. */
class FakeSocket implements SocketLike {
  readonly sent: (string | Uint8Array)[] = [];
  closedWith: number | null = null;
  private readonly handlers = new Map<string, ((e: never) => void)[]>();

  constructor(readonly spec: ConnectSpec) {}

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closedWith = code ?? 1000;
  }

  addEventListener(type: string, h: (e: never) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(h);
    this.handlers.set(type, list);
  }

  private fire(type: string, event?: unknown): void {
    for (const h of this.handlers.get(type) ?? []) (h as (e: unknown) => void)(event);
  }

  opened(): void {
    this.fire('open');
  }

  receive(frame: unknown): void {
    this.fire('message', { data: JSON.stringify(frame) });
  }

  /** Delivers the text verbatim, so a malformed frame really is malformed. */
  receiveRaw(text: string): void {
    this.fire('message', { data: text });
  }

  dropped(code = 1006, reason = 'abnormal'): void {
    this.fire('close', { code, reason });
  }

  /** The text frames only, decoded for assertion. */
  get textFrames(): string[] {
    return this.sent.filter((f): f is string => typeof f === 'string');
  }

  get binaryFrames(): Uint8Array[] {
    return this.sent.filter((f): f is Uint8Array => typeof f !== 'string');
  }
}

/** Hands back every socket it made, so a reconnect is observable. */
function fakeFactory(): { factory: (s: ConnectSpec) => SocketLike; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  return {
    factory: (spec) => {
      const socket = new FakeSocket(spec);
      sockets.push(socket);
      return socket;
    },
    sockets,
  };
}

function chunk(sequence = 0, source: AudioChunk['source'] = 'interviewer'): AudioChunk {
  return { source, pcm: new ArrayBuffer(32000), timestamp: 1_000 + sequence, sequence };
}

const OPTIONS = { turnEndGapMs: 800 };

beforeEach(() => {
  clearSttProviders();
});

/** TC-052 and TC-159: the Deepgram URL, and the gap that must not be hard-coded. */
describe('TC-052 Deepgram connection parameters', () => {
  it('carries the PCM format the audio worker produces and asks for interims', () => {
    const spec = deepgramConnectSpec({ providerId: 'deepgram', modelId: 'nova-3' }, 'k', OPTIONS);
    const url = new URL(spec.url);
    expect(url.searchParams.get('encoding')).toBe('linear16');
    expect(url.searchParams.get('sample_rate')).toBe('16000');
    expect(url.searchParams.get('channels')).toBe('1');
    expect(url.searchParams.get('interim_results')).toBe('true');
    expect(url.searchParams.get('endpointing')).toBe('800');
    expect(url.searchParams.get('model')).toBe('nova-3');
  });

  it('keeps the key out of the URL', () => {
    const spec = deepgramConnectSpec(
      { providerId: 'deepgram', modelId: 'nova-3' },
      'secret',
      OPTIONS,
    );
    expect(spec.url).not.toContain('secret');
    expect(spec.protocols).toEqual(['token', 'secret']);
  });
});

/** TC-159: a hard-coded 800 fails this. */
describe('TC-159 endpointing uses the configured gap', () => {
  it('sends 1400 when the user chose 1400', () => {
    const spec = deepgramConnectSpec({ providerId: 'deepgram', modelId: 'nova-3' }, 'k', {
      turnEndGapMs: 1400,
    });
    expect(new URL(spec.url).searchParams.get('endpointing')).toBe('1400');
  });

  it('passes the same gap to OpenAI server VAD', () => {
    const frame = JSON.parse(
      openAiHandshakeFrame(
        { providerId: 'openai', modelId: 'gpt-4o-transcribe' },
        { turnEndGapMs: 1400 },
      ),
    ) as { session: { turn_detection: { silence_duration_ms: number; type: string } } };
    expect(frame.session.turn_detection.silence_duration_ms).toBe(1400);
    expect(frame.session.turn_detection.type).toBe('server_vad');
  });

  it('passes the same gap to the ElevenLabs VAD commit strategy', () => {
    const spec = elevenLabsConnectSpec(
      { providerId: 'elevenlabs', modelId: 'scribe-v2-realtime' },
      'k',
      { turnEndGapMs: 1400 },
    );
    const url = new URL(spec.url);
    expect(url.searchParams.get('min_silence_duration_ms')).toBe('1400');
    expect(url.searchParams.get('commit_strategy')).toBe('vad');
    expect(url.searchParams.get('audio_format')).toBe('pcm_16000');
  });
});

/** TC-050: every adapter emits the same shape and nothing else. */
describe('TC-050 normalized events', () => {
  const cases: {
    name: string;
    make: (f: (s: ConnectSpec) => SocketLike) => ReturnType<typeof createDeepgramProvider>;
    modelId: string;
    interim: unknown;
    final: unknown;
    text: string;
  }[] = [
    {
      name: 'deepgram',
      make: createDeepgramProvider,
      modelId: 'nova-3',
      interim: {
        channel: { alternatives: [{ transcript: 'tell me', confidence: 0.7 }] },
        is_final: false,
      },
      final: {
        channel: { alternatives: [{ transcript: 'tell me about yourself', confidence: 0.91 }] },
        is_final: true,
      },
      text: 'tell me about yourself',
    },
    {
      name: 'openai',
      make: createOpenAiRealtimeProvider,
      modelId: 'gpt-4o-transcribe',
      interim: { type: 'conversation.item.input_audio_transcription.delta', delta: 'tell me' },
      final: {
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: 'tell me about yourself',
      },
      text: 'tell me about yourself',
    },
    {
      name: 'elevenlabs',
      make: createElevenLabsProvider,
      modelId: 'scribe-v2-realtime',
      interim: { type: 'partial_transcript', text: 'tell me' },
      final: { type: 'committed_transcript', text: 'tell me about yourself' },
      text: 'tell me about yourself',
    },
  ];

  for (const c of cases) {
    it(`${c.name} emits exactly {source, text, isFinal, timestamp, providerId}`, async () => {
      const { factory, sockets } = fakeFactory();
      const provider = c.make(factory);
      const session = await provider.open(
        { providerId: c.name, modelId: c.modelId },
        'interviewer',
        'key',
        OPTIONS,
      );
      const seen: TranscriptEvent[] = [];
      session.on('transcript', (t) => seen.push(t));

      const socket = sockets[0]!;
      socket.opened();
      socket.receive(c.interim);
      socket.receive(c.final);

      expect(seen).toHaveLength(2);
      expect(seen[0]!.isFinal).toBe(false);
      expect(seen[1]!.isFinal).toBe(true);
      expect(seen[1]!.text).toBe(c.text);
      for (const event of seen) {
        const keys = ['isFinal', 'providerId', 'source', 'text', 'timestamp'];
        if (c.name === 'deepgram') keys.push('confidence');
        expect(Object.keys(event).sort()).toEqual(keys.sort());
        expect(event.providerId).toBe(c.name);
        expect(event.source).toBe('interviewer');
        expect(typeof event.timestamp).toBe('number');
      }
      expect(seen[1]?.confidence).toBe(c.name === 'deepgram' ? 0.91 : undefined);
      await session.close();
    });
  }
});

/** TC-053: Deepgram's speech-final is the native turn end. */
describe('TC-053 endpoint event', () => {
  it('fires on a Deepgram speech_final message', async () => {
    const { factory, sockets } = fakeFactory();
    const session = await createDeepgramProvider(factory).open(
      { providerId: 'deepgram', modelId: 'nova-3' },
      'interviewer',
      'key',
      OPTIONS,
    );
    const endpoints = vi.fn();
    session.on('endpoint', endpoints);
    const socket = sockets[0]!;
    socket.opened();

    socket.receive({ channel: { alternatives: [{ transcript: 'a question' }] }, is_final: true });
    expect(endpoints).not.toHaveBeenCalled();

    socket.receive({
      channel: { alternatives: [{ transcript: 'a question' }] },
      is_final: true,
      speech_final: true,
    });
    expect(endpoints).toHaveBeenCalledTimes(1);
  });

  it('does not emit an empty interim, which would blank the overlay', async () => {
    const { factory, sockets } = fakeFactory();
    const session = await createDeepgramProvider(factory).open(
      { providerId: 'deepgram', modelId: 'nova-3' },
      'interviewer',
      'key',
      OPTIONS,
    );
    const seen: TranscriptEvent[] = [];
    session.on('transcript', (t) => seen.push(t));
    sockets[0]!.opened();
    sockets[0]!.receive({ channel: { alternatives: [{ transcript: '' }] }, is_final: false });
    expect(seen).toEqual([]);
  });
});

/** TC-152: the OpenAI realtime mapping. */
describe('TC-152 OpenAI realtime adapter', () => {
  it('configures the chosen model with server VAD on open', async () => {
    const { factory, sockets } = fakeFactory();
    await createOpenAiRealtimeProvider(factory).open(
      { providerId: 'openai', modelId: 'gpt-4o-mini-transcribe' },
      'candidate',
      'key',
      OPTIONS,
    );
    const socket = sockets[0]!;
    expect(socket.spec.headers?.Authorization).toBe('Bearer key');
    socket.opened();

    const handshake = JSON.parse(socket.textFrames[0]!) as {
      type: string;
      session: { input_audio_format: string; input_audio_transcription: { model: string } };
    };
    expect(handshake.type).toBe('transcription_session.update');
    expect(handshake.session.input_audio_transcription.model).toBe('gpt-4o-mini-transcribe');
    expect(handshake.session.input_audio_format).toBe('pcm16');
  });

  it('maps the VAD stop event to endpoint', async () => {
    const { factory, sockets } = fakeFactory();
    const session = await createOpenAiRealtimeProvider(factory).open(
      { providerId: 'openai', modelId: 'gpt-4o-transcribe' },
      'interviewer',
      'key',
      OPTIONS,
    );
    const endpoints = vi.fn();
    session.on('endpoint', endpoints);
    sockets[0]!.opened();
    sockets[0]!.receive({ type: 'input_audio_buffer.speech_stopped' });
    expect(endpoints).toHaveBeenCalledTimes(1);
  });

  it('sends audio as base64 in a JSON frame, not as bytes', async () => {
    const { factory, sockets } = fakeFactory();
    const session = await createOpenAiRealtimeProvider(factory).open(
      { providerId: 'openai', modelId: 'gpt-4o-transcribe' },
      'interviewer',
      'key',
      OPTIONS,
    );
    sockets[0]!.opened();
    session.push(chunk());
    const frame = JSON.parse(sockets[0]!.textFrames[1]!) as { type: string; audio: string };
    expect(frame.type).toBe('input_audio_buffer.append');
    expect(Buffer.from(frame.audio, 'base64').byteLength).toBe(32000);
  });
});

/** TC-153: the ElevenLabs mapping. */
describe('TC-153 ElevenLabs adapter', () => {
  it('commits a segment as a final and as a turn end', async () => {
    const { factory, sockets } = fakeFactory();
    const session = await createElevenLabsProvider(factory).open(
      { providerId: 'elevenlabs', modelId: 'scribe-v2-realtime' },
      'interviewer',
      'key',
      OPTIONS,
    );
    const seen: TranscriptEvent[] = [];
    const endpoints = vi.fn();
    session.on('transcript', (t) => seen.push(t));
    session.on('endpoint', endpoints);

    sockets[0]!.opened();
    sockets[0]!.receive({ type: 'partial_transcript', text: 'why do you' });
    expect(endpoints).not.toHaveBeenCalled();
    sockets[0]!.receive({ type: 'committed_transcript', text: 'why do you want this role' });

    expect(seen.map((t) => t.isFinal)).toEqual([false, true]);
    expect(endpoints).toHaveBeenCalledTimes(1);
  });

  it('sends raw PCM bytes with no resampling', async () => {
    const { factory, sockets } = fakeFactory();
    const session = await createElevenLabsProvider(factory).open(
      { providerId: 'elevenlabs', modelId: 'scribe-v2-realtime' },
      'interviewer',
      'key',
      OPTIONS,
    );
    sockets[0]!.opened();
    session.push(chunk());
    expect(sockets[0]!.binaryFrames[0]!.byteLength).toBe(32000);
  });
});

/** TC-051: two concurrent sessions never see each other's state. */
describe('TC-051 per-stream isolation', () => {
  it('a final on one stream does not touch the other', async () => {
    const { factory, sockets } = fakeFactory();
    const provider = createDeepgramProvider(factory);
    const interviewer = await provider.open(
      { providerId: 'deepgram', modelId: 'nova-3' },
      'interviewer',
      'key',
      OPTIONS,
    );
    const candidate = await provider.open(
      { providerId: 'deepgram', modelId: 'nova-3' },
      'candidate',
      'key',
      OPTIONS,
    );

    const interviewerEvents: TranscriptEvent[] = [];
    const candidateEvents: TranscriptEvent[] = [];
    interviewer.on('transcript', (t) => interviewerEvents.push(t));
    candidate.on('transcript', (t) => candidateEvents.push(t));

    sockets[0]!.opened();
    sockets[1]!.opened();
    sockets[0]!.receive({
      channel: { alternatives: [{ transcript: 'their turn' }] },
      is_final: true,
    });
    sockets[1]!.receive({
      channel: { alternatives: [{ transcript: 'my turn' }] },
      is_final: false,
    });

    expect(interviewerEvents.map((t) => t.text)).toEqual(['their turn']);
    expect(candidateEvents.map((t) => t.text)).toEqual(['my turn']);
    expect(interviewerEvents[0]!.source).toBe('interviewer');
    expect(candidateEvents[0]!.source).toBe('candidate');
    expect(sockets).toHaveLength(2);
  });
});

/** TC-054: a dropped socket reconnects and the session stays active. */
describe('TC-054 socket reconnect', () => {
  const immediately = () => Promise.resolve();

  function session(clock?: { t: number }) {
    const { factory, sockets } = fakeFactory();
    const s = new SocketSttSession({
      source: 'interviewer',
      choice: { providerId: 'deepgram', modelId: 'nova-3' },
      spec: {
        providerId: 'deepgram',
        connect: () => ({ url: 'wss://example.test/listen' }),
        handleMessage: (raw, emit) => emit.transcript(raw, true),
        encode: (c) => new Uint8Array(c.pcm),
      },
      factory,
      sleep: immediately,
      now: () => clock?.t ?? 0,
    });
    return { s, sockets };
  }

  it('opens a new socket and keeps delivering transcripts', async () => {
    const { s, sockets } = session();
    const errors: ProviderError[] = [];
    const seen: TranscriptEvent[] = [];
    s.on('error', (e) => errors.push(e));
    s.on('transcript', (t) => seen.push(t));

    s.connect();
    sockets[0]!.opened();
    sockets[0]!.dropped();
    await Promise.resolve();

    expect(sockets).toHaveLength(2);
    expect(errors).toEqual([]);
    sockets[1]!.opened();
    sockets[1]!.receive('still here');
    expect(seen).toHaveLength(1);
    expect(s.isOpen).toBe(true);
  });

  it('holds at most MAX_QUEUED_CHUNKS while the socket is down, then flushes', async () => {
    const { s, sockets } = session();
    s.connect();
    sockets[0]!.opened();
    sockets[0]!.dropped();
    await Promise.resolve();

    for (let i = 0; i < MAX_QUEUED_CHUNKS + 5; i += 1) s.push(chunk(i));
    expect(s.queuedChunks).toBe(MAX_QUEUED_CHUNKS);

    sockets[1]!.opened();
    expect(s.queuedChunks).toBe(0);
    expect(sockets[1]!.binaryFrames).toHaveLength(MAX_QUEUED_CHUNKS);
  });

  /**
   * ADR-036. The Cost Meter bills audio "actually sent to a provider", and the
   * queue drops the oldest chunks during an outage rather than growing without
   * bound (ADR-027). Counted at the caller, an outage longer than the queue was
   * billed as though every second of it had been transcribed.
   */
  it('counts only the bytes it put on the wire, never the chunks it dropped', async () => {
    const { s, sockets } = session();
    s.connect();
    sockets[0]!.opened();

    s.push(chunk(0));
    expect(s.sentBytes).toBe(32000);

    sockets[0]!.dropped();
    await Promise.resolve();

    // Five more than the queue holds, so five are dropped and never sent.
    for (let i = 0; i < MAX_QUEUED_CHUNKS + 5; i += 1) s.push(chunk(i));
    expect(s.sentBytes).toBe(32000);

    // The ones that survived the queue are billed when they are finally flushed.
    sockets[1]!.opened();
    expect(s.sentBytes).toBe(32000 * (1 + MAX_QUEUED_CHUNKS));
  });

  it('gives up after the ladder and reports a retryable error', async () => {
    const { s, sockets } = session();
    const errors: ProviderError[] = [];
    s.on('error', (e) => errors.push(e));

    s.connect();
    // Accepted then dropped immediately, over and over: a provider crashloop.
    // The clock never advances, so no connection counts as healthy and the
    // ladder is never reset. Three retries, then the session reports.
    for (let i = 0; i < RECONNECT_BACKOFF_MS.length + 1; i += 1) {
      sockets[i]!.opened();
      sockets[i]!.dropped();
      await Promise.resolve();
    }
    expect(sockets).toHaveLength(RECONNECT_BACKOFF_MS.length + 1);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.retryable).toBe(true);
  });

  it('resets the ladder only after a connection that stayed up', async () => {
    const clock = { t: 0 };
    const { s, sockets } = session(clock);
    const errors: ProviderError[] = [];
    s.on('error', (e) => errors.push(e));

    s.connect();
    // Two quick failures put the ladder at 2 of 3.
    for (let i = 0; i < 2; i += 1) {
      sockets[i]!.opened();
      sockets[i]!.dropped();
      await Promise.resolve();
    }
    // A connection that lives past the healthy threshold, then drops.
    sockets[2]!.opened();
    clock.t += HEALTHY_CONNECTION_MS;
    sockets[2]!.dropped();
    await Promise.resolve();

    // The ladder is back to zero, so three more quick failures are needed.
    expect(errors).toEqual([]);
    for (let i = 3; i < 6; i += 1) {
      sockets[i]!.opened();
      sockets[i]!.dropped();
      await Promise.resolve();
    }
    expect(errors).toHaveLength(1);
  });

  it('does not retry an auth rejection, which would fail identically forever', async () => {
    const { s, sockets } = session();
    const errors: ProviderError[] = [];
    s.on('error', (e) => errors.push(e));
    s.connect();
    sockets[0]!.dropped(1008, 'invalid credentials');
    await Promise.resolve();

    expect(sockets).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.class).toBe('auth');
    expect(errors[0]!.retryable).toBe(false);
  });

  it('stops reconnecting once the session is closed', async () => {
    const { s, sockets } = session();
    s.connect();
    sockets[0]!.opened();
    await s.close();
    sockets[0]!.dropped();
    await Promise.resolve();
    expect(sockets).toHaveLength(1);
    expect(s.queuedChunks).toBe(0);
  });
});

describe('error classification', () => {
  it('treats auth and client as terminal and everything else as retryable', () => {
    expect(classifyStatus(401)).toBe('auth');
    expect(classifyStatus(403)).toBe('auth');
    expect(classifyStatus(429)).toBe('rate-limit');
    expect(classifyStatus(500)).toBe('server');
    expect(classifyStatus(422)).toBe('client');
    expect(isRetryable('auth')).toBe(false);
    expect(isRetryable('client')).toBe(false);
    for (const c of ['rate-limit', 'network', 'timeout', 'server'] as const) {
      expect(isRetryable(c)).toBe(true);
    }
  });
});

describe('the facade dispatches on the model, not the provider id', () => {
  it('refuses a choice that is not in the registry', async () => {
    const { factory } = fakeFactory();
    registerSttProvider(createDeepgramProvider(factory));
    await expect(
      openSttSession({ providerId: 'deepgram', modelId: 'nova-99' }, 'interviewer', 'k', OPTIONS),
    ).rejects.toThrow(/not in the speech-to-text registry/);
  });

  it('refuses a non-streaming model until a batch adapter exists', async () => {
    const { factory } = fakeFactory();
    registerSttProvider(createOpenAiRealtimeProvider(factory));
    // whisper-1 is streaming: false, so the streaming adapter must not answer
    // for it even though the provider id matches. That is TASK-013's job.
    await expect(
      openSttSession({ providerId: 'openai', modelId: 'whisper-1' }, 'interviewer', 'k', OPTIONS),
    ).rejects.toThrow(/No batch speech-to-text adapter/);
    expect(getSttProvider('openai', 'batch')).toBeNull();
    expect(getSttProvider('openai')).not.toBeNull();
  });
});

/**
 * A key that fails validation must say why in words the user can act on. These
 * are the strings a user sees when an interview will not start, so each branch
 * is asserted rather than assumed.
 */
describe('validation failure messages', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const providers = [
    { name: 'Deepgram', make: createDeepgramProvider },
    { name: 'OpenAI', make: createOpenAiRealtimeProvider },
    { name: 'ElevenLabs', make: createElevenLabsProvider },
  ];

  for (const { name, make } of providers) {
    describe(name, () => {
      const provider = () => make(fakeFactory().factory);

      it('accepts a key the provider accepts', async () => {
        fetchMock.mockResolvedValue({ ok: true, status: 200 });
        expect(await provider().validateKey('k', 'm')).toEqual({ ok: true });
      });

      it('names a rejection as a rejection', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 401 });
        const r = await provider().validateKey('k', 'm');
        expect(r.ok).toBe(false);
        expect(r.reason).toBe(`${name} rejected this key.`);
      });

      it('tells the user to wait when rate limited, rather than to replace the key', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 429 });
        const r = await provider().validateKey('k', 'm');
        expect(r.reason).toMatch(/rate limiting this key/);
      });

      it('does not blame the key for a server fault', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 503 });
        const r = await provider().validateKey('k', 'm');
        expect(r.reason).toBe(`${name} could not confirm this key.`);
        expect(r.reason).not.toMatch(/rejected/);
      });

      it('does not blame the key when the network is down', async () => {
        fetchMock.mockRejectedValue(new Error('offline'));
        const r = await provider().validateKey('k', 'm');
        expect(r.reason).toBe(`${name} could not be reached. Check your connection.`);
      });
    });
  }
});

describe('stream teardown', () => {
  it('tells Deepgram the stream ended before closing', async () => {
    const { factory, sockets } = fakeFactory();
    const session = await createDeepgramProvider(factory).open(
      { providerId: 'deepgram', modelId: 'nova-3' },
      'interviewer',
      'key',
      OPTIONS,
    );
    sockets[0]!.opened();
    await session.close();
    expect(JSON.parse(sockets[0]!.textFrames.at(-1)!)).toEqual({ type: 'CloseStream' });
    expect(sockets[0]!.closedWith).toBe(1000);
  });

  it('tells ElevenLabs the stream ended before closing', async () => {
    const { factory, sockets } = fakeFactory();
    const session = await createElevenLabsProvider(factory).open(
      { providerId: 'elevenlabs', modelId: 'scribe-v2-realtime' },
      'candidate',
      'key',
      OPTIONS,
    );
    sockets[0]!.opened();
    await session.close();
    expect(JSON.parse(sockets[0]!.textFrames.at(-1)!)).toEqual({ type: 'close' });
  });

  it('sends nothing extra to OpenAI, which has no close frame', async () => {
    const { factory, sockets } = fakeFactory();
    const session = await createOpenAiRealtimeProvider(factory).open(
      { providerId: 'openai', modelId: 'gpt-4o-transcribe' },
      'interviewer',
      'key',
      OPTIONS,
    );
    sockets[0]!.opened();
    const before = sockets[0]!.sent.length;
    await session.close();
    expect(sockets[0]!.sent).toHaveLength(before);
    expect(sockets[0]!.closedWith).toBe(1000);
  });

  it('drops a push after close rather than reviving the socket', async () => {
    const { factory, sockets } = fakeFactory();
    const session = await createDeepgramProvider(factory).open(
      { providerId: 'deepgram', modelId: 'nova-3' },
      'interviewer',
      'key',
      OPTIONS,
    );
    sockets[0]!.opened();
    await session.close();
    const after = sockets[0]!.sent.length;
    session.push(chunk(1));
    expect(sockets[0]!.sent).toHaveLength(after);
  });

  it('ignores a frame it cannot parse instead of ending the interview', async () => {
    const { factory, sockets } = fakeFactory();
    const session = await createDeepgramProvider(factory).open(
      { providerId: 'deepgram', modelId: 'nova-3' },
      'interviewer',
      'key',
      OPTIONS,
    );
    const errors: ProviderError[] = [];
    session.on('error', (e) => errors.push(e));
    sockets[0]!.opened();
    sockets[0]!.receiveRaw('not json at all{');
    expect(errors).toEqual([]);

    sockets[0]!.receive({
      channel: { alternatives: [{ transcript: 'still working' }] },
      is_final: true,
    });
    expect(errors).toEqual([]);
  });
});

/**
 * TASK-061, TC-171. `confidence` is Deepgram's field, and nobody else's.
 *
 * `TranscriptEvent.confidence` is populated only by an adapter whose active
 * model declares `supportsConfidence`, and only Deepgram's models do
 * (`TC-185`). The gate in `CMP-05` reads the field's absence as "this model
 * cannot answer the question" rather than as low confidence, so an adapter
 * inventing a value here would silently suppress turns (`FR-113`).
 */
describe('TC-171 only the Deepgram adapter reports confidence', () => {
  it('sets confidence from channel.alternatives[0].confidence on every event', async () => {
    const { factory, sockets } = fakeFactory();
    const session = await createDeepgramProvider(factory).open(
      { providerId: 'deepgram', modelId: 'nova-3' },
      'interviewer',
      'key',
      OPTIONS,
    );
    const seen: TranscriptEvent[] = [];
    session.on('transcript', (t) => seen.push(t));

    const socket = sockets[0]!;
    socket.opened();
    socket.receive({
      channel: { alternatives: [{ transcript: 'tell me', confidence: 0.42 }] },
      is_final: false,
    });
    socket.receive({
      channel: { alternatives: [{ transcript: 'tell me about yourself', confidence: 0.91 }] },
      is_final: true,
    });

    expect(seen.map((e) => e.confidence)).toEqual([0.42, 0.91]);

    // A frame the provider sends without the field carries none, rather than a
    // substituted value: no reading is not a low reading (ADR-032).
    socket.receive({ channel: { alternatives: [{ transcript: 'and then' }] }, is_final: true });
    expect(seen[2]).not.toHaveProperty('confidence');

    await session.close();
  });

  it('never sets it on the OpenAI realtime adapter', async () => {
    const { factory, sockets } = fakeFactory();
    const session = await createOpenAiRealtimeProvider(factory).open(
      { providerId: 'openai', modelId: 'gpt-4o-transcribe' },
      'interviewer',
      'key',
      OPTIONS,
    );
    const seen: TranscriptEvent[] = [];
    session.on('transcript', (t) => seen.push(t));

    const socket = sockets[0]!;
    socket.opened();
    socket.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'tell me about yourself',
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty('confidence');
    await session.close();
  });

  it('never sets it on the ElevenLabs adapter', async () => {
    const { factory, sockets } = fakeFactory();
    const session = await createElevenLabsProvider(factory).open(
      { providerId: 'elevenlabs', modelId: 'scribe-v2-realtime' },
      'interviewer',
      'key',
      OPTIONS,
    );
    const seen: TranscriptEvent[] = [];
    session.on('transcript', (t) => seen.push(t));

    const socket = sockets[0]!;
    socket.opened();
    socket.receive({ type: 'committed_transcript', text: 'tell me about yourself' });

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty('confidence');
    await session.close();
  });

  /**
   * Whisper is the fourth adapter and the one this file does not drive
   * (`TASK-013`, `tests/unit/whisper.test.ts`). Its response parsing is
   * asserted there; what is asserted here is that this task did not touch it,
   * which is a claim about the source rather than about one response.
   */
  it('leaves the three non-Deepgram adapters with no confidence field at all', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    for (const file of ['whisper.ts', 'openai-realtime.ts', 'elevenlabs.ts']) {
      const source = readFileSync(join(root, 'src', 'main', 'ai', 'stt', file), 'utf8');
      expect(source, `${file} mentions confidence`).not.toMatch(/confidence/);
    }
  });
});
