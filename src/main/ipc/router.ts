import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import {
  invokeChannels,
  mayInvoke,
  pushChannels,
  type IpcWindowRole,
  type InvokeChannel,
  type InvokePayload,
  type InvokeResponse,
  type PushChannel,
  type PushPayload,
} from '../../shared/ipc.js';
import type { IpcError } from '../../shared/ipc-error.js';
import { getLogger } from '../logger.js';
import { isTopLevelAppFrame } from './sender.js';

/**
 * The IPC router (CMP-10, FR-086, TC-002).
 *
 * Every payload and every response is validated against the schema declared in
 * src/shared/ipc.ts. A payload that fails is logged and rejected with a typed
 * error; it is never forwarded to a handler.
 *
 * The sender is checked before the payload (FR-086). The message must come
 * from the top-level frame of an app page, in a window that `INVOKE_ACCESS`
 * allows on that channel. The preload allowlists say the same thing, but they
 * run inside the renderer they restrict, so they cannot be the boundary.
 *
 * This component does not redact. Redaction has exactly one home, the logger,
 * because a key can leak from a path that never crosses IPC (FR-034).
 * It also holds no session or business state: only the handler registry needed
 * to function.
 */

export type Handler<C extends InvokeChannel> = (
  payload: InvokePayload<C>,
  event: IpcMainInvokeEvent,
) => InvokeResponse<C> | Promise<InvokeResponse<C>>;

function ipcError(channel: string, message: string): IpcError {
  return { __ipcError: true, channel, message };
}

/** How the router tells the app's windows apart. Supplied by `index.ts`. */
export interface SenderPolicy {
  /** Which app window owns these contents, or null for none of them. */
  roleOf(sender: WebContents): IpcWindowRole | null;
  /** True when a frame URL is one of this app's own renderer pages. */
  isAppUrl(url: string): boolean;
}

export class IpcRouter {
  private readonly registered = new Set<InvokeChannel>();

  constructor(
    private readonly ipcMain: IpcMain,
    private readonly senders: SenderPolicy,
  ) {}

  /** Register one request/response channel with schema validation on both sides. */
  handle<C extends InvokeChannel>(channel: C, handler: Handler<C>): void {
    if (this.registered.has(channel)) {
      throw new Error(`IPC channel ${channel} is already registered.`);
    }
    this.registered.add(channel);

    const spec = invokeChannels[channel];

    this.ipcMain.handle(channel, async (event, rawPayload: unknown) => {
      const role = this.senders.roleOf(event.sender);
      if (
        role === null ||
        !mayInvoke(role, channel) ||
        !isTopLevelAppFrame(event.senderFrame, (url) => this.senders.isAppUrl(url))
      ) {
        // The URL stays out of the log: a packaged page URL is an install path
        // outside userData (03-tasks.md Definition of Done).
        getLogger().warn('ipc sender rejected', { channel, channelId: spec.id, role });
        return ipcError(channel, 'This window may not use this channel.');
      }

      const parsedPayload = spec.payload.safeParse(rawPayload);
      if (!parsedPayload.success) {
        getLogger().warn('ipc payload rejected', {
          channel,
          channelId: spec.id,
          issues: parsedPayload.error.issues,
        });
        return ipcError(channel, 'Invalid payload for this channel.');
      }

      let result: unknown;
      try {
        result = await handler(parsedPayload.data as InvokePayload<C>, event);
      } catch (err) {
        getLogger().error('ipc handler threw', { channel, channelId: spec.id, err });
        return ipcError(channel, 'The request failed.');
      }

      const parsedResponse = spec.response.safeParse(result);
      if (!parsedResponse.success) {
        // A handler returning the wrong shape is this app's bug, not the
        // caller's. Fail loudly in the log, quietly at the boundary.
        getLogger().error('ipc response rejected', {
          channel,
          channelId: spec.id,
          issues: parsedResponse.error.issues,
        });
        return ipcError(channel, 'The request failed.');
      }
      return parsedResponse.data;
    });
  }

  /** Remove every handler this router registered. Used on shutdown and in tests. */
  dispose(): void {
    for (const channel of this.registered) this.ipcMain.removeHandler(channel);
    this.registered.clear();
  }
}

/**
 * Send a push message to one renderer, validating the payload first.
 * A push that fails validation is dropped and logged rather than sent.
 */
export function push<C extends PushChannel>(
  target: WebContents | null | undefined,
  channel: C,
  payload: PushPayload<C>,
): void {
  if (!target || target.isDestroyed()) return;
  const spec = pushChannels[channel];
  const parsed = spec.payload.safeParse(payload);
  if (!parsed.success) {
    getLogger().error('ipc push rejected', {
      channel,
      channelId: spec.id,
      issues: parsed.error.issues,
    });
    return;
  }
  target.send(channel, parsed.data);
}
