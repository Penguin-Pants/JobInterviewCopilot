import type {
  InvokeChannel,
  InvokePayload,
  InvokeResponse,
  PushChannel,
  PushPayload,
} from './ipc.js';

/**
 * The shape every preload exposes as `window.copilot` (FR-086, TC-003).
 *
 * Type only. The implementation is written out in each preload entry rather
 * than imported from a shared runtime module, because a preload must be a
 * single self-contained file: a sandboxed preload cannot pull in a sibling
 * chunk at runtime. Keeping the contract here means the two implementations
 * still cannot drift in shape, because both are checked against this type.
 */
export interface CopilotBridge {
  invoke<C extends InvokeChannel>(
    channel: C,
    payload?: InvokePayload<C>,
  ): Promise<InvokeResponse<C>>;
  on<C extends PushChannel>(channel: C, listener: (payload: PushPayload<C>) => void): () => void;
}
