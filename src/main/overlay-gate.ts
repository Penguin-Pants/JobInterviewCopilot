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
 * The gate holds **one generation**, and holds it as a card rather than as a
 * queue: the messages of the generation currently on screen, in order, whether
 * or not they have been delivered. A `suggestion:begin` starts a new card and
 * discards the previous one, which is the same rule as `FR-054`. That shape is
 * what makes the two hard cases work:
 *
 * - A cancelled generation's `suggestion:end` arrives **after** its
 *   replacement's `suggestion:begin`, because the two run concurrently. Keyed
 *   on a card, that stale end belongs to no current card and is ignored. Keyed
 *   on "the last generation id I saw", it would have discarded the replacement
 *   and left its lines arriving with no begin to create a card from.
 * - A rebuilt overlay (a translucency change, ADR-015) has a renderer that
 *   never saw the begin. The card is replayed to it in full, so a generation
 *   streaming across the rebuild is not left half-delivered to a window that
 *   cannot reconstruct it.
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

/**
 * The generation currently on the overlay, or waiting to reach it.
 *
 * `delivered` is how many of `messages` the current renderer has been sent.
 * Bounded by the card cap: a begin, at most five lines and an end.
 */
interface Card {
  generationId: string;
  messages: GatedMessage[];
  delivered: number;
}

export class OverlayGate {
  private ready = false;
  private card: Card | null = null;

  constructor(private readonly deliver: (message: GatedMessage) => void) {}

  get isReady(): boolean {
    return this.ready;
  }

  /** How many messages are held back from the current renderer. */
  get pending(): number {
    if (!this.card) return 0;
    return this.card.messages.length - this.card.delivered;
  }

  /** The generation the gate is holding or showing, for logging and tests. */
  get currentGenerationId(): string | null {
    return this.card?.generationId ?? null;
  }

  /** `CH-122` arrived: the consent card has painted. Flush, then pass through. */
  noteReady(): void {
    if (this.ready) return;
    this.ready = true;
    this.flush();
  }

  /**
   * The overlay window went away, so the next one has to report ready again.
   *
   * Reachable in normal use: a translucency change rebuilds the window
   * (ADR-015), and a rebuilt renderer has not painted its consent card. The
   * card is kept and its delivery count reset, so the new renderer receives the
   * whole of a generation that was streaming across the rebuild rather than its
   * tail with no begin.
   */
  noteClosed(): void {
    this.ready = false;
    if (this.card) this.card.delivered = 0;
  }

  send(message: GatedMessage): void {
    if (message.channel === 'suggestion:begin') {
      // A new card replaces the old one wholesale. Interleaving two cards'
      // lines is the failure FR-054 removes from the live overlay, and it would
      // be no better arriving all at once.
      this.card = { generationId: message.payload.generationId, messages: [], delivered: 0 };
    } else if (this.card === null || this.card.generationId !== message.payload.generationId) {
      // A line or an end for a generation that is not the current card. Either
      // the card it belonged to has already been replaced, or its begin never
      // arrived. Delivering it would put an orphan line on somebody else's card.
      return;
    }

    this.card.messages.push(message);
    this.flush();
  }

  /** Send whatever the current renderer has not been sent yet, in order. */
  private flush(): void {
    if (!this.ready || !this.card) return;
    const { messages } = this.card;
    while (this.card.delivered < messages.length) {
      const next = messages[this.card.delivered];
      this.card.delivered += 1;
      if (next) this.deliver(next);
    }
  }
}
