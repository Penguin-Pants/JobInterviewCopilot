import type { JSX } from 'react';

/**
 * The idle card (FR-090, FR-102, NFR-007, TASK-043).
 *
 * "A small translucent card with a standing-by message, shown before the first
 * suggestion and whenever the trigger is paused."
 *
 * Deliberately **not** a motion component and deliberately without a
 * transition. `NFR-007` forbids any animation while the overlay is idle, and
 * the idle card is the whole of what is on screen then, so an entrance
 * animation here would be an animation on an idle overlay.
 *
 * An extended silence renders as this card and nothing else. It is not a
 * warning, it has no severity, and no wording here suggests that waiting is a
 * problem (FR-102, FR-076).
 */
export interface IdleCardProps {
  paused: boolean;
  sessionActive: boolean;
}

export function IdleCard({ paused, sessionActive }: IdleCardProps): JSX.Element {
  const message = paused
    ? 'Paused. Cues will resume when you unpause.'
    : sessionActive
      ? 'Standing by. Cues will appear here when your interviewer asks a question.'
      : 'Standing by.';

  return (
    <section
      data-testid="idle-card"
      data-paused={paused ? 'true' : 'false'}
      className="overlay-surface rounded-xl px-3 py-2 shadow-lg"
    >
      <p
        className="m-0 text-[0.7em] leading-snug"
        style={{ color: paused ? 'var(--overlay-text)' : 'var(--overlay-muted)' }}
      >
        {message}
      </p>
    </section>
  );
}
