/**
 * TASK-013. The non-streaming class, and the WAV container that keeps audio
 * off disk on the one path that has to hand a provider a file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioChunk, ProviderError, TranscriptEvent } from '../../src/shared/types.js';
import {
  NON_STREAMING_BUDGET,
  STREAMING_BUDGET,
  findSttModel,
  latencyBudgetFor,
} from '../../src/shared/registry/stt.js';
import { clearSttProviders, openSttSession } from '../../src/main/ai/stt.js';
import {
  registerBatchSttProviders,
  registerStreamingSttProviders,
} from '../../src/main/ai/stt/index.js';
import type { SocketLike } from '../../src/main/ai/stt/socket-session.js';
import { WAV_HEADER_BYTES, encodeWav } from '../../src/main/ai/stt/wav.js';
import type { PostWav } from '../../src/main/ai/stt/whisper.js';
import {
  WHISPER_BUFFER_CHUNKS,
  WHISPER_BUFFER_MS,
  WHISPER_TRANSCRIBE_URL,
  WhisperSttSession,
  postWavToOpenAi,
} from '../../src/main/ai/stt/whisper.js';
import { validateOpenAiKey } from '../../src/main/ai/stt/openai-realtime.js';

const CHOICE = { providerId: 'openai', modelId: 'whisper-1' };

/** A socket that goes nowhere, so no unit test reaches the network. */
function fakeSocket(): SocketLike {
  return {
    send: () => undefined,
    close: () => undefined,
    addEventListener: () => undefined,
  } as unknown as SocketLike;
}

function chunk(sequence: number): AudioChunk {
  // 32000 bytes: 1000 ms at 16 kHz, 16-bit, mono (FR-041).
  return { source: 'interviewer', pcm: new ArrayBuffer(32000), timestamp: sequence, sequence };
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

describe('the WAV container is built in memory and is valid', () => {
  it('writes a RIFF/WAVE header describing 16 kHz 16-bit mono PCM', () => {
    const wav = encodeWav([new ArrayBuffer(32000)]);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

    expect(ascii(wav, 0, 4)).toBe('RIFF');
    expect(ascii(wav, 8, 4)).toBe('WAVE');
    expect(ascii(wav, 12, 4)).toBe('fmt ');
    expect(ascii(wav, 36, 4)).toBe('data');

    expect(view.getUint32(4, true)).toBe(36 + 32000);
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1); // uncompressed PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(32000);
    expect(wav.byteLength).toBe(WAV_HEADER_BYTES + 32000);
  });

  it('concatenates chunks in order', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([5, 6, 7, 8]);
    const wav = encodeWav([a.buffer, b.buffer]);
    expect(Array.from(wav.subarray(WAV_HEADER_BYTES))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(8);
  });

  it('produces a header-only file for no audio rather than throwing', () => {
    const wav = encodeWav([]);
    expect(wav.byteLength).toBe(WAV_HEADER_BYTES);
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(0);
  });
});

