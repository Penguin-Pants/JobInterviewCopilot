import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  safeStorage,
  screen,
  session,
  type OpenDialogOptions,
  type WebContents,
} from 'electron';
import { AudioSupervisor } from './audio.js';
import { throttleWrites } from './write-throttle.js';
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
import { CostMeter } from './cost.js';
import { HotkeyManager } from './hotkeys.js';
import { IpcRouter, push } from './ipc/router.js';
import { LiveSessionLoop } from './live.js';
import { getLogger, initLogger } from './logger.js';
import { OverlayGate, type GatedMessage } from './overlay-gate.js';
import { RagEngine, SUPPORTED_EXTENSIONS } from './rag.js';
import { installGlobalHandlers, useAppOwnedTempDir } from './resilience.js';
import { SecretVaultStore } from './secrets.js';
import { SessionNoticeHolder } from './session-notice.js';
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
  OVERLAY_SIZE,
  resolveOverlayPosition,
  saveOverlayBounds,
  supportsAcrylic,
  translucencyChangeNeedsRecreate,
  windowsBuildNumber,
} from './windows.js';
import type {
  CredentialId,
  Profile,
  ProviderChoice,
  Session,
  Settings,
  StreamState,
  ValidationResult,
} from '../shared/types.js';
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
let cost: CostMeter;
let live: LiveSessionLoop;

/**
 * The fault standing against the live session (`CH-217`, NFR-008, TASK-050).
 *
 * Constructed at module scope rather than in `bootstrap`, alongside the windows
 * it outlives: a Dashboard closed and reopened mid-session must get its warning
 * back, and holding it anywhere the window owns would lose it with the window.
 */
const sessionNotices = new SessionNoticeHolder();

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

/**
 * Resolves once the profile list is real, which is not the same moment as the
 * app being interactive (FR-027, FR-028, TASK-042).
 *
 * `startKnowledgeBase` is deliberately not awaited by bootstrap, so the
 * Dashboard's renderer loads alongside it. Its first `profile:list` could
 * therefore be answered **before** `ensureActiveProfile` had created the
 * default profile, and it got `[]` with `activeProfileId` still empty. Nothing
 * pushes a profile list, so that empty answer stood for the whole session: a
 * fresh install showed "no profile" and an empty Company Profiles section over
 * a profile that existed.
 *
 * `profile:list` waits on this and nothing else. Reconciliation reads every
 * file in every `kb/` and only changes document *states*, which arrive on
 * `CH-213`, so making the list wait for it as well would delay the first paint
 * for no gain.
 *
 * Created here at module scope, not inside `bootstrap`. The windows are created
 * before the knowledge base is started, so a promise assigned in bootstrap was
 * still the resolved placeholder when the Dashboard's first `profile:list`
 * arrived: the gate existed and the race went through it anyway.
 *
 * The wait is bounded. A gate that is never released turns a degraded start
 * into an invoke that never settles: the router has no timeout and neither does
 * the renderer, so Company Profiles would render nothing, forever, with no
 * error to show. An answer that may be incomplete beats no answer at all, so
 * the deadline reports what exists rather than waiting on what may not come.
 */
let markProfilesReady: () => void = () => undefined;
const profilesReady: Promise<void> = new Promise<void>((resolve) => {
  markProfilesReady = resolve;
});

const PROFILES_READY_DEADLINE_MS = 10_000;

