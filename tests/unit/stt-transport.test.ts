/**
 * The streaming STT transport audit: what `open` promises, what a provider
 * error frame does, what a malformed frame or a throwing listener does, the
 * tail after Stop, the OpenAI sample rate and the ElevenLabs wire protocol.
 *
 * Driven through `tests/fakes/socket.ts`, so every claim is about frames on a
 * wire rather than about calls between functions.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AudioChunk, ProviderError, TranscriptEvent } from '../../src/shared/types.js';
import {
  CLOSE_DRAIN_MS,
  OPEN_TIMEOUT_MS,
  SocketSttSession,
  type SttLog,
} from '../../src/main/ai/stt/socket-session.js';
import { createDeepgramProvider } from '../../src/main/ai/stt/deepgram.js';
import {
  createElevenLabsProvider,
  elevenLabsConnectSpec,
} from '../../src/main/ai/stt/elevenlabs.js';
import { createOpenAiRealtimeProvider } from '../../src/main/ai/stt/openai-realtime.js';
import { createUpsampler16kTo24k } from '../../src/main/ai/stt/resample.js';
import { fakeFactory, manualTimer } from '../fakes/socket.js';

const OPTIONS = { turnEndGapMs: 800 };
const DEEPGRAM = { providerId: 'deepgram', modelId: 'nova-3' };
const OPENAI = { providerId: 'openai', modelId: 'gpt-4o-transcribe' };
const ELEVENLABS = { providerId: 'elevenlabs', modelId: 'scribe-v2-realtime' };

function chunk(bytes = 32000): AudioChunk {
  return { source: 'interviewer', pcm: new ArrayBuffer(bytes), timestamp: 1, sequence: 0 };
}

async function settled(p: Promise<unknown>): Promise<'resolved' | 'rejected' | 'pending'> {
  let state: 'resolved' | 'rejected' | 'pending' = 'pending';
  p.then(
    () => (state = 'resolved'),
    () => (state = 'rejected'),
  );
  // Two turns of the microtask queue are enough for a settled promise to report.
  await Promise.resolve();
  await Promise.resolve();
  return state;
}

function rejection(p: Promise<unknown>): Promise<ProviderError> {
  return p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e as ProviderError,
  );
}

/** Finding 1: `open` resolves on a connected socket, and rejects on a refused one. */
describe('open resolves only once the provider has accepted the socket', () => {
  it('stays pending until the socket opens', async () => {
    const { factory, sockets } = fakeFactory();
    const pending = createDeepgramProvider(factory).open(DEEPGRAM, 'interviewer', 'k', OPTIONS);
    expect(await settled(pending)).toBe('pending');
    sockets[0]!.opened();
    expect(await settled(pending)).toBe('resolved');
  });

  it('rejects with a retryable error when the socket closes before it opens', async () => {
    const { factory, sockets } = fakeFactory();
    const pending = createDeepgramProvider(factory).open(DEEPGRAM, 'interviewer', 'k', OPTIONS);
    sockets[0]!.dropped(1006, '');
    const err = await rejection(pending);
    expect(err.class).toBe('network');
    expect(err.retryable).toBe(true);
    // No reconnect ladder inside a session that never opened: the caller's
    // health machine owns the retry, so the provider is not dialled twice.
    expect(sockets).toHaveLength(1);
  });

  it('classifies a refused upgrade by its HTTP status, so a revoked key is not retried', async () => {
    const { factory, sockets } = fakeFactory();
    const pending = createDeepgramProvider(factory).open(DEEPGRAM, 'interviewer', 'k', OPTIONS);
    sockets[0]!.errored('Unexpected server response: 401');
    sockets[0]!.dropped(1006, '');
    const err = await rejection(pending);
    expect(err.class).toBe('auth');
    expect(err.retryable).toBe(false);
  });

  it('rejects with a timeout when the socket never answers', async () => {
    const { factory, sockets } = fakeFactory();
    const clock = manualTimer();
    const pending = createDeepgramProvider(factory, { timer: clock.timer }).open(
      DEEPGRAM,
      'interviewer',
      'k',
      OPTIONS,
    );
    clock.fire(OPEN_TIMEOUT_MS);
    const err = await rejection(pending);
    expect(err.class).toBe('timeout');
    expect(err.retryable).toBe(true);
    expect(sockets[0]!.closedWith).not.toBeNull();
  });

  it('waits for the ElevenLabs session_started acknowledgement', async () => {
    const { factory, sockets } = fakeFactory();
    const pending = createElevenLabsProvider(factory).open(ELEVENLABS, 'interviewer', 'k', OPTIONS);
    sockets[0]!.opened();
    expect(await settled(pending)).toBe('pending');
    sockets[0]!.receive({ message_type: 'session_started', session_id: 's' });
    expect(await settled(pending)).toBe('resolved');
  });

  it('rejects with the auth class when ElevenLabs answers the open with auth_error', async () => {
    const { factory, sockets } = fakeFactory();
    const pending = createElevenLabsProvider(factory).open(ELEVENLABS, 'interviewer', 'k', OPTIONS);
    sockets[0]!.opened();
    sockets[0]!.receive({ message_type: 'auth_error', error: 'invalid api key' });
    const err = await rejection(pending);
    expect(err.class).toBe('auth');
    expect(err.retryable).toBe(false);
    expect(sockets[0]!.closedWith).not.toBeNull();
  });

  it('keeps the reconnect ladder for a socket that drops after it opened', async () => {
    const { factory, sockets } = fakeFactory();
    const session = new SocketSttSession({
      source: 'interviewer',
      choice: DEEPGRAM,
      spec: {
        providerId: 'deepgram',
        connect: () => ({ url: 'wss://example.test' }),
        handleMessage: () => undefined,
        encode: (c) => new Uint8Array(c.pcm),
      },
      factory,
      sleep: () => Promise.resolve(),
    });
    const errors: ProviderError[] = [];
    session.on('error', (e) => errors.push(e));
    const opening = session.connect();
    sockets[0]!.opened();
    await opening;
    sockets[0]!.dropped();
    await Promise.resolve();
    expect(sockets).toHaveLength(2);
    sockets[1]!.opened();
    expect(session.isOpen).toBe(true);
    expect(errors).toEqual([]);
  });
});

