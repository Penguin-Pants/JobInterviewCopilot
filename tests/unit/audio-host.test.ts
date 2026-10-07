import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initLogger } from '../../src/main/logger.js';

initLogger({ dir: mkdtempSync(join(tmpdir(), 'icp-audio-host-')) });

/**
 * The two main-process concessions loopback needs (ADR-028).
 *
 * Both encode a finding the spike made the hard way, and both fail silently if
 * wrong: a handler that does not call its callback leaves getDisplayMedia
 * pending forever, and a permission handler that is too permissive gives a
 * window capture rights it should never have.
 */

const desktopCapturer = vi.hoisted(() => ({ getSources: vi.fn() }));

/**
 * A BrowserWindow that records what was done to it. Every load is a promise
 * the test settles by hand, so a second start or a destroy can land during it.
 */
const fakeElectron = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  class Emitter {
    private readonly listeners = new Map<string, Listener[]>();
    on(event: string, listener: Listener): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
  }
  class FakeWebContents extends Emitter {
    readonly sent: Array<{ channel: string; payload: unknown }> = [];
    send(channel: string, payload?: unknown): void {
      this.sent.push({ channel, payload });
    }
    setWindowOpenHandler(): void {}
    getURL(): string {
      return 'file:///app/out/renderer/audio-worker/index.html';
    }
  }
  const created: FakeWindow[] = [];
  class FakeWindow extends Emitter {
    readonly webContents = new FakeWebContents();
    readonly calls: string[] = [];
    destroyed = false;
    private settleLoad: { resolve: () => void; reject: (err: Error) => void } | null = null;
    constructor(readonly options: Record<string, unknown>) {
      super();
      created.push(this);
    }
    setContentProtection(enabled: boolean): void {
      this.calls.push(`setContentProtection(${enabled})`);
    }
    loadFile(): Promise<void> {
      this.calls.push('load');
      return new Promise<void>((resolve, reject) => {
        this.settleLoad = { resolve, reject };
      });
    }
    loadURL(): Promise<void> {
      return this.loadFile();
    }
    finishLoad(): void {
      this.settleLoad?.resolve();
    }
    failLoad(err: Error): void {
      this.settleLoad?.reject(err);
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    destroy(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      this.failLoad(new Error('ERR_ABORTED'));
      this.emit('closed');
    }
  }
  return { created, FakeWindow };
});

vi.mock('electron', () => ({
  desktopCapturer,
  session: { defaultSession: {} },
  BrowserWindow: fakeElectron.FakeWindow,
  screen: {},
  shell: { openExternal: () => Promise.resolve() },
}));

const { ElectronAudioWorkerHost, installLoopbackHandler, installPermissionHandler } =
  await import('../../src/main/audio-host.js');

type DisplayHandler = (
  request: unknown,
  callback: (response: Record<string, unknown>) => void,
) => Promise<void> | void;

function fakeSession(): {
  session: Parameters<typeof installLoopbackHandler>[0];
  handler: () => DisplayHandler;
  options: () => Record<string, unknown> | undefined;
  permission: () => (c: unknown, p: string, cb: (ok: boolean) => void) => void;
} {
  let displayHandler: DisplayHandler = () => {};
  let displayOptions: Record<string, unknown> | undefined;
  let permissionHandler: (c: unknown, p: string, cb: (ok: boolean) => void) => void = () => {};

  const session = {
    setDisplayMediaRequestHandler: (h: DisplayHandler, o?: Record<string, unknown>) => {
      displayHandler = h;
      displayOptions = o;
    },
    setPermissionRequestHandler: (h: typeof permissionHandler) => {
      permissionHandler = h;
    },
  } as unknown as Parameters<typeof installLoopbackHandler>[0];

  return {
    session,
    handler: () => displayHandler,
    options: () => displayOptions,
    permission: () => permissionHandler,
  };
}

beforeEach(() => {
  desktopCapturer.getSources.mockReset();
});

describe('ADR-028 display media handler', () => {
  it('disables the system picker, which would otherwise prompt the user', async () => {
    const fake = fakeSession();
    installLoopbackHandler(fake.session);
    expect(fake.options()).toMatchObject({ useSystemPicker: false });
  });

  it('answers with the screen source and loopback audio', async () => {
    const fake = fakeSession();
    desktopCapturer.getSources.mockResolvedValue([{ id: 'screen:0', name: 'Entire screen' }]);
    installLoopbackHandler(fake.session);

    const answer = vi.fn();
    await fake.handler()({}, answer);

    expect(answer).toHaveBeenCalledOnce();
    expect(answer.mock.calls[0]![0]).toMatchObject({
      video: { id: 'screen:0' },
      audio: 'loopback',
    });
  });

  it('still calls the callback when there is no capture source', async () => {
    // Returning without calling it leaves getDisplayMedia pending forever,
    // which presents as a pipeline that never starts and never errors.
    const fake = fakeSession();
    desktopCapturer.getSources.mockResolvedValue([]);
    installLoopbackHandler(fake.session);

    const answer = vi.fn();
    await fake.handler()({}, answer);

    expect(answer).toHaveBeenCalledOnce();
    expect(answer.mock.calls[0]![0]).toEqual({});
  });

  it('still calls the callback when enumerating sources throws', async () => {
    const fake = fakeSession();
    desktopCapturer.getSources.mockRejectedValue(new Error('capture subsystem unavailable'));
    installLoopbackHandler(fake.session);

    const answer = vi.fn();
    await fake.handler()({}, answer);

    expect(answer).toHaveBeenCalledOnce();
    expect(answer.mock.calls[0]![0]).toEqual({});
  });
});

