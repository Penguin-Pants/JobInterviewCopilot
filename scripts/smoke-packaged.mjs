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
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

  // A renderer that loaded is not the whole claim: bootstrap has to have run
  // far enough to answer the Dashboard. The profile list is the first thing it
  // answers that needs the knowledge base, which is where `chokidar` is pulled
  // in through the ESM `import()` that asar cannot serve.
  await dashboard.waitForSelector('[data-testid="profile-list"] > li', { timeout: 30_000 });

  console.log(`Packaged app smoke test passed: ${exe} launched and rendered the Dashboard.`);
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
