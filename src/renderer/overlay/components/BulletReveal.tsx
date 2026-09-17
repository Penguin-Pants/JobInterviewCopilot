import type { JSX, ReactNode } from 'react';
import { BlurFade } from '../vendor/blur-fade.js';

/**
 * One completed bullet, revealed once (FR-092, FR-094, NFR-010, TASK-043).
 *
 * The reveal is Magic UI's `BlurFade`, vendored under `../vendor/` with its
 * provenance in `VENDORED.md` (NFR-016). It is driven entirely through its
 * public props and its own file is untouched apart from one import line, so an
 * upstream fix can be re-applied by re-copying it.
 *
 * `FR-092` asks for a fade plus a slight upward slide over 200 to 300 ms and
 * forbids a per-word reveal. The whole line is one element with one text node,
 * so the number of DOM mutations a reveal produces is the number of bullets,
 * not the number of words or characters (`TC-112`). There is deliberately no
 * prop that could split the text.
 *
 * Both variants are supplied explicitly rather than inherited, for two
 * reasons, and `BlurFade` supports exactly this: `variant` is its documented
 * way to replace the defaults, and it keeps the vendored file untouched.
 *
 * - **No blur.** `FR-092` asks for a fade and a slide; the blur is Magic UI's
 *   own flourish and this overlay is 420 by 260, where a blurred cue is a cue
 *   you cannot read yet. `blur="0px"` alone was not enough: it makes
 *   `shouldTransitionFilter` false so nothing is *animated*, but the default
 *   variants still set `filter: blur(0px)` on the element, which promotes a
 *   compositing layer per bullet for no visible effect. Measured on the built
 *   renderer: a computed `filter` was present on every bullet. `NFR-007` holds
 *   this window to 60 fps on integrated graphics, and there are up to fifteen
 *   of these on screen.
 * - **One difference between the modes, and it is the slide.** With the blur
 *   inherited in one mode and dropped in the other, reduced motion changed two
 *   things rather than the one `NFR-010` names. Supplying both variants makes
 *   them identical apart from `y`.
 *
 * `inView` is left at its default `false`, so the reveal fires on mount rather
 * than on a viewport intersection. Every bullet is already on screen in a
 * window this size, and gating a cue on an observer would mean a cue that never
 * appears if the card is clipped (`TC-006`).
 *
 * `NFR-010` requires `prefers-reduced-motion` to disable the **slide** and keep
 * the fade. The reduced variant omits `y` entirely rather than setting it to
 * zero: framer-motion writes no transform when no transform property is
 * animated, so `TC-115` can assert the absence rather than a value.
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

/**
 * The two reveals, identical apart from the slide.
 *
 * `BlurFade` replaces its defaults with a supplied `variant` rather than
 * merging into them, so omitting `y` is what removes the transform, and
 * omitting `filter` is what keeps a no-op blur off the element.
 */
const SLIDE_AND_FADE = {
  hidden: { opacity: 0, y: REVEAL_SLIDE_PX },
  visible: { opacity: 1, y: 0 },
} as const;

const FADE_ONLY = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
} as const;

export function BulletReveal({ slide, children }: BulletRevealProps): JSX.Element {
  return (
    <BlurFade
      // A list item by role rather than by tag: `BlurFade` renders a `div`, and
      // a `div` is not valid inside a `ul`. The role keeps the semantics a
      // screen reader needs while leaving the bullet a single element with a
      // single text node, which is what `TC-112` counts.
      role="listitem"
      data-testid="bullet"
      data-slide={slide ? 'on' : 'off'}
      className="overlay-bullet mt-[0.45em] leading-snug first:mt-0"
      duration={REVEAL_DURATION_SECONDS}
      variant={slide ? SLIDE_AND_FADE : FADE_ONLY}
    >
      {children}
    </BlurFade>
  );
}
