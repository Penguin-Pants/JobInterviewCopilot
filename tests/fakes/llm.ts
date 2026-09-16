/**
 * A scripted SSE transport for the LLM adapters.
 *
 * Yields the frames a test names, records the request body and the
 * `AbortSignal`, and never opens a socket. The signal is kept so `TC-095` can
 * assert the request was aborted rather than merely unsubscribed.
 */
import type { StreamPost, StreamResponse } from '../../src/main/ai/llm/sse.js';

export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal;
}

export interface ScriptedTransport {
  post: StreamPost;
  requests: RecordedRequest[];
}

export interface ScriptOptions {
  ok?: boolean;
  status?: number;
  errorBody?: string;
  /** Raw body chunks, already SSE-framed. */
  chunks?: string[];
  /** Awaited before each chunk, so a test can interleave an abort. */
  beforeChunk?: (index: number) => Promise<void> | void;
}

export function scriptedTransport(options: ScriptOptions = {}): ScriptedTransport {
  const requests: RecordedRequest[] = [];

  const post: StreamPost = (url, init) => {
    requests.push({
      url,
      headers: init.headers,
      body: JSON.parse(init.body) as unknown,
      signal: init.signal,
    });

    const response: StreamResponse = {
      ok: options.ok ?? true,
      status: options.status ?? 200,
      errorText: () => Promise.resolve(options.errorBody ?? ''),
      chunks: async function* () {
        const chunks = options.chunks ?? [];
        for (let i = 0; i < chunks.length; i += 1) {
          await options.beforeChunk?.(i);
          // A real transport stops producing once the request is aborted.
          if (init.signal.aborted) throw abortError();
          yield chunks[i] ?? '';
        }
      },
    };
    return Promise.resolve(response);
  };

  return { post, requests };
}

export function abortError(): Error {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

/** One Anthropic message stream, as the API frames it. */
export function anthropicScript(deltas: string[]): string[] {
  return [
    sse('message_start', {
      type: 'message_start',
      message: { usage: { input_tokens: 412, output_tokens: 0 } },
    }),
    ...deltas.map((text) =>
      sse('content_block_delta', {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text },
      }),
    ),
    sse('message_delta', { type: 'message_delta', usage: { output_tokens: 57 } }),
    sse('message_stop', { type: 'message_stop' }),
  ];
}

/** One OpenAI chat-completions stream, including the usage-only final frame. */
export function openAiScript(deltas: string[]): string[] {
  return [
    ...deltas.map((content) => sse('', { choices: [{ delta: { content } }] })),
    sse('', { choices: [], usage: { prompt_tokens: 412, completion_tokens: 57 } }),
    'data: [DONE]\n\n',
  ];
}

export function sse(event: string, data: unknown): string {
  const head = event === '' ? '' : `event: ${event}\n`;
  return `${head}data: ${JSON.stringify(data)}\n\n`;
}
