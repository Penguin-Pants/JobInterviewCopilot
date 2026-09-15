import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertBackupDiffersFromPrimary,
  clampSettings,
  ConfigStore,
  migrate,
  pruneCorruptFiles,
  quarantineCorruptFile,
  quarantineIfCorrupt,
} from '../../src/main/config.js';
import { defaultSettings } from '../../src/shared/defaults.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'icp-settings-'));
}

/** TC-030: fresh settings match every documented default exactly. */
describe('TC-030 defaults', () => {
  it('matches docs/02-architecture.md section 2.1', () => {
    const s = defaultSettings();
    expect(s.schemaVersion).toBe(1);
    expect(s.providers.stt.primary).toEqual({ providerId: 'deepgram', modelId: 'nova-3' });
    expect(s.providers.stt.backup).toBeNull();
    expect(s.providers.llm.primary).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-haiku-4-5-20251001',
    });
    expect(s.theme.mode).toBe('system');
    expect(s.theme.accent).toBe('#6366F1');
    expect(s.theme.overlayOpacity).toBe(0.85);
    expect(s.theme.overlayFontSizePx).toBe(22);
    expect(s.hotkeys.toggleInteraction).toBe('Control+Shift+I');
    expect(s.hotkeys.togglePause).toBe('Control+Shift+P');
    expect(s.trigger.turnEndGapMs).toBe(800);
    expect(s.trigger.minTurnWords).toBe(3);
    expect(s.trigger.minTurnChars).toBe(12);
    expect(s.trigger.candidateContextTurns).toBe(2);
    expect(s.trigger.candidateContextChars).toBe(400);
    expect(s.thresholds.costUsd).toBe(2.0);
    expect(s.thresholds.timeMinutes).toBe(60);
    expect(s.firstRun.modelDownloaded).toBe(false);
  });

  it('default consent copy states that transcripts are unencrypted and kept (FR-007, FR-110)', () => {
    const text = defaultSettings().consentReminderText.toLowerCase();
    expect(text).toContain('transcript');
    expect(text).toContain('unencrypted');
    expect(text).toContain('no audio');
  });
});

/** TC-031: a corrupt file is quarantined with a Windows-safe name, never deleted. */
describe('TC-031 corrupt settings recovery', () => {
  it('renames rather than deletes, and the original content survives', () => {
    const dir = tmp();
    const file = join(dir, 'settings.json');
    writeFileSync(file, '{ this is not json', 'utf8');

    const result = quarantineIfCorrupt(dir);
    expect(result).not.toBeNull();
    expect(readFileSync(result!.path, 'utf8')).toBe('{ this is not json');
  });

  it('quarantine name is filesystem-safe on Windows: no colon (FR-033)', () => {
    const dir = tmp();
    const file = join(dir, 'settings.json');
    writeFileSync(file, 'garbage', 'utf8');

    const target = quarantineCorruptFile(dir, file, 1_757_000_000_000);
    const base = target.split(/[\\/]/).pop() ?? '';

    expect(base).toBe('settings.corrupt-1757000000000.json');
    expect(base).not.toContain(':');
    // The ISO form this replaced would have failed on Windows.
    expect(new Date(1_757_000_000_000).toISOString()).toContain(':');
  });

  it('a schema-invalid file is quarantined too, not just unparseable JSON', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ schemaVersion: 1, nope: true }));
    expect(quarantineIfCorrupt(dir)?.reason).toContain('schema invalid');
  });

  it('a valid file is left alone', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(defaultSettings()));
    expect(quarantineIfCorrupt(dir)).toBeNull();
  });
});

/** TC-032: the migration chain runs from a fake version 0. */
describe('TC-032 migration chain', () => {
  it('stamps schemaVersion 1 onto a version 0 shape', () => {
    const migrated = migrate({ activeProfileId: 'x' });
    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.activeProfileId).toBe('x');
  });

  it('leaves a current-version object untouched', () => {
    const input = { schemaVersion: 1, a: 1 };
    expect(migrate(input)).toEqual(input);
  });
});

