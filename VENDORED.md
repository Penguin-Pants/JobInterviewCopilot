# Vendored components

Code copied into this repository rather than installed from npm.

## Why this file exists

`npm run licenses` scans `package.json` dependencies. Code that is copied in,
Magic UI in particular, is structurally invisible to that scan, so `NFR-015`
could not actually enforce what it promises for the one dependency most likely
to be pasted in by hand.

`NFR-016` closes that hole: every vendored file must appear in the table below
with its source, version and license, and `scripts/check-licenses.mjs` fails the
build when one does not. This file is the input to that check, not documentation
about it.

## Rules

- Vendored code lives under `src/renderer/<window>/vendor/`.
- Every file gets a row naming its source URL, the version or commit copied, and
  its license.
- The license must be MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD,
  CC0-1.0, Unlicense, BlueOak-1.0.0, Python-2.0 or CC-BY-4.0.
- Record the upstream version so an upstream fix can be re-applied later.

## Components

| File | Source | Version or commit | License |
|---|---|---|---|
| `src/renderer/overlay/vendor/blur-fade.tsx` | https://github.com/magicuidesign/magicui — `apps/www/registry/magicui/blur-fade.tsx` | `52bc69354621e5cd7c9bc84a0e42b42f2d0c07b1` | MIT |

### Adaptations

Vendored files are kept byte-identical to upstream apart from the changes
listed here, each marked inline at its site, so an upstream fix can be
re-applied by re-copying the file and redoing them. `.prettierignore` excludes
`src/renderer/**/vendor` for the same reason: reformatting to this
repository's style would make every future diff against upstream unreadable.

**`blur-fade.tsx`** — four lines, none of which changes runtime behaviour:

1. The import is rewritten from `motion/react` to `framer-motion`, the package
   this repository declares. `useInView`, `AnimatePresence`, `motion` and the
   `MotionProps` / `UseInViewOptions` / `Variants` types are all exported by
   framer-motion 13.
2. `BlurFadeProps` also extends `Omit<ComponentPropsWithoutRef<'div'>, keyof
   MotionProps>`, so ordinary DOM attributes type-check. They already worked at
   runtime: upstream spreads `...props` onto the `motion.div`.
3. `variant?: Variants` replaces `variant?: { hidden: { y: number }; visible: {
   y: number } }`. The body assigns it to `combinedVariants` and hands it to
   framer-motion as `Variants`, so the narrower type rejected variants the
   component accepts — a fade with no `y`, which is how `NFR-010` drops the
   slide under `prefers-reduced-motion`.
4. `getFilter` accepts `undefined`. This repository compiles with
   `noUncheckedIndexedAccess`, under which `combinedVariants.hidden` is
   `Variant | undefined`; the body already returned undefined for anything
   without a `.filter`.

It is used by `src/renderer/overlay/components/BulletReveal.tsx`, which drives
it through its public props only.

## What is not vendored, and why

`MagicCard` is the Magic UI component that would have been the obvious choice
for the suggestion card, and it is deliberately not used. The reasons are this
application's requirements rather than anything wrong with the component:

- It is a **pointer-tracking hover effect**: a radial gradient that follows the
  cursor, driven by `onPointerMove` / `onPointerEnter`. The overlay is
  click-through by default and forwards mouse events to whatever is behind it
  (`FR-083`), which is the mode a user spends an entire interview in. The effect
  would be dead for almost all of the window's life.
- It draws its surface from shadcn theme tokens (`var(--color-background)`,
  `bg-background`, `var(--color-border)`). `FR-094` requires the cards to be
  styled from the `FR-029` tokens, which here are the custom properties
  `theme.ts` computes, including the alpha floor `FR-093`'s contrast depends on
  (ADR-039). Its surface is a gradient border, not a background that can be
  held to a contrast ratio.
- It imports `next-themes` and a shadcn `@/lib/utils`, neither of which this
  application has, and adding a Next.js theming package to an Electron app to
  get a hover gradient is not a trade worth making.
- Its orb mode animates a large blurred element with `willChange`. `NFR-007`
  holds this window to 60 fps on integrated graphics.

`AnimatedList` was considered for the card stack and does not fit either: it
reveals its children on a `setTimeout` interval, whereas the stack is driven by
`CH-207` arriving over IPC, and its `scale: 0` entry and exit would move text a
user may be halfway through reading.

So the card surface is a first-party component on Tailwind, styled from the
`FR-029` tokens, and the reveal that `FR-092` specifies is Magic UI's.