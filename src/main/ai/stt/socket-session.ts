/**
 * The WebSocket transport shared by every streaming STT adapter.
 *
 * On the reachable audio path: no filesystem imports (NFR-002).
 *
 * The three v1 streaming providers differ only in their connect URL, their
 * handshake frame and how they name things in their JSON. Everything that is
 * actually hard (reconnect without ending the session, per-stream isolation,
 * bounded buffering, normalizing to `TranscriptEvent`) is identical, so it
 * lives here once instead of three times (TC-050, TC-051, TC-054).
 */
import type {
  AudioChunk,
  ProviderChoice,
  ProviderError,
  TranscriptEvent,
  TranscriptSource,
} from '../../../shared/types.js';
import { classifyStatus, providerError } from '../stt.js';
import type { SttSession } from '../stt.js';

/**
 * Chunks held while the socket is down. One second each, so this is a three
 * second ceiling on in-flight audio during a reconnect. Exported so the bound
 * is asserted from outside rather than inferred (FR-043, ADR-027).
 *
 * Three is a deliberate trade. Zero would silently lose the words spoken during
 * a reconnect; unbounded would be the retention leak ADR-027 exists to prevent.
 * The oldest chunk is dropped when the queue is full.
 */
export const MAX_QUEUED_CHUNKS = 3;

/** Reconnect backoff, matching the failover ladder in section 3.5. */
export const RECONNECT_BACKOFF_MS = [250, 500, 1000];

/**
 * How long a socket must stay open before the reconnect ladder resets.
 *
 * Resetting on `open` alone would be wrong: a provider that accepts the socket
 * and drops it immediately would reset the ladder every cycle and reconnect
 * forever, which is the unbounded retry ADR-024 rules out. A connection that
 * lived this long was genuinely healthy, so a later drop starts a fresh ladder.
 */
export const HEALTHY_CONNECTION_MS = 5000;

/**
 * How long each dial waits for the provider to accept the socket (ADR-056).
 *
 * `ws` already bounds the HTTP upgrade (`ws-factory.ts`); this also bounds a
 * provider that upgrades and then never sends its session-start frame. It
 * applies to the first dial and to every reconnect.
 */
export const OPEN_TIMEOUT_MS = 10_000;

/**
 * How long `close` waits for the provider's last transcript after the close
 * frame (ADR-056). Closing at once dropped the words said just before Stop.
 */
export const CLOSE_DRAIN_MS = 1500;

export type SttLogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * The adapters' log sink. Injected because the logger writes to disk and this
 * directory may not import a filesystem module (NFR-002). Never handed audio
 * or a key.
 */
export type SttLog = (level: SttLogLevel, message: string, detail?: unknown) => void;

/** Schedules `fn` after `ms` and returns a function that cancels it. */
export type Timer = (fn: () => void, ms: number) => () => void;

/** What every adapter factory accepts and passes through to the session. */
export interface SocketSessionDeps {
  log?: SttLog;
  timer?: Timer;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const realTimer: Timer = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  return () => {
    clearTimeout(handle);
  };
};

export interface SocketLike {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', h: () => void): void;
  addEventListener(type: 'message', h: (e: { data: unknown }) => void): void;
  addEventListener(type: 'error', h: (e: unknown) => void): void;
  addEventListener(type: 'close', h: (e: { code: number; reason: string }) => void): void;
}

export interface ConnectSpec {
  url: string;
  protocols?: string[];
  headers?: Record<string, string>;
}

/** What the session hands an adapter so it can emit normalized events. */
export interface Emitter {
  transcript(text: string, isFinal: boolean, confidence?: number): void;
  endpoint(): void;
  /** The provider heard new speech start, before any text of it. */
  speech(): void;
  /**
   * A provider error frame that ends this session. Before `open` resolves it
   * rejects the open; after, it reaches the `error` listeners. Either way the
   * socket is closed and not redialled, so the caller's health machine decides
   * what happens next (ADR-010).
   */
  error(err: ProviderError): void;
  /** The provider's session-start frame, for a spec with `awaitsSessionStart`. */
  ready(): void;
  /** A provider notice that does not end the session. Logged only. */
  notice(message: string): void;
}

/**
 * Thrown by an adapter for a frame whose shape it does not recognize. The
 * session drops the frame and logs it, without its contents.
 */
export class FrameShapeError extends Error {
  constructor(what: string) {
    super(what);
    this.name = 'FrameShapeError';
  }
}

