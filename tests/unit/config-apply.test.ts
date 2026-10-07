import { describe, expect, it, vi } from 'vitest';
import { applySettingsPatch, type SettingsApplyDeps } from '../../src/main/config-apply.js';
import { defaultSettings } from '../../src/shared/defaults.js';
import { invokeChannels } from '../../src/shared/ipc.js';
import type { Settings } from '../../src/shared/types.js';

/**
 * `config:set` (CH-102). Audit regressions: it accepted fields owned by other
 * channels, never re-pushed a changed consent text, and awaited the overlay
 * rebuild before the trigger, the meter and health saw the new settings, so a
 * rebuild that threw left them stale after the change was already stored.
 */

function deps(overrides: Partial<SettingsApplyDeps> = {}): {
  deps: SettingsApplyDeps;
  order: string[];
  stored: () => Settings;
} {
  let current = defaultSettings();
  const order: string[] = [];
  const base: SettingsApplyDeps = {
    config: {
      get: () => structuredClone(current),
      set: (patch) => {
        current = { ...current, ...patch } as Settings;
        return structuredClone(current);
      },
    },
    cancelQueuedFontSize: vi.fn(() => order.push('cancel')),
    applyLive: vi.fn(() => order.push('live')),
    pushConsent: vi.fn(() => order.push('consent')),
    applyTheme: vi.fn(async () => {
      order.push('theme');
    }),
  };
  return { deps: { ...base, ...overrides }, order, stored: () => current };
}

describe('CH-102 config:set', () => {
  it('stores the patch and returns the stored settings', async () => {
    const d = deps();
    const after = await applySettingsPatch(d.deps, { thresholds: { costUsd: 5, timeMinutes: 30 } });
    expect(after.thresholds).toEqual({ costUsd: 5, timeMinutes: 30 });
    expect(d.stored().thresholds).toEqual({ costUsd: 5, timeMinutes: 30 });
  });

  it('applies live state before the overlay rebuild, so a rebuild failure cannot leave it stale', async () => {
    const d = deps({
      applyTheme: vi.fn(async () => {
        throw new Error('rebuild failed');
      }),
    });
    await expect(
      applySettingsPatch(d.deps, { thresholds: { costUsd: 9, timeMinutes: 60 } }),
    ).rejects.toThrow('rebuild failed');
    expect(d.deps.applyLive).toHaveBeenCalledWith(
      expect.objectContaining({ thresholds: { costUsd: 9, timeMinutes: 60 } }),
    );
  });

  it('pushes the consent text to the overlay when it changes, and only then', async () => {
    const d = deps();
    await applySettingsPatch(d.deps, { thresholds: { costUsd: 3, timeMinutes: 60 } });
    expect(d.deps.pushConsent).not.toHaveBeenCalled();

    await applySettingsPatch(d.deps, { consentReminderText: 'Say it out loud.' });
    expect(d.deps.pushConsent).toHaveBeenCalledWith('Say it out loud.');
  });

  it('drops a queued in-overlay font size write when a theme is stored (FR-093)', async () => {
    const d = deps();
    await applySettingsPatch(d.deps, { consentReminderText: 'x' });
    expect(d.deps.cancelQueuedFontSize).not.toHaveBeenCalled();

    await applySettingsPatch(d.deps, { theme: defaultSettings().theme });
    expect(d.deps.cancelQueuedFontSize).toHaveBeenCalledOnce();
    expect(d.order.indexOf('cancel')).toBeLessThan(d.order.lastIndexOf('theme'));
  });
});

describe('CH-102 refuses fields another channel owns', () => {
  const payload = invokeChannels['config:set'].payload;
  const s = defaultSettings();

  it('refuses hotkeys, overlay geometry and the active profile', () => {
    expect(payload.safeParse({ hotkeys: s.hotkeys }).success).toBe(false);
    expect(payload.safeParse({ overlayWindow: s.overlayWindow }).success).toBe(false);
    expect(payload.safeParse({ activeProfileId: 'p1' }).success).toBe(false);
  });

  it('accepts every field the Dashboard writes through it', () => {
    // One per renderer call site of `config:set`.
    for (const patch of [
      { consentReminderText: s.consentReminderText },
      { thresholds: s.thresholds },
      { profilePromptIds: {} },
      { customPrompts: [], profilePromptIds: {} },
      { theme: s.theme },
      { providers: s.providers, llmModelCutoffs: s.llmModelCutoffs },
    ]) {
      expect(payload.safeParse(patch).success, Object.keys(patch).join(',')).toBe(true);
    }
  });
});
