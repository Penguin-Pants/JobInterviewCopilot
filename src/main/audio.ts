import type { AudioChunk, TranscriptSource, StreamState } from '../shared/types.js';

/**
 * Audio supervisor (CMP-03a, ADR-005).
 *
 * The capture itself lives in a hidden renderer, because neither loopback nor
 * `getUserMedia` is reachable from the main process. This module supervises
 * that worker: it starts and stops streams, tracks their health, restarts a
 * stream that dies, and fans chunks out to whoever consumes them.
 *
 * It owns one guarantee of its own, and it is the reason this file is on the
 * filesystem lint ban list: **PCM retention is bounded** (FR-043, ADR-027).
 * Electron cannot transfer an ArrayBuffer across IPC, so every chunk arrives as
 * a copy. The copy is cheap and is not the risk. Holding on to copies is: at
 * 62.5 KiB per second, a session that never releases accumulates about 220 MiB
 * of interview audio in memory. So this supervisor hands each chunk on and
 * drops its reference in the same turn, and exposes a live count so that
 * property can be asserted from outside rather than inferred.
 */

/** How many times a stream that dies unexpectedly is restarted (FR-045). */
export const MAX_STREAM_RESTARTS = 3;

/**
 * The most chunks that may be in flight through the supervisor at once.
 *
 * One per source is the steady state: a chunk arrives, is handed to its
 * consumer, and is released. Anything above this means a consumer is holding
 * chunks the supervisor thinks it has passed on, which is the shape of the
 * retention bug ADR-027 exists to prevent.
 */
export const MAX_CHUNKS_IN_FLIGHT = 2;

export type ChunkConsumer = (chunk: AudioChunk) => void;

export interface StreamStatus {
  state: StreamState;
  restarts: number;
  error: string | null;
  /** Chunks seen from this source, for gap detection against `sequence`. */
  received: number;
}

/**
 * The worker operations the supervisor drives. Injected so the supervisor is
 * testable without Electron, and so the acquisition mechanism can change
 * without touching this file.
 */
export interface AudioWorkerHandle {
  start(streams: readonly TranscriptSource[]): Promise<void>;
  stop(): Promise<void>;
  destroy(): Promise<void>;
}

export interface AudioSupervisorOptions {
  worker: AudioWorkerHandle;
  /** Called for every chunk. Must not retain the chunk beyond the call. */
  onChunk: ChunkConsumer;
  onStreamState?: (source: TranscriptSource, status: StreamStatus) => void;
  /** Injected so restart backoff is testable without real time. */
  now?: () => number;
}

const SOURCES: readonly TranscriptSource[] = ['interviewer', 'candidate'];

export class AudioSupervisor {
  private readonly worker: AudioWorkerHandle;
  private readonly onChunk: ChunkConsumer;
  private readonly onStreamState: ((s: TranscriptSource, st: StreamStatus) => void) | undefined;

  private readonly status = new Map<TranscriptSource, StreamStatus>();
  private readonly lastSequence = new Map<TranscriptSource, number>();

  /** Chunks currently inside a consumer call. Never grows beyond the bound. */
  private inFlight = 0;
  /** High-water mark, so a test can assert the bound held over a whole run. */
  private peakInFlight = 0;
  private running = false;

  constructor(options: AudioSupervisorOptions) {
    this.worker = options.worker;
    this.onChunk = options.onChunk;
    this.onStreamState = options.onStreamState;
    for (const source of SOURCES) {
      this.status.set(source, { state: 'idle', restarts: 0, error: null, received: 0 });
    }
  }

  /** Per-source stream status, as pushed to the Dashboard on `CH-203`. */
  statusFor(source: TranscriptSource): StreamStatus {
    const status = this.status.get(source);
    if (!status) throw new Error(`unknown audio source: ${source}`);
    return { ...status };
  }

  /** Chunks currently inside a consumer call (FR-043, TC-041). */
  get chunksInFlight(): number {
    return this.inFlight;
  }

  /** The largest number ever in flight. Should never exceed the bound. */
  get peakChunksInFlight(): number {
    return this.peakInFlight;
  }

  async start(): Promise<void> {
    if (this.running) throw new Error('audio capture is already running');
    this.running = true;
    for (const source of SOURCES) this.setState(source, 'starting');
    await this.worker.start(SOURCES);
  }

