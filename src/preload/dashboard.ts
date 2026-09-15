import { contextBridge, ipcRenderer } from 'electron';
import type { CopilotBridge } from '../shared/bridge.js';
import type { PushChannel, PushPayload } from '../shared/ipc.js';

/**
 * Dashboard preload (CMP-13).
 *
 * Self-contained by necessity: a preload has to be one file, so the bridge
 * implementation is written here rather than imported from a shared runtime
 * module. The shape is pinned by CopilotBridge, so this and the overlay preload
 * cannot drift apart without failing typecheck.
 */

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

const allowed = new Set<string>(ALLOWED_PUSH);

const bridge: CopilotBridge = {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  on: (channel, listener) => {
    if (!allowed.has(channel)) {
      throw new Error(`Channel ${channel} is not exposed to the Dashboard.`);
    }
    const wrapped = (_event: unknown, payload: unknown): void =>
      listener(payload as PushPayload<typeof channel>);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
};

contextBridge.exposeInMainWorld('copilot', bridge);
