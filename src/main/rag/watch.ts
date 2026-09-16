/**
 * Knowledge base watching and the ingest queue (TASK-025, FR-068, FR-077,
 * FR-078, ADR-014).
 *
 * `kb/` is authoritative. A file that appears there is adopted whether or not it
 * came through `doc:import`, and a file that disappears takes its record, chunks
 * and vectors with it.
 *
 * The debounce and the coalescing live here rather than being left to chokidar.
 * `awaitWriteFinish` collapses the write events of one save, but it does not
 * stop a second save arriving while the first is still embedding, and that is
 * the case "five rapid writes cause exactly one re-embed" actually turns on
 * (TC-079). Owning the queue also makes the timing testable with fake timers,
 * which a dependency's internal polling is not.
 */

/** The stability window chokidar waits for before reporting a write (FR-068). */
export const STABILITY_DEBOUNCE_MS = 500;

/** The three `kb/` events this app acts on (FR-068, FR-077). */
export type KbEventKind = 'add' | 'change' | 'unlink';

/** The subset of chokidar this app uses. Injected so tests need no real watcher. */
export interface FileWatcher {
  on(event: 'add' | 'change' | 'unlink', handler: (path: string) => void): FileWatcher;
  on(event: 'error', handler: (error: unknown) => void): FileWatcher;
  close(): Promise<void>;
}

/** Builds a watcher for one directory. Injected so a test needs no real watcher. */
export type WatcherFactory = (directory: string) => FileWatcher | Promise<FileWatcher>;

/**
 * chokidar, configured for this app (FR-068).
 *
 * `awaitWriteFinish` is the point: a large PDF copied into `kb/` through
 * Explorer generates `add` while the file is still growing, and parsing a
 * half-written PDF fails in a way that looks like a corrupt document.
 *
 * Async because chokidar 5 is ESM-only and the main process bundles to
 * CommonJS, so it can only be reached through a dynamic import. Importing it
 * here rather than at module scope also keeps it out of a unit test that
 * injects its own factory.
 */
export async function createChokidarWatcher(directory: string): Promise<FileWatcher> {
  const mod: unknown = await import('chokidar');
  const namespace = (mod as { default?: unknown }).default ?? mod;
  const watch = (namespace as { watch?: unknown }).watch;
  if (typeof watch !== 'function') throw new Error('chokidar did not export watch().');
  return (watch as (path: string, options: Record<string, unknown>) => FileWatcher)(directory, {
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: STABILITY_DEBOUNCE_MS, pollInterval: 100 },
  });
}

/** What the queue calls, and how long it waits first (FR-068). */
export interface IngestQueueOptions {
  /** Re-process one file. Must not throw: a failure is a document state, not a queue state. */
  process: (profileId: string, path: string) => Promise<void>;
  /** Remove a document whose file is gone (FR-077). */
  remove: (profileId: string, path: string) => Promise<void>;
  debounceMs?: number;
  onError?: (error: unknown, context: { profileId: string; path: string }) => void;
}

interface Pending {
  profileId: string;
  kind: KbEventKind;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Coalesces file events into at most one run per file at a time (TC-079).
 *
 * Two mechanisms, because they solve different problems:
 *
 * - The debounce collapses a burst of events that arrive before any work starts.
 * - The `dirty` flag collapses events that arrive while work is already running.
 *   Without it, five saves during one 4-second embed would queue five embeds.
 *
 * The last event for a path wins. An `unlink` arriving during a re-embed must
 * remove the document, not be overwritten by the `change` that preceded it.
 */
export class IngestQueue {
  private readonly pending = new Map<string, Pending>();
  private readonly running = new Set<string>();
  private readonly dirty = new Map<string, { profileId: string; kind: KbEventKind }>();
  private readonly debounceMs: number;
  private idle: (() => void)[] = [];

  constructor(private readonly options: IngestQueueOptions) {
    this.debounceMs = options.debounceMs ?? STABILITY_DEBOUNCE_MS;
  }

