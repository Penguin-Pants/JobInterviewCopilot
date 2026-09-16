import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  safeStorage,
  screen,
  session,
} from 'electron';
import { AudioSupervisor } from './audio.js';
import {
  ElectronAudioWorkerHost,
  installLoopbackHandler,
  installPermissionHandler,
} from './audio-host.js';
import { registerAllSttProviders } from './ai/stt/index.js';
import { validateCredential } from './ai/validate.js';
import { ConfigStore } from './config.js';
import { HotkeyManager } from './hotkeys.js';
import { IpcRouter, push } from './ipc/router.js';
import { getLogger, initLogger } from './logger.js';
import { SecretVaultStore } from './secrets.js';
import {
  createDashboardWindow,
  createOverlayWindow,
  hasTrueCaptureExclusion,
  overlayBoundsFor,
  resolveOverlayPosition,
  saveOverlayPosition,
  supportsAcrylic,
  translucencyChangeNeedsRecreate,
  windowsBuildNumber,
} from './windows.js';
import type { Settings } from '../shared/types.js';

/**
 * Application bootstrap (CMP-01).
 *
 * Milestone 0 wires configuration, secrets, windows, hotkeys and the IPC
 * router. Channels belonging to later milestones are deliberately absent rather
 * than stubbed, so an unimplemented feature fails loudly at the boundary
 * instead of quietly returning something plausible.
 */

let config: ConfigStore;
let secrets: SecretVaultStore;
let hotkeys: HotkeyManager;
let router: IpcRouter;

let audioHost: ElectronAudioWorkerHost;
let audio: AudioSupervisor;

let dashboardWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let overlayInteractive = false;

/**
 * A single instance owns the app. A second launch focuses the existing
 * Dashboard rather than opening a second set of windows (TC-009).
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // The overlay keeps the process alive after the Dashboard is closed, so a
    // second launch is the user's way back to it. Returning early here left
    // them with no Dashboard and no way to open one short of killing the
    // background process.
    void focusOrRecreateDashboard();
  });
  void bootstrap();
}

async function bootstrap(): Promise<void> {
  const userData = app.getPath('userData');
  initLogger({ dir: join(userData, 'logs'), console: !app.isPackaged });

  // A live session must survive a stray rejection (NFR-009).
  process.on('uncaughtException', (err) => getLogger().error('uncaughtException', err));
  process.on('unhandledRejection', (reason) => getLogger().error('unhandledRejection', reason));

  config = new ConfigStore({
    dir: userData,
    onCorrupt: (path, reason) => getLogger().warn('settings quarantined', { path, reason }),
  });
  secrets = new SecretVaultStore({ dir: userData, safeStorage });

  await app.whenReady();
  applyContentSecurityPolicy();

  // Audio capture is wired now but not started. Starting belongs to the session
  // manager (TASK-040); what has to exist before then are the two main-process
  // concessions loopback needs, and a supervisor ready to receive chunks.
  audioHost = new ElectronAudioWorkerHost({
    onChunk: (chunk) => audio.handleChunk(chunk),
    onStreamState: ({ source, state, error }) => {
      if (state === 'error') {
        void audio.handleStreamEnded(source, error ?? 'The audio stream ended.');
      }
      push(dashboardWindow?.webContents, 'state:audio', {
        interviewer: audio.statusFor('interviewer').state,
        candidate: audio.statusFor('candidate').state,
      });
    },
  });

  audio = new AudioSupervisor({
    worker: audioHost,
    // The chunk goes straight to the STT layer once TASK-012 lands. Until then
    // it is dropped here rather than queued: a queue with no consumer is the
    // unbounded retention ADR-027 exists to prevent.
    onChunk: () => {},
  });

  // The STT adapters must be registered before any key is validated or any
  // session is opened. Registration is pure; it opens no socket.
  registerAllSttProviders();

  installLoopbackHandler();
  installPermissionHandler((contents) => audioHost.owns(contents));

  hotkeys = new HotkeyManager(globalShortcut);
  router = new IpcRouter(ipcMain);
  registerIpcHandlers();

  const settings = config.get();
  dashboardWindow = await createDashboardWindow(settings);
  dashboardWindow.on('closed', () => {
    dashboardWindow = null;
  });

  overlayWindow = await createOverlayWindow(settings);
  wireOverlayWindow();

  registerHotkeys();
  reportCaptureFidelity();

  // Re-open windows, never re-run bootstrap. A second bootstrap would build a
  // second ConfigStore and re-register every IPC channel, which throws.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length > 0) return;
    void reopenWindows();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    void audio.stop();
    hotkeys.disposeAll();
    router.dispose();
    getLogger().close();
  });
}

/** Bring the Dashboard forward, creating it again when it has been closed. */
async function focusOrRecreateDashboard(): Promise<void> {
  if (!dashboardWindow || dashboardWindow.isDestroyed()) {
    dashboardWindow = await createDashboardWindow(config.get());
    dashboardWindow.on('closed', () => {
      dashboardWindow = null;
    });
    return;
  }
  if (dashboardWindow.isMinimized()) dashboardWindow.restore();
  dashboardWindow.show();
  dashboardWindow.focus();
}

