/**
 * TASK-032. The two LLM adapters and the facade above them.
 *
 * Both adapters are driven through an injected transport, so the shape of every
 * request is asserted without a network call (`TC-092`, `TC-096`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chunk } from '../../src/shared/types.js';
import type { RetrievedChunk } from '../../src/main/rag.js';
import {
  buildMessages,
  clearLlmProviders,
  getLlmProvider,
  requireLlmProvider,
  runGeneration,
  type GenerationRequest,
  type LlmChunk,
} from '../../src/main/ai/llm.js';
import { createAnthropicProvider, validateAnthropicKey } from '../../src/main/ai/llm/anthropic.js';
import { createOpenAiLlmProvider } from '../../src/main/ai/llm/openai.js';
import { registerAllLlmProviders } from '../../src/main/ai/llm/index.js';
import { parseSse } from '../../src/main/ai/llm/sse.js';
import { MAX_CARD_LINES } from '../../src/main/ai/llm/lineBuffer.js';
import { SYSTEM_PROMPT } from '../../src/main/ai/prompt.js';
import { abortError, anthropicScript, openAiScript, scriptedTransport, sse } from '../fakes/llm.js';

function hit(over: Partial<Chunk> = {}): RetrievedChunk {
  return {
    score: 0.9,
    chunk: {
      id: 'c1',
      docId: 'd1',
      profileId: 'p1',
      index: 0,
      text: 'Cut p95 checkout latency from 900 ms to 240 ms.',
      headerPath: ['Experience'],
      docType: 'resume',
      sourceFile: 'resume.md',
      tokenCount: 12,
      ...over,
    },
  };
}

function request(providerId: string, modelId: string): GenerationRequest {
  return {
    generationId: 'gen-1',
    question: 'Tell me about a performance win',
    candidateContext: 'I mostly worked on checkout',
    chunks: [hit()],
    choice: { providerId, modelId },
  };
}

async function drain(stream: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

afterEach(() => {
  clearLlmProviders();
});

/** TC-092: both adapters send max_tokens 200 and temperature 0.3. */
describe('TC-092 generation parameters', () => {
  it('the Anthropic request carries the parameters and the system prompt', async () => {
    const transport = scriptedTransport({ chunks: anthropicScript(['a\n']) });
    const provider = createAnthropicProvider({ keyFor: () => 'sk-ant', post: transport.post });

    await drain(provider.generate(request('anthropic', 'claude-haiku-4-5-20251001'), neverAbort()));

    const body = transport.requests[0]?.body as Record<string, unknown>;
    expect(body.max_tokens).toBe(200);
    expect(body.temperature).toBe(0.3);
    expect(body.model).toBe('claude-haiku-4-5-20251001');
    expect(body.system).toBe(SYSTEM_PROMPT);
    expect(body.stream).toBe(true);
    expect(transport.requests[0]?.headers['x-api-key']).toBe('sk-ant');
  });

  it('the OpenAI request carries the same parameters and the system message', async () => {
    const transport = scriptedTransport({ chunks: openAiScript(['a\n']) });
    const provider = createOpenAiLlmProvider({ keyFor: () => 'sk-oai', post: transport.post });

    await drain(provider.generate(request('openai', 'gpt-4o-mini'), neverAbort()));

    const body = transport.requests[0]?.body as {
      max_tokens: number;
      temperature: number;
      messages: { role: string; content: string }[];
      stream_options: { include_usage: boolean };
    };
    expect(body.max_tokens).toBe(200);
    expect(body.temperature).toBe(0.3);
    expect(body.messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT });
    expect(body.messages[1]?.content).toContain('INTERVIEWER QUESTION:');
    // Without this OpenAI reports no usage at all and the Cost Meter would
    // account zero tokens for every generation.
    expect(body.stream_options.include_usage).toBe(true);
    expect(transport.requests[0]?.headers.Authorization).toBe('Bearer sk-oai');
  });

  it('both adapters are handed the identical prompt', () => {
    const messages = buildMessages(request('anthropic', 'claude-haiku-4-5-20251001'));
    expect(messages.system).toBe(SYSTEM_PROMPT);
    expect(messages.maxTokens).toBe(200);
    expect(messages.temperature).toBe(0.3);
  });
});

