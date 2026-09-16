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
import { providerError } from '../stt.js';
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
  transcript(text: string, isFinal: boolean): void;
  endpoint(): void;
  error(err: ProviderError): void;
}

export interface SocketAdapterSpec {
  providerId: string;
  /** Built fresh on every connect, so a rotated key or changed gap is picked up. */
  connect(): ConnectSpec;
  /** Frames to send immediately after the socket opens, e.g. a session update. */
  handshake?(send: (data: string) => void): void;
  /** Translate one inbound text frame into zero or more normalized events. */
  handleMessage(raw: string, emit: Emitter): void;
  /** Encode one PCM chunk for the wire. Binary for all three v1 providers. */
  encode(chunk: AudioChunk): string | Uint8Array;
  /** A frame telling the provider the stream ended, sent before close. */
  closeFrame?(): string | null;
}

export type SocketFactory = (spec: ConnectSpec) => SocketLike;

type Handlers = {
  transcript: ((t: TranscriptEvent) => void)[];
  endpoint: (() => void)[];
  error: ((e: ProviderError) => void)[];
};

export class SocketSttSession implements SttSession {
  readonly source: TranscriptSource;
  readonly choice: ProviderChoice;

  private readonly spec: SocketAdapterSpec;
  private readonly factory: SocketFactory;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  private socket: SocketLike | null = null;
  private open = false;
  private closing = false;
  private reconnectAttempt = 0;
  private openedAt = 0;

  /** Bounded by MAX_QUEUED_CHUNKS. Cleared as soon as the socket is writable. */
  private readonly queue: AudioChunk[] = [];

  private readonly handlers: Handlers = { transcript: [], endpoint: [], error: [] };

  constructor(opts: {
    source: TranscriptSource;
    choice: ProviderChoice;
    spec: SocketAdapterSpec;
    factory: SocketFactory;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  }) {
    this.source = opts.source;
    this.choice = opts.choice;
    this.spec = opts.spec;
    this.factory = opts.factory;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
  }

  /** Live chunk count, so the retention bound can be asserted (ADR-027). */
  get queuedChunks(): number {
    return this.queue.length;
  }

  get isOpen(): boolean {
    return this.open;
  }

  connect(): void {
    if (this.closing) return;
    const socket = this.factory(this.spec.connect());
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.open = true;
      this.openedAt = this.now();
      this.spec.handshake?.((data) => socket.send(data));
      this.flushQueue();
    });

    socket.addEventListener('message', (e) => {
      const raw = typeof e.data === 'string' ? e.data : String(e.data);
      try {
        this.spec.handleMessage(raw, this.emitter);
      } catch {
        // A frame we cannot parse is not a reason to end an interview. The
        // provider will send more; drop this one and keep the session alive.
      }
    });

    socket.addEventListener('error', () => {
      // 'close' always follows 'error' and carries the status, so reconnect is
      // driven from there alone. Handling both would double the backoff.
    });

    socket.addEventListener('close', (e) => {
      const wasHealthy = this.open && this.now() - this.openedAt >= HEALTHY_CONNECTION_MS;
      this.open = false;
      this.socket = null;
      if (this.closing) return;
      if (wasHealthy) this.reconnectAttempt = 0;
      void this.reconnect(e.code, e.reason);
    });
  }

  private readonly emitter: Emitter = {
    transcript: (text, isFinal) => {
      const event: TranscriptEvent = {
        source: this.source,
        text,
        isFinal,
        timestamp: Date.now(),
        providerId: this.choice.providerId,
      };
      for (const h of this.handlers.transcript) h(event);
    },
    endpoint: () => {
      for (const h of this.handlers.endpoint) h();
    },
    error: (err) => {
      for (const h of this.handlers.error) h(err);
    },
  };

  /**
   * A dropped socket reconnects and the session stays active (TC-054). The
   * session only fails outward once the ladder is exhausted, or immediately on
   * a non-retryable close, where retrying would fail identically forever.
   */
  private async reconnect(code: number, reason: string): Promise<void> {
    const errorClass = closeCodeToErrorClass(code);
    if (errorClass === 'auth' || errorClass === 'client') {
      this.emitter.error(
        providerError(
          this.spec.providerId,
          errorClass,
          reason || `The ${this.spec.providerId} socket was rejected (code ${String(code)}).`,
        ),
      );
      return;
    }

    if (this.reconnectAttempt >= RECONNECT_BACKOFF_MS.length) {
      this.emitter.error(
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
    this.connect();
  }

  push(chunk: AudioChunk): void {
    if (this.closing) return;
    if (this.open && this.socket) {
      this.socket.send(this.spec.encode(chunk));
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
    }
  }

  close(): Promise<void> {
    this.closing = true;
    this.queue.length = 0;
    const socket = this.socket;
    if (socket) {
      const frame = this.spec.closeFrame?.();
      if (frame !== null && frame !== undefined && this.open) {
        try {
          socket.send(frame);
        } catch {
          // The socket died first. Closing is the point; nothing to recover.
        }
      }
      socket.close(1000, 'session ended');
    }
    this.socket = null;
    this.open = false;
    return Promise.resolve();
  }

  on(e: 'transcript', h: (t: TranscriptEvent) => void): void;
  on(e: 'endpoint', h: () => void): void;
  on(e: 'error', h: (err: ProviderError) => void): void;
  on(e: 'transcript' | 'endpoint' | 'error', h: (...args: never[]) => void): void {
    if (e === 'transcript') this.handlers.transcript.push(h as (t: TranscriptEvent) => void);
    else if (e === 'endpoint') this.handlers.endpoint.push(h as () => void);
    else this.handlers.error.push(h as (err: ProviderError) => void);
  }
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
