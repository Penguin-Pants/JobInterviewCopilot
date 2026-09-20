import { contextBridge, ipcRenderer, webUtils } from 'electron';
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
  'llmCatalog:get',
  'llmCatalog:refresh',
  'catalog:stt',
  'profile:list',
  'profile:create',
  'profile:delete',
  'profile:activate',
  'doc:import',
  'doc:setType',
  'doc:delete',
  'doc:retry',
  'doc:pickFiles',
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
  'notice:platform',
  'notice:session',
  'state:llmCatalog',
  // The overlay's interaction mode. The Dashboard shows it as a checkbox and
  // the global hotkey can change it while the Dashboard has focus, so it needs
  // telling rather than waiting for a focus change (CH-212, FR-083).
  'overlay:mode',
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
  /**
   * Resolve a dropped file to its path on disk (ADR-037, TASK-042).
   *
   * `File.path` no longer exists in Electron's renderer, and `webUtils` is
   * reachable from a preload only, so drag and drop import has nowhere else to
   * get a path. Exposed on the Dashboard alone: the overlay accepts no drops.
   *
   * It resolves, it does not read. The bytes are still opened by the main
   * process, which is where `doc:import` already validates the path.
   */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      // A drop that is not a file on disk has no path. An empty string is the
      // caller's signal to skip it; throwing would abandon the whole drop
      // because one item of it was a text selection.
      return '';
    }
  },
};

contextBridge.exposeInMainWorld('copilot', bridge);
