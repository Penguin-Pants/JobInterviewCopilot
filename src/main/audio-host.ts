import { join } from 'node:path';
import { BrowserWindow, desktopCapturer, session, type Session } from 'electron';
import { getLogger } from './logger.js';
import type { AudioWorkerHandle } from './audio.js';
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
 */
export function installLoopbackHandler(target: Session = session.defaultSession): void {
  target.setDisplayMediaRequestHandler(
    async (_request, callback) => {
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
 * window in this app has any reason to capture anything.
 */
export function installPermissionHandler(
  isAudioWorker: (contents: Electron.WebContents) => boolean,
  target: Session = session.defaultSession,
): void {
  target.setPermissionRequestHandler((contents, permission, callback) => {
    const allowed = permission === 'media' && isAudioWorker(contents);
    if (!allowed) {
      getLogger().warn('permission denied', { permission });
    }
    callback(allowed);
  });
}

/* v8 ignore start -- binds directly to BrowserWindow and cannot run in a plain
   Node test process. The two behaviours worth asserting, the display-media
   handler and the permission handler, take an injected Session and are tested
   above; what remains here is window plumbing, exercised on Windows by the E2E
   suite and the loopback spike. */
/** Creates the hidden worker window and speaks CH-301 to CH-304 to it. */
export class ElectronAudioWorkerHost implements AudioWorkerHandle {
  private window: BrowserWindow | null = null;

  constructor(private readonly options: AudioHostOptions) {}

  /** True when these contents belong to the worker, for the permission check. */
  owns(contents: Electron.WebContents): boolean {
    return (
      this.window !== null && !this.window.isDestroyed() && this.window.webContents === contents
    );
  }

  async start(streams: readonly TranscriptSource[]): Promise<void> {
    const win = await this.ensureWindow();
    win.webContents.send('audio:start', { streams: [...streams] });
  }

  async stop(): Promise<void> {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send('audio:stop');
  }

  async destroy(): Promise<void> {
    if (!this.window) return;
    const win = this.window;
    this.window = null;
    if (!win.isDestroyed()) win.destroy();
  }

  private async ensureWindow(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) return this.window;

    const win = new BrowserWindow({
      width: 320,
      height: 240,
      show: false,
      skipTaskbar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/audioWorker.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    // Content protected as a precaution. It should never be visible to
    // anything, capture included.
    win.setContentProtection(true);

    win.webContents.on('ipc-message', (_event, channel, ...args) => {
      if (channel === 'audio:streamState') {
        this.options.onStreamState(args[0] as Parameters<AudioHostOptions['onStreamState']>[0]);
        return;
      }
      if (channel === 'audio:chunk') {
        const meta = args[0] as { source: TranscriptSource; timestamp: number; sequence: number };
        const pcm = args[1] as ArrayBuffer;
        // Handed straight on. Electron copied it getting here, which ADR-027
        // accepts; what is not accepted is this layer keeping it.
        this.options.onChunk({ ...meta, pcm });
      }
    });

    win.on('closed', () => {
      if (this.window === win) this.window = null;
    });

    const devServer = process.env.ELECTRON_RENDERER_URL;
    if (devServer) await win.loadURL(`${devServer}/audio-worker/index.html`);
    else await win.loadFile(join(__dirname, '../renderer/audio-worker/index.html'));

    this.window = win;
    return win;
  }
}
/* v8 ignore stop */
