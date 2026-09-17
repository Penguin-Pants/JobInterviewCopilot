import { motion } from 'framer-motion';
import type { JSX } from 'react';
import type { SuggestionCard } from '../cards.js';
import { BulletReveal } from './BulletReveal.js';

/**
 * One suggestion card in the stack (FR-004, FR-076, FR-091, FR-092, FR-094).
 *
 * The card is the unit `AnimatePresence` adds and removes, so its enter and
 * exit transitions live here and the stack above only decides which cards
 * exist. The oldest card's exit is the fade `FR-091` requires when a fourth
 * arrives.
 *
 * A card has three possible endings and renders none of them as a failure. A
 * `cancelled` or `nonconforming` generation shows exactly what it produced,
 * because `FR-076` bars an error card and `FR-004` says the overlay shows what
 * was salvaged. The status reaches the DOM as a data attribute only, for the
 * E2E suite; nothing in the card's appearance says "something went wrong".
 */
export interface SuggestionCardViewProps {
  card: SuggestionCard;
  /** Depth in the stack, 0 being the newest. Older cards recede. */
  depth: number;
  /** False under `prefers-reduced-motion` (NFR-010). */
  slide: boolean;
}

/** The exit `FR-091` names: the oldest card fades out as a fourth enters. */
export const CARD_EXIT_DURATION_SECONDS = 0.25;

/**
 * How opaque a card at `depth` is rendered (FR-091).
 *
 * Older cards recede rather than disappear, so a glance lands on the newest
 * cue. This is part of the **animated** target rather than a static style:
 * framer-motion writes the animated value to `element.style`, so an inline
 * `style={{ opacity }}` and an `animate={{ opacity }}` are two writers of one
 * property and the card ends up at whichever wrote last. Measured on the built
 * renderer, that produced a stack where the second card was fully opaque and
 * the third was dimmed, which is neither of the two designs.
 *
 * Making it the target also means a card recedes smoothly as it is pushed down
 * the stack, rather than jumping a step each time a new one arrives.
 */
export function depthOpacity(depth: number): number {
  return depth === 0 ? 1 : Math.max(0.55, 1 - depth * 0.22);
}

export function SuggestionCardView({ card, depth, slide }: SuggestionCardViewProps): JSX.Element {
  return (
    <motion.article
      data-testid="suggestion-card"
      data-card-id={card.cardId}
      data-status={card.status}
      data-depth={depth}
      className="overlay-surface rounded-xl px-3 py-2 shadow-lg"
      initial={slide ? { opacity: 0, y: 10 } : { opacity: 0 }}
      // Opacity only, never a scale: a scale would move text the user may be
      // halfway through reading.
      animate={slide ? { opacity: depthOpacity(depth), y: 0 } : { opacity: depthOpacity(depth) }}
      exit={{ opacity: 0 }}
      transition={{ duration: CARD_EXIT_DURATION_SECONDS, ease: 'easeOut' }}
      // Position only. A full layout projection measures every card on every
      // commit, and a card re-renders on each arriving bullet, so three cards
      // would re-measure per bullet for a reflow that is mostly vertical
      // anyway: the stack is anchored to the bottom, so an eviction moves
      // nothing and only a new card shifts the others (NFR-007).
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