describe('the adapters yield deltas and one terminal usage record', () => {
  it('Anthropic reports input tokens from message_start and output from message_delta', async () => {
    const transport = scriptedTransport({ chunks: anthropicScript(['one', ' two']) });
    const provider = createAnthropicProvider({ keyFor: () => 'k', post: transport.post });

    const out = await drain(
      provider.generate(request('anthropic', 'claude-haiku-4-5-20251001'), neverAbort()),
    );
    expect(out).toEqual([
      { delta: 'one' },
      { delta: ' two' },
      { usage: { inputTokens: 412, outputTokens: 57 } },
    ]);
  });

  it('OpenAI reports usage from its final usage-only frame', async () => {
    const transport = scriptedTransport({ chunks: openAiScript(['one', ' two']) });
    const provider = createOpenAiLlmProvider({ keyFor: () => 'k', post: transport.post });

    const out = await drain(provider.generate(request('openai', 'gpt-4o-mini'), neverAbort()));
    expect(out).toEqual([
      { delta: 'one' },
      { delta: ' two' },
      { usage: { inputTokens: 412, outputTokens: 57 } },
    ]);
  });

  it('classifies an HTTP failure rather than throwing a bare Error', async () => {
    const transport = scriptedTransport({ ok: false, status: 401, errorBody: 'invalid x-api-key' });
    const provider = createAnthropicProvider({ keyFor: () => 'k', post: transport.post });

    await expect(
      drain(provider.generate(request('anthropic', 'claude-haiku-4-5-20251001'), neverAbort())),
    ).rejects.toMatchObject({ class: 'auth', retryable: false, providerId: 'anthropic' });
  });

  it('refuses without a saved key instead of sending an unauthenticated request', async () => {
    const transport = scriptedTransport({ chunks: [] });
    const provider = createOpenAiLlmProvider({ keyFor: () => undefined, post: transport.post });

    await expect(
      drain(provider.generate(request('openai', 'gpt-4o-mini'), neverAbort())),
    ).rejects.toMatchObject({ class: 'auth' });
    expect(transport.requests).toHaveLength(0);
  });

  it('skips a malformed frame rather than failing the generation', async () => {
    const transport = scriptedTransport({
      chunks: ['data: {not json\n\n', ...anthropicScript(['ok'])],
    });
    const provider = createAnthropicProvider({ keyFor: () => 'k', post: transport.post });
    const out = await drain(
      provider.generate(request('anthropic', 'claude-haiku-4-5-20251001'), neverAbort()),
    );
    expect(out).toContainEqual({ delta: 'ok' });
  });
});

describe('the OpenAI adapter handles the same failures', () => {
  it("classifies an HTTP failure and carries the provider's own words", async () => {
    const transport = scriptedTransport({ ok: false, status: 429, errorBody: 'slow down' });
    const provider = createOpenAiLlmProvider({ keyFor: () => 'k', post: transport.post });

    await expect(
      drain(provider.generate(request('openai', 'gpt-4o-mini'), neverAbort())),
    ).rejects.toMatchObject({ class: 'rate-limit', retryable: true, message: 'slow down' });
  });

  it('reports an unreachable provider as a network failure', async () => {
    const provider = createOpenAiLlmProvider({
      keyFor: () => 'k',
      post: () => Promise.reject(new Error('ECONNREFUSED')),
    });

    await expect(
      drain(provider.generate(request('openai', 'gpt-4o-mini'), neverAbort())),
    ).rejects.toMatchObject({ class: 'network', retryable: true });
  });

  it('a transport aborted before the response arrives ends the stream quietly', async () => {
    const provider = createOpenAiLlmProvider({
      keyFor: () => 'k',
      post: () => Promise.reject(abortError()),
    });
    await expect(
      drain(provider.generate(request('openai', 'gpt-4o-mini'), neverAbort())),
    ).resolves.toEqual([]);
  });

  it('surfaces an in-band error frame rather than finishing as if it succeeded', async () => {
    const transport = scriptedTransport({
      chunks: [sse('', { error: { message: 'context length exceeded' } })],
    });
    const provider = createOpenAiLlmProvider({ keyFor: () => 'k', post: transport.post });

    await expect(
      drain(provider.generate(request('openai', 'gpt-4o-mini'), neverAbort())),
    ).rejects.toMatchObject({ class: 'server', message: 'context length exceeded' });
  });

  it('skips a malformed frame and a null delta', async () => {
    const transport = scriptedTransport({
      chunks: [
        'data: {oops\n\n',
        sse('', { choices: [{ delta: { content: null } }] }),
        ...openAiScript(['ok']),
      ],
    });
    const provider = createOpenAiLlmProvider({ keyFor: () => 'k', post: transport.post });
    const out = await drain(provider.generate(request('openai', 'gpt-4o-mini'), neverAbort()));
    expect(out).toEqual([{ delta: 'ok' }, { usage: { inputTokens: 412, outputTokens: 57 } }]);
  });

  it('the Anthropic adapter reports an unreachable provider the same way', async () => {
    const provider = createAnthropicProvider({
      keyFor: () => 'k',
      post: () => Promise.reject(new Error('ENOTFOUND')),
    });
    await expect(
      drain(provider.generate(request('anthropic', 'claude-haiku-4-5-20251001'), neverAbort())),
    ).rejects.toMatchObject({ class: 'network' });
  });
});

