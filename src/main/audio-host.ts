import { join } from 'node:path';
import { BrowserWindow, desktopCapturer, session, type Session } from 'electron';
import {
  applyNavigationLockdown,
  hardenedWebPreferences,
  loadRenderer,
  preloadPath,
} from './windows.js';
import { getLogger } from './logger.js';
import type { AudioWorkerHandle } from './audio.js';
import { appRendererUrlCheck, isTopLevelAppFrame, type SenderFrame } from './ipc/sender.js';
import { audioWorkerChannels, MAX_PCM_CHUNK_BYTES } from '../shared/ipc.js';
import type { AudioChunk, TranscriptSource } from '../shared/types.js';

/**
 * The Electron half of audio capture (CMP-03a, ADR-005, ADR-028).
 *
 * Creates and drives the hidden audio worker, and owns the two main-process
 * concessions loopback needs: a display-media request handler that answers with
 * system audio, and a permission handler that allows media for this window
 * only.
 *
 * Kept apart from `audio.ts` so the supervisor stays a pure, testable module
 * and everything that binds to Electron lives here. This file is on the
 * filesystem lint ban list because audio bytes pass through it (NFR-002).
 */

export interface AudioHostOptions {
  onChunk: (chunk: AudioChunk) => void;
  onStreamState: (payload: { source: TranscriptSource; state: string; error?: string }) => void;
}

/**
 * Answer display-media requests with system audio (ADR-028).
 *
 * Two details the spike made the hard way. The handler needs
 * `useSystemPicker: false`, or Windows offers the user a picker for what is
 * meant to be an automatic capture. And the callback must be invoked on every
 * path: returning without calling it leaves `getDisplayMedia` pending forever,
 * which presents as an audio pipeline that never starts and never errors,
 * which is close to the worst failure mode available.
 *
 * Only the audio worker's frame gets a stream. The answer is the whole screen
 * plus system audio with no picker, so any other window that asked would get
 * both without the user ever seeing a prompt. Every other frame is refused,
 * through the callback, before a source is even enumerated.
 */
export function installLoopbackHandler(
  isAudioWorkerFrame: (frame: Electron.WebFrameMain | null) => boolean,
  target: Session = session.defaultSession,
): void {
  target.setDisplayMediaRequestHandler(
    async (request, callback) => {
      if (!isAudioWorkerFrame(request.frame)) {
        getLogger().warn('display media refused for a frame that is not the audio worker');
        callback({});
        return;
      }
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        const screen = sources[0];
        if (!screen) {
          getLogger().warn('no capture source for system audio');
          callback({});
          return;
        }
        // The video is only the vehicle Chromium requires; the renderer stops
        // that track the moment the stream arrives.
        callback({ video: screen, audio: 'loopback' });
      } catch (err) {
        getLogger().error('display media request failed', err);
        callback({});
      }
    },
    { useSystemPicker: false },
  );
}

/**
 * Allow media capture for the audio worker and nothing else.
 *
 * Milestone 0 denied every permission. Loopback and the microphone both need
 * `media`, so it is granted here, scoped to the worker's own contents: no other
 * window in this app has any reason to capture anything. `display-capture` is
 * granted on the same terms: Electron 45 reports `getDisplayMedia()` as that
 * permission rather than `media`, and loopback would otherwise stop at the
 * permission before it reached the display-media handler (ADR-028).
 *
 * Checks get the same rule as requests. Chromium asks the check handler when a
 * page queries a permission without prompting, and Electron's default answers
 * yes to all of them.
 */
export function installPermissionHandler(
  isAudioWorker: (contents: Electron.WebContents) => boolean,
  target: Session = session.defaultSession,
): void {
  target.setPermissionRequestHandler((contents, permission, callback) => {
    const allowed = CAPTURE_PERMISSIONS.has(permission) && isAudioWorker(contents);
    if (!allowed) {
      getLogger().warn('permission denied', { permission });
    }
    callback(allowed);
  });
  target.setPermissionCheckHandler(
    (contents, permission) =>
      CAPTURE_PERMISSIONS.has(permission) && contents !== null && isAudioWorker(contents),
  );
}

