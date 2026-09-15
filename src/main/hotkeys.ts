import { getLogger } from './logger.js';

/**
 * Global hotkeys (CMP-11, FR-030, FR-053, FR-084).
 *
 * This component registers accelerators and reports conflicts. It does not
 * interpret application state: what pausing means is the trigger's business,
 * this module only knows an accelerator fired.
 */

export type HotkeyAction = 'toggleInteraction' | 'togglePause';

/** The Electron globalShortcut surface, injected so it can be faked in tests. */
export interface GlobalShortcutLike {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
  isRegistered(accelerator: string): boolean;
  unregisterAll(): void;
}

export interface RebindResult {
  ok: boolean;
  error?: string;
}

export class HotkeyManager {
  /** Accelerators currently held by this app. */
  private readonly bindings = new Map<HotkeyAction, string>();
  /**
   * Accelerators the user wants, whether or not registration succeeded.
   *
   * Kept separately because a startup conflict used to be forgotten entirely:
   * the handler was stored but the accelerator was not, so `reregisterAll` had
   * nothing to retry and Reset Overlay could not recover the very case it
   * exists for (FR-009, FR-030).
   */
  private readonly desired = new Map<HotkeyAction, string>();
  private readonly handlers = new Map<HotkeyAction, () => void>();

  constructor(private readonly shortcuts: GlobalShortcutLike) {}

  /**
   * Register an action at an accelerator.
   *
   * Electron's register() can return false, and on some Windows builds it
   * returns true while another process holds the key, so the binding is
   * confirmed with isRegistered() before it is accepted (FR-030, TC-034).
   */
  register(action: HotkeyAction, accelerator: string, handler: () => void): RebindResult {
    this.handlers.set(action, handler);
    this.desired.set(action, accelerator);

    let registered: boolean;
    try {
      registered = this.shortcuts.register(accelerator, handler);
    } catch (err) {
      getLogger().warn('hotkey registration threw', { action, accelerator, err });
      return { ok: false, error: describeConflict(accelerator) };
    }

    if (!registered || !this.shortcuts.isRegistered(accelerator)) {
      // Leave any previous binding untouched. The caller reports the conflict.
      return { ok: false, error: describeConflict(accelerator) };
    }

    this.bindings.set(action, accelerator);
    return { ok: true };
  }

  /**
   * Move an action to a new accelerator, taking effect without a restart.
   *
   * The new binding is registered first. Only once it succeeds is the old one
   * released, so a failed rebind leaves the user with a working hotkey rather
   * than none (FR-030, TC-034, TC-035).
   */
  rebind(action: HotkeyAction, accelerator: string): RebindResult {
    const handler = this.handlers.get(action);
    if (!handler) return { ok: false, error: `No handler registered for ${action}.` };

    const previous = this.bindings.get(action);
    this.desired.set(action, accelerator);
    if (previous === accelerator) return { ok: true };

    // Free the old accelerator only for the duration of the attempt when the
    // new one is the same key held by this app under another action.
    let registered: boolean;
    try {
      registered = this.shortcuts.register(accelerator, handler);
    } catch (err) {
      getLogger().warn('hotkey rebind threw', { action, accelerator, err });
      return { ok: false, error: describeConflict(accelerator) };
    }

    if (!registered || !this.shortcuts.isRegistered(accelerator)) {
      return { ok: false, error: describeConflict(accelerator) };
    }

    if (previous && previous !== accelerator) {
      try {
        this.shortcuts.unregister(previous);
      } catch (err) {
        getLogger().warn('releasing previous accelerator failed', { previous, err });
      }
    }

    this.bindings.set(action, accelerator);
    return { ok: true };
  }

  /** The accelerator currently bound to an action, if any. */
  current(action: HotkeyAction): string | undefined {
    return this.bindings.get(action);
  }

  /** The accelerator the user asked for, even if it could not be registered. */
  desiredFor(action: HotkeyAction): string | undefined {
    return this.desired.get(action);
  }

  /**
   * Retry every accelerator the user asked for, including ones that lost a
   * conflict at startup. This is Reset Overlay's recovery path (FR-009), so it
   * has to work for a binding this app never managed to take.
   */
  reregisterAll(): void {
    for (const [action, accelerator] of [...this.desired.entries()]) {
      const handler = this.handlers.get(action);
      if (!handler) continue;
      try {
        if (this.shortcuts.isRegistered(accelerator)) {
          this.bindings.set(action, accelerator);
          continue;
        }
        if (this.shortcuts.register(accelerator, handler)) {
          this.bindings.set(action, accelerator);
        }
      } catch (err) {
        getLogger().warn('hotkey re-registration failed', { action, accelerator, err });
      }
    }
  }

  /** Release everything. Called on will-quit (FR-030). */
  disposeAll(): void {
    this.shortcuts.unregisterAll();
    this.bindings.clear();
  }
}

function describeConflict(accelerator: string): string {
  return `${accelerator} is already in use by another application. The previous shortcut is still active.`;
}
