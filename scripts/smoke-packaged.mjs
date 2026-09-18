#!/usr/bin/env node
/**
 * Launch the packaged app and assert it comes up (TASK-051, NFR-011).
 *
 * `scripts/check-packaged.mjs` proves the unpacked modules are on disk where
 * the loader will look for them. This proves the app built around them starts:
 * that the asar resolves, that the renderer loads under `file://` with the
 * content security policy in place, and that bootstrap gets as far as painting
 * a Dashboard.
 *
 * Between them they close TASK-051's "installs and launches" criterion as far
 * as CI can. What neither can do is install from the NSIS package onto a clean
 * Windows 11 machine, which stays with `MW-01` to `MW-14` on real hardware.
 *
 * Windows only, because that is the only thing electron-builder produces here.
 * It exits 0 with a message elsewhere rather than failing, exactly as the E2E
 * suite skips rather than passing vacuously.
 *
 * Run: node scripts/smoke-packaged.mjs   (after npm run package)
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** What `startKnowledgeBase` logs when `rag.start()` throws, chokidar included. */
const KNOWLEDGE_BASE_FAILED = 'the knowledge base failed to start';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const release = join(root, 'release');

if (process.platform !== 'win32') {
  console.log(`Skipped: the packaged app is a Windows build and this is ${process.platform}.`);
  process.exit(0);
}

if (!existsSync(release)) {
  console.error('No release/ directory. Run "npm run package" first.');
  process.exit(1);
}

/** electron-builder writes exactly one `*-unpacked` directory beside the installer. */
const unpackedDir = readdirSync(release, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.endsWith('unpacked'))
  .map((e) => join(release, e.name))[0];

if (!unpackedDir) {
  console.error('No *-unpacked directory in release/. Nothing to launch.');
  process.exit(1);
}

const exe = readdirSync(unpackedDir)
  .filter((name) => name.endsWith('.exe'))
  .map((name) => join(unpackedDir, name))[0];

if (!exe) {
  console.error(`No .exe in ${unpackedDir}. Nothing to launch.`);
  process.exit(1);
}

const { _electron: electron } = await import('@playwright/test');

const userDataDir = mkdtempSync(join(tmpdir(), 'icp-packaged-'));
let app;

try {
  // The same `--user-data-dir` the E2E suite uses. Without it the smoke run
  // would write into, and overwrite, the real profile of whoever ran it.
  app = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${userDataDir}`] });

  const dashboard = await app.firstWindow();
  await dashboard.waitForSelector('[data-testid="dashboard"]', { timeout: 30_000 });
  await dashboard.waitForSelector('[data-testid="dashboard-header"]', { timeout: 30_000 });

  await dashboard.waitForSelector('[data-testid="profile-list"] > li', { timeout: 30_000 });

  // The Dashboard rendering is not the whole claim. `startKnowledgeBase` calls
  // `markProfilesReady()` *before* awaiting `rag.start()`, and catches what
  // that throws, so the profile row appears whether or not the watcher ever
  // loaded. Two further signals are needed, and neither can be got by reaching
  // into the packaged app's module system: `app.evaluate` runs a serialized
  // function with no `require` and no dynamic-import callback, so asking it to
  // load a module fails on the harness rather than on the app.
  //
  // So the app's own signals are used instead.
  //
  // First, that bootstrap ran to the end. The model state is pushed on the
  // last line of `startKnowledgeBase`, and the Dashboard mounts one of these
  // two on receiving it.
  await dashboard.waitForSelector('[data-testid="model-gate"], [data-testid="model-ready"]', {
    timeout: 30_000,
  });

  // Second, that nothing failed on the way. `rag.start()` opens a watcher,
  // which is where `chokidar` is pulled in through the ESM `import()` that
  // asar cannot serve, and a failure there is caught and logged rather than
  // thrown. The log is the only place it surfaces, so the log is what is read.
  const log = join(userDataDir, 'logs', 'main.log');
  const deadline = Date.now() + 10_000;
  let contents = '';
  for (;;) {
    contents = existsSync(log) ? readFileSync(log, 'utf8') : '';
    if (contents.includes(KNOWLEDGE_BASE_FAILED) || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (contents.includes(KNOWLEDGE_BASE_FAILED)) {
    const line = contents.split('\n').find((l) => l.includes(KNOWLEDGE_BASE_FAILED));
    throw new Error(`the knowledge base did not start in the packaged app: ${line?.trim()}`);
  }

  // Not vacuous: an app that never wrote a log never got as far as failing.
  if (contents.trim() === '') {
    throw new Error(`the packaged app wrote no log at ${log}, so nothing above was observed`);
  }

  console.log(
    `Packaged app smoke test passed: ${exe} launched, rendered the Dashboard, ` +
      'and started its knowledge base without error.',
  );
} catch (err) {
  console.error('The packaged app did not come up:');
  console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  console.error(
    '\nThis is the failure mode asarUnpack exists to prevent: the installer builds,\n' +
      'and the app only breaks when it is run. See electron-builder.yml.',
  );
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => {});
}
