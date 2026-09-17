import { motion } from 'framer-motion';
import type { JSX, ReactNode } from 'react';

/**
 * One completed bullet, revealed once (FR-092, NFR-010, TASK-043).
 *
 * `FR-092` asks for a fade plus a slight upward slide over 200 to 300 ms and
 * forbids a per-word reveal. The whole line is one element with one text node,
 * so the number of DOM mutations a reveal produces is the number of bullets,
 * not the number of words or characters (`TC-112`). There is deliberately no
 * prop that could split the text.
 *
 * `NFR-010` requires `prefers-reduced-motion` to disable the **slide** and keep
 * the fade. With `slide` off the `y` key is absent from both states rather than
 * set to zero: framer-motion writes no transform at all when no transform
 * property is animated, so `TC-115` can assert the absence rather than a value.
 */
export interface BulletRevealProps {
  /** False under `prefers-reduced-motion`. The fade runs either way. */
  slide: boolean;
  children: ReactNode;
}

/** Inside the 200 to 300 ms window `FR-092` specifies. */
export const REVEAL_DURATION_SECONDS = 0.25;

/** The upward travel of the slide. "Slight", as `FR-092` puts it. */
export const REVEAL_SLIDE_PX = 8;

export function BulletReveal({ slide, children }: BulletRevealProps): JSX.Element {
  return (
    <motion.li
      data-testid="bullet"
      data-slide={slide ? 'on' : 'off'}
      className="overlay-bullet mt-[0.45em] first:mt-0 leading-snug"
      initial={slide ? { opacity: 0, y: REVEAL_SLIDE_PX } : { opacity: 0 }}
      animate={slide ? { opacity: 1, y: 0 } : { opacity: 1 }}
      transition={{ duration: REVEAL_DURATION_SECONDS, ease: 'easeOut' }}
    >
      {children}
    </motion.li>
  );
}
