/**
 * The push channels the Dashboard subscribes to before React renders (CMP-13).
 *
 * The main process replays state to a renderer that has just loaded, because no
 * channel lets a renderer ask: `wireDashboardWindow` pushes `state:session` on
 * `did-finish-load`, and `startKnowledgeBase` pushes the model state once. Both
 * are one-shot. If React's first effect had not run by then, the Dashboard
 * missed the replay and rendered a live session as inactive for the rest of the
 * window's life, with Stop Session disabled over a running interview.
 *
 * A module script is evaluated while the document is still loading, which is
 * before `load` fires and therefore before `did-finish-load` reaches the main
 * process. Subscribing here rather than in an effect closes that race without a
 * new channel: whatever arrives early is kept, and the hook seeds its initial
 * state from it.
 *
 * Only the replayed channels are listed. A channel that is pushed on a change
 * the user causes cannot be missed this way and does not belong here.
 */
import type { PushChannel, PushPayload } from '../../shared/ipc.js';

const REPLAYED: PushChannel[] = [
  'state:session',
  'state:usage',
  'state:providers',
  'state:audio',
  'model:download',
  'notice:captureFidelity',
  // `CH-216` is replayed on every load and describes the machine, so a
  // Dashboard whose first effect ran late would otherwise render the acrylic
  // option enabled on a Windows 10 build until something else changed (FR-089).
  'notice:platform',
  // Replayed on `did-finish-load` for the session running now (CH-217). A
  // Dashboard reopened mid-session would otherwise render it as active with no
  // warning beside it, which is the silent failure the channel exists to end.
  'notice:session',
];

const latest = new Map<PushChannel, unknown>();

for (const channel of REPLAYED) {
  window.copilot.on(channel, (payload) => latest.set(channel, payload));
}

/** The last payload seen on a replayed channel, or undefined if none has come. */
export function lastSeen<C extends PushChannel>(channel: C): PushPayload<C> | undefined {
  return latest.get(channel) as PushPayload<C> | undefined;
}
