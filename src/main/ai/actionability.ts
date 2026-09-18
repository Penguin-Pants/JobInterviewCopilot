import type { ProviderChoice } from '../../shared/types.js';
import type { LlmProvider, TokenUsage } from './llm.js';

export type ActionabilityVerdict = 'actionable' | 'non-actionable';

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

export const CLASSIFICATION_SYSTEM_PROMPT = `You classify whether an interviewer's spoken turn in a job interview requires
the candidate's AI assistant to prepare a suggestion. Respond with exactly one
word: ACTIONABLE or NON_ACTIONABLE.

ACTIONABLE means the turn asks the candidate a question, or otherwise expects
a substantive response. NON_ACTIONABLE means the turn is small talk, a
greeting, an acknowledgement, or other content that needs no prepared
response.

Respond with the one word and nothing else.`;

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