/** Finding 2: a malformed frame is dropped and logged; a listener's throw is not swallowed. */
describe('inbound frame handling', () => {
  async function openDeepgram(log: SttLog) {
    const { factory, sockets } = fakeFactory();
    const pending = createDeepgramProvider(factory, { log }).open(
      DEEPGRAM,
      'interviewer',
      'k',
      OPTIONS,
    );
    sockets[0]!.opened();
    return { session: await pending, socket: sockets[0]! };
  }

  it('logs a malformed frame without its contents and keeps the session', async () => {
    const log = vi.fn<SttLog>();
    const { session, socket } = await openDeepgram(log);
    const seen: TranscriptEvent[] = [];
    session.on('transcript', (t) => seen.push(t));

    socket.receiveRaw('secret words {not json');
    socket.receive(['an', 'array']);
    socket.receive({ channel: { alternatives: [{ transcript: 42 }] }, is_final: true });

    expect(log).toHaveBeenCalledTimes(3);
    for (const [level, message, detail] of log.mock.calls) {
      expect(level).toBe('warn');
      expect(`${message} ${JSON.stringify(detail)}`).not.toContain('secret words');
    }
    socket.receive({ channel: { alternatives: [{ transcript: 'still here' }] }, is_final: true });
    expect(seen.map((t) => t.text)).toEqual(['still here']);
  });

  it('reports a throwing transcript listener instead of swallowing it', async () => {
    const log = vi.fn<SttLog>();
    const { session, socket } = await openDeepgram(log);
    const after: string[] = [];
    session.on('transcript', () => {
      throw new Error('the live loop broke');
    });
    session.on('transcript', (t) => after.push(t.text));

    socket.receive({ channel: { alternatives: [{ transcript: 'hello' }] }, is_final: true });

    expect(log).toHaveBeenCalledWith('error', expect.any(String), expect.any(Error));
    // One broken listener does not starve the others of the event.
    expect(after).toEqual(['hello']);
  });
});

