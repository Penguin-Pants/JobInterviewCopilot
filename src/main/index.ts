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
import { ProviderHealthRegistry } from './ai/health.js';
import { registerAllLlmProviders } from './ai/llm/index.js';
import { registerAllSttProviders } from './ai/stt/index.js';
import { TriggerMachine, type TriggerConfig } from './ai/trigger.js';
import { validateCredential } from './ai/validate.js';
import { ConfigStore } from './config.js';
import { HotkeyManager } from './hotkeys.js';
import { IpcRouter, push } from './ipc/router.js';
import { getLogger, initLogger } from './logger.js';
import { OverlayGate, type GatedMessage } from './overlay-gate.js';
import { RagEngine } from './rag.js';
import { SecretVaultStore } from './secrets.js';
import {
  SessionManager,
  SessionStartRefused,
  deleteSession,
  listSessions,
  readSession,
} from './session.js';
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
import type { CredentialId, Profile, Session, Settings, StreamState } from '../shared/types.js';
import { findLlmProvider } from '../shared/registry/llm.js';
import { findSttModel, findSttProvider } from '../shared/registry/stt.js';

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
let health: ProviderHealthRegistry;
let rag: RagEngine;
let trigger: TriggerMachine;
let overlayGate: OverlayGate;
let sessions: SessionManager;

/**
 * Resolves when crash recovery has finished (`FR-105`, `FR-108`).
 *
 * `session:start` awaits it. Recovery runs in the background so a slow or
 * wedged knowledge base cannot delay the windows, and the IPC handlers are
 * registered before it finishes, so without this gate a session started in that
 * window would have its **live** `.ndjson` treated as an orphan: compacted,
 * deleted, and its lock removed from under it.
 */
let recoveryComplete: Promise<void> = Promise.resolve();

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
      // Tell the supervisor first, so `canStartSession` reflects the worker's
      // view rather than waiting for the first chunk to prove it.
      audio.noteStreamState(source, state as StreamState, error);
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

  // The LLM adapters, the same way (TASK-032). `secrets.peek` rather than a
  // copied key, so a credential replaced mid-session takes effect on the next
  // request and no adapter ever holds one (NFR-003, FR-026).
  registerAllLlmProviders((credentialId) => secrets.peek(credentialId));

  // The overlay readiness gate (FR-008, ADR-016). Declared in Milestone 0 and
  // left empty because the messages it holds did not exist until now.
  overlayGate = new OverlayGate(sendToOverlay);

  // The Session Manager (CMP-08, TASK-040). Sole writer of a session file and
  // sole holder of its handle (ADR-018). Constructing it opens nothing; the
  // crash-recovery pass runs with the knowledge base, once profiles are known.
  sessions = new SessionManager({
    userDataDir: userData,
    onError: (message, detail) => getLogger().warn(message, detail),
  });

  // The trigger (CMP-05, TASK-030). Created here so the pause hotkey has
  // something real to toggle; it stays in IDLE until `session:start` exists
  // (TASK-040), and a firing turn is answered by the generation loop that task
  // owns. Nothing here opens a socket or reads a document.
  trigger = new TriggerMachine({
    config: triggerConfigFrom(config.get()),
    onFire: (turn) => {
      // TASK-040 replaces this with the query, prompt and generation loop. It
      // logs rather than silently discarding, so a turn detected with no
      // consumer is visible instead of looking like a trigger that never fired.
      getLogger().info('turn fired with no session consumer yet (TASK-040)', {
        generationId: turn.generationId,
        words: turn.question.split(/\s+/).length,
      });
    },
    // Entering PAUSED shows the idle card (FR-053). Resuming is pushed by the
    // hotkey handler, so each direction sends exactly one CH-212.
    onOverlayIdle: () => pushOverlayMode(),
  });

  // Health is keyed by credential, so one revoked key is one badge however many
  // capabilities it serves (ADR-017). Bound from settings here and rebound when
  // the user changes a provider, because the binding is what says which
  // credential serves which capability.
  health = new ProviderHealthRegistry(
    (state) => {
      push(dashboardWindow?.webContents, 'state:providers', state);
    },
    (credentialId) => () => probeCredential(credentialId),
  );
  bindHealthFromSettings(config.get());

  installLoopbackHandler();
  installPermissionHandler((contents) => audioHost.owns(contents));

  // The knowledge base engine (CMP-06). Constructing it is cheap and touches no
  // network: the embedding model is only loaded when a document is ingested
  // (ADR-011).
  rag = new RagEngine({
    userDataDir: userData,
    onDocumentProgress: (docId, state, percent) =>
      push(dashboardWindow?.webContents, 'rag:progress', { docId, state, percent }),
    onModelState: (state) => push(dashboardWindow?.webContents, 'model:download', state),
    onError: (message, detail) => getLogger().warn(message, detail),
  });

  hotkeys = new HotkeyManager(globalShortcut);
  router = new IpcRouter(ipcMain);
  registerIpcHandlers();

  const settings = config.get();
  dashboardWindow = await createDashboardWindow(settings);
  wireDashboardWindow();

  // `onCreated` rather than the returned promise, and it is load-bearing.
  // `createOverlayWindow` constructs the window and then awaits its renderer, so
  // assigning from the promise left `overlayWindow` null for the whole of that
  // load, while the Dashboard was already interactive and the window was already
  // in `BrowserWindow.getAllWindows()`. `overlay:reset` arriving in that window
  // failed its `if (overlayWindow)` guard, moved nothing, and reported success.
  // That is TC-148's -30000; delaying this one assignment reproduces it exactly
  // on Linux. The overlay's renderer is the slower of the two on Windows, which
  // is why the runner hit it every time.
  //
  // Wiring inside the callback also puts the `did-finish-load` listener in place
  // before the load it is waiting for, which the old order could not do.
  await createOverlayWindow(settings, (win) => {
    overlayWindow = win;
    wireOverlayWindow();
  });

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
    // A quit during a live session compacts rather than abandoning the
    // transcript. Not awaited, because `will-quit` cannot hold the app open;
    // the recovery pass covers what does not finish (FR-105).
    void sessions.stop();
    trigger.dispose();
    health.dispose();
    void audio.stop();
    void rag.stop();
    hotkeys.disposeAll();
    router.dispose();
    getLogger().close();
  });

  // Recovery is started here, before the first `session:start` can be served,
  // and awaited by that handler rather than by bootstrap.
  // Started last and deliberately not awaited. Reconciling a knowledge base
  // reads every file in every profile's `kb/`, and starting a watcher pulls
  // chokidar in through a dynamic ESM import; neither has anything to do with
  // the windows being ready. Awaiting it here put that work between the windows
  // appearing and the handlers above being registered, so a slow or wedged
  // knowledge base delayed shutdown cleanup and left the app interactive with no
  // `window-all-closed` handler at all.
  recoveryComplete = startKnowledgeBase();
  void recoveryComplete;
}

