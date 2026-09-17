/**
 * The one way the Dashboard calls the main process (CMP-10, CMP-13).
 *
 * `invoke` resolves with an `IpcError` rather than rejecting, so a caller that
 * ignores the error branch renders a failure as a success. That is exactly how
 * Reset Overlay reported "Overlay reset" for a call that had thrown, so every
 * call in this renderer goes through here and gets a discriminated result back
 * that TypeScript will not let it read without checking.
 */
import {
  isIpcError,
  type InvokeChannel,
  type InvokePayload,
  type InvokeResponse,
} from '../../shared/ipc.js';

export type CallResult<C extends InvokeChannel> =
  { ok: true; value: InvokeResponse<C> } | { ok: false; message: string };

export async function call<C extends InvokeChannel>(
  channel: C,
  payload?: InvokePayload<C>,
): Promise<CallResult<C>> {
  try {
    const result = await window.copilot.invoke(channel, payload);
    if (isIpcError(result)) return { ok: false, message: result.message };
    return { ok: true, value: result };
  } catch (err) {
    // A channel the preload refuses rejects rather than resolving. It is still
    // a failure the user has to see, not a console line.
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