describe('SSE framing', () => {
  it('joins multi-line data fields and ignores comments', async () => {
    async function* chunks(): AsyncIterable<string> {
      yield ': ping\n\nevent: x\ndata: one\ndata: two\n\n';
    }
    const events = [];
    for await (const e of parseSse(chunks())) events.push(e);
    expect(events).toEqual([{ event: 'x', data: 'one\ntwo' }]);
  });

  it('reassembles a frame split across two network chunks', async () => {
    async function* chunks(): AsyncIterable<string> {
      yield 'data: {"a":';
      yield '1}\n\n';
    }
    const events = [];
    for await (const e of parseSse(chunks())) events.push(e);
    expect(events).toEqual([{ event: '', data: '{"a":1}' }]);
  });
});

describe('runGeneration', () => {
  function events(): {
    begins: unknown[];
    lines: string[];
    ends: { generationId: string; status: string }[];
    sink: Parameters<typeof runGeneration>[3];
  } {
    const begins: unknown[] = [];
    const lines: string[] = [];
    const ends: { generationId: string; status: string }[] = [];
    return {
      begins,
      lines,
      ends,
      sink: {
        onBegin: (e) => begins.push(e),
        onLine: (l) => lines.push(l.line),
        onEnd: (e) => ends.push(e),
      },
    };
  }

  it('sends one CH-208 per line and one CH-209 at the end', async () => {
    const transport = scriptedTransport({
      chunks: anthropicScript([...'Led checkout\nCut p95 latency\n']),
    });
    const provider = createAnthropicProvider({ keyFor: () => 'k', post: transport.post });
    const e = events();

    const outcome = await runGeneration(
      provider,
      request('anthropic', 'claude-haiku-4-5-20251001'),
      neverAbort(),
      e.sink,
    );

    expect(e.begins).toHaveLength(1);
    expect(e.lines).toEqual(['Led checkout', 'Cut p95 latency']);
    expect(e.ends).toEqual([{ generationId: 'gen-1', status: 'complete' }]);
    expect(outcome.bullets).toEqual(['Led checkout', 'Cut p95 latency']);
    expect(outcome.usage).toEqual({ inputTokens: 412, outputTokens: 57 });
    expect(outcome.error).toBeNull();
  });

  it('records a newline-free generation as nonconforming and still shows it', async () => {
    const transport = scriptedTransport({
      chunks: anthropicScript(['one long paragraph with no newline anywhere in it']),
    });
    const provider = createAnthropicProvider({ keyFor: () => 'k', post: transport.post });
    const e = events();

    const outcome = await runGeneration(
      provider,
      request('anthropic', 'claude-haiku-4-5-20251001'),
      neverAbort(),
      e.sink,
    );

    expect(outcome.status).toBe('nonconforming');
    expect(e.lines).toEqual(['one long paragraph with no newline anywhere in it']);
    expect(e.ends[0]?.status).toBe('nonconforming');
  });

  it('never sends more than five lines to the overlay', async () => {
    const body = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) => `bullet ${x}\n`).join('');
    const transport = scriptedTransport({ chunks: anthropicScript([body]) });
    const provider = createAnthropicProvider({ keyFor: () => 'k', post: transport.post });
    const e = events();

    await runGeneration(
      provider,
      request('anthropic', 'claude-haiku-4-5-20251001'),
      neverAbort(),
      e.sink,
    );
    expect(e.lines).toHaveLength(MAX_CARD_LINES);
  });

  it('reports a provider failure to the caller and never as an overlay error', async () => {
    const transport = scriptedTransport({ ok: false, status: 500, errorBody: 'upstream' });
    const provider = createAnthropicProvider({ keyFor: () => 'k', post: transport.post });
    const e = events();

    const outcome = await runGeneration(
      provider,
      request('anthropic', 'claude-haiku-4-5-20251001'),
      neverAbort(),
      e.sink,
    );

    // FR-076: the overlay has no error state. The card is cleared and the
    // failure goes back to the caller for the Dashboard badge.
    expect(e.ends).toEqual([{ generationId: 'gen-1', status: 'cancelled' }]);
    expect(outcome.error?.class).toBe('server');
    expect(e.lines).toEqual([]);
  });

  it('keeps what was salvaged when a stream fails part-way through', async () => {
    const transport = scriptedTransport({
      chunks: [
        sse('message_start', { type: 'message_start', message: { usage: { input_tokens: 9 } } }),
        sse('content_block_delta', {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Led checkout\npartial' },
        }),
        sse('error', { type: 'error', error: { message: 'overloaded' } }),
      ],
    });
    const provider = createAnthropicProvider({ keyFor: () => 'k', post: transport.post });
    const e = events();

    const outcome = await runGeneration(
      provider,
      request('anthropic', 'claude-haiku-4-5-20251001'),
      neverAbort(),
      e.sink,
    );

    expect(e.lines).toEqual(['Led checkout', 'partial']);
    expect(e.ends[0]?.status).toBe('complete');
    expect(outcome.error?.message).toBe('overloaded');
  });
});