/** Re-create the windows after they have all been closed, without re-bootstrapping. */
async function reopenWindows(): Promise<void> {
  const settings = config.get();
  if (!dashboardWindow || dashboardWindow.isDestroyed()) {
    dashboardWindow = await createDashboardWindow(settings);
    dashboardWindow.on('closed', () => {
      dashboardWindow = null;
    });
  }
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    overlayWindow = await createOverlayWindow(settings);
    wireOverlayWindow();
  }
}

/**
 * A content security policy without unsafe-eval, applied to every renderer
 * (FR-086, TC-008).
 *
 * Applied twice on purpose. The response header covers the dev server, and a
 * meta tag in each HTML file covers the packaged app, where renderers load over
 * file:// and header interception is not dependable. Belt and braces on a
 * control that silently does nothing when it fails.
 */
function applyContentSecurityPolicy(): void {
  // Kept identical to the meta tag in each renderer's index.html.
  // `file:` is listed because the packaged app loads renderers over file://,
  // where 'self' alone does not match. It does not weaken the rule that
  // matters: no 'unsafe-eval' and no 'unsafe-inline' for scripts (FR-086).
  const policy = [
    "default-src 'self' file:",
    "script-src 'self' file:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' file: data:",
    "font-src 'self' file: data:",
    "connect-src 'self'",
    "media-src 'self' file:",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'self' blob:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    });
  });

  // The permission handler is installed by the audio host, which is the only
  // component that knows which window may capture (TASK-011).
}

