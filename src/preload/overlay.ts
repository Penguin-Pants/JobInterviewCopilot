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
 * needs six channels, so it gets six (FR-086).
 *
 * `overlay:setFontSize` is the fourth, added with the in-overlay text size
 * control (FR-093), and `overlay:setSize` is the fifth, added with the resize
 * grip (FR-081). Both exist rather than `config:set` for the reason above: a
 * channel that can change one or two numbers cannot be turned into a settings
 * write, and each one's range is enforced by the contract's own schema
 * (CH-126, CH-127).
 *
 * `overlay:setPointerOverControls` is the sixth, and it writes nothing at all:
 * it reports whether the pointer is over one of the overlay's own controls, so
 * the window can be clickable over the consent reminder and the resize grip
 * while passing clicks through everywhere else (CH-128, FR-006, FR-081,
 * FR-083).
 *
 * The push allowlist deliberately carries no error channel. The overlay has two
 * states, idle and suggestions, and no error state (FR-076, TC-096).
 *
 * Two notices are the exception that proves the rule, and neither is an error.
 * `notice:captureFidelity` is where `NFR-012` says it belongs: beside the
 * consent reminder, in the window it is about. It was pushed to the Dashboard
 * and withheld from the overlay, which contradicted both `NFR-012` and the IPC
 * table; it now reaches both windows, because `FR-089` needs its build number
 * in the Dashboard. `notice:platform` describes the machine, and the overlay
 * needs it to know whether the acrylic it was asked for is the window it
 * actually got (CH-216, ADR-038).
 */

const ALLOWED_INVOKE: readonly InvokeChannel[] = [
  'overlay:ready',
  'overlay:savePosition',
  'consent:dismiss',
  'overlay:setFontSize',
  'overlay:setSize',
  'overlay:setPointerOverControls',
];

const ALLOWED_PUSH: readonly PushChannel[] = [
  'suggestion:begin',
  'suggestion:line',
  'suggestion:end',
  'overlay:consent',
  'overlay:theme',
  'overlay:mode',
  'state:session',
  'notice:captureFidelity',
  'notice:platform',
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
