/**
 * The OpenAI adapter (TASK-032, FR-070, FR-071).
 *
 * Chat Completions with `stream: true`. Like the Anthropic adapter it yields
 * raw deltas and one terminal usage record; everything that shapes the overlay
 * lives above it in `CMP-07` (FR-074).
 */
import type { ValidationResult } from '../../../shared/types.js';
import { providerError } from '../stt.js';
import { validateOpenAiKey } from '../stt/openai-realtime.js';
import { buildMessages, type GenerationRequest, type LlmChunk, type LlmProvider } from '../llm.js';
import {
  classifyStatus,
  fetchStreamPost,
  isAbortError,
  parseJson,
  parseSse,
  type StreamPost,
} from './sse.js';

/** The Chat Completions streaming endpoint (FR-070). */
export const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

/** The `[DONE]` sentinel Chat Completions closes its stream with. */
const DONE = '[DONE]';

interface OpenAiFrame {
  choices?: { delta?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string };
}

/**
 * `keyFor` is a function for the same reason as in the Anthropic adapter: one
 * OpenAI key serves transcription and chat (ADR-017), and a key replaced
 * mid-session must take effect without rebuilding the adapter.
 */
export function createOpenAiLlmProvider(options: {
  keyFor: () => string | undefined;
  post?: StreamPost;
  validate?: (key: string) => Promise<ValidationResult>;
}): LlmProvider {
  const post = options.post ?? fetchStreamPost;

  return {
    id: 'openai',

    // One OpenAI key, one check, whichever capability asked (ADR-017). The STT
    // adapter already owns that request, so this is the same call, not a second
    // opinion about the same key.
    validateKey: (key) => (options.validate ?? validateOpenAiKey)(key),

    generate(req: GenerationRequest, signal: AbortSignal): AsyncIterable<LlmChunk> {
      return stream(req, signal, post, options.keyFor);
    },
  };
}

async function* stream(
  req: GenerationRequest,
  signal: AbortSignal,
  post: StreamPost,
  keyFor: () => string | undefined,
): AsyncIterable<LlmChunk> {
  const key = keyFor();
  if (key === undefined || key === '') {
    throw providerError('openai', 'auth', 'No OpenAI key is saved.');
  }

  const messages = buildMessages(req);
  const body = JSON.stringify({
    model: req.choice.modelId,
    max_tokens: messages.maxTokens,
    temperature: messages.temperature,
    stream: true,
    // Without this the stream carries no usage at all and the Cost Meter would
    // silently account zero tokens for every OpenAI generation (FR-106).
    stream_options: { include_usage: true },
    messages: [
      { role: 'system', content: messages.system },
      { role: 'user', content: messages.user },
    ],
  });

  let res;
  try {
    res = await post(OPENAI_CHAT_URL, {
      headers: { Authorization: `Bearer ${key}` },
      body,
      signal,
    });
  } catch (err) {
    if (isAbortError(err)) return;
    throw providerError('openai', 'network', 'OpenAI could not be reached.');
  }

  if (!res.ok) {
    const detail = (await res.errorText()).slice(0, 200);
    throw providerError(
      'openai',
      classifyStatus(res.status),
      detail === '' ? `OpenAI returned ${String(res.status)}.` : detail,
    );
  }

  const usage = { inputTokens: 0, outputTokens: 0 };
  let sawDone = false;
  try {
    for await (const event of parseSse(res.chunks())) {
      if (signal.aborted) return;
      if (event.data === DONE) {
        sawDone = true;
        break;
      }

      const frame = parseJson<OpenAiFrame>(event.data);
      if (!frame) continue;

      if (frame.error) {
        throw providerError('openai', 'server', frame.error.message ?? 'OpenAI failed.');
      }
      if (frame.usage) {
        usage.inputTokens = frame.usage.prompt_tokens ?? usage.inputTokens;
        usage.outputTokens = frame.usage.completion_tokens ?? usage.outputTokens;
      }
      // The usage-only frame carries an empty `choices`, so this is a separate
      // check rather than an else.
      const delta = frame.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta !== '') yield { delta };
    }
  } catch (err) {
    if (isAbortError(err)) return;
    throw err;
  }

  // Same rule as the Anthropic adapter: a body that ends before `[DONE]` was
  // truncated, not completed, and must not be reported as a success.
  if (!sawDone) {
    throw providerError('openai', 'network', 'OpenAI ended the stream early.');
  }

  yield { usage };
}
