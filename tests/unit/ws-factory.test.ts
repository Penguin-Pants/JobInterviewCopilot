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
