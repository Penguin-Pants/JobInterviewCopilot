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
vi.mock('electron', () => ({
  desktopCapturer,
  session: { defaultSession: {} },
  BrowserWindow: class {},
}));

const { handleWorkerMessage, installLoopbackHandler, installPermissionHandler } =
  await import('../../src/main/audio-host.js');
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