/** TC-055: one request per 4000 ms, finals only. */
describe('TC-055 non-streaming buffering', () => {
  let post: ReturnType<typeof vi.fn>;

  function session() {
    return new WhisperSttSession({
      source: 'interviewer',
      choice: CHOICE,
      key: 'a-key',
      post: post as unknown as PostWav,
    });
  }

  beforeEach(() => {
    post = vi.fn().mockResolvedValue({ ok: true, status: 200, text: 'a buffered sentence' });
  });

  it('buffers exactly 4000 ms before posting', () => {
    expect(WHISPER_BUFFER_MS).toBe(4000);
    expect(WHISPER_BUFFER_CHUNKS).toBe(4);

    const s = session();
    for (let i = 0; i < WHISPER_BUFFER_CHUNKS - 1; i += 1) s.push(chunk(i));
    expect(post).not.toHaveBeenCalled();
    expect(s.bufferedChunks).toBe(WHISPER_BUFFER_CHUNKS - 1);

    s.push(chunk(3));
    expect(post).toHaveBeenCalledTimes(1);
    // The buffer is released the moment it is handed off (ADR-027).
    expect(s.bufferedChunks).toBe(0);
  });

  it('posts a WAV body of the right size, never a path or a stream', async () => {
    const s = session();
    for (let i = 0; i < WHISPER_BUFFER_CHUNKS; i += 1) s.push(chunk(i));
    await vi.waitFor(() => {
      expect(post).toHaveBeenCalled();
    });

    const [form, key] = post.mock.calls[0] as [FormData, string];
    expect(key).toBe('a-key');
    expect(form.get('model')).toBe('whisper-1');

    const file = form.get('file') as Blob;
    expect(file).toBeInstanceOf(Blob);
    expect(file.type).toBe('audio/wav');
    expect(file.size).toBe(WAV_HEADER_BYTES + 32000 * WHISPER_BUFFER_CHUNKS);

    const head = new Uint8Array(await file.arrayBuffer());
    expect(ascii(head, 0, 4)).toBe('RIFF');
  });

  it('emits only isFinal true, and never an endpoint', async () => {
    const s = session();
    const seen: TranscriptEvent[] = [];
    const endpoints = vi.fn();
    s.on('transcript', (t) => seen.push(t));
    s.on('endpoint', endpoints);

    for (let i = 0; i < WHISPER_BUFFER_CHUNKS * 2; i += 1) s.push(chunk(i));
    await vi.waitFor(() => {
      expect(seen).toHaveLength(2);
    });

    for (const event of seen) {
      expect(event.isFinal).toBe(true);
      expect(event.providerId).toBe('openai');
      expect(event.source).toBe('interviewer');
    }
    expect(endpoints).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('posts the partial tail on close rather than dropping the last words', async () => {
    const s = session();
    s.push(chunk(0));
    s.push(chunk(1));
    expect(post).not.toHaveBeenCalled();

    await s.close();
    expect(post).toHaveBeenCalledTimes(1);
    const file = (post.mock.calls[0] as [FormData, string])[0].get('file') as Blob;
    expect(file.size).toBe(WAV_HEADER_BYTES + 32000 * 2);
    expect(s.bufferedChunks).toBe(0);
  });

  /**
   * ADR-036. `close` used to set `closed` before the tail's request came back,
   * and `transcribe` discards its response when the session is closed, so the
   * last thing said before Stop was posted, paid for, answered and thrown away.
   * The tail is the whole reason `close` flushes at all.
   */
  it('emits the tail transcript rather than discarding its own final request', async () => {
    const s = session();
    const heard: TranscriptEvent[] = [];
    s.on('transcript', (e) => heard.push(e));

    s.push(chunk(0));
    s.push(chunk(1));

    await s.close();

    expect(post).toHaveBeenCalledTimes(1);
    expect(heard.map((e) => e.text)).toEqual(['a buffered sentence']);
    expect(heard[0]?.isFinal).toBe(true);
  });

  it('waits for a request already in flight before closing', async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    post = vi.fn().mockImplementation(async () => {
      await held;
      return { ok: true, status: 200, text: 'the last window' };
    });

    const s = session();
    const heard: TranscriptEvent[] = [];
    s.on('transcript', (e) => heard.push(e));

    // A full window, so the request is posted by `push` rather than by `close`.
    for (let i = 0; i < WHISPER_BUFFER_CHUNKS; i += 1) s.push(chunk(i));
    expect(s.requestsInFlight).toBe(1);

    const closing = s.close();
    release();
    await closing;

    expect(heard.map((e) => e.text)).toEqual(['the last window']);
    expect(s.requestsInFlight).toBe(0);
  });

  it('drops a push after close and posts nothing more', async () => {
    const s = session();
    await s.close();
    s.push(chunk(0));
    s.push(chunk(1));
    s.push(chunk(2));
    s.push(chunk(3));
    expect(post).not.toHaveBeenCalled();
    expect(s.bufferedChunks).toBe(0);
  });

  it('emits nothing for an empty transcription', async () => {
    post.mockResolvedValue({ ok: true, status: 200, text: '   ' });
    const s = session();
    const seen: TranscriptEvent[] = [];
    s.on('transcript', (t) => seen.push(t));
    for (let i = 0; i < WHISPER_BUFFER_CHUNKS; i += 1) s.push(chunk(i));
    await vi.waitFor(() => {
      expect(post).toHaveBeenCalled();
    });
    expect(seen).toEqual([]);
  });

  it('classifies a rejected key as terminal and a server fault as retryable', async () => {
    const errors: ProviderError[] = [];
    post.mockResolvedValue({ ok: false, status: 401, text: 'bad key' });
    const s = session();
    s.on('error', (e) => errors.push(e));
    for (let i = 0; i < WHISPER_BUFFER_CHUNKS; i += 1) s.push(chunk(i));
    await vi.waitFor(() => {
      expect(errors).toHaveLength(1);
    });
    expect(errors[0]!.class).toBe('auth');
    expect(errors[0]!.retryable).toBe(false);

    post.mockResolvedValue({ ok: false, status: 503, text: 'busy' });
    const s2 = session();
    const errors2: ProviderError[] = [];
    s2.on('error', (e) => errors2.push(e));
    for (let i = 0; i < WHISPER_BUFFER_CHUNKS; i += 1) s2.push(chunk(i));
    await vi.waitFor(() => {
      expect(errors2).toHaveLength(1);
    });
    expect(errors2[0]!.retryable).toBe(true);
  });

  it('reports a network failure instead of hanging the session', async () => {
    post.mockRejectedValue(new Error('offline'));
    const errors: ProviderError[] = [];
    const s = session();
    s.on('error', (e) => errors.push(e));
    for (let i = 0; i < WHISPER_BUFFER_CHUNKS; i += 1) s.push(chunk(i));
    await vi.waitFor(() => {
      expect(errors).toHaveLength(1);
    });
    expect(errors[0]!.class).toBe('network');
    expect(s.requestsInFlight).toBe(0);
  });
});

/** TC-150: which budget applies is read from the registry entry. */
describe('TC-150 the latency budget comes from the registry entry', () => {
  it('holds whisper-1 to NFR-017 and the streaming models to NFR-001', () => {
    const whisper = findSttModel(CHOICE);
    expect(whisper).not.toBeNull();
    expect(latencyBudgetFor(whisper!)).toEqual(NON_STREAMING_BUDGET);
    expect(latencyBudgetFor(whisper!).requirementId).toBe('NFR-017');

    const nova = findSttModel({ providerId: 'deepgram', modelId: 'nova-3' });
    expect(latencyBudgetFor(nova!)).toEqual(STREAMING_BUDGET);
  });

  it('states the budgets the requirements name', () => {
    expect(STREAMING_BUDGET).toEqual({ requirementId: 'NFR-001', p50Ms: 2500, p95Ms: 4000 });
    expect(NON_STREAMING_BUDGET).toEqual({ requirementId: 'NFR-017', p50Ms: 7000, p95Ms: 10000 });
  });
});

/** TC-057: the badge text lives in the registry and names both penalties. */
describe('TC-057 the non-streaming badge', () => {
  it('names the accuracy penalty and the latency penalty', () => {
    const badge = findSttModel(CHOICE)?.badge ?? '';
    expect(badge).not.toBe('');
    expect(badge.toLowerCase()).toMatch(/accura/);
    expect(badge.toLowerCase()).toMatch(/second|latenc|lag|delay/);
  });

  it('is the only badge in the registry, and no streaming model carries one', () => {
    const nova = findSttModel({ providerId: 'deepgram', modelId: 'nova-3' });
    expect(nova?.badge).toBeUndefined();
  });
});

describe('the facade routes whisper-1 to the batch adapter', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearSttProviders();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens a Whisper session, not the realtime socket', async () => {
    const post = vi.fn().mockResolvedValue({ ok: true, status: 200, text: 'hello' });
    registerBatchSttProviders(post as unknown as PostWav);

    const session = await openSttSession(CHOICE, 'interviewer', 'k', { turnEndGapMs: 800 });
    expect(session).toBeInstanceOf(WhisperSttSession);
    expect(session.choice).toEqual(CHOICE);
    await session.close();
    // No socket was opened, so fetch is the only network surface here.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the two openai transports apart', async () => {
    // A fake socket factory, so this unit test opens no real connection.
    registerStreamingSttProviders(() => fakeSocket());
    registerBatchSttProviders(
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: '' }) as unknown as PostWav,
    );
    const batch = await openSttSession(CHOICE, 'interviewer', 'k', { turnEndGapMs: 800 });
    expect(batch).toBeInstanceOf(WhisperSttSession);

    const streaming = await openSttSession(
      { providerId: 'openai', modelId: 'gpt-4o-transcribe' },
      'interviewer',
      'k',
      { turnEndGapMs: 800 },
    );
    expect(streaming).not.toBeInstanceOf(WhisperSttSession);
    await batch.close();
    await streaming.close();
  });
});

/**
 * The real request shape. `postWavToOpenAi` is the only part of this adapter
 * that talks to the network, so what it puts on the wire is asserted rather
 * than assumed, including that it sends a body and never a path (ADR-019).
 */
describe('the Whisper request', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts multipart form data to the transcriptions endpoint', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('transcribed'),
    });

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(8)], { type: 'audio/wav' }), 'audio.wav');
    const result = await postWavToOpenAi()(form, 'a-key');

    expect(result).toEqual({ ok: true, status: 200, text: 'transcribed' });
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: FormData },
    ];
    expect(url).toBe(WHISPER_TRANSCRIBE_URL);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer a-key');
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get('file')).toBeInstanceOf(Blob);
  });

  it('passes a failure status back rather than throwing', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('slow down'),
    });
    const result = await postWavToOpenAi()(new FormData(), 'k');
    expect(result).toEqual({ ok: false, status: 429, text: 'slow down' });
  });

  it('validates an OpenAI key once for both transports', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    expect(await validateOpenAiKey('k')).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0]?.[0]).toContain('api.openai.com/v1/models');
  });
});
