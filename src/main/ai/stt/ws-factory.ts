/**
 * The real WebSocket transport. No filesystem imports (NFR-002).
 *
 * `ws` rather than the global `WebSocket`, because two of the three providers
 * authenticate with a request header and the platform constructor has no way to
 * set one. It also gives every adapter one transport to reconnect, rather than
 * three SDK-owned sockets with three reconnect policies (ADR-029).
 *
 * Two bounds keep a dead connection from looking alive (ADR-054). The HTTP
 * upgrade has a timeout, and an open socket is pinged on an interval: a peer
 * that misses a pong is terminated. Termination is an ordinary abnormal close,
 * so `SocketSttSession` runs its reconnect ladder. Without these a half-open
 * socket could hold a session open, still billing, with no transcripts.
 */
import WebSocket from 'ws';
import type { ConnectSpec, SocketLike } from './socket-session.js';

/** How long the HTTP upgrade may take before `ws` aborts it. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/** How often an open socket is pinged. A missed pong by the next tick ends it. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

export interface WebSocketOptions {
  handshakeTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  /** Injected so the heartbeat is testable without waiting on real time. */
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export function createWebSocket(spec: ConnectSpec, options: WebSocketOptions = {}): SocketLike {
  const socket = new WebSocket(spec.url, spec.protocols ?? [], {
    headers: spec.headers,
    handshakeTimeout: options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
  });
  socket.binaryType = 'nodebuffer';

  const every = options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const stop =
    options.clearInterval ??
    ((handle) => {
      clearInterval(handle as ReturnType<typeof setInterval>);
    });

  let awaitingPong = false;
  let heartbeat: unknown = null;

  socket.on('open', () => {
    heartbeat = every(() => {
      if (awaitingPong) {
        socket.terminate();
        return;
      }
      if (socket.readyState !== WebSocket.OPEN) return;
      awaitingPong = true;
      socket.ping();
    }, options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
  });
  socket.on('pong', () => {
    awaitingPong = false;
  });
  socket.on('close', () => {
    if (heartbeat !== null) stop(heartbeat);
    heartbeat = null;
  });

  return socket as unknown as SocketLike;
}