describe('runGeneration guards against an adapter that ignores the signal', () => {
  it('stops consuming the moment the signal is aborted mid-stream', async () => {
    const controller = new AbortController();
    const stubborn = {
      id: 'stubborn',
      validateKey: () => Promise.resolve({ ok: true }),
      generate: async function* (): AsyncIterable<LlmChunk> {
        yield { delta: 'first\n' };
        controller.abort();
        yield { delta: 'second\n' };
        yield { delta: 'third\n' };
      },
    };

    const lines: string[] = [];
    const outcome = await runGeneration(stubborn, request('stubborn', 'x'), controller.signal, {
      onBegin: () => {},
      onLine: (l) => lines.push(l.line),
      onEnd: () => {},
    });

    expect(lines).toEqual(['first']);
    expect(outcome.status).toBe('cancelled');
  });

  it('wraps a non-Error throw as a retryable network failure', async () => {
    const rude = {
      id: 'rude',
      validateKey: () => Promise.resolve({ ok: true }),
      // eslint-disable-next-line require-yield
      generate: async function* (): AsyncIterable<LlmChunk> {
        throw 'a string, not an Error';
      },
    };

    const outcome = await runGeneration(rude, request('rude', 'x'), neverAbort(), {
      onBegin: () => {},
      onLine: () => {},
      onEnd: () => {},
    });
    expect(outcome.error).toMatchObject({ class: 'network', retryable: true, providerId: 'rude' });
    expect(outcome.status).toBe('cancelled');
  });
});

describe('the adapter table', () => {
  it('registers one adapter per LLM provider id and resolves by choice', () => {
    registerAllLlmProviders(() => 'key');
    expect(getLlmProvider('anthropic')?.id).toBe('anthropic');
    expect(getLlmProvider('openai')?.id).toBe('openai');
    expect(requireLlmProvider({ providerId: 'openai', modelId: 'gpt-4o-mini' }).id).toBe('openai');
  });

  it('refuses a provider with no adapter rather than returning a plausible stub', () => {
    expect(() => requireLlmProvider({ providerId: 'acme', modelId: 'x' })).toThrow(
      /No language-model adapter/,
    );
  });
});

describe('Anthropic key validation (FR-026)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('accepts a key the provider answers for', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await expect(validateAnthropicKey('k', fetchMock as unknown as typeof fetch)).resolves.toEqual({
      ok: true,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toContain('api.anthropic.com');
    expect(init.headers['x-api-key']).toBe('k');
    expect(init.headers['anthropic-version']).toBeTruthy();
  });

  it('refuses a rejected key, and refuses rather than accepts when unreachable', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    await expect(
      validateAnthropicKey('k', fetchMock as unknown as typeof fetch),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/rejected this key/) });

    fetchMock.mockRejectedValue(new Error('offline'));
    await expect(
      validateAnthropicKey('k', fetchMock as unknown as typeof fetch),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/could not be reached/) });
  });
});

function neverAbort(): AbortSignal {
  return new AbortController().signal;
}
