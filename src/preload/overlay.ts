import { contextBridge, ipcRenderer } from 'electron';
import type { CopilotBridge } from '../shared/bridge.js';
import type { PushChannel, PushPayload } from '../shared/ipc.js';

/**
 * Overlay preload (CMP-14).
 *
 * Self-contained by necessity, see the note in dashboard.ts.
 *
 * The allowlist deliberately carries no error channel. The overlay has two
 * states, idle and suggestions, and no error state, so there is no way for a
 * provider failure to reach it (FR-076, TC-096).
 */

const ALLOWED_PUSH: readonly PushChannel[] = [
  'suggestion:begin',
  'suggestion:line',
  'suggestion:end',
  'overlay:consent',
  'overlay:theme',
  'overlay:mode',
  'state:session',
];

const allowed = new Set<string>(ALLOWED_PUSH);

const bridge: CopilotBridge = {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  on: (channel, listener) => {
    if (!allowed.has(channel)) {
      throw new Error(`Channel ${channel} is not exposed to the overlay.`);
    }
    const wrapped = (_event: unknown, payload: unknown): void =>
      listener(payload as PushPayload<typeof channel>);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
};

contextBridge.exposeInMainWorld('copilot', bridge);
