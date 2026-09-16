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

const { installLoopbackHandler, installPermissionHandler } =
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