async function profilesReadyWithin(ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      getLogger().warn('the profile list was requested before the profiles were ready', {
        waitedMs: ms,
      });
      resolve();
    }, ms);
  });
  try {
    await Promise.race([profilesReady, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let dashboardWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let overlayInteractive = false;

/**
 * Whether an undismissed consent reminder is on screen (FR-006, FR-083).
 *
 * The overlay is click-through by default, which means the operating system
 * passes every click straight through it to whatever is behind. That is right
 * for a teleprompter and wrong for the one piece of overlay UI that has to be
 * clicked: the reminder's dismiss button received no click at all, so the
 * reminder could not be dismissed and sat over the user's meeting for the whole
 * session. The hotkey was the only way out and the card does not mention it.
 *
 * So click-through is suspended while the reminder is up, and restored to
 * whatever the user had chosen the moment it is dismissed. This is deliberately
 * not the same flag as `overlayInteractive`: that one is the user's choice and
 * has to survive the reminder, and it also turns on the drag region and the
 * text-size control, neither of which belongs on screen unasked.
 */
let consentReminderPending = false;

/**
 * Whether the pointer is over one of the overlay's own controls (FR-006,
 * FR-081, FR-083, CH-128).
 *
 * A `BrowserWindow` is a rectangle, so making one control clickable makes the
 * whole overlay clickable, and clicks meant for the application behind every
 * other part of it are intercepted. `FR-006` says the consent reminder must not
 * block interaction with other applications, and the same reasoning covers the
 * resize grip. So the window follows the pointer: clickable over a control,
 * click-through everywhere else.
 *
 * It starts `false`, so a click-through overlay is click-through until the
 * renderer says the pointer has reached something. The one exception is a live
 * consent reminder, which sets it `true` (see `setConsentReminderPending`): a
 * renderer that never reports then leaves the dismiss button working rather
 * than dead, which is the bug this whole change exists to fix. Being briefly
 * too clickable is a failure this can have; an undismissable reminder is not.
 */
let pointerOverControls = false;

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
  // Released on the failure path too. `startKnowledgeBase` is the only caller
  // of `markProfilesReady`, and it runs on the last line of `bootstrap`, so a
  // bootstrap that threw earlier left every `profile:list` awaiting a promise
  // nothing would ever settle. The old behavior on that path was an empty list:
  // degraded, but the app still rendered.
  void bootstrap().catch((err) => {
    getLogger().error('bootstrap failed', err);
    markProfilesReady();
  });
}

async function bootstrap(): Promise<void> {
  const userData = app.getPath('userData');
  initLogger({ dir: join(userData, 'logs'), console: !app.isPackaged });

  // A live session must survive a stray rejection (NFR-009, TASK-050).
  installGlobalHandlers({ onFault: (kind, value) => getLogger().error(kind, value) });

  // Before anything that could spool a request body. Every temporary file a
  // dependency writes now lands somewhere the app owns, which is what lets
  // TC-137 assert the place is empty at session end (NFR-002, ADR-019).
  useAppOwnedTempDir(userData);

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
    // Straight to the live loop, which pushes it to its stream's provider
    // session and releases it in the same turn. Outside a session the loop
    // holds no stream and drops the chunk rather than queueing it: a queue with
    // no consumer is the unbounded retention ADR-027 exists to prevent.
    onChunk: (chunk) => live.handleChunk(chunk),
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

  // The Cost Meter (CMP-09, TASK-041). It holds usage in memory and hands it to
  // the Session Manager on every tick, which is why the hand-over and CH-204
  // share one callback: the number the Dashboard shows and the number that
  // reaches the transcript are then the same number by construction, not by two
  // code paths agreeing (ADR-018, FR-103).
  cost = new CostMeter({
    thresholds: config.get().thresholds,
    onUsage: (snapshot) => {
      const { elapsedSeconds, ...record } = snapshot;
      sessions.noteUsage(record);
      push(dashboardWindow?.webContents, 'state:usage', { ...record, elapsedSeconds });
    },
    onWarning: (warning) => {
      // A warning is told, never acted on. Nothing here stops the session
      // (FR-103); the user decides what a threshold means mid-interview.
      getLogger().info('usage threshold crossed', warning);
      push(dashboardWindow?.webContents, 'usage:warning', warning);
    },
  });

  // The trigger (CMP-05, TASK-030). Created here so the pause hotkey has
  // something real to toggle; it stays in IDLE until `session:start` exists
  // (TASK-040), and a firing turn is answered by the generation loop that task
  // owns. Nothing here opens a socket or reads a document.
  trigger = new TriggerMachine({
    config: triggerConfigFrom(config.get()),
    // Answered by the live loop (CMP-15, TASK-044): retrieval, then generation,
    // then the overlay gate. Routed through a closure because the loop is
    // constructed after the machine it drives.
    onFire: (turn) => live.onFire(turn),
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

  // The live session loop (CMP-15, TASK-044, ADR-035). Everything it drives
  // already exists; this is the join, and it is the last thing constructed
  // because it holds a reference to all of them. No Electron reaches it: the
  // two windows it affects are addressed through the callbacks below.
  live = new LiveSessionLoop({
    audio,
    trigger,
    sessions,
    cost,
    health,
    settings: () => config.get(),
    retrieve: (profileId, question, k) => rag.query(profileId, question, k),
    keyFor: (providerId) => secrets.peek(credentialFor(providerId)),
    onTranscript: (event) => push(dashboardWindow?.webContents, 'transcript:live', event),
    // Through the gate, never straight at the window: the first suggestion of a
    // session is the one an overlay that has not painted its consent card would
    // otherwise drop (FR-008, ADR-016).
    onSuggestion: (message) => overlayGate.send(message),
    // The model that is actually serving decides the trigger's endpointing and
    // batch window, because health can put the session on the backup and the
    // two models can disagree about both.
    onSttChoice: (choice) => trigger.setConfig(triggerConfigFrom(config.get(), choice)),
    // Logged and shown. Every fault CMP-15 survives used to reach main.log and
    // stop there, which left the one that matters most invisible: a session
    // that starts with no usable speech-to-text model runs, records and bills
    // while transcribing nothing. NFR-008 requires a session start with no
    // network to warn, and a log file the user will never open is not a
    // warning (CH-217, TASK-050, TC-132).
    //
    // The detail stays in the log. It is a provider error object, and the
    // renderer has no use for one it cannot act on (FR-034, NFR-003).
    onError: (message, detail) => {
      getLogger().error(message, detail);
      // Retained as well as pushed, so a Dashboard closed and reopened during
      // the session gets it back (CH-217, TC-132).
      const notice = sessionNotices.note(sessions.current?.id, message);
      if (notice) push(dashboardWindow?.webContents, 'notice:session', notice);
    },
    onInfo: (message, detail) => getLogger().info(message, detail),
  });

  hotkeys = new HotkeyManager(globalShortcut);
  router = new IpcRouter(ipcMain);
  registerIpcHandlers();

  const settings = config.get();
  // The callback form, for the reason `createOverlayWindow` uses it: `loadFile`
  // resolves from inside `did-finish-load`, so wiring after the await attaches
  // every replay listener to an event that has already fired (TASK-043).
  await createDashboardWindow(settings, (win) => {
    dashboardWindow = win;
    wireDashboardWindow();
  });

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

  // The stored interaction mode, applied to the window just built (FR-083).
  // `createOverlayWindow` always starts a window click-through, because that is
  // the shipped default; a user who chose a solid overlay last time would
  // otherwise get a click-through one on every launch and have to press the
  // hotkey again. Not persisted, because nothing was chosen here.
  //
  // Read afresh rather than from the `settings` snapshot above. The Dashboard
  // and the IPC handlers exist by now and the overlay's renderer load is
  // awaited, so a toggle during that window would be persisted and applied and
  // then overwritten here by a value captured before it happened: the checkbox
  // would show the new mode over a window running the old one.
  setOverlayInteractive(!config.get().overlayWindow.clickThrough);

  registerHotkeys();

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
    // The meter is stopped first: it clears its interval and hands over the
    // final record, so a quit during a session compacts with the usage it
    // accounted rather than with the last tick's, or with none at all.
    // The loop is released first, for the same reason the stop handler releases
    // it first: it is what can still append. `dispose` rather than `stop`,
    // because `will-quit` cannot hold the app open to await a teardown.
    /**
     * A coalesced geometry or text-size write is committed, not dropped
     * (FR-081, FR-093, CH-126, CH-127).
     *
     * Both writers are leading-edge with a trailing commit, so the value from
     * the middle of a drag lands at once and the settled one lands when the
     * window closes 200 ms later. A quit inside that window left the settled
     * value unwritten and the app reopened at a size the user passed through on
     * the way to the one they chose. Measured on the Windows runner: an overlay
     * dragged to 673 by 453 reopened at 483 by 308, the second frame of the
     * drag. Flushed first, because `router.dispose` below takes the channels
     * away and `config.set` is synchronous, so this costs one file write.
     */
    overlaySizeWrites.flush();
    overlayFontSizeWrites.flush();

    live.dispose();
    sessions.noteUsage(cost.stop());
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
    // Released here, not at the end: the list is complete once the profiles
    // exist, and `rag.start()` reconciles every document behind it.
    markProfilesReady();
    await rag.start();
  } catch (err) {
    getLogger().error('the knowledge base failed to start', err);
  } finally {
    // Released again in case `ensureActiveProfile` itself threw. A Dashboard
    // waiting on a promise that never settles is worse than one showing an
    // empty list, because it never renders the section at all. `resolve` is
    // idempotent, so the common path is unaffected.
    markProfilesReady();
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
      // Recovery compacts an orphan `.ndjson` into a session file *after* the
      // Dashboard has already listed that profile's history, and it changes
      // neither the profile list nor the session state, so nothing told the
      // Dashboard to look again: a recovered interview stayed invisible until
      // the window was reloaded. The state push is what Session History
      // re-lists on (FR-105, FR-108).
      pushSessionState();
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
    await createDashboardWindow(config.get(), (win) => {
      dashboardWindow = win;
      wireDashboardWindow();
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
    await createDashboardWindow(settings, (win) => {
      dashboardWindow = win;
      wireDashboardWindow();
    });
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
  /**
   * Replay the one-shot state to every Dashboard that loads (TASK-042).
   *
   * The Dashboard can be closed and reopened (`focusOrRecreateDashboard`), and
   * a reopened one has missed every earlier push with no channel to ask. The
   * model state is the one that matters most: `CH-214` fires only on a change
   * and the initial push happens once at the end of bootstrap, so a rebuilt
   * Dashboard rendered neither the "not downloaded" state nor its retry button,
   * which is the only way back when a download is `unavailable` and documents
   * are waiting on it (ADR-026).
   */
  dashboardWindow.webContents.on('did-finish-load', () => {
    pushSessionState();
    push(dashboardWindow?.webContents, 'model:download', rag.getModelState());
    push(dashboardWindow?.webContents, 'state:providers', health.snapshot());
    // Both notices describe the machine rather than a moment, so a Dashboard
    // that was closed and reopened needs them again: `FR-089`'s acrylic gate
    // reads `CH-216`, and `NFR-012`'s warning was pushed once at bootstrap and
    // was therefore missing from every reopened window.
    reportPlatform(dashboardWindow?.webContents);
    reportCaptureFidelity(dashboardWindow?.webContents);
    // And the fault standing against the session now running. Without this a
    // Dashboard reopened mid-session renders it as active with no warning
    // beside it, which is the silent failure CH-217 exists to end (NFR-008).
    const notice = sessionNotices.noticeFor(sessions.current?.id);
    if (notice) push(dashboardWindow?.webContents, 'notice:session', notice);
  });
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
    // What the machine can do, and the capture warning `NFR-012` puts beside
    // the consent reminder. Both are sent before the renderer reports ready,
    // for the same reason the consent text is: the card the warning belongs to
    // has to be able to exist by the time readiness is claimed (ADR-016).
    reportPlatform(overlayWindow?.webContents);
    reportCaptureFidelity(overlayWindow?.webContents);
  });

  /**
   * A document reload closes the gate as surely as the window closing does
   * (FR-008, ADR-016).
   *
   * `closed` fires when the **window** goes away. It does not fire when the
   * document is replaced under a window that stays, and the gate's invariant is
   * about the document: `ready` means *this renderer* has painted the consent
   * reminder. A new document reaches `overlay:ready` two animation frames after
   * it mounts, and a gate still holding the old document's answer delivers into
   * that interval: the messages reach a page with no subscription, `delivered`
   * advances past them, and the begin is then never replayed, so the lines that
   * follow arrive with no card to render them on.
   *
   * Nothing in this app reloads the overlay today, which is why this is an
   * invariant repaired rather than a bug reproduced. A renderer that crashes, a
   * reload from tooling, and `TC-115`, which reloads the overlay to pick up an
   * emulated `prefers-reduced-motion`, all take the same path.
   *
   * `noteClosed` is exactly the right call: it keeps the card and resets only
   * how much of it this renderer has been sent, so a generation streaming
   * across the reload is replayed in full to the new document (ADR-015).
   */
  overlayWindow.webContents.on('did-start-loading', () => {
    overlayGate.noteClosed();
  });

  overlayWindow.on('moved', () => {
    if (overlayWindow) saveOverlayBounds(overlayWindow, config);
  });
  /**
   * A native resize is persisted like a move (FR-081, FR-082).
   *
   * `resized` rather than `resize`: the first fires once when the drag ends,
   * the second fires for every frame of it, and each one is a synchronous
   * settings write on the process running the live audio loop.
   */
  overlayWindow.on('resized', () => {
    if (overlayWindow) saveOverlayBounds(overlayWindow, config);
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

  // Persisted: the hotkey is the user choosing how the overlay should behave,
  // so the next launch opens the way they left it (FR-083, FR-084).
  const interaction = hotkeys.register('toggleInteraction', bindings.toggleInteraction, () =>
    setOverlayInteractive(!overlayInteractive, { persist: true }),
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
    // Through the one applier, so a rebuild during a live consent reminder does
    // not re-arm click-through over a button that still has to be clicked.
    applyOverlayClickThrough();
    if (wasVisible) rebuilt.showInactive();
    return;
  }

  push(overlayWindow.webContents, 'overlay:theme', after.theme);
}

/**
 * Set the overlay's interaction mode (FR-083, FR-084).
 *
 * `persist` writes the choice to settings, so the next launch opens the way the
 * user left it. The hotkey and the Dashboard toggle both persist, because both
 * are the user saying which behavior they want. Reset Overlay does not: it
 * forces the overlay reachable to rescue a stranded window (`FR-009`), and a
 * rescue must not silently change a preference.
 */
function setOverlayInteractive(interactive: boolean, { persist = false } = {}): void {
  overlayInteractive = interactive;
  // Applied before the write, and never conditional on it. `config.set` can
  // throw on a file that is momentarily unwritable, and persisting first left
  // `overlayInteractive` already flipped with the window still in the old mode:
  // the flag and the window then disagreed, so the next press toggled from the
  // wrong state and looked like it had done nothing. A preference that failed
  // to save is a small loss; a mode toggle that does not toggle is not.
  applyOverlayClickThrough();
  pushOverlayMode();
  if (!persist) return;

  try {
    const stored = config.get().overlayWindow;
    if (stored.clickThrough === interactive) {
      config.set({ overlayWindow: { ...stored, clickThrough: !interactive } });
    }
  } catch (err) {
    getLogger().warn('could not persist the overlay interaction mode', {
      error: (err as Error).message,
    });
    return;
  }

  // The Dashboard reads this from settings, and it reloads them on its own
  // actions and on focus. The hotkey is neither: pressed while the Dashboard
  // has focus, it changed the stored value under a checkbox that went on
  // showing the old one, and the next click then re-applied the mode that was
  // already active instead of toggling. `CH-212` is what tells it to look
  // again (FR-083, FR-084).
  push(dashboardWindow?.webContents, 'overlay:mode', {
    interactive: overlayInteractive,
    paused: trigger?.isPaused ?? false,
  });
}

/**
 * Apply click-through from the two facts that decide it (FR-006, FR-083).
 *
 * The single place that calls `setIgnoreMouseEvents`, so the reminder's
 * suspension cannot be undone by a later caller that only knows about the
 * user's toggle. The window rebuild on a translucency change went through such
 * a caller and would have re-armed click-through over a live reminder.
 */
function applyOverlayClickThrough(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const clickable = overlayInteractive || pointerOverControls;
  // `forward: true` in both directions, and load-bearing in the ignoring one:
  // it is what keeps mouse **move** events reaching the renderer while the
  // window passes clicks through, which is how `CH-128` can report the pointer
  // crossing back onto the card and make the window clickable again.
  overlayWindow.setIgnoreMouseEvents(!clickable, { forward: true });
}

/**
 * The consent reminder went up, or came down (FR-006).
 *
 * Going up is reported by `overlay:ready`, which the renderer sends only once
 * the card has painted, and it is sent again at every session boundary because
 * `FR-006` is about every live session. Coming down is `consent:dismiss`.
 */
function setConsentReminderPending(pending: boolean): void {
  if (consentReminderPending === pending) return;
  consentReminderPending = pending;
  // Each reminder starts clickable, and hands click-through back when it goes.
  // A stale "the pointer is elsewhere" would open the next reminder with its
  // dismiss button already dead, and a stale "the pointer is on the card" would
  // leave the overlay solid after the card had gone; the renderer corrects
  // neither until the pointer moves (CH-128).
  pointerOverControls = pending;
  applyOverlayClickThrough();
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
 *
 * It goes to **both** windows (`CH-215`, TASK-043). `NFR-012` says the warning
 * belongs "alongside the consent reminder", which is the overlay, and the IPC
 * table said `overlay` from the day the channel was written down; the code
 * pushed it to the Dashboard only and the overlay preload did not allow it, so
 * the one window the sentence is about could never show it. The Dashboard keeps
 * it because `FR-089` reads the build number there and because the overlay card
 * is dismissible, so the Dashboard is where it can still be read afterwards.
 *
 * Sent to **the window that just loaded**, rather than to both from either
 * handler, so a window is not told twice for one load. Both windows can be
 * rebuilt: the overlay on a translucency change (ADR-015), the Dashboard by
 * being closed and reopened, and a one-shot push at bootstrap left every
 * rebuilt window with no warning at all.
 *
 * `NFR-012`'s "once per session" is about what the user is shown, and the
 * overlay shows this inside the consent card, which is itself re-shown at each
 * session boundary and at nothing else. The log line is emitted once per
 * process, because a rebuilt window is not a new fact about the machine.
 */
let captureFidelityLogged = false;

function reportCaptureFidelity(target: WebContents | undefined): void {
  const build = windowsBuildNumber();
  if (process.platform !== 'win32' || hasTrueCaptureExclusion(build)) return;

  const message =
    'This version of Windows cannot hide the overlay from screen capture. ' +
    'The overlay will appear as a black rectangle in screen shares and recordings. ' +
    'Windows 10 build 19041 or later is required for true exclusion.';

  if (!captureFidelityLogged) {
    captureFidelityLogged = true;
    getLogger().warn('capture exclusion degraded', { build });
  }
  push(target, 'notice:captureFidelity', { windowsBuild: build, message });
}

/**
 * Tell both renderers what this machine can do (`CH-216`, FR-089, ADR-038).
 *
 * `FR-089` requires the Dashboard to disable the acrylic option on Windows 10
 * with an explanatory note, and until this channel existed no push carried a
 * build number there unless capture fidelity was **also** degraded. A Windows
 * 10 machine on build 19045 has exact capture exclusion and no acrylic, so it
 * received nothing and the option stayed enabled over a mode the window cannot
 * render.
 *
 * The overlay receives it too, for a different reason: `overlayWindowOptions`
 * silently builds a transparent window when acrylic is asked for on a build
 * that cannot render it, so the stored translucency and the window that exists
 * can disagree. The renderer resolves the effective mode from this, and its
 * contrast depends on which one it really is (FR-093).
 *
 * Off Windows the build number is 0 and acrylic is unsupported, which is the
 * truth for the development container and keeps every gate falling closed.
 *
 * Sent to the window that just loaded, for the reason above: both windows are
 * rebuildable and each one asks on its own load.
 */
function reportPlatform(target: WebContents | undefined): void {
  const build = windowsBuildNumber();
  push(target, 'notice:platform', {
    windowsBuild: build,
    acrylicSupported: supportsAcrylic(build),
  });
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
function triggerConfigFrom(settings: Settings, serving?: ProviderChoice | null): TriggerConfig {
  // The model that is **serving**, not the configured primary. Health can move
  // a session to the backup, and the two models can disagree about native
  // endpointing and about the batch window, so reading the primary would give
  // the trigger a capability the open socket does not have (TASK-030 follow-up,
  // closed by TASK-044).
  const model = findSttModel(serving ?? settings.providers.stt.primary);
  return {
    ...settings.trigger,
    supportsEndpointing: model?.supportsEndpointing ?? false,
    // Zero for every streaming model, so the gap is exactly the user's value.
    // A batch model declares its window and the trigger adds it, because the
    // absence of events between two batches is not silence (FR-050).
    batchIntervalMs: model?.batchIntervalMs ?? 0,
  };
}

/**
 * How often `CH-126` may reach the settings file, in milliseconds.
 *
 * Above a human's repeat-click rate, so a real adjustment is never delayed,
 * and low enough that a hostile renderer buys five writes a second rather than
 * as many as it can issue.
 */
const FONT_SIZE_WRITE_INTERVAL_MS = 200;

/** The same bound, for the same reason, on the resize grip's writes (CH-127). */
const OVERLAY_SIZE_WRITE_INTERVAL_MS = 200;

/**
 * The throttled writer behind `overlay:setFontSize` (FR-093, CH-126).
 *
 * The commit is the whole of what a write does: store the size and push the
 * theme back, so the overlay renders the stored value rather than its own
 * optimistic one, which is what makes the Dashboard control and the in-overlay
 * one the same setting rather than two.
 */
const overlayFontSizeWrites = throttleWrites<number>((px) => {
  const theme = config.get().theme;
  if (px === theme.overlayFontSizePx) return;
  const after = config.set({ theme: { ...theme, overlayFontSizePx: px } });
  push(overlayWindow?.webContents, 'overlay:theme', after.theme);
}, FONT_SIZE_WRITE_INTERVAL_MS);

/**
 * The throttled writer behind `overlay:setSize` (FR-081, CH-127).
 *
 * The grip sends a size per pointer move, so this is rate limited for exactly
 * the reason `CH-126` is: each commit is a synchronous settings write on the
 * event loop carrying the live audio and STT loop.
 *
 * The **window** is resized on every request rather than only on commit, in the
 * handler below. Dragging a grip has to track the pointer, and a resize that
 * moved in 200 ms steps would not. Only the persistence is coalesced.
 */
const overlaySizeWrites = throttleWrites<{ width: number; height: number }>(({ width, height }) => {
  // The requested size, not `getBounds()`. The trailing commit can run from the
  // quit path, by which point the window may already be gone, and a commit that
  // read the window would then write nothing and lose the drag. The value is
  // already clamped by `CH-127`'s schema, and the position is written by the
  // `moved` and `resized` handlers rather than from here.
  config.set({ overlayWindow: { ...config.get().overlayWindow, width, height } });
}, OVERLAY_SIZE_WRITE_INTERVAL_MS);

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

/**
 * `FR-026`: an inline pass or fail within 10 seconds, every time.
 *
 * The adapters validate over the network and none of them carries its own
 * deadline, so a wedged connection left the Dashboard with a spinner and no
 * answer. A timeout in the renderer could not close that: the call would still
 * be in flight and could still save a key the user had been told was refused.
 * The deadline therefore sits here, in front of the save, so a validation that
 * has not answered in time saves nothing and reports a named failure.
 */
const KEY_VALIDATION_DEADLINE_MS = 10_000;

async function validateWithinDeadline(
  credentialId: CredentialId,
  key: string,
): Promise<ValidationResult> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<ValidationResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          ok: false,
          reason:
            `The ${credentialId} check did not answer within ` +
            `${KEY_VALIDATION_DEADLINE_MS / 1000} seconds. The key is not saved. ` +
            'Check the network and try again.',
        }),
      KEY_VALIDATION_DEADLINE_MS,
    );
  });
  try {
    return await Promise.race([validateCredential(credentialId, key), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
    // A queued `CH-126` write is older than this one, and the throttle would
    // otherwise re-read the theme this call just stored and put its own stale
    // size back over it, reversing the user's last action. Only the newest
    // writer may commit, so the pending one is dropped rather than delayed.
    if (patch.theme !== undefined) overlayFontSizeWrites.cancel();
    await applyThemeChange(before, after);
    bindHealthFromSettings(after);
    // The trigger holds its own copy of the gap and the guard, so a settings
    // change has to reach it. Applying at the next armed timer rather than
    // rewriting one in flight is the machine's own rule (FR-050).
    trigger.setConfig(triggerConfigFrom(after, live.activeSttChoice));
    // The meter holds its own copy too. A threshold already crossed stays
    // crossed for the session whatever the new value is (FR-109).
    cost.setThresholds(after.thresholds);
    return after;
  });

  router.handle('secrets:status', () => secrets.status());
  router.handle('secrets:set', async ({ provider, key }) => {
    const result = await secrets.set(provider, key, validateWithinDeadline);
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

  /**
   * The Dashboard's click-through toggle (`CH-118`, FR-083).
   *
   * Persisted, like the hotkey and for the same reason: this is the user
   * stating which behavior they want, not a transient nudge.
   */
  router.handle('overlay:setInteractive', ({ interactive }) => {
    setOverlayInteractive(interactive, { persist: true });
    return { ok: true as const };
  });

  router.handle('overlay:savePosition', ({ x, y, displayId }) => {
    // Merged onto the stored geometry rather than replacing it. This channel
    // carries a position only, and writing it as the whole `overlayWindow`
    // would drop the size the user had dragged the overlay to (FR-081).
    config.set({ overlayWindow: { ...config.get().overlayWindow, x, y, displayId } });
    return { ok: true as const };
  });

  /**
   * The in-overlay text size control (`CH-126`, FR-093).
   *
   * The range is enforced by the channel's schema, so an out-of-range value is
   * refused by the router and never reaches here (CMP-10). The write goes
   * through `config.set` like every other setting, so it persists, and the
   * theme is pushed straight back: the overlay renders the stored value rather
   * than its own optimistic one, which is what makes the Dashboard control and
   * this one the same setting rather than two.
   */
  router.handle('overlay:setFontSize', ({ px }) => {
    // Rate limited, not merely range checked. The schema bounds the value to
    // 16 to 32 and the commit below drops a write that changes nothing, but
    // neither bounds how often a renderer may call: alternating two sizes
    // reaches `config.set` every time, and that is a **synchronous** settings
    // write on the same event loop as the live audio and STT loop. The narrow
    // write capability this channel exists to be would otherwise be a way for
    // a compromised overlay renderer to stall an interview, which is worse
    // than anything the allowlist was narrowed to prevent (FR-086).
    //
    // Leading edge, so one press still feels immediate, with the last value
    // asked for committed when the window closes.
    overlayFontSizeWrites.request(px);
    return { ok: true as const };
  });

  /**
   * The in-overlay resize grip (`CH-127`, FR-081).
   *
   * The range is the channel's schema, so an out-of-range size is refused by
   * the router and never reaches here (CMP-10).
   *
   * The window is moved now and stored later: see `overlaySizeWrites`. The
   * top-left corner is held fixed, so the overlay grows down and to the right
   * from where the user put it rather than drifting across the screen as it
   * grows.
   */
  router.handle('overlay:setSize', ({ width, height }) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      throw new Error('There is no overlay window to resize.');
    }
    const { x, y } = overlayWindow.getBounds();
    overlayWindow.setBounds({ x, y, width, height });
    overlaySizeWrites.request({ width, height });
    return { ok: true as const };
  });

  /**
   * The consent reminder was dismissed (`CH-120`, FR-006).
   *
   * Dismissal is renderer state: the card disappears whether or not this call
   * succeeds, because `FR-006` is about the reminder being dismissible, not
   * about the main process knowing. What the main process does with it is
   * record it, so a transcript reader can tell a session where the reminder was
   * acknowledged from one where it sat on screen untouched. Milestone 0 left
   * this channel allowlisted with no handler, so every dismissal answered with
   * an `IpcError` the overlay had to ignore.
   */
  /**
   * The pointer crossed onto or off one of the overlay's controls (`CH-128`,
   * FR-006, FR-081, FR-083).
   *
   * This is what lets a click-through overlay still own its own dismiss button
   * and its own resize grip: the window is clickable exactly while the pointer
   * is on one of them, and passes clicks through everywhere else.
   *
   * It is not a capability worth guarding beyond the allowlist. The worst a
   * renderer can do with it is hold the overlay clickable, which is what the
   * interaction hotkey does openly, and it cannot make the overlay
   * click-through while the user has asked for a solid window, because
   * `overlayInteractive` wins in the applier either way.
   */
  router.handle('overlay:setPointerOverControls', ({ over }) => {
    if (pointerOverControls === over) return { ok: true as const };
    pointerOverControls = over;
    applyOverlayClickThrough();
    return { ok: true as const };
  });

  router.handle('consent:dismiss', () => {
    getLogger().info('consent reminder dismissed');
    // The card is gone, so the overlay goes back to the click-through state the
    // user chose. Doing this here rather than in the renderer keeps the two
    // halves of `FR-083` in the process that owns the window (FR-006).
    setConsentReminderPending(false);
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
    // Size is cleared along with position. Reset Overlay is the escape hatch for
    // an overlay the user cannot reach, and one dragged to 320 by 180 in a
    // corner is as unreachable as one dragged off-screen (FR-009, FR-081).
    const asIfFresh = {
      ...config.get(),
      overlayWindow: {
        ...config.get().overlayWindow,
        x: null,
        y: null,
        width: null,
        height: null,
        displayId: null,
      },
    };
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

    const bounds = overlayBoundsFor(pos, OVERLAY_SIZE);
    overlayWindow.setBounds(bounds);
    // setBounds and setPosition take different paths on Windows; the second is
    // the direct move and costs nothing when the first already worked.
    overlayWindow.setPosition(bounds.x, bounds.y);
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');

    setOverlayInteractive(true);
    hotkeys.reregisterAll();
    // A queued grip write carries the size the reset just discarded, and it
    // would land after this one. Cancelled rather than flushed (CH-127).
    overlaySizeWrites.cancel();
    config.set({
      overlayWindow: {
        ...config.get().overlayWindow,
        x: pos.x,
        y: pos.y,
        width: null,
        height: null,
        displayId: pos.displayId,
      },
    });

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
    // Readiness means the consent card has painted, which is exactly the moment
    // the overlay has to start accepting clicks: a click-through window makes
    // the card's dismiss button unclickable (FR-006, FR-083). It is reported
    // again at every session boundary, which is when the card comes back.
    setConsentReminderPending(true);
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

      // The gate forgets the previous interview's card. It deliberately keeps
      // one across a window rebuild, so a generation streaming through a
      // translucency change is replayed in full (ADR-016); across a session
      // boundary that same card would be replayed to the next interview
      // before it had produced anything of its own (ADR-036).
      overlayGate.reset();

      // The overlay is created hidden and shown for the session, as section
      // 5.1 sequences it. `showInactive` so the interviewer's window keeps
      // focus: the overlay is a teleprompter, never a window to work in.
      if (overlayWindow && !overlayWindow.isDestroyed() && !overlayWindow.isVisible()) {
        overlayWindow.showInactive();
      }

      // Started after the manager accepted, so a refused start leaves no meter
      // running and no timer counting a session that does not exist.
      //
      // And started *before* the loop, which section 5.1 lists last. The meter
      // clears every accumulator in `start()`, so a second of audio handed over
      // before it runs is discarded rather than counted, and the loop begins
      // sending audio the moment capture comes up. Recorded in section 5.1.
      cost.start();

      // The loop starts capture, opens one SttSession per stream, rebinds the
      // trigger to whichever model is serving, and leaves the machine in
      // LISTENING (CMP-15, TASK-044). It never throws: a capture or socket
      // failure belongs on the Dashboard badge, not on a session that has
      // already been created on disk (section 10, TC-132).
      //
      // The state is pushed **before** the loop comes up. The session is live
      // the moment the manager accepted it, and bringing capture and two
      // sockets up takes long enough that a Dashboard told afterwards would
      // render the session as inactive for the whole of it (FR-088).
      pushSessionState();
      await live.start(active.profileId);

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

    // The loop stops first and is awaited. It stops the trigger, which aborts
    // the in-flight generation, waits for that generation's cancelled entry to
    // reach the transcript, closes both STT sessions and stops capture. Nothing
    // below may run while an append is still possible, or the last entry of the
    // interview would land on a handle that has gone (FR-046, FR-107).
    await live.stop();
    // The final record is handed over before compaction, so the session file
    // carries it rather than the last tick's. The meter itself is stopped only
    // once the manager really ended the session: `sessions.stop()` can throw on
    // a compaction failure and leaves the session live, and a meter already
    // stopped would have left that live session with a frozen timer.
    sessions.noteUsage(cost.record());
    await sessions.stop();
    cost.stop();

    // Hidden again: an always-on-top window with no session behind it has
    // nothing to say and sits over whatever the user does next. The gate is
    // cleared with it, so the card cannot outlive the interview it belongs to.
    overlayGate.reset();
    // And the reminder's claim on click-through goes with it. A hidden window
    // that still refuses to pass clicks through would be invisible and in the
    // way, which is the worst of both (FR-083).
    setConsentReminderPending(false);
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();

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

  /**
   * The profile list, once there is one to list (FR-027, FR-028).
   *
   * Awaits `profilesReady` so a Dashboard that mounted while bootstrap was
   * still creating the default profile is not answered `[]` forever.
   */
  router.handle('profile:list', async () => {
    await profilesReadyWithin(PROFILES_READY_DEADLINE_MS);
    return rag.listProfiles();
  });

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
   * Choose documents in a main-process dialog and import them (`CH-125`,
   * ADR-037, TASK-042).
   *
   * The dialog runs here, so the Add documents button never hands the main
   * process a path a renderer chose. Drag and drop still reaches `doc:import`,
   * because a drop is the one case where only the renderer knows what was
   * dropped. What bounds a renderer-supplied source path there is the extension
   * allowlist in `CMP-06`, not `basename`: `basename` decides the name the copy
   * lands under inside `kb/`, it does not decide what may be read.
   *
   * A cancelled dialog answers `[]`. It is not an error and the Dashboard must
   * not render it as one.
   */
  router.handle('doc:pickFiles', async ({ profileId }) => {
    const profile = assertProfile(profileId);
    const parent = dashboardWindow && !dashboardWindow.isDestroyed() ? dashboardWindow : null;
    const options: OpenDialogOptions = {
      title: 'Add documents to this knowledge base',
      properties: ['openFile', 'multiSelections'],
      // Read from the engine, never written out here. A private copy had
      // already drifted: `.markdown` imported by drag and drop and by a copy
      // into `kb/`, and was greyed out in this picker (FR-060).
      filters: [
        { name: 'Documents', extensions: SUPPORTED_EXTENSIONS.map((ext) => ext.replace('.', '')) },
      ],
    };
    const picked = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (picked.canceled || picked.filePaths.length === 0) return [];
    return rag.importDocuments(profile, picked.filePaths);
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
