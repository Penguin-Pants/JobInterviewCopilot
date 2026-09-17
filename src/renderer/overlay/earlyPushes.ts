import type { PushChannel, PushPayload } from '../../shared/ipc.js';

/**
 * The push channels the overlay subscribes to before React renders (CMP-14,
 * FR-008, ADR-016, TASK-043).
 *
 * The same race the Dashboard hit, with a worse ending. `wireOverlayWindow`
 * replays the theme, the consent text, the mode, the session state and the two
 * platform notices on `did-finish-load`, and every one of those pushes is
 * one-shot. A module script is evaluated while the document is still loading,
 * which is before `load` fires and therefore before `did-finish-load` reaches
 * the main process; a React effect can run after it. Subscribing here rather
 * than only in an effect closes that window, and the hook seeds its initial
 * state from whatever was caught.
 *
 * On the Dashboard a missed replay meant a live session rendered as inactive.
 * Here it means the consent text never arrives, so the renderer never reports
 * `overlay:ready`, so the gate never opens and **not one suggestion reaches the
 * user for the whole session** (FR-006, FR-008). There is no channel to ask
 * again with, and nothing else would ever re-push it.
 *
 * Only the replayed channels are listed. The three suggestion channels are held
 * behind the readiness gate until this renderer reports ready, which it cannot
 * do before it has mounted, so they cannot be missed this way and do not belong
 * here.
 */

const REPLAYED: PushChannel[] = [
  'overlay:theme',
  'overlay:consent',
  'overlay:mode',
  'state:session',
  'notice:platform',
  'notice:captureFidelity',
];

const latest = new Map<PushChannel, unknown>();

for (const channel of REPLAYED) {
  window.copilot.on(channel, (payload) => latest.set(channel, payload));
}

/** The last payload seen on a replayed channel, or undefined if none has come. */
export function lastSeen<C extends PushChannel>(channel: C): PushPayload<C> | undefined {
  return latest.get(channel) as PushPayload<C> | undefined;
}
