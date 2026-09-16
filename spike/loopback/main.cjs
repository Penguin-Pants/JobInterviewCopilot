/**
 * TASK-010 spike: can we obtain a system-audio loopback MediaStream in a
 * sandboxed, context-isolated renderer, without the electron-audio-loopback
 * package?
 *
 * Why this matters. The package is the project's highest-risk dependency: one
 * maintainer, 19.5 kB, last published a year ago, and the whole product depends
 * on interviewer capture. Reading it showed it is a ~60 line wrapper whose
 * renderer half calls `ipcRenderer.invoke` from inside the renderer, only to
 * toggle a main-process handler on and off around one `getDisplayMedia` call.
 * A renderer with `sandbox: true` and `contextIsolation: true` has no
 * `ipcRenderer`, so that half cannot run in the audio worker as FR-086 requires
 * it to be configured.
 *
 * If main owns `setDisplayMediaRequestHandler` for the life of the session, the
 * renderer needs nothing but the standard web API. This harness measures
 * whether that is true.
 *
 * Run: npx electron spike/loopback/main.cjs   (add --json for machine output)
 */
const { app, BrowserWindow, desktopCapturer, ipcMain, session } = require('electron');
const path = require('path');
const os = require('os');

const wantsJson = process.argv.includes('--json');
const outIndex = process.argv.indexOf('--out');
const outPath = outIndex >= 0 ? process.argv[outIndex + 1] : null;
const TIMEOUT_MS = 25000;

const result = {
  platform: process.platform,
  release: os.release(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  handlerInvoked: false,
  sourceCount: null,
  sourcesError: null,
  streamAcquired: false,
  audioTrackCount: 0,
  videoTrackCount: 0,
  audioTrackLabel: null,
  audioSettings: null,
  sampledMs: 0,
  peakAmplitude: null,
  nonSilent: null,
  rendererError: null,
  verdict: 'unknown',
};

function finish(code) {
  if (outPath) {
    // Written to a file rather than parsed out of stdout: Chromium is noisy on
    // every platform and a spike result that depends on log scraping is a
    // spike result nobody can trust.
    require('fs').writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  }
  if (wantsJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`\n=== TASK-010 loopback spike ===\n`);
    for (const [k, v] of Object.entries(result)) {
      process.stdout.write(`${k.padEnd(18)}: ${v === null ? '-' : JSON.stringify(v)}\n`);
    }
  }
  app.exit(code);
}

app.whenReady().then(async () => {
  // Main owns the handler. This is the half the package keeps; the renderer
  // half is what we are trying to do without.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      result.handlerInvoked = true;
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        result.sourceCount = sources.length;
        if (sources.length === 0) {
          // Callback must still be called, or getDisplayMedia hangs forever.
          callback({});
          return;
        }
        callback({ video: sources[0], audio: 'loopback' });
      } catch (err) {
        result.sourcesError = String(err && err.message ? err.message : err);
        callback({});
      }
    },
    // Electron requires this opt-in to hand the renderer a local audio stream.
    { useSystemPicker: false },
  );

  // The audio worker is a hidden renderer with no UI, exactly as ADR-005 says.
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  ipcMain.on('spike:result', (_event, payload) => {
    Object.assign(result, payload);
    result.verdict = decideVerdict();
    finish(0);
  });

  await win.loadFile(path.join(__dirname, 'index.html'));

  setTimeout(() => {
    result.rendererError = result.rendererError ?? `timed out after ${TIMEOUT_MS} ms`;
    result.verdict = decideVerdict();
    finish(1);
  }, TIMEOUT_MS);
});

/**
 * Separates "the integration does not work" from "this machine has no audio to
 * capture", which are very different answers and a headless CI runner will give
 * the second one.
 */
function decideVerdict() {
  if (result.streamAcquired && result.nonSilent === true) return 'works-with-audio';
  if (result.streamAcquired && result.audioTrackCount > 0) return 'stream-acquired-but-silent';
  if (result.streamAcquired) return 'stream-without-audio-track';
  if (result.sourceCount === 0) return 'no-capture-sources-on-this-machine';
  return 'failed';
}
