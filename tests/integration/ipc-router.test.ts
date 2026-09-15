import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IpcMain } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcRouter } from '../../src/main/ipc/router.js';
import { initLogger } from '../../src/main/logger.js';
import { isIpcError } from '../../src/shared/ipc.js';
import { defaultSettings } from '../../src/shared/defaults.js';

/**
 * TC-002: the router rejects an invalid payload, logs it, and never forwards it
 * to the handler (CMP-10, FR-086).
 */

type Invoker = (event: unknown, payload: unknown) => Promise<unknown>;

/** A fake ipcMain that records handlers so they can be invoked directly. */
class FakeIpcMain {
  readonly handlers = new Map<string, Invoker>();
  handle(channel: string, listener: Invoker): void {
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
  invoke(channel: string, payload: unknown): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, payload);
  }
}

let logDir: string;
let ipc: FakeIpcMain;
let router: IpcRouter;

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), 'icp-router-'));
  initLogger({ dir: logDir });
  ipc = new FakeIpcMain();
  // The fake satisfies the two methods the router uses.
  router = new IpcRouter(ipc as unknown as IpcMain);
});

describe('TC-002 router payload validation', () => {
  it('never calls the handler when the payload fails its schema', async () => {
    const handler = vi.fn(() => ({ ok: true as const }));
    router.handle('profile:delete', handler);

    const result = await ipc.invoke('profile:delete', { wrong: 'shape' });

    expect(handler).not.toHaveBeenCalled();
    expect(isIpcError(result)).toBe(true);
  });

  it('calls the handler and returns its value when the payload is valid', async () => {
    router.handle('profile:delete', () => ({ ok: true as const }));
    const result = await ipc.invoke('profile:delete', { id: 'p1' });
    expect(result).toEqual({ ok: true });
  });

  it('logs the rejection with the channel id', async () => {
    router.handle('profile:delete', () => ({ ok: true as const }));
    await ipc.invoke('profile:delete', {});

    const log = readFileSync(join(logDir, 'main.log'), 'utf8');
    expect(log).toContain('ipc payload rejected');
    expect(log).toContain('CH-107');
  });

  it('turns a throwing handler into a typed error rather than a rejected promise', async () => {
    router.handle('profile:delete', () => {
      throw new Error('handler exploded');
    });

    const result = await ipc.invoke('profile:delete', { id: 'p1' });
    expect(isIpcError(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('exploded');
  });

  it('rejects a handler that returns the wrong response shape', async () => {
    router.handle('config:get', (() => ({ nonsense: true })) as never);
    const result = await ipc.invoke('config:get', undefined);

    expect(isIpcError(result)).toBe(true);
    expect(readFileSync(join(logDir, 'main.log'), 'utf8')).toContain('ipc response rejected');
  });

  it('passes a well-formed settings object through unchanged', async () => {
    const settings = defaultSettings();
    router.handle('config:get', () => settings);
    expect(await ipc.invoke('config:get', undefined)).toMatchObject({ schemaVersion: 1 });
  });

  it('refuses to register the same channel twice', () => {
    router.handle('consent:dismiss', () => ({ ok: true as const }));
    expect(() => router.handle('consent:dismiss', () => ({ ok: true as const }))).toThrow(
      /already registered/i,
    );
  });

  it('dispose removes every handler it registered', () => {
    router.handle('consent:dismiss', () => ({ ok: true as const }));
    router.dispose();
    expect(ipc.handlers.size).toBe(0);
  });
});

/**
 * The push path validates too. A malformed push is dropped and logged rather
 * than delivered, so a bug in the main process cannot put a nonsense payload
 * into a renderer (CMP-10).
 */
describe('push validation', () => {
  interface FakeWebContents {
    sent: Array<{ channel: string; payload: unknown }>;
    isDestroyed(): boolean;
    send(channel: string, payload: unknown): void;
  }

  function fakeWebContents(destroyed = false): FakeWebContents {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    return {
      sent,
      isDestroyed: () => destroyed,
      send: (channel, payload) => sent.push({ channel, payload }),
    };
  }

  it('sends a valid payload through', async () => {
    const { push } = await import('../../src/main/ipc/router.js');
    const wc = fakeWebContents();

    push(wc as never, 'overlay:consent', { text: 'reminder' });

    expect(wc.sent).toEqual([{ channel: 'overlay:consent', payload: { text: 'reminder' } }]);
  });

  it('drops a payload that fails its schema and logs it', async () => {
    const { push } = await import('../../src/main/ipc/router.js');
    const wc = fakeWebContents();

    push(wc as never, 'usage:warning', { kind: 'bananas', value: 1, threshold: 2 } as never);

    expect(wc.sent).toHaveLength(0);
    expect(readFileSync(join(logDir, 'main.log'), 'utf8')).toContain('ipc push rejected');
  });

  it('is a no-op for a destroyed or missing target', async () => {
    const { push } = await import('../../src/main/ipc/router.js');
    const destroyed = fakeWebContents(true);

    push(destroyed as never, 'overlay:consent', { text: 'x' });
    push(null, 'overlay:consent', { text: 'x' });

    expect(destroyed.sent).toHaveLength(0);
  });
});
