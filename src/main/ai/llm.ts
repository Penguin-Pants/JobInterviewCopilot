/**
 * The LLM facade (`CMP-07`). Mirrors `docs/02-architecture.md` section 3.2
 * (TASK-032, FR-070, FR-074, FR-075, FR-076).
 *
 * An adapter yields raw deltas and one terminal usage record. Everything that
 * makes the overlay behave the same whichever provider answered lives here:
 * prompt assembly, line buffering, cancellation and the shape rules of
 * `FR-004`.
 *
 * Nothing in this file or under `ai/llm/` may send an error to the overlay.
 * Provider failures reach the Dashboard badge through `CMP-12` and reach the
 * caller as a thrown `ProviderError`; the overlay sees only what was salvaged
 * (`FR-076`, TC-096).
 */
import type {
  ProviderChoice,
  ProviderDescriptor,
  ProviderError,
  SuggestionLine,
  ValidationResult,
} from '../../shared/types.js';
import { LLM_REGISTRY, findLlmModel } from '../../shared/registry/llm.js';
import type { RetrievedChunk } from '../rag.js';
import { LineBuffer } from './llm/lineBuffer.js';
import { GENERATION_PARAMS, SYSTEM_PROMPT, buildUserMessage } from './prompt.js';
import { providerError } from './stt.js';

/** What one generation cost, reported once per stream (FR-106, ASM-011). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** What an adapter yields: raw deltas, then exactly one usage record. */
export type LlmChunk = { delta: string } | { usage: TokenUsage };

/** One suggestion request, as `docs/02-architecture.md` section 3.2 defines it (FR-072). */
export interface GenerationRequest {
  generationId: string;
  question: string;
  candidateContext: string;
  /** Up to 3, from `RagEngine.query` (FR-072). */
  chunks: RetrievedChunk[];
  choice: ProviderChoice;
  /** Saved suggestion prompt captured when the session started. */
  systemPrompt?: string;
  promptOverride?: GenerationMessages;
  purpose?: 'suggestion' | 'classification';
}

/** The one adapter interface serving both providers (FR-070, ADR-009). */
export interface LlmProvider {
  readonly id: string;
  generate(req: GenerationRequest, signal: AbortSignal): AsyncIterable<LlmChunk>;
  validateKey(key: string): Promise<ValidationResult>;
}

/** The two messages every provider is sent. Built once, above the adapters. */
export interface GenerationMessages {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
}

/**
 * Assembles the prompt for a request (TASK-031).
 *
 * Adapters call this rather than building their own messages, so `TC-090` and
 * `TC-092` hold for both without being asserted twice.
 */
export function buildMessages(req: GenerationRequest): GenerationMessages {
  if (req.promptOverride) return req.promptOverride;
  return {
    system: req.systemPrompt ?? SYSTEM_PROMPT,
    user: buildUserMessage({
      question: req.question,
      candidateContext: req.candidateContext,
      chunks: req.chunks,
    }),
    maxTokens: GENERATION_PARAMS.maxTokens,
    temperature: GENERATION_PARAMS.temperature,
  };
}

/* ------------------------------------------------------------------ *
 * The adapter table
 * ------------------------------------------------------------------ */

const ADAPTERS = new Map<string, LlmProvider>();

/** Bind an adapter to its provider id. Called once at bootstrap (FR-037, FR-070). */
export function registerLlmProvider(provider: LlmProvider): void {
  ADAPTERS.set(provider.id, provider);
}

/** The adapter for a provider id, or null (FR-037). */
export function getLlmProvider(providerId: string): LlmProvider | null {
  return ADAPTERS.get(providerId) ?? null;
}

/** Test seam: drop every registered adapter. */
export function clearLlmProviders(): void {
  ADAPTERS.clear();
}

/**
 * The adapter for a choice, or a typed refusal (FR-070).
 *
 * Refusing beats returning a plausible stub: a missing adapter is a
 * configuration fault the Dashboard badge should name, not a silent no-op
 * during an interview.
 */
export function requireLlmProvider(
  choice: ProviderChoice,
  registry: ProviderDescriptor<{ id: string }>[] = LLM_REGISTRY,
): LlmProvider {
  // The model is checked first, exactly as `openSttSession` checks it. Settings
  // type `modelId` as a plain string, so a stale or hand-edited choice can name
  // a model that belongs to the other provider. Sent as-is it becomes a 4xx,
  // which classifies as a non-retryable `client` error and takes the whole
  // credential to CONFIG_REQUIRED, blaming a key that is perfectly good.
  if (!findLlmModel(choice, registry)) {
    throw providerError(
      choice.providerId,
      'client',
      `"${choice.providerId}:${choice.modelId}" is not in the language-model registry.`,
    );
  }

  const provider = getLlmProvider(choice.providerId);
  if (!provider) {
    throw providerError(
      choice.providerId,
      'client',
      `No language-model adapter is registered for "${choice.providerId}".`,
    );
  }
  return provider;
}