/**
 * Bring the knowledge base up (CMP-06, FR-077, FR-078, ADR-014).
 *
 * Reconciliation finishes before any watcher starts, which is `rag.start`'s own
 * contract: a watcher running alongside the pass would race it over the same
 * files. Nothing here is allowed to escape, because the caller cannot await it.
 */
async function startKnowledgeBase(): Promise<void> {
  try {
    await ensureActiveProfile();
    await rag.start();
  } catch (err) {
    getLogger().error('the knowledge base failed to start', err);
  }

  // Crash recovery (FR-105, FR-108). Any `.ndjson` left on disk means the
  // process died during a session; each is compacted so it reaches Session
  // History rather than being lost. The same pass clears a stale lock, which is
  // the only place it is cleared, so a killed process cannot block every future
  // session. It needs the profile list, so it runs here rather than earlier.
  try {
    const recovered = await sessions.recover(
      rag.listProfiles().map((p) => ({ id: p.id, name: p.name })),
    );
    if (recovered.length > 0) {
      getLogger().info('recovered sessions from a previous run', { count: recovered.length });
    }
  } catch (err) {
    getLogger().error('session recovery failed', err);
  }

  // The Dashboard has no read-only model channel, and CH-214 only fires on a
  // change, so without this first push a fresh install could not render the
  // "embedding model not downloaded" state TC-161 requires without invoking
  // `model:ensure`, which would start a 90 MB download unprompted on launch.
  push(dashboardWindow?.webContents, 'model:download', rag.getModelState());
}

