/**
 * A WebSocket the streaming STT tests drive by hand (TASK-012).
 *
 * Records every frame the adapter sends and lets a test fire `open`,
 * `message`, `error` and `close` in any order, so the wire format, the open
 * handshake and the reconnect path are asserted rather than assumed.
 */
import type { ConnectSpec, SocketLike } from '../../src/main/ai/stt/socket-session.js';

export class FakeSocket implements SocketLike {
  readonly sent: (string | Uint8Array)[] = [];
  closedWith: number | null = null;
  private readonly handlers = new Map<string, ((e: never) => void)[]>();

  constructor(readonly spec: ConnectSpec) {}

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    this.closedWith = code ?? 1000;
  }

  addEventListener(type: string, h: (e: never) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(h);
    this.handlers.set(type, list);
  }

  private fire(type: string, event?: unknown): void {
    for (const h of this.handlers.get(type) ?? []) (h as (e: unknown) => void)(event);
  }

  opened(): void {
    this.fire('open');
  }

  receive(frame: unknown): void {
    this.fire('message', { data: JSON.stringify(frame) });
  }

  /** Delivers the text verbatim, so a malformed frame really is malformed. */
  receiveRaw(text: string): void {
    this.fire('message', { data: text });
  }

  /** The `error` event `ws` fires, e.g. for a refused HTTP upgrade. */
  errored(message: string): void {
    this.fire('error', { message });
  }

  dropped(code = 1006, reason = 'abnormal'): void {
    this.fire('close', { code, reason });
  }

  /** The text frames only, decoded for assertion. */
  get textFrames(): string[] {
    return this.sent.filter((f): f is string => typeof f === 'string');
  }

  get binaryFrames(): Uint8Array[] {
    return this.sent.filter((f): f is Uint8Array => typeof f !== 'string');
  }
}

/** Hands back every socket it made, so a reconnect is observable. */
export function fakeFactory(): {
  factory: (s: ConnectSpec) => SocketLike;
  sockets: FakeSocket[];
} {
  const sockets: FakeSocket[] = [];
  return {
    factory: (spec) => {
      const socket = new FakeSocket(spec);
      sockets.push(socket);
      return socket;
    },
    sockets,
  };
}

/**
 * A timer the test fires by hand. `fire(ms)` runs every pending callback that
 * was scheduled with exactly that delay.
 */
export function manualTimer(): {
  timer: (fn: () => void, ms: number) => () => void;
  fire: (ms: number) => void;
  pending: (ms: number) => number;
} {
  const queue: { fn: () => void; ms: number; live: boolean }[] = [];
  return {
    timer: (fn, ms) => {
      const entry = { fn, ms, live: true };
      queue.push(entry);
      return () => {
        entry.live = false;
      };
    },
    fire: (ms) => {
      for (const entry of queue.filter((e) => e.live && e.ms === ms)) {
        entry.live = false;
        entry.fn();
      }
    },
    pending: (ms) => queue.filter((e) => e.live && e.ms === ms).length,
  };
}
