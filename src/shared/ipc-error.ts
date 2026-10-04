/**
 * The error an IPC call resolves with instead of throwing (CMP-10).
 *
 * Kept apart from `ipc.ts`, which builds every channel schema when it loads.
 * The overlay checks for this error on every call it makes, and importing the
 * check from `ipc.ts` put all of those schemas into the overlay bundle.
 */

/** Error shape returned when a payload fails its schema. Never a raw throw (CMP-10). */
export interface IpcError {
  __ipcError: true;
  channel: string;
  message: string;
}

export function isIpcError(value: unknown): value is IpcError {
  return typeof value === 'object' && value !== null && '__ipcError' in value;
}
