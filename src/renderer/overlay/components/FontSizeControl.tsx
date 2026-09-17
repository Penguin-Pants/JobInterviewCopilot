import type { JSX } from 'react';
import { SETTINGS_LIMITS } from '../../../shared/defaults.js';

/**
 * The in-overlay text size control (FR-093, CH-126, TASK-043).
 *
 * `FR-093` requires the size to be adjustable from the overlay as well as from
 * the Dashboard, within 16 to 32 px, and to persist. Persistence is the main
 * process's: this sends `overlay:setFontSize` and renders whatever comes back
 * on `overlay:theme`, so the number on screen is the stored number and the two
 * controls cannot disagree about it.
 *
 * It is shown only in interactive mode. In click-through mode the window
 * forwards mouse events to whatever is behind it, so a button there would be a
 * control the user can see and cannot press, and it doubles as part of the mode
 * affordance `FR-084` requires (`TC-117`).
 *
 * The buttons are real buttons and carry accessible names, so the overlay is
 * operable from the keyboard when it has focus (NFR-010).
 *
 * The controls sit on `.overlay-surface`, like every other piece of text in
 * this window. Without it they were the one exception: the shell has no
 * background and `body` is transparent, so `A-`, `A+` and the pixel value were
 * painted straight onto the desktop behind the overlay. In dark mode
 * `--overlay-text` is near white, which over a light desktop is a control the
 * user cannot see and therefore cannot use, on the very window `FR-093` asks
 * to be adjustable from. The surface is the same one `theme.ts` proves to
 * 4.5 to 1 at every supported opacity, so the affordance is readable by the
 * same construction as a bullet rather than by a second rule that could drift.
 */
export interface FontSizeControlProps {
  fontSizePx: number;
  onChange: (px: number) => void;
}

/** One press, in pixels. */
export const FONT_STEP_PX = 2;

const { min, max } = SETTINGS_LIMITS.overlayFontSizePx;

/** Clamped here as well as in the channel schema, so a press at a limit is a no-op. */
export function nextFontSize(current: number, delta: number): number {
  return Math.min(max, Math.max(min, Math.round(current + delta)));
}

export function FontSizeControl({ fontSizePx, onChange }: FontSizeControlProps): JSX.Element {
  // Sized in pixels, like the consent card and for the same reason: this is
  // chrome, not suggestion text, and a control that grew with the setting it
  // changes would take the most room exactly when there is least of it.
  const button =
    'rounded-md px-2 py-0.5 text-[12px] leading-none disabled:opacity-40 ' +
    'border border-[var(--overlay-border)] text-[var(--overlay-text)]';

  return (
    <div
      data-testid="font-size-control"
      data-no-drag="true"
      className="mt-1 flex shrink-0 items-center justify-end"
    >
      {/*
        The surface is the inner row, not this one. This element is full width
        because the shell is a column, and painting a card across it would put a
        band over the desktop for the sake of three small controls.
      */}
      <div
        data-testid="font-size-surface"
        className="overlay-surface flex items-center gap-1 rounded-lg px-1.5 py-1"
      >
        <button
          type="button"
          data-testid="font-smaller"
          aria-label="Smaller overlay text"
          className={button}
          disabled={fontSizePx <= min}
          onClick={() => onChange(nextFontSize(fontSizePx, -FONT_STEP_PX))}
        >
          A−
        </button>
        <span
          data-testid="font-size-value"
          aria-live="polite"
          className="text-[12px] tabular-nums"
          style={{ color: 'var(--overlay-muted)' }}
        >
          {fontSizePx}px
        </span>
        <button
          type="button"
          data-testid="font-larger"
          aria-label="Larger overlay text"
          className={button}
          disabled={fontSizePx >= max}
          onClick={() => onChange(nextFontSize(fontSizePx, FONT_STEP_PX))}
        >
          A+
        </button>
      </div>
    </div>
  );
}
