import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initLogger } from '../../src/main/logger.js';

initLogger({ dir: mkdtempSync(join(tmpdir(), 'icp-navigation-')) });

/**
 * Audit regression (FR-086, TC-008): a popup's URL went to `shell.openExternal`
 * whatever its scheme, so a renderer could open `file:`, `ms-settings:` or any
 * registered protocol handler. A server redirect was not covered at all,
 * because only `will-navigate` was handled.
 */

const shell = vi.hoisted(() => ({ openExternal: vi.fn(() => Promise.resolve()) }));
vi.mock('electron', () => ({ shell, screen: {}, BrowserWindow: class {} }));

const { applyNavigationLockdown, isExternalLinkAllowed } =
  await import('../../src/main/windows.js');

type Listener = (event: { preventDefault: () => void }, url: string) => void;

function fakeWindow(currentUrl: string): {
  win: Parameters<typeof applyNavigationLockdown>[0];
  open: (url: string) => unknown;
  emit: (name: string, url: string) => boolean;
} {
  let openHandler: (details: { url: string }) => unknown = () => undefined;
  const listeners = new Map<string, Listener>();
  const win = {
    webContents: {
      setWindowOpenHandler: (h: typeof openHandler) => {
        openHandler = h;
      },
      on: (name: string, l: Listener) => listeners.set(name, l),
      getURL: () => currentUrl,
    },
  } as unknown as Parameters<typeof applyNavigationLockdown>[0];
  return {
    win,
    open: (url) => openHandler({ url }),
    /** Fires an event and reports whether the listener prevented it. */
    emit: (name, url) => {
      let prevented = false;
      listeners.get(name)?.({ preventDefault: () => (prevented = true) }, url);
      return prevented;
    },
  };
}

beforeEach(() => shell.openExternal.mockClear());

describe('external links', () => {
  it('allows https and nothing else', () => {
    expect(isExternalLinkAllowed('https://example.com/docs')).toBe(true);
    for (const url of [
      'http://example.com',
      'file:///C:/Windows/System32/calc.exe',
      'ms-settings:privacy',
      'javascript:alert(1)',
      'smb://host/share',
      'not a url',
    ]) {
      expect(isExternalLinkAllowed(url), url).toBe(false);
    }
  });

  it('opens an https popup in the browser and never in the app', () => {
    const fake = fakeWindow('file:///app/out/renderer/dashboard/index.html');
    applyNavigationLockdown(fake.win);

    expect(fake.open('https://example.com')).toEqual({ action: 'deny' });
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com');
  });

  it('refuses a popup on any other scheme without opening it', () => {
    const fake = fakeWindow('file:///app/out/renderer/dashboard/index.html');
    applyNavigationLockdown(fake.win);

    expect(fake.open('file:///C:/Windows/System32/calc.exe')).toEqual({ action: 'deny' });
    expect(fake.open('ms-settings:privacy')).toEqual({ action: 'deny' });
    expect(shell.openExternal).not.toHaveBeenCalled();
  });
});

describe('navigation and redirects', () => {
  it('blocks a redirect away from the page exactly as it blocks a navigation', () => {
    const page = 'file:///app/out/renderer/overlay/index.html';
    const fake = fakeWindow(page);
    applyNavigationLockdown(fake.win);

    for (const event of ['will-navigate', 'will-redirect']) {
      expect(fake.emit(event, 'https://attacker.example/'), event).toBe(true);
      expect(fake.emit(event, page), event).toBe(false);
    }
  });
});
