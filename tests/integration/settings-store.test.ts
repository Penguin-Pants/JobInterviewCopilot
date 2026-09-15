import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigStore } from '../../src/main/config.js';
import { defaultSettings } from '../../src/shared/defaults.js';

/**
 * TC-031 end to end through the real electron-store backing file, so the
 * quarantine path is proven against the store FR-020 actually names.
 */

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'icp-store-'));
}

describe('TC-031 settings store recovery through electron-store', () => {
  it('quarantines a corrupt file, keeps the original, and starts from defaults', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'settings.json'), '{{{ broken', 'utf8');

    const store = new ConfigStore({ dir });

    const quarantined = readdirSync(dir).filter((n) => /^settings\.corrupt-\d+\.json$/.test(n));
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(dir, quarantined[0]!), 'utf8')).toBe('{{{ broken');
    expect(store.get()).toEqual(defaultSettings());
  });

  it('the quarantine name would be creatable on Windows', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'settings.json'), 'broken', 'utf8');
    new ConfigStore({ dir });

    const name = readdirSync(dir).find((n) => n.startsWith('settings.corrupt-'))!;
    // < > : " / \ | ? * are all illegal in a Windows file name.
    expect(name).not.toMatch(/[<>:"/\\|?*]/);
  });

  it('survives a settings.json that is valid JSON but the wrong shape', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hello: 'world' }), 'utf8');

    const store = new ConfigStore({ dir });

    expect(store.get().schemaVersion).toBe(1);
    expect(readdirSync(dir).some((n) => n.startsWith('settings.corrupt-'))).toBe(true);
  });

  it('persists across store instances', () => {
    const dir = tmp();
    new ConfigStore({ dir }).set({ theme: { ...defaultSettings().theme, mode: 'dark' } });
    expect(new ConfigStore({ dir }).get().theme.mode).toBe('dark');
  });
});

/**
 * TC-037: electron-store must be usable from the CommonJS bundle.
 *
 * Regression test for a startup crash that only appeared in the packaged app.
 * electron-store is ESM-only, the main process ships as CommonJS, and Node's
 * require(ESM) interop hands back the module namespace object rather than the
 * class. `new` on that throws at startup, so the app died before opening a
 * window and the E2E suite saw only "no window appeared" timeouts.
 *
 * Vitest and the bundler both resolve the default export transparently, so a
 * plain import cannot catch this. The require path has to be asserted directly.
 */
describe('TC-037 electron-store CommonJS interop', () => {
  it('require() yields a namespace object, not the constructor', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const required = require('electron-store') as unknown;

    // If this ever becomes a function upstream, the guard is harmless.
    // If it stays an object, the guard is the only thing keeping the app alive.
    if (typeof required === 'object' && required !== null) {
      expect(() => new (required as new () => unknown)()).toThrow(/not a constructor/);
      expect(typeof (required as { default?: unknown }).default).toBe('function');
    } else {
      expect(typeof required).toBe('function');
    }
  });

  it('ConfigStore constructs and persists, which is what the guard protects', () => {
    const dir = tmp();
    const store = new ConfigStore({ dir });
    store.set({ theme: { ...store.get().theme, overlayFontSizePx: 28 } });
    expect(new ConfigStore({ dir }).get().theme.overlayFontSizePx).toBe(28);
  });
});
