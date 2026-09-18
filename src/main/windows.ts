import { release } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow, screen, shell, type BrowserWindowConstructorOptions } from 'electron';
import type { ConfigStore } from './config.js';
import { getLogger } from './logger.js';
import { OVERLAY_DEFAULT_SIZE, SETTINGS_LIMITS } from '../shared/defaults.js';
import type { OverlayTranslucency, Settings } from '../shared/types.js';

/**
 * Window orchestrator (CMP-01, FR-002, FR-005, FR-080 to FR-083, FR-089).
 *
 * This module owns window creation and nothing else. It contains no business
 * logic: what a window shows is the renderer's concern, when it shows is the
 * session manager's.
 */

/** Capture exclusion is only real from this Windows 10 build on (NFR-012). */
export const MIN_BUILD_FOR_CAPTURE_EXCLUSION = 19041;
/** backgroundMaterial: 'acrylic' needs Windows 11 (ADR-015). */
export const MIN_BUILD_FOR_ACRYLIC = 22000;

/**
 * The overlay's size when the user has never resized it (FR-081).
 *
 * Re-exported from `shared/defaults` rather than declared here, because the
 * settings store clamps against the same range and the overlay's own resize
 * grip stops at the same bounds. Three copies of these numbers would be three
 * places for them to drift.
 */
export const OVERLAY_SIZE = OVERLAY_DEFAULT_SIZE;

/** The smallest the user may drag the overlay to (FR-081). */
export const OVERLAY_MIN_SIZE = {
  width: SETTINGS_LIMITS.overlayWidthPx.min,
  height: SETTINGS_LIMITS.overlayHeightPx.min,
} as const;

/**
 * The overlay's size for the current settings (FR-081).
 *
 * Stored nulls mean "the shipped default", so this is the one place that
 * resolves them. Exported so the position resolver, the window constructor and
 * `overlayBoundsFor` all answer the question the same way.
 */
export function overlaySizeFor(settings: Settings): { width: number; height: number } {
  const stored = settings.overlayWindow;
  return {
    width: stored.width ?? OVERLAY_SIZE.width,
    height: stored.height ?? OVERLAY_SIZE.height,
  };
}

/**
 * Parse the Windows build number from os.release(), for example '10.0.22631'.
 * Returns 0 on any platform where the string does not look like that, which
 * makes every Windows-version gate fall closed.
 */
export function windowsBuildNumber(releaseString = release()): number {
  const match = /^10\.0\.(\d+)/.exec(releaseString);
  return match?.[1] ? Number(match[1]) : 0;
}

/** True when capture exclusion hides the overlay instead of blacking it out. */
export function hasTrueCaptureExclusion(build = windowsBuildNumber()): boolean {
  return build >= MIN_BUILD_FOR_CAPTURE_EXCLUSION;
}

/** True when Electron's acrylic background material is available (ADR-015). */
export function supportsAcrylic(build = windowsBuildNumber()): boolean {
  return build >= MIN_BUILD_FOR_ACRYLIC;
}

/**
 * Lock every renderer down the same way (FR-086, TC-007).
 * sandbox and contextIsolation on, node integration off, no exceptions.
 */
function hardenedWebPreferences(
  preload: string,
): BrowserWindowConstructorOptions['webPreferences'] {
  return {
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
  };
}

/* v8 ignore start -- Electron webContents event wiring. The behavior it
   installs is asserted end to end by TC-008 on the Windows runner. */
/**
 * Deny every navigation and every popup (FR-086, TC-008).
 * A renderer in this app has no reason to leave its own page; an external link
 * opens in the user's browser instead.
 */
export function applyNavigationLockdown(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url).catch(() => undefined);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL();
    if (url !== current) {
      event.preventDefault();
      getLogger().warn('navigation blocked', { url });
    }
  });
  win.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
    getLogger().warn('webview attach blocked');
  });
}
/* v8 ignore stop */

/* v8 ignore start -- these wrappers bind directly to Electron and cannot run in
   a plain Node test process. Their logic is extracted into the pure, unit
   tested functions above (overlayWindowOptions, resolveOverlayPosition,
   windowsBuildNumber); what remains here is Electron plumbing, covered on the
   Windows runner by TC-005, TC-007, TC-008 and TC-148. */
function preloadPath(name: string): string {
  return join(__dirname, `../preload/${name}.js`);
}

