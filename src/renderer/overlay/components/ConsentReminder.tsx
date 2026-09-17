import type { JSX } from 'react';

/**
 * The consent reminder, and the capture-fidelity warning beside it (FR-006,
 * FR-007, NFR-012, CH-210, CH-215, TASK-043).
 *
 * `FR-006` requires this before the first suggestion of **every** live session,
 * dismissible, with no setting that disables it. The renderer holds the
 * dismissal, and the shell un-dismisses it at every session boundary, so
 * "every session" is a property of the component tree rather than of the user's
 * memory.
 *
 * `NFR-012` puts the pre-19041 capture warning "alongside the consent
 * reminder", which is here. It is a statement about the machine, not a provider
 * failure, so it is not the error card `FR-076` bars: nothing on this card
 * reports that anything went wrong with a suggestion.
 *
 * It does not block interaction with other applications. The overlay is
 * click-through by default (`FR-083`) and this card carries no backdrop, no
 * modal and no focus trap.
 *
 * Its text is sized in pixels, not in `em`. `FR-093`'s 16 to 32 px control is
 * about **suggestion text**, and scaling the reminder with it put a 297 px card
 * in a 260 px window at the top of the range: measured on the built renderer,
 * the reminder ended up 2386 px above the viewport, which is a reminder that is
 * not displayed at all (`FR-006`). The shell keeps this card out of the region
 * that clips, and the fixed size keeps it small enough to be worth keeping.
 */
export interface ConsentReminderProps {
  text: string;
  /** The `CH-215` message, or null on a build with exact capture exclusion. */
  captureNotice: string | null;
  onDismiss: () => void;
}

export function ConsentReminder({
  text,
  captureNotice,
  onDismiss,
}: ConsentReminderProps): JSX.Element {
  return (
    <section
      data-testid="consent-reminder"
      className="overlay-surface max-h-[55%] shrink-0 overflow-hidden rounded-xl px-3 py-2 shadow-lg"
    >
      <p className="m-0 text-[13px] leading-snug">{text}</p>

      {captureNotice ? (
        <p
          data-testid="capture-fidelity-notice"
          role="status"
          className="m-0 mt-1.5 text-[12px] leading-snug"
          style={{ color: 'var(--overlay-muted)' }}
        >
          {captureNotice}
        </p>
      ) : null}

      <div className="mt-2 flex justify-end">
        <button
          type="button"
          data-testid="consent-dismiss"
          data-no-drag="true"
          className="rounded-md border border-[var(--overlay-border)] px-2 py-0.5 text-[12px] leading-none text-[var(--overlay-text)]"
          onClick={onDismiss}
        >
          Got it
        </button>
      </div>
    </section>
  );
}
