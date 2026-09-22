import type { Settings } from './types.js';

export const DEFAULT_PROMPT_ID = 'default';
export const DEFAULT_PROMPT_NAME = 'Default prompt';
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

export function promptForProfile(settings: Settings, profileId: string): string {
  const id = settings.profilePromptIds[profileId] ?? DEFAULT_PROMPT_ID;
  if (id === DEFAULT_PROMPT_ID) return SHIPPED_SYSTEM_PROMPT;
  return (
    settings.customPrompts.find((prompt) => prompt.id === id)?.systemPrompt ?? SHIPPED_SYSTEM_PROMPT
  );
}

export function promptName(settings: Settings, profileId: string): string {
  const id = settings.profilePromptIds[profileId] ?? DEFAULT_PROMPT_ID;
  if (id === DEFAULT_PROMPT_ID) return DEFAULT_PROMPT_NAME;
  return settings.customPrompts.find((prompt) => prompt.id === id)?.name ?? DEFAULT_PROMPT_NAME;
}