function rendererEntry(name: string): { url?: string; file?: string } {
  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) return { url: `${devServer}/${name}/index.html` };
  return { file: join(__dirname, `../renderer/${name}/index.html`) };
}

async function loadRenderer(win: BrowserWindow, name: string): Promise<void> {
  const entry = rendererEntry(name);
  if (entry.url) await win.loadURL(entry.url);
  else if (entry.file) await win.loadFile(entry.file);
}

/**
 * The Dashboard: a standard resizable window following the theme (FR-080).
 *
 * `onCreated` exists for the reason `createOverlayWindow`'s does, and it is
 * load-bearing for the same reason. `loadURL` and `loadFile` resolve **from
 * inside** `did-finish-load`, so a caller that awaits this function and then
 * attaches a `did-finish-load` listener has attached it to an event that has
 * already been emitted, and the Dashboard never navigates again. Every replay
 * `wireDashboardWindow` installs was therefore dead on a reopened window: the
 * model state, the health snapshot, the session state and, since TASK-043, the
 * platform notice `FR-089` reads. Registering inside the callback puts the
 * listener in place before the load it is waiting for, which a caller running
 * after the await cannot do.
 */
export async function createDashboardWindow(
  settings: Settings,
  onCreated?: (win: BrowserWindow) => void,
): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    show: false,
    resizable: true,
    backgroundColor: settings.theme.mode === 'dark' ? '#0b0b0f' : '#fafafa',
    webPreferences: hardenedWebPreferences(preloadPath('dashboard')),
  });

  applyNavigationLockdown(win);
  win.once('ready-to-show', () => win.show());
  onCreated?.(win);
  await loadRenderer(win, 'dashboard');
  return win;
}

/**
 * Build the overlay's constructor options.
 *
 * Acrylic and transparency are mutually exclusive in Electron, so the two
 * translucency modes are two different window constructions and switching mode
 * has to recreate the window (ADR-015, FR-089). Exported so a test can assert
 * the flags without opening a window.
 */
export function overlayWindowOptions(
  settings: Settings,
  preload: string,
  build = windowsBuildNumber(),
): BrowserWindowConstructorOptions {
  const wantsAcrylic = settings.theme.overlayTranslucency === 'acrylic' && supportsAcrylic(build);

  const size = overlaySizeFor(settings);

  const base: BrowserWindowConstructorOptions = {
    width: size.width,
    height: size.height,
    minWidth: OVERLAY_MIN_SIZE.width,
    minHeight: OVERLAY_MIN_SIZE.height,
    show: false,
    frame: false,
    /**
     * Resizable, which `FR-081` used to forbid (TASK-052).
     *
     * The fixed 420 by 260 box could not show three cards of five bullets at
     * any font size the user was allowed to pick, so the overlay clipped its
     * own text and the text-size control made that worse rather than better.
     * The requirement was amended rather than worked around.
     *
     * This flag alone is not the whole fix. A frameless window has no border
     * for Windows to resize by, and Electron warns that a `transparent` window
     * may stop working when it is made resizable, which is the flat-opacity
     * mode below. The renderer therefore carries its own grip driving
     * `CH-127`, and that path works in both translucency modes. This flag is
     * what makes the native edges work as well, on the acrylic window that can
     * support them.
     */
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    webPreferences: hardenedWebPreferences(preload),
  };

  return wantsAcrylic
    ? { ...base, transparent: false, backgroundMaterial: 'acrylic', backgroundColor: '#00000000' }
    : { ...base, transparent: true, backgroundColor: '#00000000' };
}

/**
 * Resolve where the overlay should open.
 *
 * If the stored display is gone, fall back to the default position on the
 * primary display rather than opening off-screen (FR-082, TC-036).
 */
