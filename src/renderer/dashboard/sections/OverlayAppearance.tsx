/**
 * Overlay and appearance (FR-009, FR-029, FR-080, FR-085, NFR-012).
 *
 * `FR-087` names six sections. This is the seventh and it is deliberate: the
 * theme, the translucency mode, the opacity level and the overlay font size are
 * settings `FR-029` and `TASK-043` require to be adjustable from the Dashboard,
 * and none of the six named sections is their home. Reset Overlay (`FR-009`)
 * has lived here since Milestone 0.
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { SETTINGS_LIMITS } from '../../../shared/defaults.js';
import type { OverlayTranslucency, Settings, ThemeMode } from '../../../shared/types.js';
import { call } from '../call.js';
import type { PlatformState } from '../state.js';

const THEME_MODES: ThemeMode[] = ['light', 'dark', 'system'];
const TRANSLUCENCY: OverlayTranslucency[] = ['opacity', 'acrylic'];

/**
 * The Windows build acrylic needs (ADR-015, FR-089).
 *
 * Repeated here rather than imported: the authority is `MIN_BUILD_FOR_ACRYLIC`
 * in `src/main/windows.ts`, which imports Electron and so cannot be reached
 * from a renderer. Nothing branches on this number, `platform.acrylicSupported`
 * does that, so the worst a drift could cause is a sentence naming the wrong
 * build rather than a wrong control. Pinned by a guardrail so it cannot drift
 * silently anyway.
 */
const MIN_BUILD_FOR_ACRYLIC = 22000;

export interface OverlayAppearanceProps {
  settings: Settings;
  captureNotice: string | null;
  /** What the host machine supports (`CH-216`). Gates acrylic (FR-089). */
  platform: PlatformState;
  onSettingsChanged: () => Promise<void>;
}