describe('permission handler', () => {
  it('grants media to the audio worker', () => {
    const fake = fakeSession();
    const worker = { id: 'worker' };
    installPermissionHandler((c) => (c as unknown) === worker, fake.session);

    const decide = vi.fn();
    fake.permission()(worker, 'media', decide);

    expect(decide).toHaveBeenCalledWith(true);
  });

  it('denies media to any other window', () => {
    const fake = fakeSession();
    installPermissionHandler(() => false, fake.session);

    const decide = vi.fn();
    fake.permission()({ id: 'dashboard' }, 'media', decide);

    expect(decide).toHaveBeenCalledWith(false);
  });

  it('denies every permission other than media, even to the worker', () => {
    const fake = fakeSession();
    const worker = { id: 'worker' };
    installPermissionHandler((c) => (c as unknown) === worker, fake.session);

    for (const permission of ['geolocation', 'notifications', 'clipboard-read', 'midi']) {
      const decide = vi.fn();
      fake.permission()(worker, permission, decide);
      expect(decide, `${permission} must be denied`).toHaveBeenCalledWith(false);
    }
  });
});

type FakeWindow = InstanceType<typeof fakeElectron.FakeWindow>;

function newHost(): {
  host: InstanceType<typeof ElectronAudioWorkerHost>;
  states: Array<{ source: string; state: string; error?: string }>;
} {
  const states: Array<{ source: string; state: string; error?: string }> = [];
  const host = new ElectronAudioWorkerHost({
    onChunk: () => {},
    onStreamState: (payload) => states.push(payload),
  });
  return { host, states };
}

function lastWindow(): FakeWindow {
  const win = fakeElectron.created.at(-1);
  if (!win) throw new Error('no window was created');
  return win;
}

function startsSentTo(win: FakeWindow): unknown[] {
  return win.webContents.sent.filter((m) => m.channel === 'audio:start').map((m) => m.payload);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('TC-004 and TC-007 the live audio worker window', () => {
  beforeEach(() => {
    fakeElectron.created.length = 0;
  });

  it('is sandboxed, context isolated and without node integration', async () => {
    const { host } = newHost();
    const started = host.start(['interviewer']);
    lastWindow().finishLoad();
    await started;

    const prefs = lastWindow().options.webPreferences as Record<string, unknown>;
    expect(prefs).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false });
    expect(lastWindow().options.show).toBe(false);
  });

  it('is content protected before its renderer loads, and never unprotected', async () => {
    const { host } = newHost();
    const started = host.start(['interviewer']);
    lastWindow().finishLoad();
    await started;

    const calls = lastWindow().calls;
    expect(calls.indexOf('setContentProtection(true)')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('setContentProtection(true)')).toBeLessThan(calls.indexOf('load'));
    expect(calls).not.toContain('setContentProtection(false)');
  });
});

describe('the worker window is created once and never leaked', () => {
  beforeEach(() => {
    fakeElectron.created.length = 0;
  });

  it('creates one window for two overlapping starts and starts both', async () => {
    const { host } = newHost();
    const first = host.start(['interviewer']);
    const second = host.start(['candidate']);
    lastWindow().finishLoad();
    await Promise.all([first, second]);

    expect(fakeElectron.created).toHaveLength(1);
    expect(startsSentTo(lastWindow())).toEqual([
      { streams: ['interviewer'] },
      { streams: ['candidate'] },
    ]);
  });

  it('destroys a window whose renderer failed to load, and the next start builds a fresh one', async () => {
    const { host } = newHost();
    const failed = host.start(['interviewer']);
    const broken = lastWindow();
    broken.failLoad(new Error('ERR_FILE_NOT_FOUND'));
    await expect(failed).rejects.toThrow('ERR_FILE_NOT_FOUND');
    expect(broken.destroyed).toBe(true);

    const retried = host.start(['interviewer']);
    lastWindow().finishLoad();
    await retried;

    expect(fakeElectron.created).toHaveLength(2);
    expect(startsSentTo(lastWindow())).toEqual([{ streams: ['interviewer'] }]);
  });

  it('a destroy during the load leaves no window and starts no capture', async () => {
    const { host } = newHost();
    const started = host.start(['interviewer']).catch(() => undefined);
    const win = lastWindow();
    await host.destroy();
    await started;

    expect(win.destroyed).toBe(true);
    expect(startsSentTo(win)).toEqual([]);
    expect(host.owns(win.webContents as never)).toBe(false);
  });
});

describe('FR-045 an audio worker crash is reported, not silent', () => {
  beforeEach(() => {
    fakeElectron.created.length = 0;
  });

  it('reports every running stream as failed and replaces the window on the next start', async () => {
    const { host, states } = newHost();
    const started = host.start(['interviewer', 'candidate']);
    const crashed = lastWindow();
    crashed.finishLoad();
    await started;

    crashed.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    await settle();

    expect(crashed.destroyed).toBe(true);
    expect(states.map((s) => [s.source, s.state])).toEqual([
      ['interviewer', 'error'],
      ['candidate', 'error'],
    ]);
    expect(states[0]!.error).toContain('crashed');

    const restarted = host.start(['interviewer']);
    lastWindow().finishLoad();
    await restarted;
    expect(fakeElectron.created).toHaveLength(2);
    expect(startsSentTo(lastWindow())).toEqual([{ streams: ['interviewer'] }]);
  });

  it('reports nothing for a crash after capture was stopped', async () => {
    const { host, states } = newHost();
    const started = host.start(['interviewer']);
    const win = lastWindow();
    win.finishLoad();
    await started;
    await host.stop();

    win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    await settle();

    expect(states).toEqual([]);
  });
});
