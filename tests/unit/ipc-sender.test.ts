import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appRendererUrlCheck, isTopLevelAppFrame } from '../../src/main/ipc/sender.js';
import type { CopilotBridge } from '../../src/shared/bridge.js';
import {
  INVOKE_ACCESS,
  INVOKE_CHANNEL_NAMES,
  invokeChannelsFor,
  mayInvoke,
  PUSH_CHANNEL_NAMES,
  pushChannelsFor,
  type InvokeChannel,
  type IpcWindowRole,
  type PushChannel,
} from '../../src/shared/ipc.js';

/** The Electron surface a preload touches, so a preload can be loaded and probed. */
const electron = vi.hoisted(() => ({
  bridge: null as unknown,
  contextBridge: {
    exposeInMainWorld: (_key: string, api: unknown) => {
      electron.bridge = api;
    },
  },
  ipcRenderer: { invoke: () => Promise.resolve('sent'), on: () => {}, removeListener: () => {} },
  webUtils: { getPathForFile: () => '' },
}));
vi.mock('electron', () => electron);

/**
 * Audit regression (FR-086): the router never asked who sent a message. The
 * per-window restriction lived only in each preload, which runs inside the
 * renderer it restricts, so a compromised overlay could invoke every channel.
 */

const rendererDir = join('/opt', 'Interview Copilot', 'resources', 'app.asar', 'out', 'renderer');
const page = (name: string): string => pathToFileURL(join(rendererDir, name, 'index.html')).href;

describe('FR-086 app page origin check', () => {
  const packaged = appRendererUrlCheck(undefined, rendererDir);

  it('accepts every packaged renderer page', () => {
    for (const name of ['dashboard', 'overlay', 'audio-worker']) {
      expect(packaged(page(name)), name).toBe(true);
    }
  });

  it('refuses a file outside the renderer directory, however it is spelled', () => {
    expect(packaged(pathToFileURL('/etc/passwd').href)).toBe(false);
    expect(packaged(`${pathToFileURL(rendererDir).href}/../../secrets.bin`)).toBe(false);
    expect(packaged(`${pathToFileURL(rendererDir).href}/%2e%2e/%2e%2e/secrets.bin`)).toBe(false);
    expect(packaged(pathToFileURL(`${rendererDir}-evil/dashboard/index.html`).href)).toBe(false);
  });

  it('refuses any remote or opaque page', () => {
    for (const url of ['https://example.com/', 'data:text/html,x', 'about:blank', 'not a url']) {
      expect(packaged(url), url).toBe(false);
    }
  });

  it('in development, accepts the dev server origin and nothing else', () => {
    const dev = appRendererUrlCheck('http://localhost:5173', rendererDir);
    expect(dev('http://localhost:5173/overlay/index.html')).toBe(true);
    expect(dev('http://localhost:5174/overlay/index.html')).toBe(false);
    expect(dev('https://localhost:5173/overlay/index.html')).toBe(false);
    expect(dev(page('dashboard'))).toBe(false);
  });

  it('accepts only a top-level frame on an app page', () => {
    const isApp = appRendererUrlCheck(undefined, rendererDir);
    expect(isTopLevelAppFrame({ url: page('overlay'), parent: null }, isApp)).toBe(true);
    expect(isTopLevelAppFrame({ url: page('overlay'), parent: {} }, isApp)).toBe(false);
    expect(isTopLevelAppFrame({ url: 'https://example.com', parent: null }, isApp)).toBe(false);
    expect(isTopLevelAppFrame(null, isApp)).toBe(false);
  });
});

describe('FR-086 one access table for both sides', () => {
  it('the overlay cannot reach a settings, credential or history channel', () => {
    for (const channel of [
      'config:set',
      'config:get',
      'secrets:set',
      'session:delete',
      'hotkey:rebind',
      'doc:import',
    ] as const) {
      expect(mayInvoke('overlay', channel), channel).toBe(false);
    }
  });

  it('every channel is open to at least one window', () => {
    for (const channel of INVOKE_CHANNEL_NAMES) {
      expect(INVOKE_ACCESS[channel].length, channel).toBeGreaterThan(0);
    }
  });

  it('the overlay receives no error channel (TC-096)', () => {
    expect(pushChannelsFor('overlay').some((c) => /error/i.test(c))).toBe(false);
    expect(invokeChannelsFor('overlay').some((c) => /error/i.test(c))).toBe(false);
  });
});

/**
 * Each preload keeps a literal copy of its allowlists, because a sandboxed
 * preload cannot load a chunk shared with another preload. This loads each
 * real preload and probes its bridge, so a copy that drifts from the table
 * fails here.
 */
describe('FR-086 each preload exposes exactly its row of the table', () => {
  beforeEach(() => {
    vi.resetModules();
    electron.bridge = null;
  });

  async function load(role: IpcWindowRole): Promise<CopilotBridge> {
    await import(`../../src/preload/${role}.ts`);
    return electron.bridge as CopilotBridge;
  }

  for (const role of ['dashboard', 'overlay'] as const) {
    it(`${role}: invoke`, async () => {
      const bridge = await load(role);
      const exposed: InvokeChannel[] = [];
      for (const channel of INVOKE_CHANNEL_NAMES) {
        const sent = await bridge.invoke(channel, undefined as never).then(
          () => true,
          () => false,
        );
        if (sent) exposed.push(channel);
      }
      expect(exposed.sort()).toEqual(invokeChannelsFor(role).sort());
    });

    it(`${role}: push`, async () => {
      const bridge = await load(role);
      const exposed: PushChannel[] = PUSH_CHANNEL_NAMES.filter((channel) => {
        try {
          bridge.on(channel, () => {});
          return true;
        } catch {
          return false;
        }
      });
      expect(exposed.sort()).toEqual(pushChannelsFor(role).sort());
    });
  }
});