export function OverlayAppearance({
  settings,
  captureNotice,
  platform,
  onSettingsChanged,
}: OverlayAppearanceProps): JSX.Element {
  const [theme, setTheme] = useState(settings.theme);
  const [resetState, setResetState] = useState<'idle' | 'done' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);

  // Keyed on the value, for the same reason the other sections are: a settings
  // reload triggered by an unrelated save must not snap a slider the user is
  // still dragging back to the stored value.
  const storedTheme = JSON.stringify(settings.theme);
  useEffect(() => {
    // Not while an adjustment is uncommitted, or a settings reload caused by
    // another section would snap a slider out from under the pointer.
    if (pending.current) return;
    setTheme(JSON.parse(storedTheme) as Settings['theme']);
  }, [storedTheme]);

  /**
   * Write the theme, once, and never from inside a drag.
   *
   * A `range` fires `change` on every step, and each write was followed by a
   * `config:get` that re-seeded the control from the answer. Dragging opacity
   * across its range issued a dozen unordered write-then-read pairs: the last
   * *response* won the slider, the last *write* to land won the disk, and the
   * two need not be the same one. The slider visibly jumped backwards and the
   * settings file was rewritten once per pointer step.
   *
   * So a continuous control updates local state while it moves and commits when
   * it is released, which is one write for one adjustment. Discrete controls, a
   * select and the theme mode, commit immediately: there is no intermediate
   * value to write.
   */
  const pending = useRef<Settings['theme'] | null>(null);

  /**
   * One theme write at a time.
   *
   * A translucency change destroys the overlay and awaits its replacement
   * (ADR-015). A second change made while the first is in flight stores the
   * newer setting, but `applyThemeChange` finds no window to act on and
   * returns, and the first call then finishes building a window from the older
   * settings: the overlay ends up in one mode while the settings and the
   * Dashboard both say the other.
   *
   * What this serializes is exactly the control that rebuilds the window, and
   * that is the whole of the claim: the translucency select is the only one
   * `committing` disables, so two rebuilds cannot overlap. The other controls
   * stay live during a commit on purpose, because they write settings without
   * rebuilding anything and locking the whole section behind a window rebuild
   * would freeze five controls on the strength of one. A rebuild racing a plain
   * settings write is therefore still reachable from here; it is harmless today
   * only because `wireOverlayWindow` reads `config.get()` afresh on
   * `did-finish-load`, so the rebuilt renderer is handed the newest theme
   * rather than the snapshot its rebuild started from. Making the rebuild
   * itself reconcile, rather than relying on that, is the main process's half
   * and is carried as follow-up work.
   */
  const [committing, setCommitting] = useState(false);

  /**
   * The next value is computed here, not inside the state updater.
   *
   * A `setTheme(current => { pending.current = …; })` runs its updater when
   * React processes the update, which is after this function has returned, so a
   * discrete control that committed on the next line found `pending` still
   * empty and wrote nothing at all. An updater is also re-invoked under
   * StrictMode, which makes it the wrong place for a side effect either way.
   * One event carries one change, so reading `theme` here cannot be stale.
   */
  function editTheme(patch: Partial<Settings['theme']>): Settings['theme'] {
    const next = { ...theme, ...patch };
    pending.current = next;
    setTheme(next);
    return next;
  }

  async function commitTheme(): Promise<void> {
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    setError(null);
    setCommitting(true);
    try {
      const result = await call('config:set', { theme: next });
      if (!result.ok) {
        setError(result.message);
        // Put the control back to what is actually stored, rather than leaving
        // a value on screen that the main process refused.
        setTheme(settings.theme);
        return;
      }
      await onSettingsChanged();
    } finally {
      setCommitting(false);
    }
  }

  function writeTheme(patch: Partial<Settings['theme']>): void {
    editTheme(patch);
    void commitTheme();
  }

  return (
    <section data-testid="section-overlay" aria-labelledby="overlay-heading">
      <h2 id="overlay-heading">Overlay and appearance</h2>

      {captureNotice ? (
        <p role="status" data-testid="capture-fidelity-notice">
          {captureNotice}
        </p>
      ) : null}

      <label htmlFor="theme-mode">Theme</label>
      <select
        id="theme-mode"
        data-testid="theme-mode"
        value={theme.mode}
        onChange={(e) => writeTheme({ mode: e.target.value as ThemeMode })}
      >
        {THEME_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {mode}
          </option>
        ))}
      </select>

      <label htmlFor="theme-accent">Accent color</label>
      <input
        id="theme-accent"
        data-testid="theme-accent"
        type="color"
        value={theme.accent}
        onChange={(e) => editTheme({ accent: e.target.value })}
        onBlur={() => void commitTheme()}
      />

      <label htmlFor="overlay-translucency">Overlay translucency</label>
      <select
        id="overlay-translucency"
        data-testid="overlay-translucency"
        value={theme.overlayTranslucency}
        disabled={committing}
        onChange={(e) => writeTheme({ overlayTranslucency: e.target.value as OverlayTranslucency })}
      >
        {TRANSLUCENCY.map((mode) => (
          <option
            key={mode}
            value={mode}
            // FR-089: on Windows 10 the acrylic option is disabled, with the
            // reason beside it. It was offered on every build until `CH-216`
            // carried one here, and choosing it there left the settings saying
            // acrylic over a window `overlayWindowOptions` had quietly built
            // transparent instead.
            disabled={mode === 'acrylic' && !platform.acrylicSupported}
          >
            {mode}
            {mode === 'acrylic' && !platform.acrylicSupported ? ' (needs Windows 11)' : ''}
          </option>
        ))}
      </select>
      <p data-testid="translucency-note">
        {platform.acrylicSupported
          ? 'Changing this mode rebuilds the overlay window, keeping its position, its monitor and its click-through state.'
          : `Acrylic needs Windows 11 (build ${MIN_BUILD_FOR_ACRYLIC} or later) and is unavailable on this machine${
              platform.windowsBuild > 0 ? `, which reports build ${platform.windowsBuild}` : ''
            }. Changing this mode rebuilds the overlay window, keeping its position, its monitor and its click-through state.`}
      </p>

      <label htmlFor="overlay-opacity">
        Overlay opacity ({SETTINGS_LIMITS.overlayOpacity.min} to{' '}
        {SETTINGS_LIMITS.overlayOpacity.max})
      </label>
      <input
        id="overlay-opacity"
        data-testid="overlay-opacity"
        type="range"
        min={SETTINGS_LIMITS.overlayOpacity.min}
        max={SETTINGS_LIMITS.overlayOpacity.max}
        step="0.05"
        value={theme.overlayOpacity}
        onChange={(e) => editTheme({ overlayOpacity: Number(e.target.value) })}
        onPointerUp={() => void commitTheme()}
        onKeyUp={() => void commitTheme()}
        onBlur={() => void commitTheme()}
      />
      <output htmlFor="overlay-opacity" data-testid="overlay-opacity-value">
        {theme.overlayOpacity.toFixed(2)}
      </output>

      <label htmlFor="overlay-font-size">
        Overlay text size in pixels ({SETTINGS_LIMITS.overlayFontSizePx.min} to{' '}
        {SETTINGS_LIMITS.overlayFontSizePx.max})
      </label>
      <input
        id="overlay-font-size"
        data-testid="overlay-font-size"
        type="range"
        min={SETTINGS_LIMITS.overlayFontSizePx.min}
        max={SETTINGS_LIMITS.overlayFontSizePx.max}
        step="1"
        value={theme.overlayFontSizePx}
        onChange={(e) => editTheme({ overlayFontSizePx: Number(e.target.value) })}
        onPointerUp={() => void commitTheme()}
        onKeyUp={() => void commitTheme()}
        onBlur={() => void commitTheme()}
      />
      <output htmlFor="overlay-font-size" data-testid="overlay-font-size-value">
        {theme.overlayFontSizePx}
      </output>

      {/*
        Click-through, as a setting rather than only a hotkey (FR-083, FR-084).

        The overlay is always on top, so it hides part of the screen whichever
        way this is set. What the user is choosing is whether it also takes the
        clicks it covers. Leaving that to `Ctrl+Shift+I` alone meant a user whose
        overlay sat over their browser toolbar could see the buttons it covered,
        click them by accident, and have no setting to point at.

        Written through `CH-118` rather than `config:set`, so the live window
        changes with the stored value instead of on the next launch. The main
        process persists it from there.
      */}
      <label htmlFor="overlay-click-through">Overlay passes clicks through</label>
      <input
        id="overlay-click-through"
        data-testid="overlay-click-through"
        type="checkbox"
        checked={settings.overlayWindow.clickThrough}
        onChange={(e) => {
          const clickThrough = e.target.checked;
          setError(null);
          void call('overlay:setInteractive', { interactive: !clickThrough }).then(
            async (result) => {
              if (!result.ok) {
                setError(result.message);
                return;
              }
              await onSettingsChanged();
            },
          );
        }}
      />
      <p data-testid="overlay-click-through-note">
        {settings.overlayWindow.clickThrough
          ? 'On: clicks pass through the overlay to whatever is behind it. The overlay still owns its own dismiss button and resize grip.'
          : 'Off: the overlay is a solid window. It blocks clicks on whatever it covers, can be dragged by its body, and shows its text size control.'}
      </p>

      <button
        type="button"
        data-testid="reset-overlay"
        onClick={() => {
          // An IPC rejection resolves like any other response, so it has to be
          // checked. Reporting it as success is how a failed reset looked fine.
          void call('overlay:reset').then((result) => setResetState(result.ok ? 'done' : 'failed'));
        }}
      >
        Reset Overlay
      </button>
      {resetState === 'done' ? <span data-testid="reset-overlay-done">Overlay reset</span> : null}
      {resetState === 'failed' ? (
        <span role="alert" data-testid="reset-overlay-failed">
          Could not reset the overlay. See the log for details.
        </span>
      ) : null}

      {error ? (
        <p role="alert" data-testid="appearance-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
