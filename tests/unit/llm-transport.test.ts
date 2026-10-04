/**
 * TASK-032. The real `fetch`-backed SSE transport.
 *
 * Driven against a stubbed global `fetch` rather than excluded from coverage
 * like `ws-factory.ts`: this file does more than construct a dependency. It
 * decodes a byte stream, and a multi-byte character split across two packets is
 * a failure nobody would see until a user typed one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LLM_FIRST_BYTE_TIMEOUT_MS,
  LLM_IDLE_TIMEOUT_MS,
  fetchStreamPost,
  isAbortError,
} from '../../src/main/ai/llm/sse.js';

function bodyOf(...packets: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const packet of packets) controller.enqueue(packet);
      controller.close();
    },
  });
}

async function collect(chunks: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const chunk of chunks) out += chunk;
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchStreamPost', () => {
  it('posts JSON with the caller’s headers and the caller’s signal', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: bodyOf(new TextEncoder().encode('data: hi\n\n')),
      text: () => Promise.resolve(''),
    });
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const res = await fetchStreamPost('https://example.test/v1', {
      providerId: 'anthropic',
      headers: { 'x-api-key': 'k' },
      body: '{"a":1}',
      signal: controller.signal,
    });

    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
    ];
    expect(url).toBe('https://example.test/v1');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.headers['x-api-key']).toBe('k');
    expect(init.body).toBe('{"a":1}');
    // The caller's signal reaches fetch, which is what makes cancellation abort
    // the request rather than stop the read (FR-075).
    expect(init.signal.aborted).toBe(false);
    controller.abort();
    expect(init.signal.aborted).toBe(true);

    expect(res.ok).toBe(true);
    expect(await collect(res.chunks())).toBe('data: hi\n\n');
  });

  it('decodes a multi-byte character split across two packets', async () => {
    const bytes = new TextEncoder().encode('café — done');
    const split = 4; // Inside the two bytes of "é".
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: bodyOf(bytes.slice(0, split), bytes.slice(split)),
        text: () => Promise.resolve(''),
      }),
    );

    const res = await fetchStreamPost('https://example.test/v1', {
      providerId: 'anthropic',
      headers: {},
      body: '{}',
      signal: new AbortController().signal,
    });
    expect(await collect(res.chunks())).toBe('café — done');
  });

  it('reads the error body only on a failure, and yields nothing for a bodyless response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        body: null,
        text: () => Promise.resolve('upstream exploded'),
      }),
    );

    const res = await fetchStreamPost('https://example.test/v1', {
      providerId: 'anthropic',
      headers: {},
      body: '{}',
      signal: new AbortController().signal,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
    expect(await res.errorText()).toBe('upstream exploded');
    expect(await collect(res.chunks())).toBe('');
  });
});

/**
 * A provider that accepts the request and then sends nothing must count as a
 * failure, or no retry and no failover ever runs while the overlay waits.
 */
describe('fetchStreamPost timeouts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A fetch that never answers, and rejects with the abort reason like undici does. */
  function silentFetch() {
    return vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(init.signal.reason as Error);
          });
        }),
    );
  }

  /** A response whose body sends one packet and then goes quiet until aborted. */
  function stallingFetch() {
    return vi.fn((_url: string, init: { signal: AbortSignal }) =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: first\n\n'));
            init.signal.addEventListener('abort', () => {
              controller.error(init.signal.reason);
            });
          },
        }),
      }),
    );
  }

  function post(signal = new AbortController().signal) {
    return fetchStreamPost('https://example.test/v1', {
      providerId: 'openai',
      headers: {},
      body: '{}',
      signal,
    });
  }

  it('fails a request with no first byte as a retryable timeout', async () => {
    vi.stubGlobal('fetch', silentFetch());
    const pending = post();
    const settled = pending.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(LLM_FIRST_BYTE_TIMEOUT_MS);
    expect(await Promise.race([settled, Promise.resolve('still waiting')])).toMatchObject({
      class: 'timeout',
      retryable: true,
      providerId: 'openai',
    });
  });

  it('fails a stream that goes quiet after it started as a retryable timeout', async () => {
    vi.stubGlobal('fetch', stallingFetch());
    const res = await post();
    const read = collect(res.chunks()).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(LLM_IDLE_TIMEOUT_MS);
    expect(await Promise.race([read, Promise.resolve('still waiting')])).toMatchObject({
      class: 'timeout',
      retryable: true,
    });
  });

  it('reports a caller abort as a cancellation, never as a timeout', async () => {
    vi.stubGlobal('fetch', silentFetch());
    const controller = new AbortController();
    const settled = post(controller.signal).catch((e: unknown) => e);

    controller.abort();
    const error = await settled;
    expect(isAbortError(error)).toBe(true);
    expect(error).not.toHaveProperty('class');

    // And the watchdog is gone: nothing fires later.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows a slow answer that keeps sending', async () => {
    const encoder = new TextEncoder();
    let push: (text: string) => void = () => undefined;
    let close: () => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            push = (text) => {
              controller.enqueue(encoder.encode(text));
            };
            close = () => {
              controller.close();
            };
          },
        }),
      }),
    );
    const res = await post();
    const read = collect(res.chunks());

    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(LLM_IDLE_TIMEOUT_MS - 1);
      push(`${String(i)} `);
    }
    close();
    expect(await read).toBe('0 1 2 3 4 ');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('isAbortError', () => {
  it('recognizes an abort and a timeout, and nothing else', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';

    expect(isAbortError(abort)).toBe(true);
    expect(isAbortError(timeout)).toBe(true);
    expect(isAbortError(new Error('ordinary'))).toBe(false);
    expect(isAbortError('not an error')).toBe(false);
  });
});