/** Bring the Dashboard forward, creating it again when it has been closed. */
async function focusOrRecreateDashboard(): Promise<void> {
  if (!dashboardWindow || dashboardWindow.isDestroyed()) {
    dashboardWindow = await createDashboardWindow(config.get());
    wireDashboardWindow();
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
    wireDashboardWindow();
  }
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    // The callback form, for the reason bootstrap uses it: assigning from the
    // returned promise leaves `overlayWindow` null for the whole of the
    // renderer load, so `did-finish-load` fires against a null window and the
    // theme, the consent text and the mode never reach it.
    await createOverlayWindow(settings, (win) => {
      overlayWindow = win;
      wireOverlayWindow();
    });
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

/**
 * A Dashboard that loads mid-session has missed every earlier `CH-201` and has
 * no channel to ask for the current one, so it would render the session as
 * inactive until the next transition. Reachable by closing and reopening it,
 * which the single-instance handler supports.
 */
function wireDashboardWindow(): void {
  if (!dashboardWindow) return;
  dashboardWindow.webContents.on('did-finish-load', () => pushSessionState());
  dashboardWindow.on('closed', () => {
    dashboardWindow = null;
  });
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
    // And its mode. A translucency change rebuilds the window (ADR-015), and a
    // rebuilt renderer starts with no idea whether the trigger is paused, so
    // without this a pause survives the rebuild in the main process while the
    // overlay stops showing the idle card (FR-053).
    pushOverlayMode();
    // A renderer that loads mid-session missed every earlier push and has no
    // channel to ask, so it would render the session as inactive until the next
    // transition. Reachable whenever the overlay is rebuilt (ADR-015).
    pushSessionState();
  });

  overlayWindow.on('moved', () => {
    if (overlayWindow) saveOverlayPosition(overlayWindow, config);
  });
  overlayWindow.on('closed', () => {
    overlayWindow = null;
    // The next overlay has to report ready again before anything is delivered
    // to it. A gate left open against a window that has not painted its consent
    // card would drop the first suggestion of the next session (FR-008).
    overlayGate.noteClosed();
  });
}