/** Finding 3: provider error frames reach the error path, classified. */
describe('provider error frames', () => {
  async function openOpenAi(log: SttLog = () => undefined) {
    const { factory, sockets } = fakeFactory();
    const pending = createOpenAiRealtimeProvider(factory, { log }).open(
      OPENAI,
      'interviewer',
      'k',
      OPTIONS,
    );
    sockets[0]!.opened();
    const session = await pending;
    const errors: ProviderError[] = [];
    session.on('error', (e) => errors.push(e));
    return { session, socket: sockets[0]!, errors, sockets };
  }

  it.each([
    ['server_error', null, 'server', true],
    ['invalid_request_error', 'invalid_api_key', 'auth', false],
    ['insufficient_quota', 'insufficient_quota', 'rate-limit', true],
    ['rate_limit_error', 'rate_limit_exceeded', 'rate-limit', true],
  ] as const)('maps an OpenAI %s/%s error to %s', async (type, code, cls, retryable) => {
    const { socket, errors, sockets } = await openOpenAi();
    socket.receive({ type: 'error', event_id: 'e', error: { type, code, message: 'bad' } });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.class).toBe(cls);
    expect(errors[0]!.retryable).toBe(retryable);
    expect(errors[0]!.providerId).toBe('openai');
    // The session is finished: the socket is closed and not redialled.
    expect(socket.closedWith).not.toBeNull();
    socket.dropped(1000, '');
    await Promise.resolve();
    expect(sockets).toHaveLength(1);
  });

  it('logs a recoverable OpenAI error and keeps the session open', async () => {
    const log = vi.fn<SttLog>();
    const { socket, errors, session } = await openOpenAi(log);
    socket.receive({
      type: 'error',
      event_id: 'e',
      error: { type: 'invalid_request_error', code: 'unknown_parameter', message: 'x' },
    });
    expect(errors).toEqual([]);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('invalid_request_error'));
    expect(session).toBeDefined();
    expect(socket.closedWith).toBeNull();
  });

  it.each([
    ['auth_error', 'auth'],
    ['unaccepted_terms', 'auth'],
    ['quota_exceeded', 'rate-limit'],
    ['rate_limited', 'rate-limit'],
    ['transcriber_error', 'server'],
    ['error', 'server'],
  ] as const)('maps an ElevenLabs %s frame to %s', async (messageType, cls) => {
    const { factory, sockets } = fakeFactory();
    const pending = createElevenLabsProvider(factory).open(ELEVENLABS, 'interviewer', 'k', OPTIONS);
    sockets[0]!.opened();
    sockets[0]!.receive({ message_type: 'session_started' });
    const session = await pending;
    const errors: ProviderError[] = [];
    session.on('error', (e) => errors.push(e));
    sockets[0]!.receive({ message_type: messageType, error: 'details' });
    expect(errors.map((e) => e.class)).toEqual([cls]);
    expect(errors[0]!.message).toContain('details');
  });

  it('ignores Deepgram metadata frames rather than reading them as transcripts', async () => {
    const { factory, sockets } = fakeFactory();
    const pending = createDeepgramProvider(factory).open(DEEPGRAM, 'interviewer', 'k', OPTIONS);
    sockets[0]!.opened();
    const session = await pending;
    const seen: TranscriptEvent[] = [];
    const errors: ProviderError[] = [];
    session.on('transcript', (t) => seen.push(t));
    session.on('error', (e) => errors.push(e));
    sockets[0]!.receive({ type: 'Metadata', request_id: 'r' });
    sockets[0]!.receive({ type: 'SpeechStarted' });
    expect(seen).toEqual([]);
    expect(errors).toEqual([]);
  });
});

