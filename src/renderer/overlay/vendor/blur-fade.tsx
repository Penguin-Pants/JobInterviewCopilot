// VENDORED from Magic UI. Do not edit except as recorded in VENDORED.md.
//
// Source: https://github.com/magicuidesign/magicui
//   apps/www/registry/magicui/blur-fade.tsx @ 52bc69354621e5cd7c9bc84a0e42b42f2d0c07b1
// License: MIT (c) Magic UI
//
// Four adapted lines, each marked inline below, none of which changes any
// runtime behaviour: the import is rewritten to `framer-motion`, the package
// this repository declares, and three type widenings describe what the body
// already does, needed because this repository compiles stricter than upstream
// (`noUncheckedIndexedAccess`, DoD 1).
//
// Everything else is byte-identical to upstream, including its formatting, so
// an upstream fix can be re-applied by re-copying the file and redoing those
// four. `.prettierignore` excludes `src/renderer/**/vendor` to keep it that way
// (FR-094, NFR-016).
//
// Used by `../components/BulletReveal.tsx`, which drives it through its public
// props only. Reduced motion is handled there, by passing a `variant` with no
// `y`, rather than by forking this file (NFR-010).

"use client"

import { useRef } from "react"
import {
  AnimatePresence,
  motion,
  useInView,
  type MotionProps,
  type UseInViewOptions,
  type Variants,
} from "framer-motion" // VENDORED ADAPTATION: upstream imports "motion/react"

type MarginType = UseInViewOptions["margin"]

// VENDORED ADAPTATION: two type widenings, neither changing runtime behaviour.
//   1. `Omit<ComponentPropsWithoutRef<"div">, keyof MotionProps>` so ordinary
//      DOM attributes (role, data-*) type-check. They already worked, because
//      `...props` is spread onto the `motion.div` below.
//   2. `variant?: Variants` instead of `{ hidden: { y: number } }`. The body
//      assigns it to `combinedVariants` and hands it to framer-motion as
//      `Variants`, so the narrower type rejected variants the component
//      accepts, a fade with no `y` among them (NFR-010).
interface BlurFadeProps
  extends MotionProps,
    Omit<React.ComponentPropsWithoutRef<"div">, keyof MotionProps> {
  children: React.ReactNode
  className?: string
  variant?: Variants
  duration?: number
  delay?: number
  offset?: number
  direction?: "up" | "down" | "left" | "right"
  inView?: boolean
  inViewMargin?: MarginType
  blur?: string
}

// VENDORED ADAPTATION: accepts `undefined`. This repository compiles with
// `noUncheckedIndexedAccess`, under which reading `combinedVariants.hidden`
// yields `Variant | undefined`. The body already returned undefined for
// anything without a `.filter`, so this only tells the compiler what was
// always true.
const getFilter = (v: Variants[string] | undefined) =>
  typeof v === "function" || v === undefined ? undefined : v.filter

export function BlurFade({
  children,
  className,
  variant,
  duration = 0.4,
  delay = 0,
  offset = 6,
  direction = "down",
  inView = false,
  inViewMargin = "-50px",
  blur = "6px",
  ...props
}: BlurFadeProps) {
  const ref = useRef(null)
  const inViewResult = useInView(ref, { once: true, margin: inViewMargin })
  const isInView = !inView || inViewResult
  const defaultVariants: Variants = {
    hidden: {
      [direction === "left" || direction === "right" ? "x" : "y"]:
        direction === "right" || direction === "down" ? -offset : offset,
      opacity: 0,
      filter: `blur(${blur})`,
    },
    visible: {
      [direction === "left" || direction === "right" ? "x" : "y"]: 0,
      opacity: 1,
      filter: `blur(0px)`,
    },
  }
  const combinedVariants = variant ?? defaultVariants

  const hiddenFilter = getFilter(combinedVariants.hidden)
  const visibleFilter = getFilter(combinedVariants.visible)

  const shouldTransitionFilter =
    hiddenFilter != null &&
    visibleFilter != null &&
    hiddenFilter !== visibleFilter

  return (
    <AnimatePresence>
      <motion.div
        ref={ref}
        initial="hidden"
        animate={isInView ? "visible" : "hidden"}
        exit="hidden"
        variants={combinedVariants}
        transition={{
          delay: 0.04 + delay,
          duration,
          ease: "easeOut",
          ...(shouldTransitionFilter ? { filter: { duration } } : {}),
        }}
        className={className}
        {...props}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  )
}
