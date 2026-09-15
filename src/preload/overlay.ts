import { contextBridge, ipcRenderer } from 'electron';
import type { CopilotBridge } from '../shared/bridge.js';
import type { InvokeChannel, PushChannel, PushPayload } from '../shared/ipc.js';

/**
 * Overlay preload (CMP-14).
 *
 * Self-contained by necessity: a preload has to be one file, so the bridge
 * implementation is written here rather than imported from a shared runtime
 * module. The shape is pinned by CopilotBridge.
 *
 * Both directions are allowlisted. An unrestricted invoke forwarder would give
 * a compromised overlay renderer the whole main-process surface, including
 * writing settings, rebinding hotkeys and replacing credentials. The overlay
 * needs three channels, so it gets three (FR-086).
 *
 * The push allowlist deliberately carries no error channel. The overlay has two
 * states, idle and suggestions, and no error state (FR-076, TC-096).
 */

const ALLOWED_INVOKE: readonly InvokeChannel[] = [
  'overlay:ready',
  'overlay:savePosition',
  'consent:dismiss',
];

const ALLOWED_PUSH: readonly PushChannel[] = [
  'suggestion:begin',
  'suggestion:line',
  'suggestion:end',
  'overlay:consent',
  'overlay:theme',
  'overlay:mode',
  'state:session',
];

const allowedInvoke = new Set<string>(ALLOWED_INVOKE);
const allowedPush = new Set<string>(ALLOWED_PUSH);

const bridge: CopilotBridge = {
  invoke: (channel, payload) => {
    if (!allowedInvoke.has(channel)) {
      return Promise.reject(new Error(`Channel ${channel} is not exposed to the overlay.`));
    }
    return ipcRenderer.invoke(channel, payload);
  },
  on: (channel, listener) => {
    if (!allowedPush.has(channel)) {
      throw new Error(`Channel ${channel} is not exposed to the overlay.`);
    }
    const wrapped = (_event: unknown, payload: unknown): void =>
      listener(payload as PushPayload<typeof channel>);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
};

contextBridge.exposeInMainWorld('copilot', bridge);
