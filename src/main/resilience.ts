/**
 * TASK-050. Two process-wide guarantees that belong to no single component.
 *
 * 1. `NFR-009`: a stray rejection or a throw off the call stack must be logged
 *    and survived, never allowed to take a live session down with it.
 * 2. `NFR-002` and `ADR-019`: the process points its own temporary directory at
 *    one the app owns, so "no audio reached the filesystem" can be asserted by
 *    looking in a known place instead of being assumed of the whole machine.
 *
 * Neither imports the logger. `index.ts` owns the logger singleton and passes a
 * sink in, which is what lets a test drive both without a running app.
 */
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The two faults Node reports out of band (`NFR-009`). */
export type FaultKind = 'uncaughtException' | 'unhandledRejection';

/**
 * The slice of `process` the handlers need. Injected so a test can install onto
 * an emitter of its own rather than onto the runner's own process (`TC-130`).
 */
export interface FaultEmitter {
  on(event: FaultKind, listener: (value: unknown) => void): unknown;
  off(event: FaultKind, listener: (value: unknown) => void): unknown;
}

/** Options for {@link installGlobalHandlers} (`NFR-009`). */
export interface GlobalHandlerOptions {
  /**
   * Where a fault is reported. It must not rethrow: throwing from an
   * `uncaughtException` listener is what terminates the process, which is the
   * outcome `NFR-009` exists to prevent.
   */
  onFault: (kind: FaultKind, value: unknown) => void;
  /** Defaults to the real `process`. */
  emitter?: FaultEmitter;
}

/** The faults installed, in the order they are registered. Exported for `TC-130`. */
export const FAULT_KINDS: readonly FaultKind[] = ['uncaughtException', 'unhandledRejection'];

/**
 * Install the global fault handlers and return a disposer (`NFR-009`).
 *
 * The handlers log and return. They do not set `process.exitCode`, do not
 * rethrow and do not touch the session: a live session outlives any one fault,
 * and deciding a fault is fatal is a judgement this layer cannot make.
 *
 * A sink that throws is swallowed. The alternative is a throw inside the
 * `uncaughtException` listener, which Node treats as unrecoverable and which
 * would turn a logging defect into the session loss this guards against.
 */
export function installGlobalHandlers(options: GlobalHandlerOptions): () => void {
  const emitter = options.emitter ?? process;
  const installed: { kind: FaultKind; listener: (value: unknown) => void }[] = [];

  for (const kind of FAULT_KINDS) {
    const listener = (value: unknown): void => {
      try {
        options.onFault(kind, value);
      } catch {
        // Deliberately empty. See the note above.
      }
    };
    emitter.on(kind, listener);
    installed.push({ kind, listener });
  }

  return () => {
    for (const { kind, listener } of installed) emitter.off(kind, listener);
  };
}

/** The app-owned temporary directory, relative to `userData` (`ADR-019`). */
export const APP_TEMP_DIR_NAME = 'tmp';

/** The environment variables that decide where `os.tmpdir()` resolves. */
const TEMP_VARS = ['TMPDIR', 'TEMP', 'TMP'] as const;

/**
 * Point this process's temporary directory at one the app owns (`NFR-002`,
 * `ADR-019`).
 *
 * `NFR-002` forbids this project's code from writing audio to disk, and the
 * lint ban plus `TC-137`'s write monitor prove that much. What neither can
 * prove is that a dependency did not spool a request body to a temp file. This
 * moves that risk somewhere bounded: every spool a dependency or a child
 * process performs lands under `userData/tmp`, which `TC-137` asserts is empty
 * at session end.
 *
 * Set before anything that could spool runs, which in practice means directly
 * after the logger in `bootstrap`.
 *
 * @returns the absolute path of the app-owned temporary directory.
 */
export function useAppOwnedTempDir(
  userDataDir: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const dir = join(userDataDir, APP_TEMP_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  for (const name of TEMP_VARS) env[name] = dir;
  return dir;
}

/**
 * What is sitting in the app-owned temporary directory (`NFR-002`, `TC-137`).
 *
 * A missing directory reads as empty: never having spooled anything is the
 * passing case, not an error. Every other failure is rethrown. Swallowing them
 * would report an unreadable directory as empty, which is the one answer that
 * turns `TC-137`'s assertion into a test that cannot fail.
 */
export function appOwnedTempEntries(tempDir: string): string[] {
  try {
    return readdirSync(tempDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}
