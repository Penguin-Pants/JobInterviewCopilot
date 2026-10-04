/**
 * The interop guard for `ws`, mirroring TC-037.
 *
 * Milestone 0 lost a CI round to `electron-store` being ESM-only: `require()`
 * returned a namespace object, `new` threw inside bootstrap, and the app stayed
 * alive with no windows. Registering an adapter does not construct a socket, so
 * the smoke test cannot catch the same shape of bug here. This connects to a
 * real server, which does.
 */
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { createWebSocket } from '../../src/main/ai/stt/ws-factory.js';

const server = createServer();
const wss = new WebSocketServer({ server });
let url = '';
let seenHeader: string | undefined;

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      wss.on('connection', (socket, req) => {
        seenHeader = req.headers['xi-api-key'] as string | undefined;
        socket.send('hello');
      });
      server.listen(0, '127.0.0.1', () => {
        url = `ws://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
        resolve();
      });
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve) => {
      wss.close(() => server.close(() => resolve()));
    }),
);

describe('the ws transport is constructible and carries headers', () => {
  it('connects, sets the auth header and delivers a frame', async () => {
    const socket = createWebSocket({ url, headers: { 'xi-api-key': 'a-key' } });

    const message = await new Promise<string>((resolve, reject) => {
      socket.addEventListener('message', (e) => {
        resolve(typeof e.data === 'string' ? e.data : String(e.data));
      });
      socket.addEventListener('close', () => {
        reject(new Error('closed before any frame arrived'));
      });
      setTimeout(() => {
        reject(new Error('timed out'));
      }, 5000);
    });

    expect(message).toBe('hello');
    // The header is the reason `ws` is here rather than the platform
    // constructor, so it is asserted rather than assumed (ADR-029).
    expect(seenHeader).toBe('a-key');
    socket.close(1000, 'done');
  });
});

/**
 * ADR-054. A half-open socket kept a session alive, and billing, with no
 * transcripts. The upgrade is bounded and an open socket is pinged; a peer
 * that misses a pong is terminated, which is an ordinary abnormal close.
 */
describe('the ws transport detects a dead peer', () => {
  type Socket = ReturnType<typeof createWebSocket>;

  function closed(socket: Socket): Promise<number> {
    return new Promise((resolve) => {
      socket.addEventListener('close', (e) => resolve(e.code));
    });
  }

  function opened(socket: Socket): Promise<void> {
    return new Promise((resolve) => {
      socket.addEventListener('open', () => resolve());
    });
  }

  const pause = () => new Promise((r) => setTimeout(r, 50));

  it('aborts an upgrade the server never answers', async () => {
    const silent = createNetServer(() => undefined);
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    const port = (silent.address() as AddressInfo).port;
    try {
      const socket = createWebSocket(
        { url: `ws://127.0.0.1:${String(port)}` },
        { handshakeTimeoutMs: 50 },
      );
      const errors: unknown[] = [];
      // `SocketSttSession` always listens for `error`; without a listener the
      // emitter would throw instead of closing.
      socket.addEventListener('error', (e) => errors.push(e));
      expect(await closed(socket)).toBe(1006);
      expect(errors).toHaveLength(1);
    } finally {
      silent.close();
    }
  });

  async function heartbeatAgainst(autoPong: boolean) {
    const http = createServer();
    const peer = new WebSocketServer({ server: http, autoPong });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    const port = (http.address() as AddressInfo).port;
    let tick: (() => void) | null = null;
    let cleared = false;
    const socket = createWebSocket(
      { url: `ws://127.0.0.1:${String(port)}` },
      {
        setInterval: (fn) => {
          tick = fn;
          return 'handle';
        },
        clearInterval: () => {
          cleared = true;
        },
      },
    );
    await opened(socket);
    return {
      socket,
      tick: () => tick?.(),
      cleared: () => cleared,
      stop: () =>
        new Promise<void>((r) => {
          for (const client of peer.clients) client.terminate();
          peer.close(() => http.close(() => r()));
        }),
    };
  }

  it('terminates a peer that does not answer a ping', async () => {
    const h = await heartbeatAgainst(false);
    const code = closed(h.socket);
    h.tick(); // ping
    await pause();
    h.tick(); // no pong came back
    expect(await code).toBe(1006);
    expect(h.cleared()).toBe(true);
    await h.stop();
  });

  it('keeps a peer that answers', async () => {
    const h = await heartbeatAgainst(true);
    let wasClosed = false;
    h.socket.addEventListener('close', () => {
      wasClosed = true;
    });
    for (let i = 0; i < 3; i += 1) {
      h.tick();
      await pause();
    }
    expect(wasClosed).toBe(false);
    h.socket.close(1000, 'done');
    await h.stop();
  });
});
