/**
 * The overlay readiness gate (`FR-008`, ADR-016).
 *
 * Suggestion delivery is gated on the overlay renderer having mounted and
 * painted its consent card. Until `overlay:ready` arrives, `suggestion:begin`,
 * `suggestion:line` and `suggestion:end` are **buffered rather than dropped**,
 * so the first question of a session is not the one the user never sees.
 *
 * Milestone 0 declared the gate and deliberately left it empty: there were no
 * suggestion messages to hold. TASK-032 is where they first exist, so this is
 * where it lands.
 *
 * The buffer holds **one generation**. A second generation arriving while the
 * first is still buffered discards the first, which is the same rule as
 * `FR-054`: the overlay only ever shows the newest question's card.
 */
import type { PushChannel, PushPayload } from '../shared/ipc.js';

/** The three channels the gate holds. No other channel is buffered. */
export type GatedChannel = 'suggestion:begin' | 'suggestion:line' | 'suggestion:end';

/** One held message, channel and payload kept together (FR-008). */
export type GatedMessage = {
  [C in GatedChannel]: { channel: C; payload: PushPayload<C> };
}[GatedChannel];

const GATED: readonly PushChannel[] = ['suggestion:begin', 'suggestion:line', 'suggestion:end'];

/** Whether a push channel is one the readiness gate holds (FR-008). */
export function isGatedChannel(channel: PushChannel): channel is GatedChannel {
  return GATED.includes(channel);
}

export class OverlayGate {
  private ready = false;
  private buffered: GatedMessage[] = [];
  /** Which generation the buffer belongs to. One at a time (FR-008). */
  private bufferedGenerationId: string | null = null;

  constructor(private readonly deliver: (message: GatedMessage) => void) {}

  get isReady(): boolean {
    return this.ready;
  }

  /** How many messages are held. Zero once the overlay is ready. */
  get pending(): number {
    return this.buffered.length;
  }

  /** `CH-122` arrived: the consent card has painted. Flush, then pass through. */
  noteReady(): void {
    if (this.ready) return;
    this.ready = true;
    const held = this.buffered;
    this.buffered = [];
    this.bufferedGenerationId = null;
    for (const message of held) this.deliver(message);
  }

  /**
   * The overlay window went away, so the next one has to report ready again.
   *
   * Reachable in normal use: a translucency change rebuilds the window
   * (ADR-015), and a rebuilt renderer has not painted its consent card. Without
   * this the gate would stay open against a window that cannot yet render.
   */
  noteClosed(): void {
    this.ready = false;
    this.buffered = [];
    this.bufferedGenerationId = null;
  }

  send(message: GatedMessage): void {
    if (this.ready) {
      this.deliver(message);
      return;
    }

    const { generationId } = message.payload;
    if (this.bufferedGenerationId !== null && this.bufferedGenerationId !== generationId) {
      // A newer generation replaces the buffered one wholesale. Interleaving
      // two cards' lines is the failure FR-054 removes from the live overlay,
      // and it would be no better arriving all at once.
      this.buffered = [];
    }
    this.bufferedGenerationId = generationId;
    this.buffered.push(message);
  }
}