  /** Note a file system event. Returns immediately; work happens after the debounce. */
  enqueue(profileId: string, path: string, kind: KbEventKind): void {
    const existing = this.pending.get(path);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      this.pending.delete(path);
      void this.run(profileId, path, kind);
    }, this.debounceMs);
    // A pending timer must not hold the process open at shutdown.
    timer.unref?.();
    this.pending.set(path, { profileId, kind, timer });
  }

  private async run(profileId: string, path: string, kind: KbEventKind): Promise<void> {
    if (this.running.has(path)) {
      this.dirty.set(path, { profileId, kind });
      return;
    }
    this.running.add(path);
    try {
      if (kind === 'unlink') await this.options.remove(profileId, path);
      else await this.options.process(profileId, path);
    } catch (err) {
      this.options.onError?.(err, { profileId, path });
    } finally {
      this.running.delete(path);
      const next = this.dirty.get(path);
      if (next) {
        this.dirty.delete(path);
        await this.run(next.profileId, path, next.kind);
      } else if (this.running.size === 0 && this.pending.size === 0) {
        this.releaseIdleWaiters();
      }
    }
  }

  /** True while any file is debouncing or being processed. Used by tests and shutdown. */
  get busy(): boolean {
    return this.pending.size > 0 || this.running.size > 0;
  }

  /** Resolves once nothing is queued or running. */
  async drain(): Promise<void> {
    if (!this.busy) return;
    await new Promise<void>((resolve) => this.idle.push(resolve));
  }

  /**
   * Drop every pending timer. In-flight work is left to finish.
   *
   * Releases anyone awaiting {@link drain}. Without this, disposing while a
   * caller waited on `drain` left that promise unresolved forever, because the
   * only place it settles is the end of a run that will now never start.
   */
  dispose(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    this.dirty.clear();
    if (this.running.size === 0) this.releaseIdleWaiters();
  }

  private releaseIdleWaiters(): void {
    const waiters = this.idle;
    this.idle = [];
    for (const resolve of waiters) resolve();
  }
}

/** The queue events are routed to, and how watchers are built (FR-068). */
export interface KnowledgeBaseWatcherOptions {
  queue: IngestQueue;
  factory?: WatcherFactory;
  onError?: (error: unknown, profileId: string) => void;
}

/**
 * One chokidar watcher per profile's `kb/` folder (FR-068, FR-077).
 *
 * Per profile rather than one watcher over `profiles/`, so an event carries the
 * profile it belongs to without parsing it back out of the path, and so deleting
 * a profile closes exactly one watcher.
 */
export class KnowledgeBaseWatcher {
  private readonly watchers = new Map<string, FileWatcher>();
  /** Profiles whose factory call is in flight, so a second call does not race it. */
  private readonly starting = new Set<string>();
  /**
   * Profiles unwatched while their factory call was still in flight.
   *
   * Cleared unconditionally once that call settles, success or failure, so a
   * one-off factory rejection cannot leave a profile permanently unwatched.
   */
  private readonly stopped = new Set<string>();
  private readonly factory: WatcherFactory;

  constructor(private readonly options: KnowledgeBaseWatcherOptions) {
    this.factory = options.factory ?? createChokidarWatcher;
  }

  /**
   * Start watching one profile. Idempotent: watching twice is a no-op.
   *
   * The placeholder is registered before the factory is awaited, so two
   * concurrent calls for one profile cannot each create a watcher and leave the
   * first one running with nothing holding a reference to close it.
   */
  async watch(profileId: string, kbDir: string): Promise<void> {
    if (this.watchers.has(profileId) || this.starting.has(profileId)) return;
    this.starting.add(profileId);
    let watcher: FileWatcher;
    let cancelled = false;
    try {
      watcher = await this.factory(kbDir);
    } finally {
      // Both sets are cleared in the `finally`, so a rejected factory call
      // clears them too. Clearing `stopped` only on the success path left the id
      // set forever after one rejection: the next `watch` opened a real watcher,
      // immediately closed it and resolved successfully, so `kb/` went unwatched
      // with nothing reported, and it self-healed only on a third call that
      // nothing makes.
      this.starting.delete(profileId);
      if (this.stopped.delete(profileId)) cancelled = true;
    }

    // `unwatch` or `closeAll` during the await wins: close what we just opened
    // rather than registering a watcher the caller already asked to stop.
    if (cancelled) {
      await watcher.close();
      return;
    }

    for (const kind of ['add', 'change', 'unlink'] as const) {
      watcher.on(kind, (path: string) => this.options.queue.enqueue(profileId, path, kind));
    }
    watcher.on('error', (error: unknown) => this.options.onError?.(error, profileId));
    this.watchers.set(profileId, watcher);
  }

  async unwatch(profileId: string): Promise<void> {
    if (this.starting.has(profileId)) this.stopped.add(profileId);
    const watcher = this.watchers.get(profileId);
    if (!watcher) return;
    this.watchers.delete(profileId);
    await watcher.close();
  }

  /**
   * Close every watcher, including any whose start is still in flight.
   *
   * Iterating `watchers` alone missed a profile still in `starting`, whose
   * watcher was then registered after the close and left a live chokidar
   * instance with open file handles behind `RagEngine.stop()`.
   */
  async closeAll(): Promise<void> {
    const ids = new Set([...this.watchers.keys(), ...this.starting]);
    await Promise.all([...ids].map((id) => this.unwatch(id)));
  }
}