function wireOverlayWindow(): void {
  if (!overlayWindow) return;

  // Push the theme and the consent text as soon as the renderer has loaded.
  // The renderer reports readiness only after the consent card has painted, so
  // the text has to arrive first; replying to overlay:ready with it would
  // deadlock the gate it is supposed to close (ADR-016).
  overlayWindow.webContents.on('did-finish-load', () => {
    const settings = config.get();
    push(overlayWindow?.webContents, 'overlay:theme', settings.theme);
    push(overlayWindow?.webContents, 'overlay:consent', { text: settings.consentReminderText });
  });

  overlayWindow.on('moved', () => {
    if (overlayWindow) saveOverlayPosition(overlayWindow, config);
  });
  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

function registerHotkeys(): void {
  const { hotkeys: bindings } = config.get();

  const interaction = hotkeys.register('toggleInteraction', bindings.toggleInteraction, () =>
    setOverlayInteractive(!overlayInteractive),
  );
  if (!interaction.ok) getLogger().warn('interaction hotkey unavailable', interaction);

  // The trigger does not exist until TASK-030. The binding is held now so the
  // key is reserved and rebinding is testable; the handler becomes real then.
  const pause = hotkeys.register('togglePause', bindings.togglePause, () => {
    getLogger().info('pause hotkey fired before the trigger exists (TASK-030)');
  });
  if (!pause.ok) getLogger().warn('pause hotkey unavailable', pause);
}

/**
 * Apply a theme change to the running overlay (FR-085, ADR-015).
 *
 * Opacity, accent and font size are pushed and applied live. A translucency
 * mode change cannot be: acrylic needs `backgroundMaterial` with
 * `transparent: false`, flat opacity needs `transparent: true`, and Electron
 * fixes both at construction. So the window is rebuilt, keeping its position,
 * monitor and click-through state. "Without a restart" means without restarting
 * the application, not without recreating the window.
 */
async function applyThemeChange(before: Settings, after: Settings): Promise<void> {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;

  if (
    translucencyChangeNeedsRecreate(
      before.theme.overlayTranslucency,
      after.theme.overlayTranslucency,
    )
  ) {
    const [x, y] = overlayWindow.getPosition();
    const wasVisible = overlayWindow.isVisible();
    overlayWindow.destroy();
    overlayWindow = await createOverlayWindow(after);
    wireOverlayWindow();
    if (x !== undefined && y !== undefined) overlayWindow.setPosition(x, y);
    overlayWindow.setIgnoreMouseEvents(!overlayInteractive, { forward: true });
    if (wasVisible) overlayWindow.showInactive();
    return;
  }

  push(overlayWindow.webContents, 'overlay:theme', after.theme);
}

function setOverlayInteractive(interactive: boolean): void {
  overlayInteractive = interactive;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.setIgnoreMouseEvents(!interactive, { forward: true });
  push(overlayWindow.webContents, 'overlay:mode', { interactive, paused: false });
}

/**
 * Warn about degraded capture exclusion once per session, not once per install
 * (NFR-012). A user who dismissed this months ago must not be surprised by a
 * black rectangle in a screen share today.
 */
function reportCaptureFidelity(): void {
  const build = windowsBuildNumber();
  if (process.platform !== 'win32' || hasTrueCaptureExclusion(build)) return;

  const message =
    'This version of Windows cannot hide the overlay from screen capture. ' +
    'The overlay will appear as a black rectangle in screen shares and recordings. ' +
    'Windows 10 build 19041 or later is required for true exclusion.';

  getLogger().warn('capture exclusion degraded', { build });
  push(dashboardWindow?.webContents, 'notice:captureFidelity', { windowsBuild: build, message });
}

function registerIpcHandlers(): void {
  router.handle('config:get', () => config.get());
  router.handle('config:set', async (patch) => {
    const before = config.get();
    const after = config.set(patch);
    await applyThemeChange(before, after);
    return after;
  });

  router.handle('secrets:status', () => secrets.status());
  router.handle('secrets:set', async ({ provider, key }) =>
    secrets.set(provider, key, validateCredential),
  );

  router.handle('hotkey:rebind', ({ action, accelerator }) => {
    const result = hotkeys.rebind(action, accelerator);
    if (!result.ok) return { error: result.error ?? 'Rebinding failed.' };
    config.set({ hotkeys: { ...config.get().hotkeys, [action]: accelerator } });
    return { ok: true as const };
  });

  router.handle('overlay:setInteractive', ({ interactive }) => {
    setOverlayInteractive(interactive);
    return { ok: true as const };
  });

  router.handle('overlay:savePosition', ({ x, y, displayId }) => {
    config.set({ overlayWindow: { x, y, displayId } });
    return { ok: true as const };
  });

  /**
   * Reset Overlay (FR-009, TC-148): the escape hatch for a click-through
   * overlay stranded off-screen with a hotkey another application has taken.
   */
  router.handle('overlay:reset', () => {
    const displays = screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds }));
    const primary = screen.getPrimaryDisplay();
    // Resolve against a cleared position without persisting the cleared state,
    // so a crash between the two writes cannot leave the position blank.
    const asIfFresh = { ...config.get(), overlayWindow: { x: null, y: null, displayId: null } };
    const pos = resolveOverlayPosition(asIfFresh, displays, primary.id);

    if (overlayWindow && !overlayWindow.isDestroyed()) {
      // Show before moving. A window that has never been shown can have its
      // placement re-applied by Windows when it is finally shown, which
      // silently undoes bounds set while it was hidden. That left the overlay
      // exactly where it was and made Reset Overlay look like a no-op.
      if (!overlayWindow.isVisible()) overlayWindow.showInactive();

      const bounds = overlayBoundsFor(pos);
      overlayWindow.setBounds(bounds);
      // setBounds and setPosition take different paths on Windows; the second
      // is the direct move and costs nothing when the first already worked.
      overlayWindow.setPosition(bounds.x, bounds.y);
      overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    }

    setOverlayInteractive(true);
    hotkeys.reregisterAll();
    config.set({ overlayWindow: { x: pos.x, y: pos.y, displayId: pos.displayId } });

    const [appliedX, appliedY] =
      overlayWindow?.isDestroyed() === false ? overlayWindow.getPosition() : [pos.x, pos.y];
    getLogger().info('overlay reset', { requested: pos, applied: { x: appliedX, y: appliedY } });

    return {
      ok: true as const,
      x: appliedX ?? pos.x,
      y: appliedY ?? pos.y,
      displayId: pos.displayId,
    };
  });

  /**
   * The overlay has mounted and rendered its consent card (FR-008, ADR-016).
   *
   * This is the signal the suggestion buffer will gate on. The buffer itself
   * belongs to TASK-032, which is where the messages being buffered first
   * exist, so nothing is held here yet. Keeping unused state now would be
   * speculative; the ordering guarantee it depends on is what Milestone 0 has
   * to get right, and that is on the renderer side.
   */
  router.handle('overlay:ready', () => {
    getLogger().info('overlay reported ready, consent card rendered');
    return { ok: true as const };
  });
}

/** Exported for the acrylic-availability check in the Dashboard. */
export { supportsAcrylic, translucencyChangeNeedsRecreate };
