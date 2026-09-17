import { describe, expect, it } from 'vitest';
import { SETTINGS_LIMITS, defaultSettings } from '../../src/shared/defaults.js';
import type { ThemeMode } from '../../src/shared/types.js';
import {
  CONTRAST_TARGET,
  OVERLAY_PALETTES,
  WORST_CASE_BACKDROPS,
  cardSurfaceAlpha,
  compositeOver,
  contrastRatio,
  effectiveTranslucency,
  minimumSurfaceAlpha,
  parseHex,
  relativeLuminance,
  resolveMode,
  resolveOverlayTheme,
  toCss,
  worstCaseContrast,
  type ResolvedMode,
} from '../../src/renderer/overlay/theme.js';

/**
 * TASK-043. The overlay's colour resolution.
 *
 * `theme.ts` is deliberately free of React and of any DOM import, so the whole
 * of `FR-093`'s contrast claim is checked here rather than through a window,
 * where it could only ever be sampled at whatever opacity the test happened to
 * set.
 */

const MODES: ResolvedMode[] = ['light', 'dark'];

/** Every opacity the Dashboard slider can produce, at its 0.05 step. */
function everySupportedOpacity(): number[] {
  const { min, max } = SETTINGS_LIMITS.overlayOpacity;
  const values: number[] = [];
  for (let v = min; v <= max + 1e-9; v += 0.05) values.push(Number(v.toFixed(2)));
  return values;
}

describe('WCAG arithmetic', () => {
  it('matches the reference luminances at the ends of the range', () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 6);
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 6);
  });

  it('gives 21 to 1 for black on white, in either order', () => {
    const black = { r: 0, g: 0, b: 0 };
    const white = { r: 255, g: 255, b: 255 };
    expect(contrastRatio(black, white)).toBeCloseTo(21, 4);
    expect(contrastRatio(white, black)).toBeCloseTo(21, 4);
  });

  it('composites source-over, and is the identity at full alpha', () => {
    const red = { r: 255, g: 0, b: 0 };
    const white = { r: 255, g: 255, b: 255 };
    expect(compositeOver(red, 1, white)).toEqual(red);
    expect(compositeOver(red, 0, white)).toEqual(white);
    expect(compositeOver(red, 0.5, white)).toEqual({ r: 255, g: 127.5, b: 127.5 });
  });

  it('parses both hex forms and refuses anything else', () => {
    expect(parseHex('#6366f1')).toEqual({ r: 0x63, g: 0x66, b: 0xf1 });
    expect(parseHex('6366F1')).toEqual({ r: 0x63, g: 0x66, b: 0xf1 });
    expect(parseHex('#abc')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc });
    expect(parseHex('rgb(1,2,3)')).toBeNull();
    expect(parseHex('#12345')).toBeNull();
    expect(parseHex('')).toBeNull();
  });

  it('renders a colour as the CSS the custom properties carry', () => {
    expect(toCss({ r: 16, g: 16, b: 22 })).toBe('rgb(16 16 22)');
    expect(toCss({ r: 16.4, g: 16.5, b: 21.6 })).toBe('rgb(16 17 22)');
  });
});

/**
 * TC-114: a computed contrast check over every theme and opacity combination
 * returns at least 4.5 to 1 (FR-093).
 *
 * "Against the card background" is measured as the worst case the card can
 * actually be read on: composited over pure black and over pure white, which
 * bound every desktop the overlay can float above. Measuring against the
 * card's own colour with its alpha ignored would pass for any palette at any
 * opacity and would prove nothing about what the user sees.
 */
