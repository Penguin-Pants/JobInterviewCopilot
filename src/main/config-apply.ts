import type { InvokePayload } from '../shared/ipc.js';
import type { Settings } from '../shared/types.js';

/**
 * Everything a stored settings change reaches besides the store (`CH-102`).
 *
 * Injected rather than imported, so the order is unit tested instead of living
 * in `index.ts`, which a test cannot import (the pattern `key-save.ts` set).
 */
export interface SettingsApplyDeps {
  config: { get(): Settings; set(patch: Partial<Settings>): Settings };
  /**
   * Drop a queued `CH-126` write. It is older than this one, and the throttle
   * would otherwise re-read the theme just stored and put its own stale size
   * back over it (FR-093).
   */
  cancelQueuedFontSize(): void;
  /** Rebind health, the trigger and the cost meter from the stored settings. */
  applyLive(after: Settings): void;
  /** Send the overlay its consent text (CH-210). */
  pushConsent(text: string): void;
  /** Push the theme to the overlay, or rebuild it for a translucency change (ADR-015). */
  applyTheme(before: Settings, after: Settings): Promise<void>;
}

/**
 * `config:set` (`CH-102`): store a patch, then make the running app match it.
 *
 * The payload schema already refused the fields another channel owns
 * (hotkeys, overlay geometry, the active profile), because a write here would
 * store them without doing what their own channel does.
 *
 * The overlay rebuild runs last. It is the one step that can fail after the
 * write, and running it first left health, the trigger and the meter on the
 * old settings whenever it threw, although the new ones were already stored.
 */
export async function applySettingsPatch(
  deps: SettingsApplyDeps,
  patch: InvokePayload<'config:set'>,
): Promise<Settings> {
  const before = deps.config.get();
  const after = deps.config.set(patch);
  if (patch.theme !== undefined) deps.cancelQueuedFontSize();
  deps.applyLive(after);
  // Pushed on change, not only on load. The overlay otherwise kept showing the
  // old reminder until it was next rebuilt (FR-032).
  if (after.consentReminderText !== before.consentReminderText) {
    deps.pushConsent(after.consentReminderText);
  }
  await deps.applyTheme(before, after);
  return after;
}
