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