/** Finding 7: the provider's last transcript after Stop is kept, within a bound. */
describe('the stream tail after Stop', () => {
  async function openWithClock(make: typeof createDeepgramProvider, choice = DEEPGRAM) {
    const { factory, sockets } = fakeFactory();
    const clock = manualTimer();
    const pending = make(factory, { timer: clock.timer }).open(choice, 'interviewer', 'k', OPTIONS);
    sockets[0]!.opened();
    if (choice.providerId === 'elevenlabs')
      sockets[0]!.receive({ message_type: 'session_started' });
    const session = await pending;
    const seen: TranscriptEvent[] = [];
    session.on('transcript', (t) => seen.push(t));
    return { session, socket: sockets[0]!, clock, seen };
  }

  it('routes Deepgram finals that arrive after CloseStream, until the provider closes', async () => {
    const { session, socket, seen } = await openWithClock(createDeepgramProvider);
    const closing = session.close();
    expect(await settled(closing)).toBe('pending');
    expect(socket.closedWith).toBeNull();

    socket.receive({ channel: { alternatives: [{ transcript: 'last words' }] }, is_final: true });
    session.push(chunk());
    socket.dropped(1000, '');

    await closing;
    expect(seen.map((t) => t.text)).toEqual(['last words']);
    // No chunk is accepted while closing.
    expect(socket.binaryFrames).toHaveLength(0);
  });

  it('closes on the drain bound when the provider never answers', async () => {
    const { session, socket, clock } = await openWithClock(createDeepgramProvider);
    const closing = session.close();
    expect(clock.pending(CLOSE_DRAIN_MS)).toBe(1);
    clock.fire(CLOSE_DRAIN_MS);
    await closing;
    expect(socket.closedWith).toBe(1000);
  });

  it('commits ElevenLabs and closes once the committed transcript arrives', async () => {
    const { session, socket, seen } = await openWithClock(createElevenLabsProvider, ELEVENLABS);
    const closing = session.close();
    expect(JSON.parse(socket.textFrames.at(-1)!)).toMatchObject({
      message_type: 'input_audio_chunk',
      audio_base_64: '',
      commit: true,
    });
    socket.receive({ message_type: 'committed_transcript', text: 'the tail' });
    await closing;
    expect(seen.map((t) => t.text)).toEqual(['the tail']);
    expect(socket.closedWith).toBe(1000);
  });
});

/** Finding 5: OpenAI realtime takes 24 kHz PCM; the worker produces 16 kHz. */
describe('16 kHz to 24 kHz resampling for OpenAI realtime', () => {
  function pcm(samples: number[]): ArrayBuffer {
    return new Int16Array(samples).buffer;
  }

  it('keeps a linear ramp linear at the new rate', () => {
    const up = createUpsampler16kTo24k();
    const out = up(pcm([0, 300, 600, 900, 1200, 1500]));
    // Input sample i sits at time 3i in thirds; output j at 2j. A ramp of 300
    // per input sample is 200 per output sample.
    expect(Array.from(out)).toEqual([0, 200, 400, 600, 800, 1000, 1200, 1400]);
  });

  it('produces three samples for every two, so one second becomes one second', () => {
    const up = createUpsampler16kTo24k();
    let total = 0;
    for (let i = 0; i < 10; i += 1) total += up(new ArrayBuffer(32000)).length;
    // 160000 input samples. The last output waits on the next input sample.
    expect(total).toBe(240000 - 1);
  });

  it('gives the same samples however the stream is chunked', () => {
    const signal = Array.from({ length: 101 }, (_, i) => Math.round(8000 * Math.sin(i / 3)));
    const whole = Array.from(createUpsampler16kTo24k()(pcm(signal)));

    const up = createUpsampler16kTo24k();
    const pieces: number[] = [];
    let at = 0;
    for (const size of [1, 2, 7, 13, 1, 40, 37]) {
      pieces.push(...up(pcm(signal.slice(at, at + size))));
      at += size;
    }
    expect(pieces).toEqual(whole);
  });

  it('sends 24 kHz audio but bills the 16 kHz bytes it was handed', async () => {
    const { factory, sockets } = fakeFactory();
    const pending = createOpenAiRealtimeProvider(factory).open(OPENAI, 'interviewer', 'k', OPTIONS);
    sockets[0]!.opened();
    const session = await pending;
    session.push(chunk(32000));
    const frame = JSON.parse(sockets[0]!.textFrames.at(-1)!) as { type: string; audio: string };
    expect(frame.type).toBe('input_audio_buffer.append');
    // 16000 samples in, 23999 out (the last waits on the next chunk), 2 bytes each.
    expect(Buffer.from(frame.audio, 'base64').byteLength).toBe(23999 * 2);
    expect(session.sentBytes).toBe(32000);
  });
});