function registerHotkeys(): void {
  const { hotkeys: bindings } = config.get();

  const interaction = hotkeys.register('toggleInteraction', bindings.toggleInteraction, () =>
    setOverlayInteractive(!overlayInteractive),
  );
  if (!interaction.ok) getLogger().warn('interaction hotkey unavailable', interaction);

  // Pause and resume the trigger (FR-053, ASM-002). Capture and the STT
  // sockets are deliberately untouched: pausing stops suggestions, not the
  // session.
  const pause = hotkeys.register('togglePause', bindings.togglePause, () => {
    trigger.togglePause();
    // Pausing already pushed the idle card through the trigger's own callback.
    // Pushing again here would send CH-212 twice for one keypress.
    if (!trigger.isPaused) pushOverlayMode();
    // CH-201 carries `paused` too, so the Dashboard shows the same state as
    // the overlay rather than only the overlay knowing.
    pushSessionState();
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

    // Same reason as bootstrap and `reopenWindows`: the window has to be handed
    // over *before* its renderer loads. Assigning from the promise left this
    // path's `did-finish-load` firing against a null `overlayWindow`, so a
    // translucency change produced an overlay that never received its theme,
    // its consent text or its paused state (FR-008, FR-053, FR-085).
    const rebuilt = await createOverlayWindow(after, (win) => {
      overlayWindow = win;
      wireOverlayWindow();
    });
    if (x !== undefined && y !== undefined) rebuilt.setPosition(x, y);
    rebuilt.setIgnoreMouseEvents(!overlayInteractive, { forward: true });
    if (wasVisible) rebuilt.showInactive();
    return;
  }

  push(overlayWindow.webContents, 'overlay:theme', after.theme);
}

function setOverlayInteractive(interactive: boolean): void {
  overlayInteractive = interactive;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.setIgnoreMouseEvents(!interactive, { forward: true });
  pushOverlayMode();
}

/**
 * The overlay's mode (`CH-212`), from the two facts that decide it.
 *
 * `paused` used to be hard-coded false here, which was harmless while the pause
 * hotkey only logged. Now that it pauses the trigger, toggling interaction
 * while paused would have told the overlay it was running and taken the idle
 * card off the screen (FR-053).
 */
function pushOverlayMode(): void {
  push(overlayWindow?.webContents, 'overlay:mode', {
    interactive: overlayInteractive,
    // `trigger` is assigned during bootstrap, before any window exists. The
    // guard covers the recreate path, which can run from a test harness.
    paused: trigger?.isPaused ?? false,
  });
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

/**
 * The trigger's view of the settings (`CMP-05`, FR-050, FR-051, FR-052).
 *
 * `supportsEndpointing` is read off the **registry entry of the selected STT
 * model**, never off the provider id, so a new streaming provider needs no
 * trigger change (FR-037, TC-056). A model that is not in the registry cannot
 * endpoint as far as the trigger is concerned, which falls back to the local
 * timer rather than trusting a signal nothing described (TC-159).
 */
function triggerConfigFrom(settings: Settings): TriggerConfig {
  const model = findSttModel(settings.providers.stt.primary);
  return {
    ...settings.trigger,
    supportsEndpointing: model?.supportsEndpointing ?? false,
    // Zero for every streaming model, so the gap is exactly the user's value.
    // A batch model declares its window and the trigger adds it, because the
    // absence of events between two batches is not silence (FR-050).
    batchIntervalMs: model?.batchIntervalMs ?? 0,
  };
}

/** `CH-201`, from the Session Manager rather than from a second copy of the state. */
function pushSessionState(): void {
  const active = sessions.current;
  const payload = {
    active: active !== null,
    sessionId: active?.id ?? null,
    profileName: active?.profileNameSnapshot ?? null,
    startedAt: active?.startedAt ?? null,
    paused: trigger.isPaused,
  };
  push(dashboardWindow?.webContents, 'state:session', payload);
  push(overlayWindow?.webContents, 'state:session', payload);
}

/** Finds a session by id across every profile's sessions folder (ADR-013). */
async function findSession(sessionId: string): Promise<Session | null> {
  for (const profile of rag.listProfiles()) {
    const found = await readSession(app.getPath('userData'), profile.id, sessionId);
    if (found) return found;
  }
  return null;
}

/** The gate's outlet. One place the three suggestion channels reach a window. */
function sendToOverlay(message: GatedMessage): void {
  push(overlayWindow?.webContents, message.channel, message.payload);
}

/**
 * Maps the chosen providers onto credentials. The registry never reads settings
 * itself, so a provider swap is a rebind rather than a restart.
 */
function bindHealthFromSettings(settings: Settings): void {
  health.bind({
    capability: 'stt',
    primary: credentialFor(settings.providers.stt.primary.providerId),
    backup: settings.providers.stt.backup
      ? credentialFor(settings.providers.stt.backup.providerId)
      : null,
  });
  health.bind({
    capability: 'llm',
    primary: credentialFor(settings.providers.llm.primary.providerId),
    backup: settings.providers.llm.backup
      ? credentialFor(settings.providers.llm.backup.providerId)
      : null,
  });
}

/**
 * Which vault key a provider uses, read from the registries rather than from a
 * table here, so a new provider needs no edit in this file (FR-037).
 */
function credentialFor(providerId: string): CredentialId {
  const descriptor = findSttProvider(providerId) ?? findLlmProvider(providerId);
  if (!descriptor) {
    throw new Error(`"${providerId}" is not in either provider registry.`);
  }
  return descriptor.credentialId;
}

/**
 * The recovery probe: re-validate the credential against its provider. A key
 * that validates is a provider that answered, which is what the probe asks.
 */
async function probeCredential(credentialId: CredentialId): Promise<boolean> {
  const key = secrets.peek(credentialId);
  if (key === undefined) return false;
  const result = await validateCredential(credentialId, key);
  return result.ok;
}

/**
 * Guarantee exactly one active profile (FR-028, ADR-013).
 *
 * A fresh install has none, and `settings.activeProfileId` defaults to the empty
 * string. Every document channel needs a profile to address, so one is created
 * here rather than leaving the Dashboard to discover it has nothing to show.
 * An `activeProfileId` pointing at a profile that has since been deleted is
 * repaired the same way.
 */
async function ensureActiveProfile(): Promise<Profile> {
  const profiles = rag.listProfiles();
  const settings = config.get();
  const active = profiles.find((p) => p.id === settings.activeProfileId);
  if (active) return active;

  // `rag.createProfile` and not `rag.store.create`: the engine's method also
  // starts the `kb/` watcher. Creating the record alone left a profile whose
  // folder nothing watched, so a file dropped into it was never adopted
  // (FR-077). Reachable by deleting the last profile, where this runs again.
  const fallback = profiles[0] ?? (await rag.createProfile('My profile'));
  config.set({ activeProfileId: fallback.id });
  return fallback;
}

/**
 * Which profile a document channel addresses.
 *
 * The payload names it, so a Dashboard showing one profile cannot mutate
 * another's documents by replaying a stale id (FR-069).
 */
function assertProfile(profileId: string): string {
  if (!rag.store.get(profileId)) throw new Error(`Unknown profile ${profileId}.`);
  return profileId;
}

function registerIpcHandlers(): void {
  router.handle('config:get', () => config.get());
  router.handle('config:set', async (patch) => {
    const before = config.get();
    // `activeProfileId` is a plain string in the settings schema, so a Dashboard
    // replaying a cached settings object could name a profile that has since
    // been deleted, and nothing repaired it until the next launch. Only
    // `profile:activate` is supposed to move it, and only to a profile that
    // exists (FR-028).
    if (patch.activeProfileId !== undefined && patch.activeProfileId !== before.activeProfileId) {
      assertProfile(patch.activeProfileId);
    }
    const after = config.set(patch);
    await applyThemeChange(before, after);
    bindHealthFromSettings(after);
    // The trigger holds its own copy of the gap and the guard, so a settings
    // change has to reach it. Applying at the next armed timer rather than
    // rewriting one in flight is the machine's own rule (FR-050).
    trigger.setConfig(triggerConfigFrom(after));
    return after;
  });

  router.handle('secrets:status', () => secrets.status());
  router.handle('secrets:set', async ({ provider, key }) => {
    const result = await secrets.set(provider, key, validateCredential);
    // A saved, validated key is the only thing that clears CONFIG_REQUIRED for
    // that credential (FR-026, ADR-024). Checked on the result, because a key
    // that failed validation was never saved and changes nothing.
    if (!('error' in result)) health.noteKeySaved(provider);
    return result;
  });

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

    // No overlay is a failure, not a success. Skipping the move and still
    // returning `ok` is what let TC-148 fail silently for two rounds: the
    // Dashboard rendered "Overlay reset" over a window that had not moved. The
    // throw reaches the router, which returns a typed error, and the Dashboard
    // renders its existing failure state (FR-009).
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      throw new Error('There is no overlay window to reset.');
    }

    // Show before moving. A window that has never been shown can have its
    // placement re-applied by Windows when it is finally shown, which silently
    // undoes bounds set while it was hidden. That left the overlay exactly
    // where it was and made Reset Overlay look like a no-op.
    if (!overlayWindow.isVisible()) overlayWindow.showInactive();

    const bounds = overlayBoundsFor(pos);
    overlayWindow.setBounds(bounds);
    // setBounds and setPosition take different paths on Windows; the second is
    // the direct move and costs nothing when the first already worked.
    overlayWindow.setPosition(bounds.x, bounds.y);
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');

    setOverlayInteractive(true);
    hotkeys.reregisterAll();
    config.set({ overlayWindow: { x: pos.x, y: pos.y, displayId: pos.displayId } });

    const [appliedX, appliedY] = overlayWindow.getPosition();
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
   * This closes the readiness gate Milestone 0 declared and left empty. Until
   * it arrives, `suggestion:begin`, `suggestion:line` and `suggestion:end` are
   * held rather than dropped, so the first question of a session is not the one
   * the user never sees. The buffer holds one generation; see
   * `src/main/overlay-gate.ts`.
   */
  router.handle('overlay:ready', () => {
    getLogger().info('overlay reported ready, consent card rendered', {
      buffered: overlayGate.pending,
    });
    overlayGate.noteReady();
    return { ok: true as const };
  });

  /* ---- Sessions (CMP-08, TASK-040) ---- */

  /**
   * Start a session (`CH-112`, FR-088, ADR-013).
   *
   * A session never starts implicitly. Each refusal names which of four things
   * to go and fix, rather than reporting a single "could not start" (TC-104).
   */
  router.handle('session:start', async () => {
    const settings = config.get();
    const profile = rag.store.get(settings.activeProfileId);
    const keys = secrets.status();

    // Recovery must finish first, or it would treat this session's live
    // `.ndjson` as an orphan and delete it out from under the writer.
    await recoveryComplete;

    try {
      const active = await sessions.start({
        profile: profile ? { id: profile.id, name: profile.name } : null,
        sttKeyPresent: keys[credentialFor(settings.providers.stt.primary.providerId)],
        llmKeyPresent: keys[credentialFor(settings.providers.llm.primary.providerId)],
      });

      // The trigger leaves IDLE only here. Audio capture and the STT sessions
      // are TASK-040's remaining half and are not started yet, so the machine
      // is listening to a stream that does not exist; it fires nothing until it
      // does, rather than being stubbed into looking live.
      trigger.start();
      pushSessionState();
      return { sessionId: active.id };
    } catch (err) {
      // A refusal is an answer, not a failure. Thrown, it would reach the
      // router, which replaces every thrown error with one generic message, so
      // all four refusals would look alike and TC-104's "distinct, named
      // reason" would hold only inside the manager. It is returned instead.
      if (err instanceof SessionStartRefused) {
        getLogger().info('session start refused', { reason: err.reason });
        return { refused: err.reason, message: err.message };
      }
      throw err;
    }
  });

  /** Stop cleanly (`CH-113`): the transcript compacts and the lock is released. */
  router.handle('session:stop', async () => {
    const active = sessions.current;
    if (!active) throw new Error('No session is running.');

    // The trigger stops first, so an in-flight generation is aborted before the
    // writer closes and cannot append to a handle that has gone.
    trigger.stop();
    await sessions.stop();
    pushSessionState();
    return { sessionId: active.id };
  });

  router.handle('session:list', async ({ profileId }) =>
    listSessions(app.getPath('userData'), assertProfile(profileId)),
  );

  /**
   * `CH-115` and `CH-116` name a session but not its profile, and a session
   * belongs to exactly one profile's folder (ADR-013). The profile is found by
   * asking each one, which is a directory read per profile and keeps the
   * channel's payload as the contract documents it.
   */
  router.handle('session:read', async ({ sessionId }) => {
    const found = await findSession(sessionId);
    if (!found) throw new Error(`Unknown session ${sessionId}.`);
    return found;
  });

  router.handle('session:delete', async ({ sessionId }) => {
    if (sessions.current?.id === sessionId) {
      throw new Error('That session is still running. Stop it before deleting it.');
    }
    for (const profile of rag.listProfiles()) {
      await deleteSession(app.getPath('userData'), profile.id, sessionId);
    }
    return { ok: true as const };
  });

  /* ---- Profiles and the knowledge base (CMP-06, TASK-020 to TASK-025) ---- */

  router.handle('profile:list', () => rag.listProfiles());

  router.handle('profile:create', async ({ name }) => rag.createProfile(name));

  /**
   * Delete a profile and everything belonging to it (FR-028, FR-069).
   *
   * Deleting the active profile activates another, creating a default when none
   * remains, so the app is never left with no profile to address.
   */
  router.handle('profile:delete', async ({ id }) => {
    assertProfile(id);
    // The live transcript is written inside this folder. Removing it would
    // unlink the open `.ndjson`, leave the lock behind and make a clean stop
    // impossible, which loses the session that is being recorded right now
    // (FR-101, ADR-013).
    if (sessions.current?.profileId === id) {
      throw new Error('A session is running in this profile. Stop it before deleting the profile.');
    }
    await rag.deleteProfile(id);
    if (config.get().activeProfileId === id) await ensureActiveProfile();
    return { ok: true as const };
  });

  router.handle('profile:activate', ({ id }) => {
    assertProfile(id);
    config.set({ activeProfileId: id });
    return { ok: true as const };
  });

  router.handle('doc:import', async ({ profileId, paths }) =>
    rag.importDocuments(assertProfile(profileId), paths),
  );

  router.handle('doc:setType', async ({ docId, profileId, docType }) => {
    const record = await rag.setDocType(assertProfile(profileId), docId, docType);
    if (!record) throw new Error(`Unknown document ${docId}.`);
    return record;
  });

  router.handle('doc:retry', async ({ docId, profileId }) => {
    const record = await rag.retryDocument(assertProfile(profileId), docId);
    if (!record) throw new Error(`Unknown document ${docId}.`);
    return record;
  });

  router.handle('doc:delete', async ({ docId, profileId }) => {
    await rag.deleteDocument(assertProfile(profileId), docId);
    return { ok: true as const };
  });

  /**
   * Download the embedding model, or say why it cannot be (ADR-011, ADR-026).
   *
   * Also the Dashboard's retry action on the "not downloaded" state. Progress
   * reaches the renderer on CH-214 through the engine's own callback, so this
   * handler only reports the outcome.
   */
  router.handle('model:ensure', async () => {
    const state = await rag.ensureModelReady({ userInitiated: true });
    // Documents that arrived while the model was missing are left `pending`
    // rather than `error` (ADR-011). Nothing else re-visits them until the next
    // launch, so the retry that finally produces a model is also what unblocks
    // them; without this the user downloads the model and their documents just
    // sit there.
    if (state.kind === 'ready') {
      for (const profile of rag.listProfiles()) await rag.reconcile(profile.id);
    }
    return state;
  });
}

/** Exported for the acrylic-availability check in the Dashboard. */
export { supportsAcrylic, translucencyChangeNeedsRecreate };
