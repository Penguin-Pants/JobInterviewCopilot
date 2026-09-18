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

export async function launchApp(reuseUserDataDir?: string): Promise<LaunchedApp> {
  // A caller may hand back a directory from an earlier launch, which is the
  // only way to assert that a setting survives a relaunch rather than merely a
  // reload (`TC-113`). A fresh directory is still the default.
  const userDataDir = reuseUserDataDir ?? mkdtempSync(join(tmpdir(), 'icp-e2e-'));
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
 * The overlay's page, once its renderer has painted (CMP-14, TASK-043).
 *
 * The window is found by its loaded URL, exactly as `pushToDashboard` finds the
 * Dashboard and for the same reason: the hidden audio worker is a real renderer
 * too, so "the one that is not the Dashboard" picks whichever of the two
 * happens to exist first.
 *
 * Waiting for `[data-testid="overlay"]` rather than for the window is what
 * makes the returned page usable: bootstrap creates the overlay and awaits its
 * renderer, so the page exists for the whole of that load with nothing in it.
 *
 * A closed page is skipped, and `replacing` names a page the caller expects to
 * be replaced. A translucency change destroys the overlay and builds a new one
 * (ADR-015), and the destroy happens on the far side of a `config:set` round
 * trip: when `selectOption` returns, the doomed window is still open and still
 * matches, so "the first page whose URL says overlay" hands back the window
 * that is about to disappear. Naming it is what makes the wait mean "the new
 * one" rather than "any one".
 */
export async function overlayPage(app: ElectronApplication, replacing?: Page): Promise<Page> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const page = app
      .windows()
      .find((w) => w !== replacing && !w.isClosed() && w.url().includes('overlay'));
    if (page) {
      await page.waitForSelector('[data-testid="overlay"]');
      return page;
    }
    if (Date.now() > deadline) {
      throw new Error(
        replacing
          ? 'The overlay window was not replaced within 30s.'
          : 'No overlay window appeared within 30s.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Open a Dashboard sidebar tab (`App.tsx`).
 *
 * Every section but Company Profiles sits behind a tab that starts hidden, so
 * a test that reaches into one has to open it first or every Playwright action
 * on its controls times out waiting for something that is not displayed.
 */
export async function openDashboardTab(dashboard: Page, id: string): Promise<void> {
  await dashboard.click(`[data-testid="tab-${id}"]`);
  await dashboard.waitForSelector(`[data-testid="tab-${id}"][aria-selected="true"]`);
}

/**
 * Push a main-to-renderer message into the overlay.
 *
 * The suggestion channels are driven directly for the same reason the
 * Dashboard's live state is: reaching them through a real session needs
 * provider credentials this suite has no way to supply, and asserting a card
 * against a generation that never happens would assert nothing. What is under
 * test here is the renderer, and these are the messages it really receives.
 */
export async function pushToOverlay(
  app: ElectronApplication,
  channel: string,
  payload: unknown,
): Promise<void> {
  const delivered = await app.evaluate(
    ({ BrowserWindow }, args) => {
      const overlay = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes('overlay'),
      );
      if (!overlay) return false;
      overlay.webContents.send(args.channel, args.payload);
      return true;
    },
    { channel, payload },
  );
  if (!delivered) throw new Error(`No overlay window to receive ${channel}.`);
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
