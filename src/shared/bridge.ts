import type {
  InvokeChannel,
  InvokePayload,
  InvokeResponse,
  IpcError,
  PushChannel,
  PushPayload,
} from './ipc.js';

/**
 * The shape every preload exposes as `window.copilot` (FR-086, TC-003).
 *
 * Type only. The implementation is written out in each preload entry rather
 * than imported from a shared runtime module, because a preload must be a
 * single self-contained file: a sandboxed preload cannot pull in a sibling
 * chunk at runtime. Keeping the contract here means the implementations still
 * cannot drift in shape, because both are checked against this type.
 */
export interface CopilotBridge {
  /**
   * Invoke a main-process channel.
   *
   * The result is the response **or** an `IpcError`. The router resolves rather
   * than rejects when a payload fails validation, a handler throws, or a
   * response has the wrong shape, so a caller that ignores the error branch
   * treats a failure as a success. Reset Overlay did exactly that and reported
   * "Overlay reset" for a call that had thrown. The union makes TypeScript
   * force the check (CMP-10).
   */
  invoke<C extends InvokeChannel>(
    channel: C,
    payload?: InvokePayload<C>,
  ): Promise<InvokeResponse<C> | IpcError>;
  on<C extends PushChannel>(channel: C, listener: (payload: PushPayload<C>) => void): () => void;
  /**
   * The absolute path of a file the user dropped on this window (ADR-037).
   *
   * Optional, and present only in the Dashboard preload. `File.path` was
   * removed from Electron's renderer, so `webUtils.getPathForFile` is the only
   * way a drop can name a file on disk, and it has to be called in the preload.
   * The overlay accepts no drops and does not expose it, which is why this is
   * optional rather than required: a window that cannot drop cannot resolve.
   *
   * Returns an empty string when the path cannot be resolved, which is what a
   * drop that is not a real file (a browser image, a text selection) gives.
   */
  pathForFile?(file: File): string;
}