/** TC-033: out-of-range values are clamped, not rejected. */
describe('TC-033 clamping', () => {
  it('clamps opacity, font size and turn gap to their documented ranges', () => {
    const s = defaultSettings();
    s.theme.overlayOpacity = 5.0;
    s.theme.overlayFontSizePx = 4;
    s.trigger.turnEndGapMs = 99;

    const clamped = clampSettings(s);
    expect(clamped.theme.overlayOpacity).toBe(1.0);
    expect(clamped.theme.overlayFontSizePx).toBe(16);
    expect(clamped.trigger.turnEndGapMs).toBe(500);
  });

  it('clamps the low and high ends symmetrically', () => {
    const s = defaultSettings();
    s.theme.overlayOpacity = 0.01;
    s.theme.overlayFontSizePx = 999;
    s.trigger.turnEndGapMs = 9999;

    const clamped = clampSettings(s);
    expect(clamped.theme.overlayOpacity).toBe(0.3);
    expect(clamped.theme.overlayFontSizePx).toBe(32);
    expect(clamped.trigger.turnEndGapMs).toBe(1500);
  });

  it('a non-finite value falls to the minimum rather than propagating NaN', () => {
    const s = defaultSettings();
    s.theme.overlayOpacity = Number.NaN;
    expect(clampSettings(s).theme.overlayOpacity).toBe(0.3);
  });
});

/** TC-025: a backup must be a different provider from the primary. */
describe('TC-025 backup differs from primary', () => {
  it('rejects a backup on the same provider, even with a different model', () => {
    const s = defaultSettings();
    s.providers.stt.backup = { providerId: 'deepgram', modelId: 'nova-2' };
    expect(() => assertBackupDiffersFromPrimary(s)).toThrow(/must differ/i);
  });

  it('accepts a backup on a different provider', () => {
    const s = defaultSettings();
    s.providers.stt.backup = { providerId: 'openai', modelId: 'gpt-4o-transcribe' };
    expect(() => assertBackupDiffersFromPrimary(s)).not.toThrow();
  });

  it('is enforced at the config layer, not only in the UI', () => {
    const store = new ConfigStore({ dir: tmp() });
    expect(() =>
      store.set({
        providers: {
          stt: {
            primary: { providerId: 'deepgram', modelId: 'nova-3' },
            backup: { providerId: 'deepgram', modelId: 'nova-2' },
          },
          llm: {
            primary: { providerId: 'anthropic', modelId: 'claude-haiku-4-5-20251001' },
            backup: null,
          },
        },
      }),
    ).toThrow(/must differ/i);
  });
});

/** TC-147: at most three quarantined settings files are kept. */
describe('TC-147 corrupt-file retention', () => {
  it('keeps three and deletes the oldest when a fourth appears', () => {
    const dir = tmp();
    for (const stamp of [1000, 2000, 3000, 4000]) {
      writeFileSync(join(dir, `settings.corrupt-${stamp}.json`), 'x', 'utf8');
    }
    pruneCorruptFiles(dir);

    const remaining = readdirSync(dir)
      .filter((n) => n.startsWith('settings.corrupt-'))
      .sort();
    expect(remaining).toHaveLength(3);
    expect(remaining).not.toContain('settings.corrupt-1000.json');
    expect(remaining).toContain('settings.corrupt-4000.json');
  });
});

describe('ConfigStore round trip', () => {
  it('persists a patch and clamps it on the way in', () => {
    const dir = tmp();
    const store = new ConfigStore({ dir });
    const updated = store.set({
      theme: { ...store.get().theme, overlayFontSizePx: 99 },
    });
    expect(updated.theme.overlayFontSizePx).toBe(32);
    expect(new ConfigStore({ dir }).get().theme.overlayFontSizePx).toBe(32);
  });

  it('reports the corrupt file through onCorrupt and recovers to defaults', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'settings.json'), 'not json', 'utf8');

    const seen: string[] = [];
    const store = new ConfigStore({ dir, onCorrupt: (_p, reason) => seen.push(reason) });

    expect(seen).toHaveLength(1);
    expect(store.get().theme.overlayFontSizePx).toBe(22);
  });
});
