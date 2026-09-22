import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertBackupDiffersFromPrimary,
  clampSettings,
  ConfigStore,
  CURRENT_SCHEMA_VERSION,
  dropInvalidBackups,
  migrate,
  pruneCorruptFiles,
  quarantineCorruptFile,
  quarantineIfCorrupt,
} from '../../src/main/config.js';
import { defaultSettings, SETTINGS_LIMITS } from '../../src/shared/defaults.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'icp-settings-'));
}

/** TC-030: fresh settings match every documented default exactly. */
describe('TC-030 defaults', () => {
  it('matches docs/02-architecture.md section 2.1', () => {
    const s = defaultSettings();
    expect(s.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(s.providers.stt.primary).toEqual({ providerId: 'deepgram', modelId: 'nova-3' });
    expect(s.providers.stt.backup).toBeNull();
    expect(s.providers.llm.primary).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-haiku-4-5-20251001',
    });
    expect(s.llmModelCutoffs).toEqual({ openai: null, anthropic: null });
    expect(s.customPrompts).toEqual([]);
    expect(s.profilePromptIds).toEqual({});
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

  it('migrates a version 6 reserved prompt name instead of quarantining the file', () => {
    const dir = tmp();
    const settings = {
      ...defaultSettings(),
      schemaVersion: 6,
      customPrompts: [{ id: 'one', name: 'Default prompt', systemPrompt: 'Keep this.' }],
    };
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));

    expect(quarantineIfCorrupt(dir)).toBeNull();
  });
});

/** TC-032: the migration chain runs from a fake version 0. */
describe('TC-032 migration chain', () => {
  it('runs a version 0 shape all the way to the current version', () => {
    const migrated = migrate({ activeProfileId: 'x' });
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.activeProfileId).toBe('x');
  });

  it('leaves a current-version object untouched', () => {
    const input = { schemaVersion: CURRENT_SCHEMA_VERSION, a: 1 };
    expect(migrate(input)).toEqual(input);
  });

  /**
   * 1 -> 2: the overlay became resizable (FR-081, TASK-052).
   *
   * The stored size is null, not the default numbers. A user upgrading has
   * never resized, so they follow the shipped default rather than being pinned
   * to whatever it happened to be on the day they upgraded.
   */
  it('adds a null overlay size to a version 1 file and keeps its position', () => {
    const migrated = migrate({
      schemaVersion: 1,
      overlayWindow: { x: 100, y: 200, displayId: '2' },
    });

    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.overlayWindow).toEqual({
      x: 100,
      y: 200,
      width: null,
      height: null,
      displayId: '2',
      // Added by the 2 -> 3 step in the same chain run.
      clickThrough: true,
    });
  });

  /**
   * 2 -> 3: click-through became a setting (FR-083, TASK-053).
   *
   * True for everyone upgrading, because that is what the overlay already did.
   * Making it block what it covers is a change the user asks for, never one an
   * upgrade makes for them.
   */
  it('defaults an upgraded file to click-through, and keeps an explicit choice', () => {
    expect(migrate({ schemaVersion: 2, overlayWindow: {} }).overlayWindow).toMatchObject({
      clickThrough: true,
    });
    expect(
      migrate({ schemaVersion: 2, overlayWindow: { clickThrough: false } }).overlayWindow,
    ).toMatchObject({ clickThrough: false });
  });

  it('does not overwrite a size that is already stored', () => {
    const migrated = migrate({
      schemaVersion: 1,
      overlayWindow: { x: 0, y: 0, width: 800, height: 600, displayId: '1' },
    });
    expect(migrated.overlayWindow).toMatchObject({ width: 800, height: 600 });
  });

  it('shows every language model by default when upgrading a version 4 file', () => {
    const migrated = migrate({ schemaVersion: 4 });
    expect(migrated.llmModelCutoffs).toEqual({ openai: null, anthropic: null });
  });

  it('keeps existing profiles on the shipped prompt when upgrading a version 5 file', () => {
    const migrated = migrate({ schemaVersion: 5 });
    expect(migrated.customPrompts).toEqual([]);
    expect(migrated.profilePromptIds).toEqual({});
  });

  it('renames a version 6 custom prompt that uses the newly reserved name', () => {
    const migrated = migrate({
      schemaVersion: 6,
      customPrompts: [
        { id: 'one', name: ' DEFAULT PROMPT ', systemPrompt: 'First' },
        { id: 'two', name: 'Default prompt (custom)', systemPrompt: 'Second' },
      ],
    });

    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.customPrompts).toEqual([
      { id: 'one', name: 'Default prompt (custom 2)', systemPrompt: 'First' },
      { id: 'two', name: 'Default prompt (custom)', systemPrompt: 'Second' },
    ]);
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

  /**
   * The overlay size is nullable, and null is the shipped default rather than
   * an out-of-range number (FR-081, TASK-052). Clamping it to the minimum would
   * pin every never-resized overlay to 320 by 180 on the first load after the
   * upgrade.
   */
  it('leaves an unset overlay size unset', () => {
    const clamped = clampSettings(defaultSettings());
    expect(clamped.overlayWindow.width).toBeNull();
    expect(clamped.overlayWindow.height).toBeNull();
  });

  it('clamps a stored overlay size to its documented range', () => {
    const s = defaultSettings();
    s.overlayWindow = { ...s.overlayWindow, width: 99_999, height: 10 };

    const clamped = clampSettings(s);
    expect(clamped.overlayWindow.width).toBe(SETTINGS_LIMITS.overlayWidthPx.max);
    expect(clamped.overlayWindow.height).toBe(SETTINGS_LIMITS.overlayHeightPx.min);
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

/**
 * FR-025 regression: the separation invariant was only enforced by set(), so a
 * schema-valid file naming the same provider for primary and backup loaded
 * cleanly. The app would then run with a "backup" sharing the failing service
 * and credential, until some later write happened to throw.
 */
describe('FR-025 provider separation is enforced on load', () => {
  it('clears a backup that matches its primary', () => {
    const s = defaultSettings();
    s.providers.stt.backup = { providerId: 'deepgram', modelId: 'nova-2' };
    s.providers.llm.backup = { providerId: 'openai', modelId: 'gpt-4o-mini' };

    const dropped = dropInvalidBackups(s);

    expect(dropped.providers.stt.backup).toBeNull();
    // A genuinely different provider is left alone.
    expect(dropped.providers.llm.backup).toEqual({ providerId: 'openai', modelId: 'gpt-4o-mini' });
  });

  it('reports which capability was cleared', () => {
    const s = defaultSettings();
    s.providers.llm.backup = { providerId: 'anthropic', modelId: 'other' };

    const seen: string[] = [];
    dropInvalidBackups(s, (capability) => seen.push(capability));

    expect(seen).toEqual(['llm']);
  });

  it('a file written by hand with a duplicate backup still starts, cleaned', () => {
    const dir = tmp();
    const bad = defaultSettings();
    bad.providers.stt.backup = { providerId: 'deepgram', modelId: 'nova-2' };
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(bad), 'utf8');

    const store = new ConfigStore({ dir });

    expect(store.get().providers.stt.backup).toBeNull();
  });
});