/** Finding 6: the ElevenLabs wire protocol, as the official SDK speaks it. */
describe('ElevenLabs realtime protocol', () => {
  it('passes the turn-end gap as vad_silence_threshold_secs, clamped to 0.3..3.0', () => {
    const at = (gap: number) =>
      new URL(elevenLabsConnectSpec(ELEVENLABS, 'k', { turnEndGapMs: gap }).url).searchParams;
    expect(at(1400).get('vad_silence_threshold_secs')).toBe('1.4');
    expect(at(100).get('vad_silence_threshold_secs')).toBe('0.3');
    expect(at(5000).get('vad_silence_threshold_secs')).toBe('3');
    expect(at(1400).has('min_silence_duration_ms')).toBe(false);
  });

  it('sends audio as base64 JSON input_audio_chunk frames', async () => {
    const { factory, sockets } = fakeFactory();
    const pending = createElevenLabsProvider(factory).open(ELEVENLABS, 'interviewer', 'k', OPTIONS);
    sockets[0]!.opened();
    sockets[0]!.receive({ message_type: 'session_started' });
    const session = await pending;
    const bytes = new Uint8Array(32000).fill(7);
    session.push({ source: 'interviewer', pcm: bytes.buffer, timestamp: 1, sequence: 0 });

    expect(sockets[0]!.binaryFrames).toHaveLength(0);
    const frame = JSON.parse(sockets[0]!.textFrames.at(-1)!) as Record<string, unknown>;
    expect(frame).toMatchObject({
      message_type: 'input_audio_chunk',
      commit: false,
      sample_rate: 16000,
    });
    expect(Buffer.from(frame.audio_base_64 as string, 'base64')).toEqual(Buffer.from(bytes));
    expect(session.sentBytes).toBe(32000);
  });

  it('reads partial and committed transcripts from message_type', async () => {
    const { factory, sockets } = fakeFactory();
    const pending = createElevenLabsProvider(factory).open(ELEVENLABS, 'interviewer', 'k', OPTIONS);
    sockets[0]!.opened();
    sockets[0]!.receive({ message_type: 'session_started' });
    const session = await pending;
    const seen: TranscriptEvent[] = [];
    const endpoints = vi.fn();
    session.on('transcript', (t) => seen.push(t));
    session.on('endpoint', endpoints);

    sockets[0]!.receive({ message_type: 'partial_transcript', text: 'why do' });
    sockets[0]!.receive({ message_type: 'committed_transcript', text: 'why do you want it' });
    // A frame keyed the old way is not this protocol and produces nothing.
    sockets[0]!.receive({ type: 'committed_transcript', text: 'wrong key' });

    expect(seen.map((t) => [t.text, t.isFinal])).toEqual([
      ['why do', false],
      ['why do you want it', true],
    ]);
    expect(endpoints).toHaveBeenCalledTimes(1);
  });
});
