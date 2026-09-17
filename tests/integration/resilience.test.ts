/**
 * TASK-050, TC-130. `NFR-009`: no unhandled rejection and no uncaught exception
 * may terminate a live session.
 *
 * Three levels, because each one can pass while the next fails:
 *
 * 1. The wiring. `installGlobalHandlers` registers both faults and its disposer
 *    removes them again.
 * 2. The runtime. A *genuine* rejection and a *genuine* throw off the call stack
 *    reach the installed handlers and the process carries on. Nothing is
 *    simulated here: the test hands the two faults to Node and lets Node emit.
 * 3. The session. The same faults injected while a session is live leave the
 *    loop running, and the next turn still produces a transcript entry and a
 *    card.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearSttProviders } from '../../src/main/ai/stt.js';
import {
  APP_TEMP_DIR_NAME,
  FAULT_KINDS,
  appOwnedTempEntries,
  installGlobalHandlers,
  useAppOwnedTempDir,
  type FaultEmitter,
  type FaultKind,
} from '../../src/main/resilience.js';
import { readSession } from '../../src/main/session.js';
import { PROFILE, harness, speak, startSession, stopSession } from '../fakes/live-harness.js';

/** Let Node drain its microtasks and run one macrotask turn. */
function nextTick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let userData: string;

beforeEach(() => {
  clearSttProviders();
  userData = mkdtempSync(join(tmpdir(), 'icp-resilience-'));
});

