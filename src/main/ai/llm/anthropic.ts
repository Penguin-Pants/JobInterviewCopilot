/**
 * The Anthropic adapter (TASK-032, FR-070, FR-071).
 *
 * Yields raw deltas and one terminal usage record, and nothing else. Line
 * buffering, the card cap and the shape rules are `CMP-07`'s job, above this
 * file, so both providers behave identically on the overlay (FR-074).
 */
import type { ValidationResult } from '../../../shared/types.js';
import { providerError } from '../stt.js';
import { findLlmModel } from '../../../shared/registry/llm.js';
import { buildMessages, type GenerationRequest, type LlmChunk, type LlmProvider } from '../llm.js';
import {
  classifyStatus,
  fetchStreamPost,
  isAbortError,
  parseJson,
  parseSse,
  type StreamPost,
} from './sse.js';

/** The streaming endpoint, the validation endpoint and the API version (FR-070). */
export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models?limit=1';
export const ANTHROPIC_VERSION = '2023-06-01';

/** The frames this adapter reads. Everything else in the stream is ignored. */
interface AnthropicFrame {
  type?: string;
  delta?: { type?: string; text?: string };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

function headers(key: string): Record<string, string> {
  return {
    'x-api-key': key,
    'anthropic-version': ANTHROPIC_VERSION,
  };
}

/**
 * Live key validation before the key is saved (FR-026).
 *
 * `GET /v1/models` rather than a one-token message: it answers the only
 * question being asked, costs nothing and cannot be rate limited by a token
 * budget.
 */
export async function validateAnthropicKey(
  key: string,
  get: typeof fetch = fetch,
): Promise<ValidationResult> {
  try {
    const res = await get(ANTHROPIC_MODELS_URL, { headers: headers(key) });
    if (res.ok) return { ok: true };
    const cls = classifyStatus(res.status);
    if (cls === 'auth') return { ok: false, reason: 'Anthropic rejected this key.' };
    if (cls === 'rate-limit') {
      return { ok: false, reason: 'Anthropic is rate limiting this key. Try again shortly.' };
    }
    return { ok: false, reason: 'Anthropic could not confirm this key.' };
  } catch {
    return { ok: false, reason: 'Anthropic could not be reached. Check your connection.' };
  }
}

/**
 * The adapter. `keyFor` is a function rather than a key so a credential saved
 * or replaced mid-session is picked up on the next request, without the
 * adapter ever holding a copy of it (NFR-003).
 */
export function createAnthropicProvider(options: {
  keyFor: () => string | undefined;
  post?: StreamPost;
  validate?: (key: string) => Promise<ValidationResult>;
}): LlmProvider {
  const post = options.post ?? fetchStreamPost;

  return {
    id: 'anthropic',

    validateKey: (key) => (options.validate ?? validateAnthropicKey)(key),

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
    throw providerError('anthropic', 'auth', 'No Anthropic key is saved.');
  }

  const messages = buildMessages(req);
  const descriptor = findLlmModel(req.choice);
  const effort = descriptor?.effort?.allowed.includes(req.choice.effort ?? '')
    ? req.choice.effort
    : descriptor?.effort?.default;
  const classification = req.purpose === 'classification';
  const body = JSON.stringify({
    model: req.choice.modelId,
    max_tokens: messages.maxTokens,
    ...(descriptor?.effort && !classification
      ? { thinking: { type: 'adaptive' }, output_config: { effort } }
      : {
          temperature: messages.temperature,
        }),
    system: messages.system,
    messages: [{ role: 'user', content: messages.user }],
    stream: true,
  });

  let res;
  try {
    res = await post(ANTHROPIC_MESSAGES_URL, { headers: headers(key), body, signal });
  } catch (err) {
    if (isAbortError(err)) return;
    throw providerError('anthropic', 'network', 'Anthropic could not be reached.');
  }

  if (!res.ok) {
    const detail = (await res.errorText()).slice(0, 200);
    throw providerError(
      'anthropic',
      classifyStatus(res.status),
      detail === '' ? `Anthropic returned ${String(res.status)}.` : detail,
    );
  }

  const usage = { inputTokens: 0, outputTokens: 0 };
  let sawTerminalFrame = false;
  try {
    for await (const event of parseSse(res.chunks())) {
      if (signal.aborted) return;
      const frame = parseJson<AnthropicFrame>(event.data);
      if (!frame) continue;

      if (frame.type === 'message_stop') {
        sawTerminalFrame = true;
        break;
      }

      if (frame.type === 'error') {
        throw providerError('anthropic', 'server', frame.error?.message ?? 'Anthropic failed.');
      }
      if (frame.type === 'message_start') {
        usage.inputTokens = frame.message?.usage?.input_tokens ?? 0;
        // Anthropic reports a running output count here too; the final
        // message_delta supersedes it.
        usage.outputTokens = frame.message?.usage?.output_tokens ?? 0;
        continue;
      }
      if (frame.type === 'content_block_delta' && typeof frame.delta?.text === 'string') {
        yield { delta: frame.delta.text };
        continue;
      }
      if (frame.type === 'message_delta') {
        usage.outputTokens = frame.usage?.output_tokens ?? usage.outputTokens;
      }
    }
  } catch (err) {
    if (isAbortError(err)) return;
    throw err;
  }

  // A clean EOF is not a completed generation. A proxy or a dropped connection
  // ends the body without `message_stop`, and reporting that as a success would
  // put a truncated answer on the overlay with nothing to say it was cut short.
  // The facade still shows the lines that did arrive (FR-076).
  if (!sawTerminalFrame) {
    throw providerError('anthropic', 'network', 'Anthropic ended the stream early.');
  }

  // Exactly one terminal usage record, whatever the stream reported along the
  // way. The Cost Meter adds it once (FR-106).
  yield { usage };
}
