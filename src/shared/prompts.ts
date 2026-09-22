import type { Settings } from './types.js';

export const DEFAULT_PROMPT_ID = 'default';
export const MAX_CUSTOM_PROMPTS = 5;
export const MAX_PROMPT_NAME_CHARS = 80;
export const MAX_SYSTEM_PROMPT_CHARS = 12_000;

/** The one authoritative shipped suggestion prompt, shared by main and Dashboard. */
export const SHIPPED_SYSTEM_PROMPT = `You are a live interview memory aid for a candidate who has consented to
using this tool. Answer with 3 to 5 very short bullets. Each bullet is at
most 12 words. Use keywords, concrete facts from the candidate's notes,
or STAR-method reminders (Situation, Task, Action, Result).

Never write a paragraph. Never write a sentence the candidate could read
aloud verbatim. You are producing cues, not a script.

If the notes do not cover the question, say so in one bullet and give
structural cues instead of invented facts. Never invent an employer,
a date, a metric or a project that is not in the notes.`;

/**
 * The rules a custom prompt may not drop (FR-004, FR-073).
 *
 * A custom prompt replaces the *style* of the shipped prompt, never its
 * grounding and shape rules: a preset that only says "focus on company values"
 * must not be able to license invented employers or a readable script.
 * `LineBuffer` caps line count and length, so nothing downstream can restore
 * these rules once they are gone.
 */
export const NON_OVERRIDABLE_PROMPT_RULES = `Whatever the instructions above ask for, these rules always hold:
Answer with 3 to 5 very short bullets. Each bullet is at most 12 words.
Never write a paragraph. Never write a sentence the candidate could read
aloud verbatim. You are producing cues, not a script.
If the notes do not cover the question, say so in one bullet and give
structural cues instead of invented facts. Never invent an employer,
a date, a metric or a project that is not in the notes.`;

/**
 * A custom prompt plus the rules it may not override (FR-073).
 *
 * The shipped prompt already states these rules, so it is returned unchanged
 * rather than repeating them.
 */
export function composeSystemPrompt(systemPrompt: string): string {
  if (systemPrompt === SHIPPED_SYSTEM_PROMPT) return systemPrompt;
  return `${systemPrompt.trimEnd()}\n\n${NON_OVERRIDABLE_PROMPT_RULES}`;
}

export function promptForProfile(settings: Settings, profileId: string): string {
  const id = settings.profilePromptIds[profileId] ?? DEFAULT_PROMPT_ID;
  if (id === DEFAULT_PROMPT_ID) return SHIPPED_SYSTEM_PROMPT;
  return (
    settings.customPrompts.find((prompt) => prompt.id === id)?.systemPrompt ?? SHIPPED_SYSTEM_PROMPT
  );
}

export function promptName(settings: Settings, profileId: string): string {
  const id = settings.profilePromptIds[profileId] ?? DEFAULT_PROMPT_ID;
  if (id === DEFAULT_PROMPT_ID) return 'Default prompt';
  return settings.customPrompts.find((prompt) => prompt.id === id)?.name ?? 'Default prompt';
}
