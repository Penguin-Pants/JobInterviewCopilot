import { contextBridge, ipcRenderer } from 'electron';
import type { CopilotBridge } from '../shared/bridge.js';
import type { InvokeChannel, PushChannel, PushPayload } from '../shared/ipc.js';

/**
 * Dashboard preload (CMP-13).
 *
 * Self-contained by necessity: a preload has to be one file, so the bridge
 * implementation is written here rather than imported from a shared runtime
 * module. The shape is pinned by CopilotBridge, so this and the overlay preload
 * cannot drift apart without failing typecheck.
 */

/**
 * The Dashboard is the configuration surface, so it may invoke everything.
 * Listed explicitly rather than left open, so adding a channel is a decision
 * about which window may call it (FR-086).
 */
const ALLOWED_INVOKE: readonly InvokeChannel[] = [
  'config:get',
  'config:set',
  'secrets:set',
  'secrets:status',
  'profile:list',
  'profile:create',
  'profile:delete',
  'profile:activate',
  'doc:import',
  'doc:setType',
  'doc:delete',
  'doc:retry',
  'model:ensure',
  'session:start',
  'session:stop',
  'session:list',
  'session:read',
  'session:delete',
  'hotkey:rebind',
  'overlay:setInteractive',
  'overlay:reset',
];

/** Push channels the Dashboard may receive. Anything else is refused. */
const ALLOWED_PUSH: readonly PushChannel[] = [
  'state:session',
  'state:providers',
  'state:audio',
  'state:usage',
  'usage:warning',
  'transcript:live',
  'rag:progress',
  'model:download',
  'notice:captureFidelity',
];

const allowedInvoke = new Set<string>(ALLOWED_INVOKE);
const allowedPush = new Set<string>(ALLOWED_PUSH);

const bridge: CopilotBridge = {
  invoke: (channel, payload) => {
    if (!allowedInvoke.has(channel)) {
      return Promise.reject(new Error(`Channel ${channel} is not exposed to the Dashboard.`));
    }
    return ipcRenderer.invoke(channel, payload);
  },
  on: (channel, listener) => {
    if (!allowedPush.has(channel)) {
      throw new Error(`Channel ${channel} is not exposed to the Dashboard.`);
    }
    const wrapped = (_event: unknown, payload: unknown): void =>
      listener(payload as PushPayload<typeof channel>);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
};

contextBridge.exposeInMainWorld('copilot', bridge);