/** The permissions the audio worker's capture needs, and the only ones it gets. */
const CAPTURE_PERMISSIONS: ReadonlySet<string> = new Set(['media', 'display-capture']);

/** The worker side of `AudioHostOptions`, which is all a message can reach. */
type WorkerSink = Pick<AudioHostOptions, 'onChunk' | 'onStreamState'>;

/** True for a buffer that can be a chunk of 16-bit PCM (ADR-027). */
function isPcm(value: unknown): value is ArrayBuffer {
  return (
    value instanceof ArrayBuffer &&
    value.byteLength > 0 &&
    value.byteLength % 2 === 0 &&
    value.byteLength <= MAX_PCM_CHUNK_BYTES
  );
}

/**
 * Parse one message from the audio worker and hand it on (CH-303, CH-304).
 *
 * Parsed, never cast. This runs inside an Electron `ipc-message` listener, so
 * anything it throws is an uncaught exception in the main process. A message
 * from a frame that is not the worker page, or one that fails its schema, is
 * dropped and logged. The log names the channel only, never the bytes
 * (NFR-002).
 */
export function handleWorkerMessage(
  sink: WorkerSink,
  isWorkerFrame: (frame: SenderFrame | null) => boolean,
  event: { senderFrame: SenderFrame | null },
  channel: string,
  args: readonly unknown[],
): void {
  if (channel !== 'audio:streamState' && channel !== 'audio:chunk') return;
  if (!isWorkerFrame(event.senderFrame)) {
    getLogger().warn('audio worker message from another frame dropped', { channel });
    return;
  }

  if (channel === 'audio:streamState') {
    const parsed = audioWorkerChannels['audio:streamState'].payload.safeParse(args[0]);
    if (!parsed.success) {
      getLogger().warn('audio worker message rejected', { channel });
      return;
    }
    sink.onStreamState(parsed.data);
    return;
  }

  const meta = audioWorkerChannels['audio:chunk'].payload.safeParse(args[0]);
  const pcm = args[1];
  if (!meta.success || !isPcm(pcm)) {
    getLogger().warn('audio worker message rejected', { channel });
    return;
  }
  try {
    // Handed straight on. Electron copied it getting here, which ADR-027
    // accepts; what is not accepted is this layer keeping it.
    sink.onChunk({ ...meta.data, pcm });
  } catch (err) {
    getLogger().error('audio chunk consumer threw', { err });
  }
}

/**
 * Creates the hidden worker window and speaks CH-301 to CH-304 to it.
 *
 * The window is the one place this app builds it, so its guardrails are
 * asserted here against a fake BrowserWindow: the shared hardened preferences
 * and content protection before the load (FR-086, TC-004, TC-007).
 */
export class ElectronAudioWorkerHost implements AudioWorkerHandle {
  private window: BrowserWindow | null = null;
  /**
   * The window still loading, shared by every start that arrives meanwhile.
   * Two overlapping starts each built a window before, and the one not kept
   * still listened for IPC and still held capture.
   */
  private creating: Promise<BrowserWindow> | null = null;
  /** The streams the worker was told to run, for the crash report. */
  private readonly active = new Set<TranscriptSource>();

  constructor(private readonly options: AudioHostOptions) {}

  /** True when these contents belong to the worker, for the permission check. */
  owns(contents: Electron.WebContents): boolean {
    return (
      this.window !== null && !this.window.isDestroyed() && this.window.webContents === contents
    );
  }

  /** True when this frame is the worker's own top-level frame, for display media. */
  ownsFrame(frame: Electron.WebFrameMain | null): boolean {
    if (frame === null || this.window === null || this.window.isDestroyed()) return false;
    const main = this.window.webContents.mainFrame;
    return frame.processId === main.processId && frame.routingId === main.routingId;
  }

