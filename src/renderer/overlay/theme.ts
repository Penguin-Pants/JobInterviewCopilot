import type { OverlayTranslucency, Settings, ThemeMode } from '../../shared/types.js';

/**
 * The overlay's colour resolution and its contrast guarantee (FR-085, FR-093,
 * FR-094, NFR-010, ADR-039, TASK-043).
 *
 * A pure module with no React and no DOM import, so `TC-114` can drive every
 * theme and opacity combination in the unit suite rather than through a window.
 *
 * ## Why the card has an alpha floor
 *
 * `FR-093` requires suggestion text to hold 4.5 to 1 against the card
 * background at **every** supported opacity level. The overlay floats over an
 * unknown desktop, so "the card background" is not a colour until the card is
 * composited over whatever is behind it. The honest reading, and the only one a
 * test can check, is the worst case: the card over pure white and the card over
 * pure black, which bound every desktop between them.
 *
 * At `SETTINGS_LIMITS.overlayOpacity.min` (0.3) no single text colour can clear
 * 4.5 to 1 against both bounds: a dark card at 0.3 over a white desktop
 * composites to roughly 70 percent grey, and white text on that is about 2 to 1.
 * So the **card surface** carries a floor, computed here from the palette
 * rather than guessed, and the user's opacity moves the surface between that
 * floor and fully opaque. Opacity below the floor still changes the overlay:
 * the frame, the shadow and the idle card follow the raw value, because nothing
 * reads text off them.
 *
 * The alternative, letting the surface go to 0.3 and accepting 2 to 1, fails
 * the requirement silently on the exact setting a user picks when they want the
 * overlay to be unobtrusive, which is when they can least afford to squint.
 */

/** The ratio `FR-093` requires between suggestion text and its card. */
export const CONTRAST_TARGET = 4.5;

/** The two backdrops that bound every desktop the overlay can float over. */
export const WORST_CASE_BACKDROPS: readonly Rgb[] = [
  { r: 0, g: 0, b: 0 },
  { r: 255, g: 255, b: 255 },
];

/** An 8-bit sRGB colour. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `ThemeMode` after `system` has been resolved against the host preference. */
export type ResolvedMode = 'light' | 'dark';

/**
 * One theme's colours. `surface` is the card's own colour before its alpha is
 * applied; `text` and `muted` are both held to `CONTRAST_TARGET`, because the
 * idle message and a card's question line are rendered in `muted` and a user
 * reads them the same way they read a bullet.
 */
export interface OverlayPalette {
  surface: Rgb;
  text: Rgb;
  muted: Rgb;
  border: Rgb;
}

export const OVERLAY_PALETTES: Readonly<Record<ResolvedMode, OverlayPalette>> = {
  dark: {
    surface: { r: 16, g: 16, b: 22 },
    text: { r: 244, g: 244, b: 248 },
    muted: { r: 199, g: 199, b: 212 },
    border: { r: 62, g: 62, b: 76 },
  },
  light: {
    surface: { r: 252, g: 252, b: 254 },
    text: { r: 22, g: 22, b: 27 },
    muted: { r: 61, g: 61, b: 72 },
    border: { r: 202, g: 202, b: 214 },
  },
};

/** Parse `#rgb` or `#rrggbb`. Returns null rather than guessing (FR-029). */
export function parseHex(hex: string): Rgb | null {
  const value = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(value)) return null;
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value;
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

/** `rgb(r g b)`, the form the CSS custom properties carry. */
export function toCss(color: Rgb): string {
  return `rgb(${Math.round(color.r)} ${Math.round(color.g)} ${Math.round(color.b)})`;
}

