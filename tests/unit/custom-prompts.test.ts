import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../../src/shared/defaults.js';
import {
  DEFAULT_PROMPT_ID,
  SHIPPED_SYSTEM_PROMPT,
  promptForProfile,
  promptName,
} from '../../src/shared/prompts.js';
import { settingsSchema } from '../../src/shared/ipc.js';

describe('custom suggestion prompts', () => {
  it('uses the shipped default for profiles without a selection or with a stale selection', () => {
    const settings = defaultSettings();
    expect(promptForProfile(settings, 'profile-1')).toBe(SHIPPED_SYSTEM_PROMPT);
    settings.profilePromptIds['profile-1'] = 'missing';
    expect(promptForProfile(settings, 'profile-1')).toBe(SHIPPED_SYSTEM_PROMPT);
    expect(promptName(settings, 'profile-1')).toBe('Default prompt');
  });

  it('resolves a profile selection from the shared library', () => {
    const settings = defaultSettings();
    settings.customPrompts = [
      { id: 'focused', name: 'Focused', systemPrompt: 'Focus on metrics.' },
    ];
    settings.profilePromptIds['profile-1'] = 'focused';
    expect(promptForProfile(settings, 'profile-1')).toBe('Focus on metrics.');
    expect(promptName(settings, 'profile-1')).toBe('Focused');
    expect(settings.profilePromptIds['other'] ?? DEFAULT_PROMPT_ID).toBe(DEFAULT_PROMPT_ID);
  });

  it('rejects blank, duplicate, and more than five custom prompts', () => {
    const blank = defaultSettings();
    blank.customPrompts = [{ id: 'one', name: ' ', systemPrompt: 'text' }];
    expect(settingsSchema.safeParse(blank).success).toBe(false);

    const duplicate = defaultSettings();
    duplicate.customPrompts = [
      { id: 'one', name: 'Focused', systemPrompt: 'one' },
      { id: 'two', name: ' focused ', systemPrompt: 'two' },
    ];
    expect(settingsSchema.safeParse(duplicate).success).toBe(false);

    const reservedId = defaultSettings();
    reservedId.customPrompts = [{ id: DEFAULT_PROMPT_ID, name: 'Impostor', systemPrompt: 'text' }];
    expect(settingsSchema.safeParse(reservedId).success).toBe(false);

    const tooMany = defaultSettings();
    tooMany.customPrompts = Array.from({ length: 6 }, (_, index) => ({
      id: String(index),
      name: `Prompt ${index}`,
      systemPrompt: 'text',
    }));
    expect(settingsSchema.safeParse(tooMany).success).toBe(false);
  });
});