describe('TC-114 overlay contrast', () => {
  for (const mode of MODES) {
    for (const opacity of everySupportedOpacity()) {
      it(`${mode} theme at opacity ${opacity} holds ${CONTRAST_TARGET} to 1`, () => {
        const palette = OVERLAY_PALETTES[mode];
        const alpha = cardSurfaceAlpha(mode, opacity);
        for (const [name, colour] of [
          ['text', palette.text],
          ['muted', palette.muted],
        ] as const) {
          expect(
            worstCaseContrast(colour, palette.surface, alpha),
            `${mode}/${name} at opacity ${opacity}`,
          ).toBeGreaterThanOrEqual(CONTRAST_TARGET);
        }
      });
    }
  }

  it('checks both bounding backdrops, not one', () => {
    expect(WORST_CASE_BACKDROPS).toHaveLength(2);
    expect(WORST_CASE_BACKDROPS.map(toCss)).toEqual(['rgb(0 0 0)', 'rgb(255 255 255)']);
  });

  /**
   * The floor is the whole reason the check above can pass at 0.3. Asserting it
   * is real stops a later change from "fixing" the cap by removing it: the
   * failure would be a card at 2 to 1, which no test but this one would notice
   * until a user squinted at it.
   */
  it('the raw opacity below the floor would fail, which is why the floor exists', () => {
    for (const mode of MODES) {
      const palette = OVERLAY_PALETTES[mode];
      const floor = minimumSurfaceAlpha(mode);
      expect(floor).toBeGreaterThan(SETTINGS_LIMITS.overlayOpacity.min);
      expect(floor).toBeLessThan(1);
      expect(
        worstCaseContrast(palette.text, palette.surface, SETTINGS_LIMITS.overlayOpacity.min),
      ).toBeLessThan(CONTRAST_TARGET);
      // And a step below the floor at least one held colour already fails, so
      // the floor is the boundary rather than a number picked well clear of it.
      // Checked over the held set, because the colour that sets the floor is
      // whichever of the two needs the most alpha, not necessarily `text`.
      const held = [palette.text, palette.muted];
      expect(
        held.some(
          (colour) => worstCaseContrast(colour, palette.surface, floor - 0.02) < CONTRAST_TARGET,
        ),
        `${mode}: nothing fails just below the floor, so the floor is not the boundary`,
      ).toBe(true);
    }
  });

  it('a user opacity above the floor is used as given', () => {
    for (const mode of MODES) {
      expect(cardSurfaceAlpha(mode, 0.95)).toBeCloseTo(0.95, 6);
      expect(cardSurfaceAlpha(mode, 1)).toBe(1);
      expect(cardSurfaceAlpha(mode, 0.3)).toBe(minimumSurfaceAlpha(mode));
    }
  });

  it('clamps an out-of-range opacity rather than trusting it', () => {
    expect(cardSurfaceAlpha('dark', 5)).toBe(1);
    expect(cardSurfaceAlpha('dark', -1)).toBe(minimumSurfaceAlpha('dark'));
  });

  /**
   * The floor's promise is about the whole band above it, not about one point.
   *
   * Worst-case contrast is **not** monotonic in alpha: the minimum over the two
   * backdrops rises while the card covers the hostile one, then falls back
   * toward the card's own contrast at alpha 1. A floor found by stopping at the
   * first passing alpha can therefore have a failing band above it, and
   * `cardSurfaceAlpha` hands back any user opacity at or above the floor. This
   * is the assertion that makes the floor mean what its name says.
   */
  it('every alpha from the floor to 1 clears the target, not just the floor', () => {
    for (const mode of MODES) {
      const palette = OVERLAY_PALETTES[mode];
      const floor = minimumSurfaceAlpha(mode);
      for (let alpha = floor; alpha <= 1.0000001; alpha += 0.0005) {
        const clamped = Math.min(1, alpha);
        for (const colour of [palette.text, palette.muted]) {
          expect(
            worstCaseContrast(colour, palette.surface, clamped),
            `${mode} at alpha ${clamped.toFixed(4)}`,
          ).toBeGreaterThanOrEqual(CONTRAST_TARGET);
        }
      }
    }
  });

  it('does not return a floor with a failing band above it', () => {
    // A palette where alpha 0 passes and alpha 0.012 does not: the card is
    // black, so at alpha 0 the "surface" is the desktop itself and the grey
    // text clears 4.5 against both bounds, then fails as the card fades in.
    // A search that stopped at the first pass would answer 0 here.
    const nonMonotonic = {
      dark: {
        surface: { r: 0, g: 0, b: 0 },
        text: { r: 117, g: 117, b: 117 },
        muted: { r: 117, g: 117, b: 117 },
        border: { r: 117, g: 117, b: 117 },
      },
      light: OVERLAY_PALETTES.light,
    };
    const palette = nonMonotonic.dark;
    expect(worstCaseContrast(palette.text, palette.surface, 0.012)).toBeLessThan(CONTRAST_TARGET);

    const floor = minimumSurfaceAlpha('dark', CONTRAST_TARGET, nonMonotonic);
    expect(floor).toBeGreaterThan(0.012);
    for (let alpha = floor; alpha <= 1.0000001; alpha += 0.001) {
      expect(
        worstCaseContrast(palette.text, palette.surface, Math.min(1, alpha)),
        `alpha ${alpha.toFixed(3)}`,
      ).toBeGreaterThanOrEqual(CONTRAST_TARGET);
    }
  });

  it('reports 1 for a palette no alpha below 1 can carry', () => {
    // A grey-on-grey palette that cannot clear the target at any alpha. The
    // function must say so rather than return a floor that does not work.
    const impossible = {
      dark: {
        surface: { r: 128, g: 128, b: 128 },
        text: { r: 140, g: 140, b: 140 },
        muted: { r: 140, g: 140, b: 140 },
        border: { r: 140, g: 140, b: 140 },
      },
      light: OVERLAY_PALETTES.light,
    };
    expect(minimumSurfaceAlpha('dark', CONTRAST_TARGET, impossible)).toBe(1);
  });
});