/** Parses one JSON text frame and requires a plain object. */
export function parseFrame(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FrameShapeError('the frame is not a JSON object');
  }
  return value as Record<string, unknown>;
}

/**
 * Reads an optional string field. Absent is `undefined`; any other type is a
 * frame this adapter does not understand.
 */
export function optionalString(frame: Record<string, unknown>, key: string): string | undefined {
  const value = frame[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new FrameShapeError(`"${key}" is not a string`);
  return value;
}

export interface SocketAdapterSpec {
  providerId: string;
  /** Built fresh on every connect, so a rotated key or changed gap is picked up. */
  connect(): ConnectSpec;
  /** Frames to send immediately after the socket opens, e.g. a session update. */
  handshake?(send: (data: string) => void): void;
  /**
   * When true, every dial (the first and each reconnect) is ready on the
   * provider's session-start frame (`emit.ready()`) rather than on the
   * socket's `open` event. Audio waits in the queue until then.
   */
  awaitsSessionStart?: boolean;
  /**
   * Translate one inbound text frame into zero or more normalized events.
   * Throws on a frame it cannot read; the session drops and logs it.
   */
  handleMessage(raw: string, emit: Emitter): void;
  /** Encode one PCM chunk for the wire: raw bytes or a JSON text frame. */
  encode(chunk: AudioChunk): string | Uint8Array;
  /**
   * A frame telling the provider the stream ended. When there is one, `close`
   * keeps the socket up until the provider closes it or CLOSE_DRAIN_MS passes.
   */
  closeFrame?(): string | null;
}

export type SocketFactory = (spec: ConnectSpec) => SocketLike;

type Handlers = {
  transcript: ((t: TranscriptEvent) => void)[];
  endpoint: (() => void)[];
  speech: (() => void)[];
  error: ((e: ProviderError) => void)[];
};

export class SocketSttSession implements SttSession {
  readonly source: TranscriptSource;
  readonly choice: ProviderChoice;

  private readonly spec: SocketAdapterSpec;
  private readonly factory: SocketFactory;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly timer: Timer;
  private readonly log: SttLog;

  private socket: SocketLike | null = null;
  /** The current socket is ready: the provider accepted it, so audio may go. */
  private open = false;
  private closing = false;
  private reconnectAttempt = 0;
  private openedAt = 0;

  /**
   * The HTTP status of a refused upgrade, when `ws` reported one. A WebSocket
   * close code cannot say "401", so a revoked key would otherwise read as a
   * retryable network drop.
   */
  private refusedStatus: number | null = null;

  /** Settles the promise `connect` returned. Null once the first open is done. */
  private pendingOpen: {
    resolve: () => void;
    reject: (err: ProviderError) => void;
  } | null = null;

  /** Cancels the current dial's acceptance timeout (OPEN_TIMEOUT_MS). */
  private cancelAccept: (() => void) | null = null;

  /**
   * A failure that ended the session while no `error` listener was attached.
   * After `open` resolves, the caller has not yet got the session, so a close
   * or an error frame in that same tick reached nobody and the dead session
   * read as a success. `connect` rejects with it instead.
   */
  private unheard: ProviderError | null = null;

  /** Ends the close drain. Set only while `close` waits for the provider. */
  private finishDrain: (() => void) | null = null;
  private closed: Promise<void> | null = null;

  /** Bounded by MAX_QUEUED_CHUNKS. Cleared as soon as the socket is writable. */
  private readonly queue: AudioChunk[] = [];

  /**
   * PCM bytes this session has actually put on the wire (`FR-103`).
   *
   * The Cost Meter bills audio "actually sent to a provider", and during an
   * outage `push` drops the oldest queued chunks rather than growing without
   * bound (ADR-027). Counting at the caller would therefore bill an outage
   * longer than the queue as though it had been transcribed. Counted here, at
   * the one place a chunk reaches the socket, a dropped chunk costs nothing and
   * a chunk that waits in the queue is billed when it is finally flushed. The
   * count is the PCM handed in, whatever the adapter's encoding makes of it.
   */
  private sent = 0;

  private readonly handlers: Handlers = { transcript: [], endpoint: [], speech: [], error: [] };

  constructor(
    opts: {
      source: TranscriptSource;
      choice: ProviderChoice;
      spec: SocketAdapterSpec;
      factory: SocketFactory;
    } & SocketSessionDeps,
  ) {
    this.source = opts.source;
    this.choice = opts.choice;
    this.spec = opts.spec;
    this.factory = opts.factory;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
    this.timer = opts.timer ?? realTimer;
    this.log = opts.log ?? (() => undefined);
  }

  /** Live chunk count, so the retention bound can be asserted (ADR-027). */
  get queuedChunks(): number {
    return this.queue.length;
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** PCM bytes put on the wire, for the Cost Meter (`FR-103`, ADR-036). */
  get sentBytes(): number {
    return this.sent;
  }

  /**
   * Opens the socket. Resolves once the provider has accepted it: on `open`,
   * or on the session-start frame for a spec that waits for one. Rejects with
   * a classified error if the socket closes first, the provider sends an error
   * frame, or nothing answers within OPEN_TIMEOUT_MS (ADR-056). It also
   * rejects if the session fails in the same tick as it was accepted, before
   * the caller can attach an `error` listener.
   *
   * A session that never opened does not run the reconnect ladder. Its caller
   * is the health machine, which owns the retry and the failover. Resolving
   * early recorded every refused attempt as a success, so the backup was never
   * reached. After a successful open, a drop runs the ladder as before.
   */
  connect(): Promise<void> {
    if (this.closing || this.pendingOpen || this.socket) {
      return Promise.reject(
        providerError(this.spec.providerId, 'client', 'This session was already opened.'),
      );
    }
    const opened = new Promise<void>((resolve, reject) => {
      this.pendingOpen = { resolve, reject };
    });
    this.dial();
    // The `then` runs after the tick that accepted the socket, so a failure
    // later in that tick is seen here rather than lost.
    return opened.then(() => {
      if (this.unheard) throw this.unheard;
    });
  }

  private dial(): void {
    if (this.closing) return;
    this.refusedStatus = null;
    const socket = this.factory(this.spec.connect());
    this.socket = socket;
    this.cancelAccept?.();
    this.cancelAccept = this.timer(() => {
      this.acceptTimedOut(socket);
    }, OPEN_TIMEOUT_MS);

    socket.addEventListener('open', () => {
      this.spec.handshake?.((data) => socket.send(data));
      if (!this.spec.awaitsSessionStart) this.markReady();
    });

    socket.addEventListener('message', (e) => {
      // A socket this session let go of may still deliver a frame. Its late
      // session-start frame must not mark the current socket ready.
      if (this.socket !== socket) return;
      const raw = typeof e.data === 'string' ? e.data : String(e.data);
      try {
        this.spec.handleMessage(raw, this.emitter);
      } catch (err) {
        // A frame we cannot read is not a reason to end an interview. Drop it
        // and say so, without its contents: it may hold what someone said.
        // A listener's throw never lands here; `dispatch` reports those.
        this.log('warn', `dropped a ${this.spec.providerId} frame it could not read`, {
          reason: err instanceof FrameShapeError ? err.message : 'not valid JSON',
          length: raw.length,
        });
      }
    });

    socket.addEventListener('error', (e) => {
      // 'close' always follows 'error' and carries the code, so reconnect is
      // driven from there alone. What 'error' adds is the HTTP status of a
      // refused upgrade, which `ws` reports only in its message.
      const status = refusedUpgradeStatus(e);
      if (status !== null) this.refusedStatus = status;
    });

    socket.addEventListener('close', (e) => {
      // A socket this session already let go of, e.g. after an error frame
      // or a reconnect the provider never accepted.
      if (this.socket !== socket) return;
      const wasHealthy = this.open && this.now() - this.openedAt >= HEALTHY_CONNECTION_MS;
      this.open = false;
      this.socket = null;
      this.cancelAccept?.();
      this.cancelAccept = null;
      const errorClass =
        this.refusedStatus === null
          ? closeCodeToErrorClass(e.code)
          : classifyStatus(this.refusedStatus);
      if (this.pendingOpen) {
        this.fail(
          providerError(
            this.spec.providerId,
            errorClass,
            e.reason ||
              `The ${this.spec.providerId} socket closed before it was ready (code ${String(e.code)}).`,
          ),
        );
        return;
      }
      if (this.closing) {
        this.finishDrain?.();
        return;
      }
      if (wasHealthy) this.reconnectAttempt = 0;
      void this.reconnect(
        errorClass,
        e.reason || `The ${this.spec.providerId} socket was rejected (code ${String(e.code)}).`,
      );
    });
  }

  /**
   * The provider accepted the current socket. Only now is it writable, so a
   * reconnect does not send audio before the provider's session-start frame.
   */
  private markReady(): void {
    if (!this.socket || this.open) return;
    this.cancelAccept?.();
    this.cancelAccept = null;
    this.open = true;
    this.openedAt = this.now();
    this.flushQueue();
    const pending = this.pendingOpen;
    if (!pending) return;
    this.pendingOpen = null;
    pending.resolve();
  }

  /**
   * The provider did not accept `socket` within OPEN_TIMEOUT_MS. On the first
   * open this rejects it. On a reconnect the socket is let go and the ladder
   * runs, so a stalled handshake reaches failover instead of hanging.
   */
  private acceptTimedOut(socket: SocketLike): void {
    if (this.socket !== socket || this.open) return;
    const message = `The ${this.spec.providerId} socket was not accepted within ${String(
      OPEN_TIMEOUT_MS,
    )} ms.`;
    if (this.pendingOpen) {
      this.fail(providerError(this.spec.providerId, 'timeout', message));
      return;
    }
    this.cancelAccept = null;
    this.socket = null;
    socket.close(1000, 'not accepted');
    void this.reconnect('timeout', message);
  }

  /**
   * Ends the session on an error: rejects a pending open or tells the error
   * listeners, closes the socket, and never redials.
   */
  private fail(err: ProviderError): void {
    this.closing = true;
    this.queue.length = 0;
    const socket = this.socket;
    this.socket = null;
    this.open = false;
    this.cancelAccept?.();
    this.cancelAccept = null;
    socket?.close(1000, 'provider error');

    const pending = this.pendingOpen;
    if (pending) {
      this.pendingOpen = null;
      pending.reject(err);
      return;
    }
    this.finishDrain?.();
    if (this.handlers.error.length === 0) {
      this.unheard ??= err;
      return;
    }
    this.dispatch(this.handlers.error, err);
  }

  /**
   * Calls every listener, and reports one that throws rather than swallowing
   * it. A throw is a defect in the listener, not a provider failure, so it is
   * logged as an error and never reaches the health machine. The listeners
   * after it still get the event.
   */
  private dispatch<A extends unknown[]>(list: ((...args: A) => void)[], ...args: A): void {
    for (const h of list) {
      try {
        h(...args);
      } catch (err) {
        this.log('error', `a ${this.source} transcription listener threw`, err);
      }
    }
  }

  private readonly emitter: Emitter = {
    transcript: (text, isFinal, confidence) => {
      const event: TranscriptEvent = {
        source: this.source,
        text,
        isFinal,
        timestamp: Date.now(),
        providerId: this.choice.providerId,
        ...(confidence === undefined ? {} : { confidence }),
      };
      this.dispatch(this.handlers.transcript, event);
    },
    endpoint: () => {
      this.dispatch(this.handlers.endpoint);
    },
    speech: () => {
      this.dispatch(this.handlers.speech);
    },
    error: (err) => {
      this.fail(err);
    },
    ready: () => {
      this.markReady();
    },
    notice: (message) => {
      this.log('warn', message);
    },
  };

  /**
   * A dropped socket reconnects and the session stays active (TC-054). The
   * session only fails outward once the ladder is exhausted, or immediately on
   * a non-retryable close, where retrying would fail identically forever.
   */
  private async reconnect(errorClass: ProviderError['class'], reason: string): Promise<void> {
    if (errorClass === 'auth' || errorClass === 'client') {
      this.fail(providerError(this.spec.providerId, errorClass, reason));
      return;
    }

    if (this.reconnectAttempt >= RECONNECT_BACKOFF_MS.length) {
      this.fail(
        providerError(
          this.spec.providerId,
          errorClass,
          `The ${this.spec.providerId} socket dropped and did not come back after ${String(
            RECONNECT_BACKOFF_MS.length,
          )} attempts.`,
        ),
      );
      return;
    }

    const delay = RECONNECT_BACKOFF_MS[this.reconnectAttempt] ?? 1000;
    this.reconnectAttempt += 1;
    await this.sleep(delay);
    if (this.closing) return;
    this.dial();
  }

  push(chunk: AudioChunk): void {
    if (this.closing) return;
    if (this.open && this.socket) {
      this.socket.send(this.spec.encode(chunk));
      this.sent += chunk.pcm.byteLength;
      return;
    }
    // Socket is down. Hold at most MAX_QUEUED_CHUNKS, dropping the oldest, so a
    // long outage cannot grow the queue without bound (ADR-027).
    this.queue.push(chunk);
    while (this.queue.length > MAX_QUEUED_CHUNKS) this.queue.shift();
  }

  private flushQueue(): void {
    const socket = this.socket;
    if (!socket) return;
    // splice empties the array in place, so no chunk is retained past the send.
    for (const chunk of this.queue.splice(0, this.queue.length)) {
      socket.send(this.spec.encode(chunk));
      this.sent += chunk.pcm.byteLength;
    }
  }

  /**
   * Ends the stream. No chunk is accepted from here on.
   *
   * With a close frame, the socket stays up until the provider closes it or
   * CLOSE_DRAIN_MS passes, and transcripts keep flowing meanwhile. Closing at
   * once dropped the provider's last transcript, which is the last thing said
   * before Stop (ADR-056). An answer frame does not end the drain: ElevenLabs
   * answers a VAD commit and the final commit with the same uncorrelated
   * frame, so an earlier segment's answer would close before the tail.
   */
  close(): Promise<void> {
    if (this.closed) return this.closed;
    this.closing = true;
    this.queue.length = 0;

    this.cancelAccept?.();
    this.cancelAccept = null;
    const pending = this.pendingOpen;
    if (pending) {
      this.pendingOpen = null;
      pending.reject(
        providerError(this.spec.providerId, 'network', 'The session was closed before it opened.'),
      );
    }

    const socket = this.socket;
    let drain = false;
    if (socket && this.open) {
      const frame = this.spec.closeFrame?.() ?? null;
      if (frame !== null) {
        try {
          socket.send(frame);
          drain = true;
        } catch {
          // The socket died first. Closing is the point; nothing to recover.
        }
      }
    }

    const finish = () => {
      this.finishDrain = null;
      socket?.close(1000, 'session ended');
      if (this.socket === socket) {
        this.socket = null;
        this.open = false;
      }
    };

    if (!drain) {
      finish();
      this.closed = Promise.resolve();
      return this.closed;
    }

    this.closed = new Promise<void>((resolve) => {
      const cancel = this.timer(() => {
        this.finishDrain?.();
      }, CLOSE_DRAIN_MS);
      this.finishDrain = () => {
        cancel();
        finish();
        resolve();
      };
    });
    return this.closed;
  }

  on(e: 'transcript', h: (t: TranscriptEvent) => void): void;
  on(e: 'endpoint', h: () => void): void;
  on(e: 'speech', h: () => void): void;
  on(e: 'error', h: (err: ProviderError) => void): void;
  on(e: 'transcript' | 'endpoint' | 'speech' | 'error', h: (...args: never[]) => void): void {
    if (e === 'transcript') this.handlers.transcript.push(h as (t: TranscriptEvent) => void);
    else if (e === 'endpoint') this.handlers.endpoint.push(h as () => void);
    else if (e === 'speech') this.handlers.speech.push(h as () => void);
    else this.handlers.error.push(h as (err: ProviderError) => void);
  }
}

/**
 * Opens a session and resolves once the provider has accepted it. The `open`
 * every streaming adapter shares.
 */
export async function openSocketSession(
  opts: ConstructorParameters<typeof SocketSttSession>[0],
): Promise<SocketSttSession> {
  const session = new SocketSttSession(opts);
  await session.connect();
  return session;
}

/**
 * `ws` reports a refused upgrade as an error whose message carries the status,
 * e.g. "Unexpected server response: 401". Null when there is none.
 */
function refusedUpgradeStatus(e: unknown): number | null {
  const message = typeof e === 'object' && e !== null && 'message' in e ? String(e.message) : '';
  const match = /Unexpected server response: (\d{3})/.exec(message);
  return match ? Number(match[1]) : null;
}

/**
 * WebSocket close codes carry less information than an HTTP status, so only the
 * ones that genuinely mean "do not retry" are treated that way. Anything else
 * is retryable, because a session that stops on an ambiguous code is worse than
 * one that tries again.
 */
export function closeCodeToErrorClass(code: number): ProviderError['class'] {
  switch (code) {
    case 1008: // policy violation, which every v1 provider uses for a bad key
    case 3000: // unauthorized, the IANA registered application code
      return 'auth';
    case 1003: // unsupported data
    case 1007: // invalid payload
      return 'client';
    case 1011: // server error
      return 'server';
    case 1013: // try again later
      return 'rate-limit';
    default:
      return 'network';
  }
}
