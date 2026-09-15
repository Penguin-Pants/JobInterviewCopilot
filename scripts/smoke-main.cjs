#!/usr/bin/env node
/**
 * Startup smoke test for the packaged main bundle.
 *
 * Why this exists. The main process ships as CommonJS. An ESM-only dependency
 * required from that bundle yields a module namespace object rather than its
 * export, so `new Dep(...)` throws at startup. The app installs an
 * unhandledRejection handler before that point, so the throw is swallowed: the
 * process stays alive with no windows, and the only symptom is the E2E suite
 * timing out after 30 seconds per test with "no window appeared". That is an
 * expensive and uninformative way to learn about a one-line interop bug.
 *
 * This loads the real built bundle with a stubbed Electron, lets bootstrap run
 * as far as its synchronous setup, and asserts the settings file was written.
 * It fails in about a second, naming the real error.
 *
 * Run: node scripts/smoke-main.cjs   (after npm run build)
 */
const Module = require('module');
const path = require('path');
const os = require('os');
const fs = require('fs');

const BUNDLE = path.join(__dirname, '..', 'out', 'main', 'index.js');
if (!fs.existsSync(BUNDLE)) {
  console.error(`Main bundle not found at ${BUNDLE}. Run "npm run build" first.`);
  process.exit(1);
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'icp-smoke-'));
const failures = [];

// whenReady never resolves, so bootstrap stops after its synchronous setup and
// before it starts opening windows, which need a real Electron.
const pending = new Promise(() => {});

const electronStub = {
  app: {
    getPath: () => userData,
    requestSingleInstanceLock: () => true,
    whenReady: () => pending,
    isPackaged: true,
    quit() {},
    on() {},
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  ipcMain: { handle() {}, removeHandler() {} },
  globalShortcut: {
    register: () => true,
    isRegistered: () => true,
    unregister() {},
    unregisterAll() {},
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => '{}',
  },
  screen: {
    getAllDisplays: () => [],
    getPrimaryDisplay: () => ({ id: 0, bounds: { x: 0, y: 0, width: 0, height: 0 } }),
  },
  session: {
    defaultSession: { webRequest: { onHeadersReceived() {} }, setPermissionRequestHandler() {} },
  },
  shell: { openExternal: async () => undefined },
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return originalResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = {
  id: 'electron-stub',
  filename: 'electron-stub',
  loaded: true,
  exports: electronStub,
};

process.on('uncaughtException', (err) => failures.push(`uncaughtException: ${err.message}`));
process.on('unhandledRejection', (reason) => {
  failures.push(`unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});

require(BUNDLE);

setTimeout(() => {
  const settings = path.join(userData, 'settings.json');

  if (failures.length > 0) {
    console.error('Main bundle failed to start:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  if (!fs.existsSync(settings)) {
    console.error(
      'Main bundle started but never wrote settings.json. Bootstrap stopped early, ' +
        'which is how an ESM interop failure presents: swallowed by the ' +
        'unhandledRejection handler, leaving a live process with no windows.',
    );
    process.exit(1);
  }
  console.log('Main bundle smoke test passed: bootstrap ran and settings were written.');
  process.exit(0);
}, 1500);
