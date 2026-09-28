/**
 * One Dashboard action at a time (TASK-050, FR-030, FR-079, FR-087).
 *
 * A button whose action waits for a round trip must not start that action a
 * second time from one intent. Create profile was guarded when a double click
 * made two profiles. The other action buttons were not, so a fast second click
 * on Save thresholds, Apply, Save provider and model settings, or a document
 * row's Try again or Remove document sent its `config:set`, `hotkey:rebind`,
 * `doc:retry` or `doc:delete` twice. This is the one convention those buttons
 * share, rather than a flag of their own in each section.
 *
 * The gate refuses a second run synchronously, so the control needs no native
 * `disabled` to be safe. It binds `busy` to `aria-disabled` instead, because
 * Chromium moves focus off a focused control that becomes `disabled` and does
 * not give it back: a keyboard user who pressed Enter on Save lost their place
 * for good (NFR-010). `aria-disabled` keeps the focus, is announced as
 * unavailable, and is styled like `disabled` in `styles.css`.
 */
import { useState } from 'react';

/** Starts an action unless one is still pending. */
export type InFlightRun = (action: () => Promise<void>) => Promise<void>;

/**
 * The gate without React, so its rule can be tested on its own.
 *
 * A run that arrives while another is pending is refused, not queued: a second
 * click is the same intent as the first, and replaying it after the first has
 * answered is the duplicate this exists to stop. The gate opens again however
 * the action ends, a throw included.
 */
export function createInFlightGate(onBusyChange: (busy: boolean) => void): InFlightRun {
  let pending = false;
  return async (action) => {
    if (pending) return;
    pending = true;
    onBusyChange(true);
    try {
      await action();
    } finally {
      pending = false;
      onBusyChange(false);
    }
  };
}

export interface InFlight {
  /**
   * True while an action runs. Bind it as `aria-disabled={busy || undefined}`,
   * never to `disabled`, so the attribute is absent at rest and cannot
   * contradict a native `disabled` the control has for another reason.
   */
  busy: boolean;
  run: InFlightRun;
}

/** One gate for the life of the component that holds it. */
export function useInFlight(): InFlight {
  const [busy, setBusy] = useState(false);
  // Built once. A gate made on every render would forget the pending run.
  const [run] = useState(() => createInFlightGate(setBusy));
  return { busy, run };
}
