/**
 * Server-sent-event plumbing shared by both LLM adapters (TASK-032).
 *
 * Anthropic and OpenAI both stream SSE over HTTPS and differ only in the JSON
 * inside each frame, so the transport, the framing and the abort wiring live
 * here once. An adapter is then the shape of one provider's JSON and nothing
 * else.
 */
import type { ProviderError } from '../../../shared/types.js';
import { classifyStatus, providerError } from '../stt.js';

/** One decoded SSE frame. `event` is empty when the stream omits the field. */
export interface SseEvent {
  event: string;
  data: string;
}

/** One streaming HTTP response, in the shape both adapters read (FR-074, FR-075). */
export interface StreamResponse {
  ok: boolean;
  status: number;
  /** Read only on a failure, to put the provider's own words in the log. */
  errorText: () => Promise<string>;
  /** Decoded body chunks, in arrival order. Not split on frames. */
  chunks: () => AsyncIterable<string>;
}

/**
 * The injected transport. Tests supply one that yields scripted chunks and
 * records the `AbortSignal`, so `TC-095` can assert the request was aborted
 * rather than merely unsubscribed.
 */
export type StreamPost = (
  url: string,
  init: {
    /** Names the provider in a timeout the transport raises itself. */
    providerId: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<StreamResponse>;

/**
 * How long a request may wait for its first body byte, and a started stream
 * for its next one.
 *
 * Without these a provider that accepted the request and then sent nothing
 * never counted as a failure: no retry, no failover, and an empty overlay.
 * Ten seconds is the `NFR-017` p95 for a whole turn, so an answer slower than
 * that misses every latency budget. It still leaves one retry room to land
 * before `STALE_DISCARD_MS` (20 s, `ASM-017`) throws the suggestion away. The
 * idle limit is as long, because a reasoning model can pause after its first
 * frame while it thinks.
 */
export const LLM_FIRST_BYTE_TIMEOUT_MS = 10_000;
export const LLM_IDLE_TIMEOUT_MS = 10_000;

/**
 * The production transport.
 *
 * The caller's `signal` reaches `fetch`, so cancelling aborts the underlying
 * HTTP request. Stopping at the reader would leave the connection open and the
 * provider still billing for tokens nobody will read (`FR-075`). A watchdog
 * signal joins it and aborts the request when the first byte, or the next one,
 * is late; that abort surfaces as a retryable `timeout` `ProviderError`, while
 * a caller abort still surfaces as an `AbortError`, which is a cancellation.
 */
export const fetchStreamPost: StreamPost = async (url, init) => {
  const watchdog = new AbortController();
  let timedOut: ProviderError | null = null;
  let handle: ReturnType<typeof setTimeout> | undefined;
  const disarm = (): void => {
    clearTimeout(handle);
    handle = undefined;
  };
  const arm = (ms: number, what: string): void => {
    disarm();
    handle = setTimeout(() => {
      timedOut = providerError(init.providerId, 'timeout', `The language model sent ${what}.`);
      watchdog.abort(timedOut);
    }, ms);
  };
  // Whatever the caller aborts, the watchdog has nothing left to guard.
  init.signal.addEventListener('abort', disarm, { once: true });
  /** A failure caused by the watchdog is reported as the timeout it is. */
  const rethrow = (err: unknown): never => {
    disarm();
    throw timedOut ?? err;
  };

  arm(LLM_FIRST_BYTE_TIMEOUT_MS, `nothing for ${String(LLM_FIRST_BYTE_TIMEOUT_MS)} ms`);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...init.headers },
      body: init.body,
      signal: AbortSignal.any([init.signal, watchdog.signal]),
    });
  } catch (err) {
    return rethrow(err);
  }

  return {
    ok: res.ok,
    status: res.status,
    errorText: async () => {
      try {
        return await res.text();
      } catch (err) {
        // The status already arrived and is what classifies the failure. A
        // body that stalls is only missing detail, so it must not turn a 401
        // into a retryable timeout; the adapter names the status instead.
        if (timedOut) return '';
        return rethrow(err);
      } finally {
        disarm();
      }
    },
    chunks: () =>
      decodeBody(res.body, {
        onChunk: () => {
          arm(LLM_IDLE_TIMEOUT_MS, `no more for ${String(LLM_IDLE_TIMEOUT_MS)} ms`);
        },
        onEnd: disarm,
        rethrow,
      }),
  };
};

async function* decodeBody(
  body: ReadableStream<Uint8Array> | null,
  watch: { onChunk: () => void; onEnd: () => void; rethrow: (err: unknown) => never },
): AsyncIterable<string> {
  if (!body) {
    watch.onEnd();
    return;
  }
  const decoder = new TextDecoder();
  const reader = body.getReader();
  try {
    for (;;) {
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        read = await reader.read();
      } catch (err) {
        return watch.rethrow(err);
      }
      if (read.done) break;
      watch.onChunk();
      // `stream: true` so a multi-byte character split across two network
      // packets is not decoded as two replacement characters.
      yield decoder.decode(read.value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail !== '') yield tail;
  } finally {
    watch.onEnd();
    reader.releaseLock();
  }
}

/** A failure already classified, by the transport or by an adapter. */
export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof Error && 'class' in err && 'retryable' in err;
}

/**
 * Reframes raw body chunks into SSE events.
 *
 * A frame ends at a blank line. `data:` lines accumulate, which is what the
 * specification says and what Anthropic's longer frames rely on.
 */
export async function* parseSse(chunks: AsyncIterable<string>): AsyncIterable<SseEvent> {
  let buffer = '';
  for await (const chunk of chunks) {
    buffer += chunk.replace(/\r\n?/g, '\n');
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end < 0) break;
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const parsed = parseFrame(frame);
      if (parsed) yield parsed;
    }
  }
  const parsed = parseFrame(buffer);
  if (parsed) yield parsed;
}

function parseFrame(frame: string): SseEvent | null {
  let event = '';
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (data.length === 0) return null;
  return { event, data: data.join('\n') };
}

/** Parses a frame's JSON, or returns null. A malformed frame is skipped, never thrown. */
export function parseJson<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

/** An `AbortError` from `fetch` is a cancellation, not a provider failure. */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/**
 * Maps an HTTP status onto the shared error classes (ADR-010).
 *
 * Re-exported from the STT facade rather than written again here. A 401 has to
 * mean the same thing whoever returned it, and two classifiers are two things
 * that can drift apart while both look right.
 */
export { classifyStatus };