  /**
   * Hand a chunk to its consumer and drop the reference in the same turn.
   *
   * The `chunk` parameter goes out of scope when this returns, and nothing here
   * stores it. A consumer that retains it is retaining its own reference, which
   * is that consumer's declared bound to justify (ADR-027).
   */
  handleChunk(chunk: AudioChunk): void {
    const status = this.status.get(chunk.source);
    if (!status) return;

    if (status.state !== 'running') this.setState(chunk.source, 'running');
    status.received += 1;
    this.lastSequence.set(chunk.source, chunk.sequence);

    this.inFlight += 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    let settled = false;
    const release = (): void => {
      if (settled) return;
      settled = true;
      this.inFlight -= 1;
    };

    let result: unknown;
    try {
      result = this.onChunk(chunk);
    } catch (err) {
      // A consumer that throws must not leak the count, and must not have its
      // error swallowed either: the caller is the only one who can report it.
      release();
      throw err;
    }

    // An async consumer is not finished when it returns its promise. Counting
    // it as finished there would report one chunk in flight while several
    // requests were genuinely outstanding.
    if (isPromiseLike(result)) {
      void Promise.resolve(result).then(release, release);
      return;
    }
    release();
  }

  /**
   * Record a stream state the worker reported.
   *
   * Without this the supervisor only learned that a stream was running when its
   * first chunk arrived, up to a second late, and `canStartSession` would
   * refuse a perfectly healthy stream for that whole second. The worker knows
   * the moment the graph is connected, so it says so.
   */
  noteStreamState(source: TranscriptSource, state: StreamState, error?: string): void {
    const status = this.status.get(source);
    if (!status) return;
    if (state === 'error') status.error = error ?? null;
    this.setState(source, state);
  }

  /**
   * Whether this source has skipped a chunk.
   *
   * A gap means audio was dropped, which shows up later as a transcript that
   * reads fine but is missing a clause. Worth detecting at the source rather
   * than puzzling over the suggestion it produces.
   */
  hasSequenceGap(source: TranscriptSource, sequence: number): boolean {
    const previous = this.lastSequence.get(source);
    return previous !== undefined && sequence !== previous + 1;
  }

  /**
   * A stream ended unexpectedly. Restart it up to `MAX_STREAM_RESTARTS`, then
   * leave it in `error` for the Dashboard badge to report (FR-045).
   *
   * @returns whether a restart was attempted.
   */
  async handleStreamEnded(source: TranscriptSource, reason: string): Promise<boolean> {
    const status = this.status.get(source);
    if (!status || !this.running) return false;

    if (status.restarts >= MAX_STREAM_RESTARTS) {
      status.error = `${reason} (gave up after ${MAX_STREAM_RESTARTS} restarts)`;
      this.setState(source, 'error');
      return false;
    }

    status.restarts += 1;
    status.error = reason;
    this.setState(source, 'starting');
    await this.worker.start([source]);
    return true;
  }

  /** A stream failed to acquire at all, for example no loopback device (FR-044). */
  markUnavailable(source: TranscriptSource, reason: string): void {
    const status = this.status.get(source);
    if (!status) return;
    status.error = reason;
    this.setState(source, 'error');
  }

  /**
   * Whether a session may start.
   *
   * The interviewer stream is the product: without it there is nothing to react
   * to. Starting a session with a silently dead interviewer stream would look
   * like an app that simply never suggests anything (FR-044).
   */
  canStartSession(): { ok: boolean; reason?: string } {
    const interviewer = this.status.get('interviewer');
    // `running` is required, not merely "not error". `start()` resolves as soon
    // as the worker has been told to start, so `starting` means acquisition is
    // still in flight and a loopback failure has not been reported yet. Letting
    // a session begin there is exactly the silently dead interviewer stream
    // FR-044 forbids: the app would look like one that never suggests anything.
    if (interviewer?.state === 'running') return { ok: true };

    if (interviewer?.state === 'error') {
      return {
        ok: false,
        reason:
          interviewer.error ??
          'System audio could not be captured, so the interviewer would not be heard.',
      };
    }
    if (interviewer?.state === 'starting') {
      return { ok: false, reason: 'System audio is still starting. Try again in a moment.' };
    }
    return {
      ok: false,
      reason: 'System audio capture has not started, so the interviewer would not be heard.',
    };
  }

  /** Tear everything down. Releases the worker and resets all state (FR-046). */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.worker.stop();
    await this.worker.destroy();
    for (const source of SOURCES) {
      this.status.set(source, { state: 'idle', restarts: 0, error: null, received: 0 });
    }
    this.lastSequence.clear();
    this.inFlight = 0;
  }

  private setState(source: TranscriptSource, state: StreamState): void {
    const status = this.status.get(source);
    if (!status) return;
    status.state = state;
    if (state !== 'error') status.error = null;
    this.onStreamState?.(source, { ...status });
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
