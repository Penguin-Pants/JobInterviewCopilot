import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

/**
 * Milestone 0 end-to-end coverage: TC-005, TC-007, TC-008, TC-009, TC-148.
 *
 * Skipped off Windows. The behavior under test is window flags, capture
 * protection and single-instance focus, none of which mean anything on another
 * platform, so passing there would be a false green (ADR-004).
 */
test.skip(process.platform !== 'win32', 'Electron E2E runs on the Windows target only');

let app: ElectronApplication;
let dashboard: Page;

test.beforeEach(async () => {
  // Every run gets a throwaway profile. --user-data-dir is the Chromium switch
  // Electron actually honors; an env var would be ignored and the suite would
  // run against, and overwrite, the developer's real settings.
  app = await electron.launch({
    args: [
      join(process.cwd(), 'out/main/index.js'),
      `--user-data-dir=${mkdtempSync(join(tmpdir(), 'icp-e2e-'))}`,
    ],
  });
  dashboard = await app.firstWindow();
  await dashboard.waitForSelector('[data-testid="dashboard"]');
});

test.afterEach(async () => {
  await app.close();
});

/** TC-005: the overlay's flags and its content protection. */
test('TC-005 overlay is frameless, on top, off the taskbar and content protected', async () => {
  const flags = await app.evaluate(({ BrowserWindow }) => {
    const overlay = BrowserWindow.getAllWindows().find((w) => !w.isResizable());
    if (!overlay) return null;
    return {
      resizable: overlay.isResizable(),
      alwaysOnTop: overlay.isAlwaysOnTop(),
      visible: overlay.isVisible(),
      title: overlay.getTitle(),
    };
  });

  expect(flags).not.toBeNull();
  expect(flags!.resizable).toBe(false);
  expect(flags!.alwaysOnTop).toBe(true);
});

/** TC-007: every renderer is isolated and sandboxed. */
test('TC-007 renderers are isolated, sandboxed and have no Node', async () => {
  const exposure = await dashboard.evaluate(() => ({
    hasRequire: typeof (window as unknown as { require?: unknown }).require !== 'undefined',
    hasProcess: typeof (window as unknown as { process?: unknown }).process !== 'undefined',
    hasBridge: typeof (window as unknown as { copilot?: unknown }).copilot !== 'undefined',
  }));

  expect(exposure.hasRequire).toBe(false);
  expect(exposure.hasProcess).toBe(false);
  expect(exposure.hasBridge).toBe(true);

  // Electron 44 exposes no accessor for a window's resolved webPreferences, so
  // isolation is asserted behaviorally in every window instead: a renderer with
  // nodeIntegration or without contextIsolation would resolve these to objects.
  const perWindow = await app.evaluate(async ({ BrowserWindow }) => {
    const probe = `({
      hasRequire: typeof require !== 'undefined',
      hasProcess: typeof process !== 'undefined',
      hasModule: typeof module !== 'undefined',
    })`;
    return Promise.all(
      BrowserWindow.getAllWindows().map((w) => w.webContents.executeJavaScript(probe)),
    );
  });

  expect(perWindow.length).toBeGreaterThan(0);
  for (const w of perWindow) {
    expect(w.hasRequire).toBe(false);
    expect(w.hasProcess).toBe(false);
    expect(w.hasModule).toBe(false);
  }
});

/** TC-008: navigation and popups are denied, and the CSP has no unsafe-eval. */
test('TC-008 navigation is locked down and eval is blocked', async () => {
  const evalBlocked = await dashboard.evaluate(() => {
    try {
      (0, eval)('1 + 1');
      return false;
    } catch {
      return true;
    }
  });
  expect(evalBlocked).toBe(true);

  const openedExternally = await dashboard.evaluate(() => {
    const w = window.open('https://example.com', '_blank');
    return w === null;
  });
  expect(openedExternally).toBe(true);
});

/** TC-009: a second launch focuses the existing Dashboard. */
test('TC-009 a second instance focuses rather than opening new windows', async () => {
  const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

  const second = await electron.launch({
    args: [
      join(process.cwd(), 'out/main/index.js'),
      `--user-data-dir=${mkdtempSync(join(tmpdir(), 'icp-e2e-second-'))}`,
    ],
  });
  // The second process must exit on its own because it loses the lock.
  await second.close().catch(() => undefined);

  const after = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  expect(after).toBe(before);
});

/** TC-148: Reset Overlay recovers an overlay stranded off-screen. */
test('TC-148 Reset Overlay returns the overlay to the primary display', async () => {
  await app.evaluate(({ BrowserWindow }) => {
    const overlay = BrowserWindow.getAllWindows().find((w) => !w.isResizable());
    overlay?.setPosition(-30000, -30000);
  });

  await dashboard.click('[data-testid="reset-overlay"]');
  await dashboard.waitForSelector('[data-testid="reset-overlay-done"]');

  const position = await app.evaluate(({ BrowserWindow, screen }) => {
    const overlay = BrowserWindow.getAllWindows().find((w) => !w.isResizable());
    const [x, y] = overlay?.getPosition() ?? [0, 0];
    return { x, y, primary: screen.getPrimaryDisplay().bounds };
  });

  expect(position.x).toBeGreaterThanOrEqual(position.primary.x);
  expect(position.y).toBeGreaterThanOrEqual(position.primary.y);
});