/* ------------------------------------------------------------------ *
 * Running one generation
 * ------------------------------------------------------------------ */

/** The three statuses `CH-209` and a suggestion transcript entry can carry. */
export type GenerationStatus = 'complete' | 'cancelled' | 'nonconforming';

export interface GenerationEvents {
  /** `CH-207`. Sent before the first delta is read. */
  onBegin: (e: { generationId: string; cardId: string; question: string }) => void;
  /** `CH-208`. One per completed line, never per token (FR-074). */
  onLine: (line: SuggestionLine) => void;
  /** `CH-209`. Exactly once, whatever the outcome. */
  onEnd: (e: { generationId: string; status: GenerationStatus }) => void;
}

/** What the caller gets back. TASK-040 turns this into a transcript entry (FR-106). */
export interface GenerationOutcome {
  generationId: string;
  cardId: string;
  status: GenerationStatus;
  /** The lines actually sent, in order. TASK-040 writes these to the transcript. */
  bullets: string[];
  usage: TokenUsage;
  /**
   * Set when the provider failed. The overlay was told `cancelled`, because it
   * has no error state; the failure itself belongs to the Dashboard badge and
   * to the health machine, which is why it is returned rather than shown.
   */
  error: ProviderError | null;
}

/**
 * Drives one generation end to end.
 *
 * Cancellation is the `AbortSignal` the trigger owns: aborting it aborts the
 * adapter's HTTP request, not merely this loop (`FR-075`, TC-095).
 */
export async function runGeneration(
  provider: LlmProvider,
  req: GenerationRequest,
  signal: AbortSignal,
  events: GenerationEvents,
): Promise<GenerationOutcome> {
  // One card per generation. A cancelled generation's card is replaced, never
  // appended to, which is how FR-054 removes the partial output.
  const cardId = `card-${req.generationId}`;
  const bullets: string[] = [];
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  const buffer = new LineBuffer({
    onLine: (line, index) => {
      bullets.push(line);
      events.onLine({ generationId: req.generationId, cardId, line, index });
    },
  });

  events.onBegin({ generationId: req.generationId, cardId, question: req.question });

  let error: ProviderError | null = null;
  let cancelled = signal.aborted;

  try {
    for await (const chunk of provider.generate(req, signal)) {
      if (signal.aborted) {
        cancelled = true;
        break;
      }
      if ('usage' in chunk) {
        usage.inputTokens = chunk.usage.inputTokens;
        usage.outputTokens = chunk.usage.outputTokens;
        continue;
      }
      buffer.push(chunk.delta);
    }
  } catch (err) {
    if (signal.aborted) cancelled = true;
    else error = asProviderError(err, provider.id);
  }

  // Checked again after the loop, not only inside it. An adapter that sees the
  // abort first ends its stream cleanly, so the loop finishes with no error and
  // no further iteration to test the signal on. Without this a cancelled
  // generation reported `complete` and flushed its half-written bullet onto a
  // card that was about to be replaced.
  if (signal.aborted) cancelled = true;

  // A cancelled generation's partial output is discarded rather than flushed:
  // FR-054 removes it from the overlay, so completing its last bullet first
  // would put one more line on a card that is about to be replaced. A *failed*
  // generation is flushed, because FR-076 says the overlay still shows what was
  // salvaged.
  const nonconforming = cancelled ? false : buffer.end().nonconforming;

  const status = resolveStatus({ cancelled, failed: error !== null, bullets, nonconforming });
  events.onEnd({ generationId: req.generationId, status });

  return { generationId: req.generationId, cardId, status, bullets, usage, error };
}

/**
 * The one place a generation's outcome becomes a status.
 *
 * A provider failure is not a status of its own, because `CH-209` has no such
 * value and the overlay has no error state (`FR-076`). It reports `cancelled`
 * only when nothing was salvaged: a card cleared to empty says nothing false,
 * while wiping lines the model did produce would throw away the salvage
 * `FR-076` asks for.
 */
function resolveStatus(o: {
  cancelled: boolean;
  failed: boolean;
  bullets: string[];
  nonconforming: boolean;
}): GenerationStatus {
  if (o.cancelled) return 'cancelled';
  if (o.failed && o.bullets.length === 0) return 'cancelled';
  return o.nonconforming ? 'nonconforming' : 'complete';
}

function asProviderError(err: unknown, providerId: string): ProviderError {
  if (err instanceof Error && 'class' in err && 'retryable' in err) return err as ProviderError;
  return providerError(
    providerId,
    'network',
    err instanceof Error ? err.message : 'The language model failed.',
  );
}
