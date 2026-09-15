import { existsSync, readdirSync, readFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import ElectronStoreImport from 'electron-store';

/**
 * electron-store's generic requires an index signature, which `Settings`
 * deliberately does not have: an index signature would let any key be written
 * and defeat the schema. The store is therefore typed loosely and the two
 * boundary reads and writes are cast, with `settingsSchema` validating both
 * directions so the cast can never smuggle in a bad shape.
 */
type StoreShape = Record<string, unknown>;
type ElectronStoreInstance = InstanceType<typeof ElectronStoreImport<StoreShape>>;
import { defaultSettings, SETTINGS_LIMITS } from '../shared/defaults.js';
import { settingsSchema } from '../shared/ipc.js';
import type { Settings } from '../shared/types.js';

/**
 * Non-secret settings (CMP-02, FR-020, FR-029 to FR-033, FR-036).
 *
 * Persistence is electron-store, as FR-020 requires. The schema, migration,
 * clamping and quarantine logic live in exported pure functions above the store
 * so they are unit testable without an Electron runtime.
 *
 * Secrets never appear here. They live in secrets.bin behind safeStorage
 * (FR-021) and no code path in this file reads or writes them.
 */

/**
 * Interop guard for electron-store, which is ESM-only (FR-020).
 *
 * The main process ships as a CommonJS bundle, so this import compiles to
 * `require('electron-store')`. Under Node's require(ESM) interop that yields the
 * module namespace object, `{ __esModule, default }`, not the class. Calling
 * `new` on it throws "is not a constructor" at startup, which kills the app
 * before any window opens and shows up only as a window-never-appeared timeout.
 *
 * Bundlers and test runners resolve the default export for you, so this is
 * invisible until the packaged CommonJS build actually runs. TC-037 pins it.
 */
const ElectronStore = ((ElectronStoreImport as unknown as { default?: unknown }).default ??
  ElectronStoreImport) as typeof ElectronStoreImport;

const MAX_CORRUPT_FILES = 3;

/** Bump when the Settings shape changes, and add a step to MIGRATIONS. */
export const CURRENT_SCHEMA_VERSION = 1;

type UnknownRecord = Record<string, unknown>;

/**
 * Migration chain. Version 1 is the baseline so the chain has only the step
 * that stamps it, but the mechanism exists and is exercised by a fake version 0
 * in tests (TC-032). Each step takes the previous shape and returns the next.
 */
export const MIGRATIONS: Record<number, (input: UnknownRecord) => UnknownRecord> = {
  // 0 -> 1: the pre-release shape had no schemaVersion field.
  0: (input) => ({ ...input, schemaVersion: 1 }),
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Clamp out-of-range values rather than rejecting them (FR-033, TC-033).
 * A user who types 5.0 for opacity gets 1.0, not a failed load.
 */
export function clampSettings(settings: Settings): Settings {
  const limits = SETTINGS_LIMITS;
  return {
    ...settings,
    theme: {
      ...settings.theme,
      overlayOpacity: clamp(
        settings.theme.overlayOpacity,
        limits.overlayOpacity.min,
        limits.overlayOpacity.max,
      ),
      overlayFontSizePx: Math.round(
        clamp(
          settings.theme.overlayFontSizePx,
          limits.overlayFontSizePx.min,
          limits.overlayFontSizePx.max,
        ),
      ),
    },
    trigger: {
      ...settings.trigger,
      turnEndGapMs: Math.round(
        clamp(settings.trigger.turnEndGapMs, limits.turnEndGapMs.min, limits.turnEndGapMs.max),
      ),
    },
  };
}

/** Run the migration chain from the file's claimed version up to current. */
export function migrate(raw: UnknownRecord): UnknownRecord {
  let current = raw;
  let version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0;
  while (version < CURRENT_SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) break;
    current = step(current);
    version += 1;
  }
  return current;
}

/**
 * Quarantine a corrupt settings file.
 *
 * The name uses epoch milliseconds, not an ISO 8601 timestamp: ISO contains
 * colons, which are illegal in Windows file names, so an ISO name would throw
 * at exactly the moment the app is recovering from corruption (FR-033, TC-031).
 * The original is renamed, never deleted. At most three are kept (FR-036).
 */
export function quarantineCorruptFile(dir: string, file: string, now = Date.now()): string {
  let target = join(dir, `settings.corrupt-${now}.json`);
  let suffix = 0;
  while (existsSync(target)) {
    suffix += 1;
    target = join(dir, `settings.corrupt-${now + suffix}.json`);
  }
  renameSync(file, target);
  pruneCorruptFiles(dir);
  return target;
}

/** Keep at most three quarantined files, oldest deleted first (FR-036, TC-147). */
export function pruneCorruptFiles(dir: string): void {
  const entries = readdirSync(dir)
    .filter((n) => /^settings\.corrupt-\d+\.json$/.test(n))
    .map((n) => ({ name: n, stamp: Number(/\d+/.exec(n)?.[0] ?? '0') }))
    .sort((a, b) => a.stamp - b.stamp);

  while (entries.length > MAX_CORRUPT_FILES) {
    const oldest = entries.shift();
    if (!oldest) break;
    try {
      unlinkSync(join(dir, oldest.name));
    } catch {
      // A file we cannot remove is not worth failing settings recovery over.
    }
  }
}

/**
 * A backup must be a different provider from the primary. A different model on
 * the same provider is not a backup: the credential and the service are the
 * same, so it fails for the same reason at the same moment (FR-025, TC-025).
 */
export function assertBackupDiffersFromPrimary(settings: Settings): void {
  for (const capability of ['stt', 'llm'] as const) {
    const { primary, backup } = settings.providers[capability];
    if (backup && backup.providerId === primary.providerId) {
      throw new Error(
        `${capability} backup provider must differ from the primary. A different model on ` +
          `${primary.providerId} shares its credential and is not a backup (FR-025).`,
      );
    }
  }
}

/**
 * Clear any backup that names the same provider as its primary (FR-025).
 * Used on load, where throwing would leave the user unable to start the app.
 */
export function dropInvalidBackups(
  settings: Settings,
  onDropped?: (capability: 'stt' | 'llm') => void,
): Settings {
  const next = structuredClone(settings);
  for (const capability of ['stt', 'llm'] as const) {
    const { primary, backup } = next.providers[capability];
    if (backup && backup.providerId === primary.providerId) {
      next.providers[capability].backup = null;
      onDropped?.(capability);
    }
  }
  return next;
}

function isPlainObject(v: unknown): v is UnknownRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Merge a partial patch into settings. Arrays and nulls replace, they do not merge. */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const out: UnknownRecord = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

/**
 * Inspect settings.json before electron-store opens it.
 *
 * electron-store can clear an invalid config, but clearing deletes it and
 * FR-033 says the original must be kept. So the file is validated here first
 * and quarantined by rename if it is bad, leaving electron-store a clean file.
 *
 * @returns the quarantined path and the reason, or null when the file is fine.
 */
export function quarantineIfCorrupt(dir: string): { path: string; reason: string } | null {
  const file = join(dir, 'settings.json');
  if (!existsSync(file)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return {
      path: quarantineCorruptFile(dir, file),
      reason: `unparseable: ${(err as Error).message}`,
    };
  }

  if (!isPlainObject(parsed)) {
    return { path: quarantineCorruptFile(dir, file), reason: 'not an object' };
  }

  const result = settingsSchema.safeParse(migrate(parsed));
  if (!result.success) {
    return {
      path: quarantineCorruptFile(dir, file),
      reason: `schema invalid: ${result.error.issues.length} issue(s)`,
    };
  }
  return null;
}

export interface ConfigStoreOptions {
  /** Directory holding settings.json. Injected so tests never touch real userData. */
  dir: string;
  onCorrupt?: (quarantinedPath: string, reason: string) => void;
}

/** The settings store (FR-020). */
export class ConfigStore {
  private readonly store: ElectronStoreInstance;

  constructor(options: ConfigStoreOptions) {
    mkdirSync(options.dir, { recursive: true });

    const corrupt = quarantineIfCorrupt(options.dir);
    if (corrupt) options.onCorrupt?.(corrupt.path, corrupt.reason);

    // The Settings object is the whole file, not a value nested under a key.
    // settings.json must be exactly the shape quarantineIfCorrupt validates,
    // otherwise a valid file looks corrupt on the next launch.
    this.store = new ElectronStore<StoreShape>({
      cwd: options.dir,
      name: 'settings',
      defaults: defaultSettings() as unknown as StoreShape,
    });

    // Migrate and clamp whatever survived, then write it back once.
    const parsed = settingsSchema.safeParse(migrate(this.store.store as UnknownRecord));
    let settled = parsed.success ? clampSettings(parsed.data as Settings) : defaultSettings();

    // The separation invariant has to hold on load too. A hand-edited or
    // badly migrated file can be schema-valid while naming the same provider
    // for primary and backup, which would start the app with a "backup" that
    // shares the failing service and credential (FR-025). Drop the offending
    // backup rather than refusing to start.
    settled = dropInvalidBackups(settled, (capability) =>
      options.onCorrupt?.(
        this.pathFor(options.dir),
        `${capability} backup matched its primary provider and was cleared (FR-025)`,
      ),
    );
    this.store.store = settled as unknown as StoreShape;
  }

  private pathFor(dir: string): string {
    return join(dir, 'settings.json');
  }

  /** The whole settings object. Never contains a secret (FR-021). */
  get(): Settings {
    return structuredClone(this.store.store) as unknown as Settings;
  }

  /** Merge a partial update, validate it, clamp it and persist it. */
  set(patch: Partial<Settings>): Settings {
    const merged = deepMerge(this.get(), patch) as Settings;
    assertBackupDiffersFromPrimary(merged);
    const validated = settingsSchema.parse(clampSettings(merged)) as Settings;
    this.store.store = validated as unknown as StoreShape;
    return structuredClone(validated);
  }

  /** Absolute path of settings.json. Used by tests and by the corrupt-file flow. */
  get path(): string {
    return this.store.path;
  }
}
