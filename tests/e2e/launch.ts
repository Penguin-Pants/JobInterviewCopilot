import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

/**
 * One way to bring the app up in an E2E test.
 *
 * Every run gets a throwaway profile directory. `--user-data-dir` is the
 * Chromium switch Electron actually honors; an environment variable would be
 * ignored and the suite would run against, and overwrite, the developer's real
 * settings. The directory is returned so a test can seed files the app reads.
 */
export interface LaunchedApp {
  app: ElectronApplication;
  dashboard: Page;
  userDataDir: string;
}

export async function launchApp(): Promise<LaunchedApp> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'icp-e2e-'));
  const app = await electron.launch({
    args: [join(process.cwd(), 'out/main/index.js'), `--user-data-dir=${userDataDir}`],
  });
  const dashboard = await app.firstWindow();
  await dashboard.waitForSelector('[data-testid="dashboard"]');
  // The shell renders before the settings arrive. Waiting for the header keeps
  // every test from racing the first `config:get`, and waiting for a profile
  // row keeps it from racing the first `profile:list`: the per-profile controls
  // do not exist until it answers, so a test that counted controls before then
  // would check a smaller surface than it meant to.
  await dashboard.waitForSelector('[data-testid="dashboard-header"]');
  await dashboard.waitForSelector('[data-testid="profile-list"] > li');
  // And the embedding-model state, which arrives on a push the main process
  // sends at the end of bootstrap and which mounts a retry button. Waiting for
  // either branch of it keeps a test that counts controls from racing a control
  // that is about to appear.
  await dashboard.waitForSelector('[data-testid="model-gate"], [data-testid="model-ready"]');
  return { app, dashboard, userDataDir };
}

/**
 * Push a main-to-renderer message into the Dashboard.
 *
 * The window is found by its loaded URL, not by a flag. The hidden audio worker
 * is resizable too, so "the resizable one" picks whichever of the two happens
 * to exist first and would send the message into a window with no UI.
 *
 * Driving the renderer through its real channels is how the live-state behavior
 * is tested without a provider key: `session:start` needs credentials this suite
 * has no way to supply, and asserting the panel against a session that never
 * starts would assert nothing.
 */
export async function pushToDashboard(
  app: ElectronApplication,
  channel: string,
  payload: unknown,
): Promise<void> {
  const delivered = await app.evaluate(
    ({ BrowserWindow }, args) => {
      const dashboard = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes('dashboard'),
      );
      if (!dashboard) return false;
      dashboard.webContents.send(args.channel, args.payload);
      return true;
    },
    { channel, payload },
  );
  if (!delivered) throw new Error(`No Dashboard window to receive ${channel}.`);
}