describe('theme mode resolution (FR-029, FR-080)', () => {
  it('honours an explicit choice and defers to the host for system', () => {
    const cases: Array<[ThemeMode, boolean, ResolvedMode]> = [
      ['light', true, 'light'],
      ['dark', false, 'dark'],
      ['system', true, 'dark'],
      ['system', false, 'light'],
    ];
    for (const [mode, prefersDark, expected] of cases) {
      expect(resolveMode(mode, prefersDark), `${mode}/${prefersDark}`).toBe(expected);
    }
  });
});

/**
 * FR-089, CH-216. `overlayWindowOptions` builds a transparent window when
 * acrylic is selected on a build that cannot render it, so the renderer has to
 * style the window it got rather than the one that was asked for.
 */
describe('effective translucency', () => {
  it('falls back to opacity when the build cannot render acrylic', () => {
    expect(effectiveTranslucency('acrylic', true)).toBe('acrylic');
    expect(effectiveTranslucency('acrylic', false)).toBe('opacity');
    expect(effectiveTranslucency('opacity', true)).toBe('opacity');
    expect(effectiveTranslucency('opacity', false)).toBe('opacity');
  });
});

describe('resolveOverlayTheme (FR-085, TC-116)', () => {
  const base = defaultSettings().theme;

  it('derives every custom property the stylesheet reads', () => {
    const resolved = resolveOverlayTheme(base, { prefersDark: true, acrylicSupported: true });
    expect(Object.keys(resolved.vars).sort()).toEqual([
      '--overlay-accent',
      '--overlay-border',
      '--overlay-chrome-alpha',
      '--overlay-font-size',
      '--overlay-muted',
      '--overlay-surface',
      '--overlay-surface-alpha',
      '--overlay-text',
    ]);
    expect(resolved.vars['--overlay-font-size']).toBe('22px');
    expect(resolved.mode).toBe('dark');
  });

  it('carries the font size through unchanged, which is what persists it', () => {
    for (const px of [16, 22, 32]) {
      const resolved = resolveOverlayTheme(
        { ...base, overlayFontSizePx: px },
        { prefersDark: false, acrylicSupported: false },
      );
      expect(resolved.fontSizePx).toBe(px);
      expect(resolved.vars['--overlay-font-size']).toBe(`${px}px`);
    }
  });

  it('keeps the chrome on the raw opacity while the surface holds its floor', () => {
    const resolved = resolveOverlayTheme(
      { ...base, overlayOpacity: 0.3 },
      { prefersDark: true, acrylicSupported: false },
    );
    expect(resolved.chromeAlpha).toBe(0.3);
    expect(resolved.surfaceAlpha).toBe(minimumSurfaceAlpha('dark'));
    expect(resolved.textContrast).toBeGreaterThanOrEqual(CONTRAST_TARGET);
  });

  /**
   * `textContrast` is the worst over the held set, not over `text` alone.
   * `muted` is what the floor is pinned to, so reporting `text` overstated the
   * worst case by about half again and a palette change that pushed `muted`
   * below the target would have left the number comfortably above it.
   */
  it('reports the worst held colour, which is not the one named text', () => {
    const palette = OVERLAY_PALETTES.dark;
    const resolved = resolveOverlayTheme(
      { ...base, mode: 'dark', overlayOpacity: 0.3 },
      { prefersDark: false, acrylicSupported: false },
    );
    const textOnly = worstCaseContrast(palette.text, palette.surface, resolved.surfaceAlpha);
    const mutedOnly = worstCaseContrast(palette.muted, palette.surface, resolved.surfaceAlpha);
    expect(mutedOnly).toBeLessThan(textOnly);
    expect(resolved.textContrast).toBeCloseTo(mutedOnly, 6);
  });

  it('falls back to the theme text colour for an unparseable accent', () => {
    const resolved = resolveOverlayTheme(
      { ...base, accent: 'not-a-colour', mode: 'dark' },
      { prefersDark: false, acrylicSupported: false },
    );
    expect(resolved.vars['--overlay-accent']).toBe(toCss(OVERLAY_PALETTES.dark.text));
  });

  it('reports the effective translucency, not the requested one', () => {
    const asked = { ...base, overlayTranslucency: 'acrylic' as const };
    expect(
      resolveOverlayTheme(asked, { prefersDark: false, acrylicSupported: false }).translucency,
    ).toBe('opacity');
    expect(
      resolveOverlayTheme(asked, { prefersDark: false, acrylicSupported: true }).translucency,
    ).toBe('acrylic');
  });
});
