/**
 * Server-sent-event plumbing shared by both LLM adapters (TASK-032).
 *
 * Anthropic and OpenAI both stream SSE over HTTPS and differ only in the JSON
 * inside each frame, so the transport, the framing and the abort wiring live
 * here once. An adapter is then the shape of one provider's JSON and nothing
 * else.
 */
import { classifyStatus } from '../stt.js';

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
  init: { headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<StreamResponse>;

/**
 * The production transport.
 *
 * `signal` is handed to `fetch`, so cancelling aborts the underlying HTTP
 * request. Stopping at the reader would leave the connection open and the
 * provider still billing for tokens nobody will read (`FR-075`).
 */
export const fetchStreamPost: StreamPost = async (url, init) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...init.headers },
    body: init.body,
    signal: init.signal,
  });

  return {
    ok: res.ok,
    status: res.status,
    errorText: () => res.text(),
    chunks: () => decodeBody(res.body),
  };
};

async function* decodeBody(body: ReadableStream<Uint8Array> | null): AsyncIterable<string> {
  if (!body) return;
  const decoder = new TextDecoder();
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // `stream: true` so a multi-byte character split across two network
      // packets is not decoded as two replacement characters.
      if (value) yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail !== '') yield tail;
  } finally {
    reader.releaseLock();
  }
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
