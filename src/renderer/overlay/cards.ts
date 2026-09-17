import type { PushPayload } from '../../shared/ipc.js';

/**
 * The overlay's card stack, as a pure reducer (FR-004, FR-008, FR-091, FR-102,
 * TASK-043).
 *
 * No React and no DOM import, so the cap, the ordering and the replay rules are
 * driven directly in the unit suite rather than through a window. The component
 * tree holds the result of this function and nothing else about the stack.
 *
 * There is no error state and no way to reach one. `suggestion:end` carries
 * `complete`, `cancelled` or `nonconforming`, and all three are outcomes of a
 * card that is already on screen: none of them adds anything to it, and a card
 * that never ends simply stays as it is (FR-076, FR-102).
 */

/** How many cards the active state holds (FR-091, ASM-010). */
export const MAX_CARDS = 3;

/**
 * How many lines a card can render (FR-004).
 *
 * The line buffer in `CMP-11` already refuses to emit a sixth, so this is
 * defence in depth at the boundary rather than the enforcement point. It is
 * here because the overlay is the thing `FR-004` describes: "a card renders at
 * most 5 lines" is a statement about this component, and a component that
 * relies on someone upstream for it cannot be read as satisfying it.
 */
export const MAX_LINES_PER_CARD = 5;

/** One revealed bullet. `index` is the line buffer's, not the array position. */
export interface CardLine {
  index: number;
  text: string;
}

export type CardStatus = 'streaming' | 'complete' | 'cancelled' | 'nonconforming';

/** A suggestion card, built from one generation's `CH-207` to `CH-209`. */
export interface SuggestionCard {
  cardId: string;
  generationId: string;
  question: string;
  lines: CardLine[];
  status: CardStatus;
}

/** The three suggestion pushes, plus the session boundary that clears them. */
export type CardEvent =
  | { kind: 'begin'; payload: PushPayload<'suggestion:begin'> }
  | { kind: 'line'; payload: PushPayload<'suggestion:line'> }
  | { kind: 'end'; payload: PushPayload<'suggestion:end'> }
  | { kind: 'reset' };

/**
 * Apply one event to the stack, returning a new array (FR-091).
 *
 * Returns the **same** array reference when nothing changed, so a push that
 * belongs to no card cannot cause a re-render and therefore cannot restart an
 * animation (NFR-007).
 */
export function reduceCards(cards: SuggestionCard[], event: CardEvent): SuggestionCard[] {
  switch (event.kind) {
    case 'reset':
      return cards.length === 0 ? cards : [];

    case 'begin': {
      const { cardId, generationId, question } = event.payload;
      // A rebuilt overlay is replayed the whole card it missed (ADR-015), and a
      // renderer that is *not* rebuilt can still be sent a begin it already
      // holds if the main process replays for another reason. Re-adding it
      // would show one generation twice and evict a card that is still current.
      if (cards.some((card) => card.cardId === cardId)) return cards;
      const next = [
        ...cards,
        { cardId, generationId, question, lines: [], status: 'streaming' as const },
      ];
      // Oldest first, so the one that leaves is the one at the front. The slice
      // is what `AnimatePresence` sees a card disappear from (FR-091, TC-111).
      return next.length > MAX_CARDS ? next.slice(next.length - MAX_CARDS) : next;
    }

    case 'line': {
      const { cardId, index, line } = event.payload;
      const target = cards.findIndex((card) => card.cardId === cardId);
      // A line whose card has already been evicted, or whose begin never
      // arrived. Rendering it would put an orphan bullet on somebody else's
      // card, which is the failure `FR-054` removes upstream.
      if (target === -1) return cards;
      const card = cards[target];
      if (!card) return cards;
      if (card.lines.length >= MAX_LINES_PER_CARD) return cards;
      // Keyed on the buffer's index, not on arrival, so a replayed line is the
      // same line rather than a second copy of it.
      if (card.lines.some((existing) => existing.index === index)) return cards;
      const lines = [...card.lines, { index, text: line }].sort((a, b) => a.index - b.index);
      const next = [...cards];
      next[target] = { ...card, lines };
      return next;
    }

    case 'end': {
      const { generationId, status } = event.payload;
      const target = cards.findIndex((card) => card.generationId === generationId);
      if (target === -1) return cards;
      const card = cards[target];
      if (!card || card.status === status) return cards;
      const next = [...cards];
      next[target] = { ...card, status };
      return next;
    }
  }
}

/**
 * Whether the idle card is what the overlay should be showing (FR-090, FR-102).
 *
 * Extended silence is not a state of its own: it is simply no card having
 * arrived yet, which is the idle card. Pausing shows it too, because the
 * trigger has stopped producing suggestions and saying nothing about that would
 * leave a stale cue on screen looking live (FR-053).
 */
export function shouldShowIdle(cards: readonly SuggestionCard[], paused: boolean): boolean {
  return paused || cards.length === 0;
}