/** WCAG 2.1 relative luminance of an sRGB colour. */
export function relativeLuminance(color: Rgb): number {
  const channel = (raw: number): number => {
    const c = raw / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** WCAG 2.1 contrast ratio. Order of the arguments does not matter. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/** Source-over compositing of `color` at `alpha` onto an opaque `backdrop`. */
export function compositeOver(color: Rgb, alpha: number, backdrop: Rgb): Rgb {
  const mix = (c: number, b: number): number => c * alpha + b * (1 - alpha);
  return {
    r: mix(color.r, backdrop.r),
    g: mix(color.g, backdrop.g),
    b: mix(color.b, backdrop.b),
  };
}

/** The worst contrast `foreground` reaches on `surface` at `alpha`, over any desktop. */
export function worstCaseContrast(
  foreground: Rgb,
  surface: Rgb,
  alpha: number,
  backdrops: readonly Rgb[] = WORST_CASE_BACKDROPS,
): number {
  return backdrops.reduce(
    (worst, backdrop) =>
      Math.min(worst, contrastRatio(foreground, compositeOver(surface, alpha, backdrop))),
    Number.POSITIVE_INFINITY,
  );
}

/**
 * The lowest alpha from which **every** alpha up to 1 clears the target.
 *
 * Not "the first alpha that passes". Worst-case contrast is not monotonic in
 * alpha: the minimum over the two backdrops rises while the card covers the
 * hostile one, then falls back toward the card's own contrast at alpha 1, so
 * the passing set is an interval rather than a suffix of [0, 1]. A search that
 * stopped at the first pass could return a floor with a failing band above it,
 * and `cardSurfaceAlpha` hands back any user opacity at or above the floor.
 * Surface `rgb(0 0 0)` with a `rgb(117 117 117)` text colour is such a palette:
 * alpha 0 passes and alpha 0.012 does not.
 *
 * So the scan runs **downward from 1** and stops at the first failure, which
 * makes the whole band above the answer safe by construction rather than by
 * assumption. Searched on a 0.001 grid rather than solved, because the answer
 * only has to be a safe floor and a search cannot be wrong about a palette a
 * closed form was never checked against. Returns 1 when no alpha below 1 is
 * safe, which makes a palette that cannot be rendered translucently fail
 * `TC-114` loudly instead of shipping a card nobody can read.
 */
export function minimumSurfaceAlpha(
  mode: ResolvedMode,
  target = CONTRAST_TARGET,
  palettes = OVERLAY_PALETTES,
): number {
  // The search is ~1000 steps of four contrast computations and the answer for
  // the shipped palettes never changes, so it is computed once per mode. Only
  // the shipped palettes are cached: a caller that passes its own, which is the
  // test proving an impossible palette reports 1, gets the real search.
  const cacheable = palettes === OVERLAY_PALETTES && target === CONTRAST_TARGET;
  const cached = cacheable ? FLOOR_CACHE.get(mode) : undefined;
  if (cached !== undefined) return cached;
  const computed = searchMinimumSurfaceAlpha(mode, target, palettes);
  if (cacheable) FLOOR_CACHE.set(mode, computed);
  return computed;
}

const FLOOR_CACHE = new Map<ResolvedMode, number>();

function searchMinimumSurfaceAlpha(
  mode: ResolvedMode,
  target: number,
  palettes: Readonly<Record<ResolvedMode, OverlayPalette>>,
): number {
  const palette = palettes[mode];
  const passes = (alpha: number): boolean =>
    heldColours(palette).every((fg) => worstCaseContrast(fg, palette.surface, alpha) >= target);

  if (!passes(1)) return 1;

  let lowestSafe = 1;
  for (let step = 1000; step >= 0; step -= 1) {
    const alpha = step / 1000;
    if (!passes(alpha)) break;
    lowestSafe = alpha;
  }
  // Rounded **up** to the next hundredth, so the shipped value sits inside the
  // proved-safe band rather than a floating-point step below its edge.
  return Math.min(1, Math.ceil(lowestSafe * 100) / 100);
}

/**
 * The colours held to `CONTRAST_TARGET`.
 *
 * `muted` is in the set and is usually the binding one: it renders a card's
 * question line and the idle message, and a user reads those the same way they
 * read a bullet.
 */
function heldColours(palette: OverlayPalette): Rgb[] {
  return [palette.text, palette.muted];
}

/**
 * The alpha the card is actually rendered at (FR-085, FR-093).
 *
 * The user's opacity, never allowed below the floor the palette needs.
 */
export function cardSurfaceAlpha(mode: ResolvedMode, overlayOpacity: number): number {
  const clamped = Math.min(1, Math.max(0, overlayOpacity));
  return Math.max(clamped, minimumSurfaceAlpha(mode));
}

/**
 * The translucency mode the window was actually built in (FR-089, CH-216).
 *
 * `overlayWindowOptions` falls back to a transparent window when acrylic is
 * selected on a build that cannot render it, so the stored setting and the
 * window can disagree. Styling the card for acrylic over a transparent window
 * is how a card ends up with no readable surface at all, so the renderer asks
 * for the effective mode rather than the requested one.
 */
export function effectiveTranslucency(
  requested: OverlayTranslucency,
  acrylicSupported: boolean,
): OverlayTranslucency {
  return requested === 'acrylic' && acrylicSupported ? 'acrylic' : 'opacity';
}

/** `system` resolved against the host preference (FR-029, FR-080). */
export function resolveMode(mode: ThemeMode, prefersDark: boolean): ResolvedMode {
  if (mode === 'light' || mode === 'dark') return mode;
  return prefersDark ? 'dark' : 'light';
}

/** Everything the overlay's CSS needs, derived once per theme push. */
export interface ResolvedOverlayTheme {
  mode: ResolvedMode;
  translucency: OverlayTranslucency;
  fontSizePx: number;
  surfaceAlpha: number;
  chromeAlpha: number;
  /**
   * The worst contrast **any** held colour reaches, for the record and for
   * tests.
   *
   * Over the held set, not over `text` alone. `muted` is what the floor is
   * actually pinned to, so reporting `text` overstated the worst case by about
   * half again and a palette change that pushed `muted` to 3 to 1 would have
   * left this number comfortably above the target.
   */
  textContrast: number;
  vars: Record<string, string>;
}

/**
 * Resolve a `CH-211` theme payload into CSS custom properties (FR-085).
 *
 * Every value the overlay renders with is derived here, so a theme change is a
 * re-render of one style object rather than a restart (`TC-116`).
 */
export function resolveOverlayTheme(
  theme: Settings['theme'],
  options: { prefersDark: boolean; acrylicSupported: boolean },
): ResolvedOverlayTheme {
  const mode = resolveMode(theme.mode, options.prefersDark);
  const palette = OVERLAY_PALETTES[mode];
  const translucency = effectiveTranslucency(theme.overlayTranslucency, options.acrylicSupported);
  const surfaceAlpha = cardSurfaceAlpha(mode, theme.overlayOpacity);
  // The frame, the shadow and the idle card follow the raw setting: no text is
  // read off them, so nothing is owed a contrast floor there and the control
  // keeps its full range where it is free to have it.
  const chromeAlpha = Math.min(1, Math.max(0, theme.overlayOpacity));
  const accent = parseHex(theme.accent) ?? palette.text;

  return {
    mode,
    translucency,
    fontSizePx: theme.overlayFontSizePx,
    surfaceAlpha,
    chromeAlpha,
    textContrast: Math.min(
      ...heldColours(palette).map((fg) => worstCaseContrast(fg, palette.surface, surfaceAlpha)),
    ),
    vars: {
      '--overlay-font-size': `${theme.overlayFontSizePx}px`,
      '--overlay-surface': toCss(palette.surface),
      '--overlay-surface-alpha': String(surfaceAlpha),
      '--overlay-chrome-alpha': String(chromeAlpha),
      '--overlay-text': toCss(palette.text),
      '--overlay-muted': toCss(palette.muted),
      '--overlay-border': toCss(palette.border),
      '--overlay-accent': toCss(accent),
    },
  };
}
