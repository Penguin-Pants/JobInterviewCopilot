/**
 * TASK-032. The real `fetch`-backed SSE transport.
 *
 * Driven against a stubbed global `fetch` rather than excluded from coverage
 * like `ws-factory.ts`: this file does more than construct a dependency. It
 * decodes a byte stream, and a multi-byte character split across two packets is
 * a failure nobody would see until a user typed one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchStreamPost, isAbortError } from '../../src/main/ai/llm/sse.js';

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
    // The signal reaches fetch, which is what makes cancellation abort the
    // request rather than stop the read (FR-075).
    expect(init.signal).toBe(controller.signal);

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
