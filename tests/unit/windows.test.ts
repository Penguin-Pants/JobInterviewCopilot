import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  hasTrueCaptureExclusion,
  overlayBoundsFor,
  MIN_BUILD_FOR_ACRYLIC,
  MIN_BUILD_FOR_CAPTURE_EXCLUSION,
  overlayWindowOptions,
  OVERLAY_SIZE,
  resolveOverlayPosition,
  supportsAcrylic,
  translucencyChangeNeedsRecreate,
  windowsBuildNumber,
} from '../../src/main/windows.js';
import { defaultSettings, SETTINGS_LIMITS } from '../../src/shared/defaults.js';

const DISPLAYS = [
  { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
  { id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 } },
];

/**
 * TC-004: content protection is never disabled anywhere in the source.
 * A static scan, because this guardrail cannot be observed from inside the
 * process once the window exists (FR-005, ADR-001).
 */
describe('TC-004 content protection is never disabled', () => {
  it('setContentProtection(false) appears nowhere under src/', () => {
    const files = execSync('git ls-files src', { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);
    const offenders = files.filter((f) =>
      /setContentProtection\s*\(\s*false\s*\)/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders, `files disabling content protection: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the overlay and the audio worker both enable it', () => {
    // Named rather than counted. An assertion like "one fewer than the number
    // of windows" breaks confusingly the moment a window is added, and does not
    // say which window is meant to be protected.
    const source = readFileSync('src/main/windows.ts', 'utf8');

    const overlayFn = source.slice(
      source.indexOf('export async function createOverlayWindow'),
      source.indexOf('export async function createAudioWorkerWindow'),
    );
    const workerFn = source.slice(source.indexOf('export async function createAudioWorkerWindow'));

    expect(overlayFn).toContain('setContentProtection(true)');
    expect(workerFn).toContain('setContentProtection(true)');
  });

  it('the Dashboard is deliberately not content protected', () => {
    // It is the user's own configuration window, never sitting over a shared
    // screen, and hiding it from capture would only make support harder.
    const source = readFileSync('src/main/windows.ts', 'utf8');
    const dashboardFn = source.slice(
      source.indexOf('export async function createDashboardWindow'),
      source.indexOf('export function overlayWindowOptions'),
    );
    expect(dashboardFn).not.toContain('setContentProtection');
  });
});

/** TC-005 support: the overlay's construction flags. */
describe('TC-005 overlay window flags', () => {
  it('is frameless, resizable, always on top and off the taskbar', () => {
    const opts = overlayWindowOptions(defaultSettings(), '/preload.js', 22631);
    expect(opts.frame).toBe(false);
    // `FR-081` was amended (TASK-052). The fixed 420 by 260 box could not show
    // the text it was given at any font size the user was allowed to pick.
    expect(opts.resizable).toBe(true);
    expect(opts.minWidth).toBe(SETTINGS_LIMITS.overlayWidthPx.min);
    expect(opts.minHeight).toBe(SETTINGS_LIMITS.overlayHeightPx.min);
    expect(opts.alwaysOnTop).toBe(true);
    expect(opts.skipTaskbar).toBe(true);
    expect(opts.show).toBe(false);
  });

  it('opens at the shipped default size until the user has resized (FR-081)', () => {
    const opts = overlayWindowOptions(defaultSettings(), '/preload.js', 22631);
    expect(opts.width).toBe(OVERLAY_SIZE.width);
    expect(opts.height).toBe(OVERLAY_SIZE.height);
  });

  it('opens at the stored size once the user has resized (FR-081)', () => {
    const s = defaultSettings();
    s.overlayWindow = { ...s.overlayWindow, width: 720, height: 480 };
    const opts = overlayWindowOptions(s, '/preload.js', 22631);
    expect(opts.width).toBe(720);
    expect(opts.height).toBe(480);
  });

  it('hardens every renderer the same way (FR-086)', () => {
    const wp = overlayWindowOptions(defaultSettings(), '/preload.js').webPreferences;
    expect(wp?.contextIsolation).toBe(true);
    expect(wp?.nodeIntegration).toBe(false);
    expect(wp?.sandbox).toBe(true);
  });
});

/** TC-142 support: acrylic and transparency are mutually exclusive (ADR-015). */
describe('TC-142 translucency modes are different window constructions', () => {
  it('opacity mode is transparent with no background material', () => {
    const s = defaultSettings();
    s.theme.overlayTranslucency = 'opacity';
    const opts = overlayWindowOptions(s, '/p.js', 22631);
    expect(opts.transparent).toBe(true);
    expect(opts.backgroundMaterial).toBeUndefined();
  });

  it('acrylic mode is opaque with a background material', () => {
    const s = defaultSettings();
    s.theme.overlayTranslucency = 'acrylic';
    const opts = overlayWindowOptions(s, '/p.js', 22631);
    expect(opts.transparent).toBe(false);
    expect(opts.backgroundMaterial).toBe('acrylic');
  });

  it('falls back to transparency on Windows 10, where acrylic is unavailable', () => {
    const s = defaultSettings();
    s.theme.overlayTranslucency = 'acrylic';
    const opts = overlayWindowOptions(s, '/p.js', 19045);
    expect(opts.transparent).toBe(true);
    expect(opts.backgroundMaterial).toBeUndefined();
  });

  it('a mode change requires recreating the window, an opacity change does not', () => {
    expect(translucencyChangeNeedsRecreate('opacity', 'acrylic')).toBe(true);
    expect(translucencyChangeNeedsRecreate('acrylic', 'acrylic')).toBe(false);
  });
});

/** TC-036: position persistence, and the missing-display fallback. */
describe('TC-036 overlay position', () => {
  it('restores a stored position on a display that still exists', () => {
    const s = defaultSettings();
    s.overlayWindow = { ...s.overlayWindow, x: 2000, y: 300, displayId: '2' };
    expect(resolveOverlayPosition(s, DISPLAYS, 1)).toEqual({ x: 2000, y: 300, displayId: '2' });
  });

  it('falls back to the primary display default when the stored display is gone', () => {
    const s = defaultSettings();
    s.overlayWindow = { ...s.overlayWindow, x: 2000, y: 300, displayId: '99' };
    const pos = resolveOverlayPosition(s, DISPLAYS, 1);
    expect(pos.displayId).toBe('1');
    expect(pos.x).toBe(1920 - OVERLAY_SIZE.width - 48);
  });

  it('falls back when the stored point is outside its display bounds', () => {
    const s = defaultSettings();
    s.overlayWindow = { ...s.overlayWindow, x: 99999, y: 300, displayId: '2' };
    expect(resolveOverlayPosition(s, DISPLAYS, 1).displayId).toBe('1');
  });

  it('uses the primary default on a first run with nothing stored', () => {
    const pos = resolveOverlayPosition(defaultSettings(), DISPLAYS, 1);
    expect(pos).toEqual({ x: 1920 - OVERLAY_SIZE.width - 48, y: 96, displayId: '1' });
  });
});

/** NFR-012: the Windows build gates. */
describe('NFR-012 Windows build detection', () => {
  it('parses a Windows release string', () => {
    expect(windowsBuildNumber('10.0.22631')).toBe(22631);
    expect(windowsBuildNumber('10.0.19041')).toBe(19041);
  });

  it('treats a non-Windows release string as build 0, so every gate falls closed', () => {
    expect(windowsBuildNumber('6.18.44-fc-v33')).toBe(0);
    expect(hasTrueCaptureExclusion(0)).toBe(false);
    expect(supportsAcrylic(0)).toBe(false);
  });

  it('gates on the documented build numbers', () => {
    expect(hasTrueCaptureExclusion(MIN_BUILD_FOR_CAPTURE_EXCLUSION)).toBe(true);
    expect(hasTrueCaptureExclusion(MIN_BUILD_FOR_CAPTURE_EXCLUSION - 1)).toBe(false);
    expect(supportsAcrylic(MIN_BUILD_FOR_ACRYLIC)).toBe(true);
    expect(supportsAcrylic(MIN_BUILD_FOR_ACRYLIC - 1)).toBe(false);
  });
});

/**
 * FR-009 regression: Reset Overlay silently did nothing on Windows.
 *
 * The resolver returns `{ x, y, displayId }`. Spreading that into
 * `setBounds` passed a string `displayId` into an Electron Rectangle, so the
 * call failed and the window stayed exactly where it was. The E2E suite caught
 * it as "overlay is still at -30000"; this pins it locally.
 */
describe('FR-009 overlay reset bounds', () => {
  it('produces a Rectangle and nothing else', () => {
    const pos = resolveOverlayPosition(defaultSettings(), DISPLAYS, 1);
    const bounds = overlayBoundsFor(pos);

    expect(Object.keys(bounds).sort()).toEqual(['height', 'width', 'x', 'y']);
    expect(bounds).not.toHaveProperty('displayId');
    expect(bounds.width).toBe(OVERLAY_SIZE.width);
    expect(bounds.height).toBe(OVERLAY_SIZE.height);
  });

  it('carries the resolved position through unchanged', () => {
    expect(overlayBoundsFor({ x: 12, y: 34 })).toMatchObject({ x: 12, y: 34 });
  });

  it('takes the size it is given, so a reset can restore the default one', () => {
    expect(overlayBoundsFor({ x: 0, y: 0 }, { width: 900, height: 600 })).toEqual({
      x: 0,
      y: 0,
      width: 900,
      height: 600,
    });
  });
});

/**
 * FR-083 regression: the consent reminder could not be dismissed (TASK-052).
 *
 * The overlay is click-through, so the operating system passed the click on the
 * "Got it" button to whatever was behind the overlay and the button never saw
 * it. The reminder then sat over the user's meeting for the whole session.
 *
 * A static scan, for the reason TC-004's is: whether a window ignores mouse
 * events is an operating-system hit-test property, and the E2E suite drives
 * clicks through the Chrome DevTools Protocol straight into the renderer, which
 * bypasses that hit test entirely. Every click assertion in that suite passed
 * against a window no human could click. What can be checked here is the
 * invariant that made the bug possible: more than one place deciding
 * click-through, so one of them could re-arm it over a live reminder.
 */
describe('FR-083 click-through has exactly one applier', () => {
  it('only the constructor default and the one applier touch it', () => {
    const files = execSync('git ls-files src', { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);

    const callSites = files.flatMap((file) => {
      const matches = readFileSync(file, 'utf8').match(/\.setIgnoreMouseEvents\s*\(/g) ?? [];
      return matches.map(() => file);
    });

    // `windows.ts` sets the shipped default on a new window and never changes
    // it; every change goes through `index.ts`. A third site would be a second
    // opinion about a state the consent reminder depends on.
    expect(callSites.sort()).toEqual(['src/main/index.ts', 'src/main/windows.ts']);
    expect(readFileSync('src/main/windows.ts', 'utf8')).toContain(
      'setIgnoreMouseEvents(true, { forward: true })',
    );
  });

  it('the applier consults the consent reminder, not only the user toggle', () => {
    const source = readFileSync('src/main/index.ts', 'utf8');
    const applier = source.slice(
      source.indexOf('function applyOverlayClickThrough'),
      source.indexOf('function setConsentReminderPending'),
    );
    expect(applier).toContain('consentReminderPending');
    expect(applier).toContain('overlayInteractive');
  });
});
