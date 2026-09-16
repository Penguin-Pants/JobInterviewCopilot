/**
 * The real WebSocket transport. No filesystem imports (NFR-002).
 *
 * `ws` rather than the global `WebSocket`, because two of the three providers
 * authenticate with a request header and the platform constructor has no way to
 * set one. It also gives every adapter one transport to reconnect, rather than
 * three SDK-owned sockets with three reconnect policies (ADR-029).
 */
import WebSocket from 'ws';
import type { ConnectSpec, SocketLike } from './socket-session.js';

export function createWebSocket(spec: ConnectSpec): SocketLike {
  const socket = new WebSocket(spec.url, spec.protocols ?? [], { headers: spec.headers });
  socket.binaryType = 'nodebuffer';
  return socket as unknown as SocketLike;
}
