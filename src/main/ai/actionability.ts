import type { ProviderChoice } from '../../shared/types.js';
import type { LlmProvider, TokenUsage } from './llm.js';

/** Whether a turn needs a prepared suggestion (FR-111, ADR-045). */
export type ActionabilityVerdict = 'actionable' | 'non-actionable';

/**
 * Lead words that mark a turn actionable when the trimmed text starts with one
 * (FR-111, ADR-045). Matched as a prefix, after `NON_ACTIONABLE_PHRASES`.
 */
export const ACTIONABLE_LEADS = [
  'what',
  'why',
  'how',
  'when',
  'where',
  'who',
  'which',
  'tell me',
  'describe',
  'explain',
  'walk me through',
  'can you',
  'could you',
  'would you',
  'give an example',
] as const;

/**
 * Small talk and acknowledgements that mark a turn non-actionable (FR-111,
 * ADR-045). Matched against the whole trimmed text only, never as a prefix,
 * and checked before `ACTIONABLE_LEADS`.
 */
export const NON_ACTIONABLE_PHRASES = [
  'okay',
  'ok',
  'thanks for joining',
  'nice to meet you',
  'how are you',
  'welcome',
  'great',
  'got it',
  'sounds good',
  'perfect',
  'sure',
  'no problem',
] as const;

/**
 * The fixed classification prompt (FR-111, ADR-045). Byte-identical to
 * `02-architecture.md` section 3.6a, which `TC-181` checks.
 */
export const CLASSIFICATION_SYSTEM_PROMPT = `You classify whether an interviewer's spoken turn in a job interview requires
the candidate's AI assistant to prepare a suggestion. Respond with exactly one
word: ACTIONABLE or NON_ACTIONABLE.

ACTIONABLE means the turn asks the candidate a question, or otherwise expects
a substantive response. NON_ACTIONABLE means the turn is small talk, a
greeting, an acknowledgement, or other content that needs no prepared
response.

Respond with the one word and nothing else.`;

/**
 * The free, local half of the actionability filter (FR-111, ADR-045).
 *
 * Returns `null` when neither lexicon rule decides the turn, which is the only
 * case the LLM-backed half is asked about. Pure, with no network access, so
 * `trigger.ts` may import it (`TC-182`).
 */
export function classifyHeuristically(text: string): ActionabilityVerdict | null {
  const trimmed = text.trim();
  const exact = trimmed
    .replace(/[?.!,]+$/u, '')
    .trim()
    .toLocaleLowerCase();
  if (NON_ACTIONABLE_PHRASES.some((phrase) => exact === phrase)) return 'non-actionable';

  const lower = trimmed.toLocaleLowerCase();
  if (
    text.includes('?') ||
    ACTIONABLE_LEADS.some((lead) => lower === lead || lower.startsWith(`${lead} `))
  ) {
    return 'actionable';
  }
  return null;
}

/**
 * The LLM-backed half of the actionability filter (FR-111, NFR-018, ADR-045).
 *
 * Drains the whole response so its usage can be accounted, then reads the
 * verdict by exact, case-insensitive equality. Anything else is `'actionable'`.
 * Called only from `live.ts` (`CMP-15`), never from the trigger.
 */
export async function classifyWithLlm(
  text: string,
  classificationId: string,
  choice: ProviderChoice,
  llm: LlmProvider,
  signal: AbortSignal,
  onUsage?: (usage: TokenUsage) => void,
): Promise<ActionabilityVerdict> {
  let response = '';
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  for await (const chunk of llm.generate(
    {
      generationId: classificationId,
      question: text,
      candidateContext: '',
      chunks: [],
      choice,
      purpose: 'classification',
      promptOverride: {
        system: CLASSIFICATION_SYSTEM_PROMPT,
        user: `TURN:\n${text.trim()}`,
        maxTokens: 5,
        temperature: 0,
      },
    },
    signal,
  )) {
    if ('delta' in chunk) response += chunk.delta;
    else usage = chunk.usage;
  }
  onUsage?.(usage);
  const normalized = response.trim().toLocaleUpperCase();
  if (normalized === 'NON_ACTIONABLE') return 'non-actionable';
  return 'actionable';
}
