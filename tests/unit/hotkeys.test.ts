import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HotkeyManager, type GlobalShortcutLike } from '../../src/main/hotkeys.js';
import { initLogger } from '../../src/main/logger.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

initLogger({ dir: mkdtempSync(join(tmpdir(), 'icp-hotkey-log-')) });

/** A fake globalShortcut that models Electron's behavior, conflicts included. */
class FakeShortcuts implements GlobalShortcutLike {
  readonly held = new Map<string, () => void>();
  /** Accelerators another application owns. register() returns false for these. */
  readonly takenByOthers = new Set<string>();

  register(accelerator: string, callback: () => void): boolean {
    if (this.takenByOthers.has(accelerator)) return false;
    this.held.set(accelerator, callback);
    return true;
  }
  unregister(accelerator: string): void {
    this.held.delete(accelerator);
  }
  isRegistered(accelerator: string): boolean {
    return this.held.has(accelerator);
  }
  unregisterAll(): void {
    this.held.clear();
  }
  fire(accelerator: string): void {
    this.held.get(accelerator)?.();
  }
}

let shortcuts: FakeShortcuts;
let manager: HotkeyManager;

beforeEach(() => {
  shortcuts = new FakeShortcuts();
  manager = new HotkeyManager(shortcuts);
});

describe('registration', () => {
  it('registers both accelerators from settings', () => {
    expect(manager.register('toggleInteraction', 'Control+Shift+I', () => {}).ok).toBe(true);
    expect(manager.register('togglePause', 'Control+Shift+P', () => {}).ok).toBe(true);
    expect(shortcuts.isRegistered('Control+Shift+I')).toBe(true);
    expect(shortcuts.isRegistered('Control+Shift+P')).toBe(true);
  });

  it('invokes the handler when the accelerator fires', () => {
    const handler = vi.fn();
    manager.register('togglePause', 'Control+Shift+P', handler);
    shortcuts.fire('Control+Shift+P');
    expect(handler).toHaveBeenCalledOnce();
  });
});

/** TC-034: a conflicting rebind keeps the previous binding active. */
describe('TC-034 rebind conflict', () => {
  it('returns an error and leaves the previous accelerator registered', () => {
    manager.register('togglePause', 'Control+Shift+P', () => {});
    shortcuts.takenByOthers.add('Control+Alt+Q');

    const result = manager.rebind('togglePause', 'Control+Alt+Q');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already in use/i);
    expect(shortcuts.isRegistered('Control+Shift+P')).toBe(true);
    expect(manager.current('togglePause')).toBe('Control+Shift+P');
  });

  it('treats register() returning true while the key is not held as a conflict', () => {
    // Some Windows builds report success without granting the key.
    const liar: GlobalShortcutLike = {
      register: () => true,
      unregister: () => {},
      isRegistered: () => false,
      unregisterAll: () => {},
    };
    const m = new HotkeyManager(liar);
    expect(m.register('togglePause', 'Control+Shift+P', () => {}).ok).toBe(false);
  });

  it('a throwing register is reported as a conflict, not a crash', () => {
    const thrower: GlobalShortcutLike = {
      register: () => {
        throw new Error('boom');
      },
      unregister: () => {},
      isRegistered: () => false,
      unregisterAll: () => {},
    };
    const m = new HotkeyManager(thrower);
    expect(m.register('togglePause', 'X', () => {}).ok).toBe(false);
  });
});

/** TC-035: a successful rebind takes effect without a restart. */
describe('TC-035 rebind applies live', () => {
  it('releases the old accelerator and activates the new one', () => {
    const handler = vi.fn();
    manager.register('toggleInteraction', 'Control+Shift+I', handler);

    expect(manager.rebind('toggleInteraction', 'Control+Alt+J').ok).toBe(true);
    expect(shortcuts.isRegistered('Control+Shift+I')).toBe(false);
    expect(shortcuts.isRegistered('Control+Alt+J')).toBe(true);

    shortcuts.fire('Control+Alt+J');
    expect(handler).toHaveBeenCalledOnce();
  });

  it('rebinding to the same accelerator is a no-op that still succeeds', () => {
    manager.register('togglePause', 'Control+Shift+P', () => {});
    expect(manager.rebind('togglePause', 'Control+Shift+P').ok).toBe(true);
    expect(shortcuts.isRegistered('Control+Shift+P')).toBe(true);
  });

  it('refuses to rebind an action that was never registered', () => {
    expect(manager.rebind('togglePause', 'F8').ok).toBe(false);
  });
});

describe('lifecycle', () => {
  it('reregisterAll restores a binding another process stole and released', () => {
    manager.register('toggleInteraction', 'Control+Shift+I', () => {});
    shortcuts.unregister('Control+Shift+I');

    manager.reregisterAll();
    expect(shortcuts.isRegistered('Control+Shift+I')).toBe(true);
  });

  it('disposeAll releases everything, as will-quit requires', () => {
    manager.register('toggleInteraction', 'Control+Shift+I', () => {});
    manager.register('togglePause', 'Control+Shift+P', () => {});

    manager.disposeAll();

    expect(shortcuts.held.size).toBe(0);
    expect(manager.current('togglePause')).toBeUndefined();
  });
});

/**
 * FR-009 / FR-030 regression: a binding that lost a conflict at startup was
 * forgotten, so Reset Overlay's reregisterAll had nothing to retry. That
 * defeated the recovery path for exactly the case Reset Overlay exists for.
 */
describe('FR-009 startup conflicts are retried, not forgotten', () => {
  it('remembers the desired accelerator even when registration fails', () => {
    shortcuts.takenByOthers.add('Control+Shift+I');

    const result = manager.register('toggleInteraction', 'Control+Shift+I', () => {});

    expect(result.ok).toBe(false);
    expect(manager.current('toggleInteraction')).toBeUndefined();
    expect(manager.desiredFor('toggleInteraction')).toBe('Control+Shift+I');
  });

  it('reregisterAll takes the accelerator once the conflict clears', () => {
    const handler = vi.fn();
    shortcuts.takenByOthers.add('Control+Shift+I');
    manager.register('toggleInteraction', 'Control+Shift+I', handler);

    // The other application releases the key.
    shortcuts.takenByOthers.delete('Control+Shift+I');
    manager.reregisterAll();

    expect(shortcuts.isRegistered('Control+Shift+I')).toBe(true);
    expect(manager.current('toggleInteraction')).toBe('Control+Shift+I');

    shortcuts.fire('Control+Shift+I');
    expect(handler).toHaveBeenCalledOnce();
  });

  it('leaves a still-conflicting accelerator unregistered without throwing', () => {
    shortcuts.takenByOthers.add('Control+Shift+P');
    manager.register('togglePause', 'Control+Shift+P', () => {});

    expect(() => manager.reregisterAll()).not.toThrow();
    expect(manager.current('togglePause')).toBeUndefined();
  });
});