  async start(streams: readonly TranscriptSource[]): Promise<void> {
    const win = await this.ensureWindow();
    for (const source of streams) this.active.add(source);
    win.webContents.send('audio:start', { streams: [...streams] });
  }

  async stop(): Promise<void> {
    this.active.clear();
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send('audio:stop');
  }

  async destroy(): Promise<void> {
    this.active.clear();
    this.creating = null;
    if (!this.window) return;
    const win = this.window;
    this.window = null;
    if (!win.isDestroyed()) win.destroy();
  }

  private async ensureWindow(): Promise<BrowserWindow> {
    if (this.creating) return this.creating;
    if (this.window && !this.window.isDestroyed()) return this.window;

    const creating = this.createWindow();
    this.creating = creating;
    try {
      return await creating;
    } finally {
      if (this.creating === creating) this.creating = null;
    }
  }

  /**
   * The worker renderer died (FR-045).
   *
   * Nothing else notices: the worker reports `error` only while it runs, so a
   * dead renderer left both streams reading `running` with no chunks and no
   * badge. Each stream it was running is reported failed, which feeds the
   * supervisor's restart and badge path, and the window is dropped so the
   * restart builds a fresh one.
   */
  private handleRendererGone(win: BrowserWindow, details: Electron.RenderProcessGoneDetails): void {
    // A window this host already let go of, by destroy or by an earlier crash.
    if (this.window !== win) return;
    this.window = null;
    if (!win.isDestroyed()) win.destroy();
    getLogger().error('audio worker renderer gone', {
      reason: details.reason,
      exitCode: details.exitCode,
    });

    const failed = [...this.active];
    this.active.clear();
    for (const source of failed) {
      this.options.onStreamState({
        source,
        state: 'error',
        error: `The audio worker stopped unexpectedly (${details.reason}).`,
      });
    }
  }

  private async createWindow(): Promise<BrowserWindow> {
    const win = new BrowserWindow({
      width: 320,
      height: 240,
      show: false,
      skipTaskbar: true,
      webPreferences: hardenedWebPreferences(preloadPath('audioWorker')),
    });

    // Content protected as a precaution. It should never be visible to
    // anything, capture included. Never turned off (FR-005, TC-004).
    win.setContentProtection(true);

    // The same lockdown every other window gets, and it matters more here.
    // Without it a redirect to a remote origin would keep this window's preload
    // bridge and would still be recognized by `owns()` as the media-authorized
    // worker, handing a remote page the capture and audio IPC surface that
    // every other renderer is explicitly denied (FR-086).
    applyNavigationLockdown(win);

    // The worker's own page directory, not the whole renderer tree, so a
    // message is trusted only from the document this window was built for.
    const isWorkerPage = appRendererUrlCheck(
      process.env.ELECTRON_RENDERER_URL,
      join(__dirname, '../renderer/audio-worker'),
    );
    win.webContents.on('ipc-message', (event, channel, ...args) =>
      handleWorkerMessage(
        this.options,
        (frame) => isTopLevelAppFrame(frame, isWorkerPage),
        event,
        channel,
        args,
      ),
    );

    win.webContents.on('render-process-gone', (_event, details) => {
      this.handleRendererGone(win, details);
    });

    win.on('closed', () => {
      if (this.window === win) this.window = null;
    });

    // Held from construction rather than from the end of the load, so a
    // `destroy()` during the load reaches this window instead of missing it.
    this.window = win;
    try {
      await loadRenderer(win, 'audio-worker');
    } catch (err) {
      // A window whose renderer never loaded is useless and still listens.
      if (this.window === win) this.window = null;
      if (!win.isDestroyed()) win.destroy();
      throw err;
    }
    // Destroyed while it loaded, by `destroy()` or a crash. Starting capture
    // in it now would be a start nobody can stop.
    if (this.window !== win || win.isDestroyed()) {
      throw new Error('The audio worker window closed while it loaded.');
    }
    return win;
  }
}