export function resolveOverlayPosition(
  settings: Settings,
  displays: Array<{ id: number; bounds: { x: number; y: number; width: number; height: number } }>,
  primaryId: number,
): { x: number; y: number; displayId: string } {
  const stored = settings.overlayWindow;
  const storedDisplay =
    stored.displayId === null ? undefined : displays.find((d) => String(d.id) === stored.displayId);

  if (storedDisplay && stored.x !== null && stored.y !== null) {
    const { bounds } = storedDisplay;
    const withinX = stored.x >= bounds.x && stored.x < bounds.x + bounds.width;
    const withinY = stored.y >= bounds.y && stored.y < bounds.y + bounds.height;
    if (withinX && withinY) {
      return { x: stored.x, y: stored.y, displayId: String(storedDisplay.id) };
    }
  }

  const primary = displays.find((d) => d.id === primaryId) ?? displays[0];
  if (!primary) return { x: 0, y: 0, displayId: String(primaryId) };

  return {
    // Against the right edge, so the inset has to account for however wide the
    // user has made the overlay rather than for the shipped default (FR-081).
    x: Math.round(primary.bounds.x + primary.bounds.width - overlaySizeFor(settings).width - 48),
    y: Math.round(primary.bounds.y + 96),
    displayId: String(primary.id),
  };
}

/**
 * The teleprompter overlay (FR-005, FR-081, FR-082, FR-083).
 *
 * Content protection is applied before the window is ever shown and is never
 * disabled. On Windows 10 builds below 19041 it degrades to a black rectangle
 * in captures rather than true exclusion, which the Dashboard warns about once
 * per session (NFR-012).
 */
export async function createOverlayWindow(
  settings: Settings,
  onCreated?: (win: BrowserWindow) => void,
): Promise<BrowserWindow> {
  const options = overlayWindowOptions(settings, preloadPath('overlay'));
  const win = new BrowserWindow(options);

  // Before show(), and never turned off (FR-005, TC-004, TC-005).
  win.setContentProtection(true);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Click-through by default, with mouse events forwarded (FR-083).
  win.setIgnoreMouseEvents(true, { forward: true });

  applyNavigationLockdown(win);

  const displays = screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds }));
  const pos = resolveOverlayPosition(settings, displays, screen.getPrimaryDisplay().id);
  win.setPosition(pos.x, pos.y);

  // Hand the window over before the renderer load, not after. The window is
  // fully configured by this point, and it is already visible to
  // `BrowserWindow.getAllWindows()`, so a caller that only learns about it from
  // the returned promise holds null for the whole load while the rest of the app
  // can already be asked to act on it (TC-148). Registering listeners here also
  // means a `did-finish-load` handler is in place before the load below, which
  // a caller running after the await cannot achieve.
  onCreated?.(win);

  await loadRenderer(win, 'overlay');
  return win;
}

/**
 * The hidden audio worker (CMP-03b, ADR-005).
 *
 * It never shows and has no UI. It is content-protected as a precaution: it
 * should never be visible to anything, capture included.
 */
export async function createAudioWorkerWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 320,
    height: 240,
    show: false,
    skipTaskbar: true,
    webPreferences: hardenedWebPreferences(preloadPath('audioWorker')),
  });
  win.setContentProtection(true);
  applyNavigationLockdown(win);
  await loadRenderer(win, 'audio-worker');
  return win;
}

/* v8 ignore stop */

/**
 * The overlay's bounds for a resolved position (FR-009, FR-082).
 *
 * Exists so the position resolver's result, which carries a `displayId`, can
 * never be spread straight into `setBounds`. Electron expects a Rectangle and
 * rejects the call when an extra key rides along, which silently leaves the
 * window where it was. Extracted and unit tested after exactly that bug.
 */
export function overlayBoundsFor(
  pos: { x: number; y: number },
  size: { width: number; height: number } = OVERLAY_SIZE,
): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return { x: pos.x, y: pos.y, width: size.width, height: size.height };
}

/** Whether a translucency change requires recreating the overlay (ADR-015). */
export function translucencyChangeNeedsRecreate(
  before: OverlayTranslucency,
  after: OverlayTranslucency,
): boolean {
  return before !== after;
}

/* v8 ignore start -- Electron screen and window binding, covered by TC-036's
   pure resolver above and by the E2E suite. */
/**
 * Persist the overlay's current geometry and display (FR-081, FR-082, CH-119).
 *
 * Position and size are written together because they are one fact about one
 * window. Writing them from two handlers meant a resize that also nudged the
 * window, which is what dragging the top-left corner is, could commit the new
 * size against the old position.
 */
export function saveOverlayBounds(win: BrowserWindow, config: ConfigStore): void {
  if (win.isDestroyed()) return;
  const { x, y, width, height } = win.getBounds();
  const display = screen.getDisplayNearestPoint({ x, y });
  config.set({ overlayWindow: { x, y, width, height, displayId: String(display.id) } });
}
/* v8 ignore stop */
