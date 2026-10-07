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
  let nextRoutingId = 1;
  class FakeWebContents extends Emitter {
    readonly sent: Array<{ channel: string; payload: unknown }> = [];
    readonly mainFrame = { processId: 7, routingId: nextRoutingId++, parent: null, url: '' };
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

const {
  ElectronAudioWorkerHost,
  handleWorkerMessage,
  installLoopbackHandler,
  installPermissionHandler,
} = await import('../../src/main/audio-host.js');
const { MAX_PCM_CHUNK_BYTES } = await import('../../src/shared/ipc.js');

/** The worker's frame, and one that belongs to some other window. */
const workerFrame = { id: 'worker-frame' };
const otherFrame = { id: 'overlay-frame' };
const isWorkerFrame = (frame: unknown): boolean => frame === workerFrame;

type DisplayHandler = (
  request: unknown,
  callback: (response: Record<string, unknown>) => void,
) => Promise<void> | void;

function fakeSession(): {
  session: Parameters<typeof installLoopbackHandler>[1];
  handler: () => DisplayHandler;
  options: () => Record<string, unknown> | undefined;
  permission: () => (c: unknown, p: string, cb: (ok: boolean) => void) => void;
  check: () => (c: unknown, p: string) => boolean;
} {
  let displayHandler: DisplayHandler = () => {};
  let displayOptions: Record<string, unknown> | undefined;
  let permissionHandler: (c: unknown, p: string, cb: (ok: boolean) => void) => void = () => {};
  let checkHandler: (c: unknown, p: string) => boolean = () => true;

  const session = {
    setDisplayMediaRequestHandler: (h: DisplayHandler, o?: Record<string, unknown>) => {
      displayHandler = h;
      displayOptions = o;
    },
    setPermissionRequestHandler: (h: typeof permissionHandler) => {
      permissionHandler = h;
    },
    setPermissionCheckHandler: (h: typeof checkHandler) => {
      checkHandler = h;
    },
  } as unknown as Parameters<typeof installLoopbackHandler>[1];

  return {
    session,
    handler: () => displayHandler,
    options: () => displayOptions,
    permission: () => permissionHandler,
    check: () => checkHandler,
  };
}

beforeEach(() => {
  desktopCapturer.getSources.mockReset();
});

describe('ADR-028 display media handler', () => {
  it('disables the system picker, which would otherwise prompt the user', async () => {
    const fake = fakeSession();
    installLoopbackHandler(isWorkerFrame, fake.session);
    expect(fake.options()).toMatchObject({ useSystemPicker: false });
  });

  it('answers with the screen source and loopback audio', async () => {
    const fake = fakeSession();
    desktopCapturer.getSources.mockResolvedValue([{ id: 'screen:0', name: 'Entire screen' }]);
    installLoopbackHandler(isWorkerFrame, fake.session);

    const answer = vi.fn();
    await fake.handler()({ frame: workerFrame }, answer);

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
    installLoopbackHandler(isWorkerFrame, fake.session);

    const answer = vi.fn();
    await fake.handler()({ frame: workerFrame }, answer);

    expect(answer).toHaveBeenCalledOnce();
    expect(answer.mock.calls[0]![0]).toEqual({});
  });

  it('still calls the callback when enumerating sources throws', async () => {
    const fake = fakeSession();
    desktopCapturer.getSources.mockRejectedValue(new Error('capture subsystem unavailable'));
    installLoopbackHandler(isWorkerFrame, fake.session);

    const answer = vi.fn();
    await fake.handler()({ frame: workerFrame }, answer);

    expect(answer).toHaveBeenCalledOnce();
    expect(answer.mock.calls[0]![0]).toEqual({});
  });
});

/**
 * Audit regression: the handler ignored which frame asked. Any window that
 * called `getDisplayMedia` got the screen and loopback audio with no picker.
 */
describe('display media is for the audio worker only', () => {
  it('refuses any other frame without enumerating a source', async () => {
    const fake = fakeSession();
    desktopCapturer.getSources.mockResolvedValue([{ id: 'screen:0', name: 'Entire screen' }]);
    installLoopbackHandler(isWorkerFrame, fake.session);

    for (const frame of [otherFrame, null]) {
      const answer = vi.fn();
      await fake.handler()({ frame }, answer);
      expect(answer).toHaveBeenCalledOnce();
      expect(answer.mock.calls[0]![0]).toEqual({});
    }
    expect(desktopCapturer.getSources).not.toHaveBeenCalled();
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

  it('grants display-capture to the audio worker and to nothing else', () => {
    // Electron 45 reports getDisplayMedia() as display-capture, not media. The
    // worker's loopback capture must survive that upgrade (ADR-028).
    const fake = fakeSession();
    const worker = { id: 'worker' };
    installPermissionHandler((c) => (c as unknown) === worker, fake.session);

    const forWorker = vi.fn();
    fake.permission()(worker, 'display-capture', forWorker);
    expect(forWorker).toHaveBeenCalledWith(true);

    const forDashboard = vi.fn();
    fake.permission()({ id: 'dashboard' }, 'display-capture', forDashboard);
    expect(forDashboard).toHaveBeenCalledWith(false);
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

/**
 * Permission checks, as opposed to requests, were left on Electron's default.
 * They are scoped by the same rule as requests now.
 */
describe('permission check handler', () => {
  it('answers yes to media for the worker and no to everything else', () => {
    const fake = fakeSession();
    const worker = { id: 'worker' };
    installPermissionHandler((c) => (c as unknown) === worker, fake.session);
    const check = fake.check();

    expect(check(worker, 'media')).toBe(true);
    expect(check({ id: 'overlay' }, 'media')).toBe(false);
    expect(check(null, 'media')).toBe(false);
    expect(check(worker, 'geolocation')).toBe(false);
  });

  it('answers yes to display-capture for the worker only', () => {
    const fake = fakeSession();
    const worker = { id: 'worker' };
    installPermissionHandler((c) => (c as unknown) === worker, fake.session);
    const check = fake.check();

    expect(check(worker, 'display-capture')).toBe(true);
    expect(check({ id: 'overlay' }, 'display-capture')).toBe(false);
    expect(check(null, 'display-capture')).toBe(false);
  });
});

/**
 * Audit regression: worker messages were cast, not parsed. A malformed chunk
 * threw inside an EventEmitter listener, which is an uncaught main-process
 * exception, and a message from any frame was trusted.
 */
describe('CH-303 and CH-304 are parsed, not cast', () => {
  function host(): {
    onChunk: ReturnType<typeof vi.fn>;
    onStreamState: ReturnType<typeof vi.fn>;
    send: (channel: string, args: unknown[], frame?: unknown) => void;
  } {
    const onChunk = vi.fn();
    const onStreamState = vi.fn();
    return {
      onChunk,
      onStreamState,
      send: (channel, args, frame = workerFrame) =>
        handleWorkerMessage(
          { onChunk, onStreamState },
          isWorkerFrame,
          { senderFrame: frame as never },
          channel,
          args,
        ),
    };
  }
  const meta = { source: 'interviewer', timestamp: 1, sequence: 0 };

  it('hands a well-formed chunk on', () => {
    const h = host();
    const pcm = new ArrayBuffer(32_000);
    h.send('audio:chunk', [meta, pcm]);
    expect(h.onChunk).toHaveBeenCalledWith({ ...meta, pcm });
  });

  it('drops a chunk with bad metadata or a buffer that is not PCM', () => {
    const h = host();
    h.send('audio:chunk', [{ ...meta, source: 'mixed' }, new ArrayBuffer(2)]);
    h.send('audio:chunk', [meta, 'not a buffer']);
    h.send('audio:chunk', [meta, new Uint8Array(2)]);
    h.send('audio:chunk', [meta, new ArrayBuffer(3)]);
    h.send('audio:chunk', [meta, new ArrayBuffer(0)]);
    h.send('audio:chunk', [meta, new ArrayBuffer(MAX_PCM_CHUNK_BYTES + 2)]);
    h.send('audio:chunk', []);
    expect(h.onChunk).not.toHaveBeenCalled();
  });

  it('a consumer that throws does not escape the listener', () => {
    const h = host();
    h.onChunk.mockImplementation(() => {
      throw new Error('consumer exploded');
    });
    expect(() => h.send('audio:chunk', [meta, new ArrayBuffer(2)])).not.toThrow();
  });

  it('hands a well-formed stream state on and drops a malformed one', () => {
    const h = host();
    h.send('audio:streamState', [{ source: 'candidate', state: 'running' }]);
    h.send('audio:streamState', [{ source: 'candidate', state: 'exploded' }]);
    h.send('audio:streamState', [null]);
    expect(h.onStreamState).toHaveBeenCalledOnce();
    expect(h.onStreamState).toHaveBeenCalledWith({ source: 'candidate', state: 'running' });
  });

  it('ignores a message from any frame but the worker page', () => {
    const h = host();
    h.send('audio:chunk', [meta, new ArrayBuffer(2)], otherFrame);
    h.send('audio:streamState', [{ source: 'candidate', state: 'error' }], null);
    expect(h.onChunk).not.toHaveBeenCalled();
    expect(h.onStreamState).not.toHaveBeenCalled();
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

/**
 * `ownsFrame` decides who may capture the screen silently (ADR-028), so it is
 * tested on its own, not only through an injected predicate.
 */
describe('only the worker window owns the display-media frame', () => {
  beforeEach(() => {
    fakeElectron.created.length = 0;
  });

  async function started(): Promise<{
    host: InstanceType<typeof ElectronAudioWorkerHost>;
    win: FakeWindow;
  }> {
    const { host } = newHost();
    const start = host.start(['interviewer']);
    lastWindow().finishLoad();
    await start;
    return { host, win: lastWindow() };
  }

  it("accepts the worker's own top-level frame", async () => {
    const { host, win } = await started();
    const frame = { ...win.webContents.mainFrame };
    expect(host.ownsFrame(frame as unknown as Electron.WebFrameMain)).toBe(true);
  });

  it('refuses a frame with another routing id or process id', async () => {
    const { host, win } = await started();
    const main = win.webContents.mainFrame;
    const otherRoute = { ...main, routingId: main.routingId + 100 };
    const otherProcess = { ...main, processId: main.processId + 1 };
    expect(host.ownsFrame(otherRoute as unknown as Electron.WebFrameMain)).toBe(false);
    expect(host.ownsFrame(otherProcess as unknown as Electron.WebFrameMain)).toBe(false);
  });

  it('refuses a null frame', async () => {
    const { host } = await started();
    expect(host.ownsFrame(null)).toBe(false);
  });

  it('refuses every frame once the window is destroyed, and before it exists', async () => {
    const { host: fresh } = newHost();
    expect(fresh.ownsFrame({ processId: 7, routingId: 1 } as Electron.WebFrameMain)).toBe(false);

    const { host, win } = await started();
    const frame = { ...win.webContents.mainFrame };
    win.destroy();
    expect(host.ownsFrame(frame as unknown as Electron.WebFrameMain)).toBe(false);
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