afterEach(() => {
  clearSttProviders();
  rmSync(userData, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * 1. The wiring
 * ------------------------------------------------------------------ */

describe('TC-130 the global fault handlers are installed and removable', () => {
  it('registers both faults and reports each with its kind', () => {
    const emitter = new EventEmitter() as unknown as FaultEmitter;
    const faults: { kind: FaultKind; value: unknown }[] = [];
    const dispose = installGlobalHandlers({
      emitter,
      onFault: (kind, value) => faults.push({ kind, value }),
    });

    const boom = new Error('boom');
    (emitter as unknown as EventEmitter).emit('uncaughtException', boom);
    (emitter as unknown as EventEmitter).emit('unhandledRejection', 'nope');

    expect(faults).toEqual([
      { kind: 'uncaughtException', value: boom },
      { kind: 'unhandledRejection', value: 'nope' },
    ]);
    expect(FAULT_KINDS).toEqual(['uncaughtException', 'unhandledRejection']);

    dispose();
    (emitter as unknown as EventEmitter).emit('uncaughtException', new Error('again'));
    expect(faults).toHaveLength(2);
    expect((emitter as unknown as EventEmitter).listenerCount('uncaughtException')).toBe(0);
    expect((emitter as unknown as EventEmitter).listenerCount('unhandledRejection')).toBe(0);
  });

  it('swallows a sink that throws, because a throw here is what kills the process', () => {
    const emitter = new EventEmitter() as unknown as FaultEmitter;
    const dispose = installGlobalHandlers({
      emitter,
      onFault: () => {
        throw new Error('the logger itself failed');
      },
    });

    expect(() =>
      (emitter as unknown as EventEmitter).emit('uncaughtException', new Error('boom')),
    ).not.toThrow();
    dispose();
  });
});

describe('TASK-050 the app-owned temporary directory', () => {
  it('is created, is pointed at by the process, and reads as empty when absent', () => {
    const env: Record<string, string | undefined> = {};
    const dir = useAppOwnedTempDir(userData, env);

    expect(dir).toBe(join(userData, APP_TEMP_DIR_NAME));
    expect(env).toEqual({ TMPDIR: dir, TEMP: dir, TMP: dir });
    expect(appOwnedTempEntries(dir)).toEqual([]);

    // A directory that was never created is the passing case, not an error: it
    // means nothing was ever spooled (NFR-002, TC-137).
    expect(appOwnedTempEntries(join(userData, 'never-created'))).toEqual([]);

    // Every other failure is rethrown. Reporting an unreadable directory as
    // empty is the one answer that would make TC-137's assertion unfailable.
    const notADirectory = join(userData, 'a-file');
    writeFileSync(notADirectory, 'not a directory');
    expect(() => appOwnedTempEntries(notADirectory)).toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * 2. The runtime
 * ------------------------------------------------------------------ */

describe('TC-130 a real fault reaches the handlers and the process continues', () => {
  /**
   * The runner installs its own listeners for both faults and fails the file if
   * either fires. They are lifted for the length of one assertion and put back,
   * so what Node emits reaches this app's handler and nothing else.
   */
  async function withOnlyOurHandlers(
    body: (faults: { kind: FaultKind; value: unknown }[]) => Promise<void>,
  ): Promise<void> {
    const saved = FAULT_KINDS.map((kind) => ({ kind, listeners: process.listeners(kind) }));
    for (const { kind } of saved) process.removeAllListeners(kind);

    const faults: { kind: FaultKind; value: unknown }[] = [];
    const dispose = installGlobalHandlers({
      onFault: (kind, value) => faults.push({ kind, value }),
    });
    try {
      await body(faults);
    } finally {
      dispose();
      for (const { kind, listeners } of saved) {
        for (const listener of listeners) {
          // `process.on` is overloaded per event name, and `kind` is a union of
          // two of them, so neither overload matches on its own.
          (process.on as (event: string, listener: (...args: unknown[]) => void) => unknown)(
            kind,
            listener as (...args: unknown[]) => void,
          );
        }
      }
    }
  }

  it('survives a genuine unhandled rejection', async () => {
    await withOnlyOurHandlers(async (faults) => {
      // Never awaited and never caught, which is exactly what NFR-009 names.
      void Promise.reject(new Error('a stray rejection'));
      await nextTick(20);

      expect(faults.map((f) => f.kind)).toEqual(['unhandledRejection']);
      expect((faults[0]?.value as Error).message).toBe('a stray rejection');
    });

    // The process is still here to run the next line, which is the claim.
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('survives a genuine throw off the call stack', async () => {
    await withOnlyOurHandlers(async (faults) => {
      setTimeout(() => {
        throw new Error('a throw from a timer');
      }, 0);
      await nextTick(20);

      expect(faults.map((f) => f.kind)).toEqual(['uncaughtException']);
      expect((faults[0]?.value as Error).message).toBe('a throw from a timer');
    });

    expect(process.exitCode ?? 0).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 3. The session
 * ------------------------------------------------------------------ */

describe('TC-130 an injected rejection during a session leaves it active', () => {
  it('logs the fault and the session still transcribes and suggests', async () => {
    const h = harness(userData);
    h.gate.noteReady();
    await startSession(h);

    const logged: { kind: FaultKind; value: unknown }[] = [];
    const emitter = new EventEmitter() as unknown as FaultEmitter;
    const dispose = installGlobalHandlers({
      emitter,
      onFault: (kind, value) => logged.push({ kind, value }),
    });

    // A rejection and a throw, both during the session.
    (emitter as unknown as EventEmitter).emit(
      'unhandledRejection',
      new Error('a provider promise nobody awaited'),
    );
    (emitter as unknown as EventEmitter).emit('uncaughtException', new Error('a stray throw'));

    expect(logged.map((f) => f.kind)).toEqual(['unhandledRejection', 'uncaughtException']);

    // Still live: capture up, both streams open, the manager still holding the
    // transcript handle.
    expect(h.live.isRunning).toBe(true);
    expect(h.live.openStreamCount).toBe(2);
    expect(h.sessions.isActive).toBe(true);

    // And the next turn works end to end, which is the part that matters. A
    // session that is "active" but can no longer answer is not a survivor.
    speak(h, 'What did you own on that project?');
    h.stt.opened.find((s) => s.source === 'interviewer')?.emitEndpoint();
    await h.live.whenSettled();

    expect(h.sent.map((m) => m.channel)).toEqual([
      'suggestion:begin',
      'suggestion:line',
      'suggestion:line',
      'suggestion:end',
    ]);

    dispose();
    const session = await stopSession(h);
    expect(session).not.toBeNull();

    const onDisk = await readSession(userData, PROFILE.id, session!.id);
    expect(onDisk?.entries.map((e) => e.kind)).toEqual(['turn', 'suggestion']);
  });
});
