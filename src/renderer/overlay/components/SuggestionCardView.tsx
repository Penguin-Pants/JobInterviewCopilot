import { motion } from 'framer-motion';
import type { JSX } from 'react';
import type { SuggestionCard } from '../cards.js';
import { BulletReveal } from './BulletReveal.js';

/**
 * The overlay's one suggestion card (FR-004, FR-076, FR-091, FR-092, FR-094).
 *
 * The card is the unit `AnimatePresence` adds and removes, so its enter and
 * exit transitions live here and `cards.ts` above only decides which card
 * exists. The exit is the fade a card leaving gets -- a cancellation
 * (`FR-054`), a session boundary, or a replacement arriving (`ADR-047`).
 *
 * A card has three possible endings and renders none of them as a failure. A
 * `cancelled` or `nonconforming` generation shows exactly what it produced,
 * because `FR-076` bars an error card and `FR-004` says the overlay shows what
 * was salvaged. The status reaches the DOM as a data attribute only, for the
 * E2E suite; nothing in the card's appearance says "something went wrong".
 */
export interface SuggestionCardViewProps {
  card: SuggestionCard;
  /** False under `prefers-reduced-motion` (NFR-010). */
  slide: boolean;
}

/** How long a card takes to fade out on its way off the overlay. */
export const CARD_EXIT_DURATION_SECONDS = 0.25;

/**
 * Opacity is the **animated** target, never an inline style (NFR-010).
 *
 * framer-motion writes the animated value to `element.style`, so an inline
 * `style={{ opacity }}` and an `animate={{ opacity }}` are two writers of one
 * property and the card ends up at whichever wrote last. That is what the
 * removed depth dimming got wrong, and the reason a card's settled opacity is
 * stated here once rather than in two places.
 */
export function SuggestionCardView({ card, slide }: SuggestionCardViewProps): JSX.Element {
  return (
    <motion.article
      data-testid="suggestion-card"
      data-card-id={card.cardId}
      data-status={card.status}
      className="overlay-surface rounded-xl px-3 py-2 shadow-lg"
      initial={slide ? { opacity: 0, y: 10 } : { opacity: 0 }}
      // Opacity only, never a scale: a scale would move text the user may be
      // halfway through reading.
      animate={slide ? { opacity: 1, y: 0 } : { opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: CARD_EXIT_DURATION_SECONDS, ease: 'easeOut' }}
      // Position only. A full layout projection re-measures the card on every
      // commit, and a card re-renders on each arriving bullet, for a reflow
      // that is vertical anyway: the card is anchored to the bottom of the
      // region, so a bullet arriving moves the card, not its box (NFR-007).
      layout={slide ? 'position' : false}
    >
      <p
        data-testid="card-question"
        className="m-0 truncate text-[0.62em] tracking-wide uppercase"
        style={{ color: 'var(--overlay-muted)' }}
      >
        {card.question}
      </p>
      {/*
        A list by role, not by tag. The bullets are Magic UI `BlurFade` divs
        (FR-094), and a `div` is not valid inside a `ul`, so the roles carry the
        semantics a screen reader needs while each bullet stays a single element
        with a single text node, which is what `TC-112` counts.
      */}
      <div role="list" data-testid="card-lines" className="m-0 mt-[0.35em] list-none p-0">
        {card.lines.map((line) => (
          <BulletReveal key={line.index} slide={slide}>
            {line.text}
          </BulletReveal>
        ))}
      </div>
    </motion.article>
  );
}
