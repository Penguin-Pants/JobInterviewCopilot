import { describe, expect, it } from 'vitest';
import {
  MAX_CARDS,
  MAX_LINES_PER_CARD,
  reduceCards,
  shouldShowIdle,
  type CardEvent,
  type SuggestionCard,
} from '../../src/renderer/overlay/cards.js';

/**
 * TASK-043. The overlay's card stack.
 *
 * `cards.ts` carries the whole of `FR-091`'s cap and `FR-004`'s line limit and
 * has no React or DOM import, so the rules are driven here directly. The E2E
 * cases (`TC-110`, `TC-111`, `TC-112`) then assert what the rendered window
 * does with the same rules, on the platform they mean something on.
 */

function begin(id: string, question = 'Tell me about a time…'): CardEvent {
  return {
    kind: 'begin',
    payload: { generationId: `gen-${id}`, cardId: `card-${id}`, question },
  };
}

function line(id: string, index: number, text: string): CardEvent {
  return {
    kind: 'line',
    payload: { generationId: `gen-${id}`, cardId: `card-${id}`, line: text, index },
  };
}

function end(id: string, status: 'complete' | 'cancelled' | 'nonconforming'): CardEvent {
  return { kind: 'end', payload: { generationId: `gen-${id}`, status } };
}

function run(events: CardEvent[], from: SuggestionCard[] = []): SuggestionCard[] {
  return events.reduce<SuggestionCard[]>(reduceCards, from);
}

/** FR-091, ASM-010, TC-111: the active state holds the 3 most recent cards. */
describe('TC-111 the card stack holds three', () => {
  it('keeps every card up to the cap, newest last', () => {
    const cards = run([begin('1'), begin('2'), begin('3')]);
    expect(cards.map((c) => c.cardId)).toEqual(['card-1', 'card-2', 'card-3']);
  });

  it('a fourth evicts the oldest, and only the oldest', () => {
    const cards = run([begin('1'), begin('2'), begin('3'), begin('4')]);
    expect(cards).toHaveLength(MAX_CARDS);
    expect(cards.map((c) => c.cardId)).toEqual(['card-2', 'card-3', 'card-4']);
  });

  it('stays at the cap however many arrive', () => {
    const many = Array.from({ length: 40 }, (_, i) => begin(String(i)));
    const cards = run(many);
    expect(cards).toHaveLength(MAX_CARDS);
    expect(cards.map((c) => c.cardId)).toEqual(['card-37', 'card-38', 'card-39']);
  });

  it('a begin for a card already held is ignored rather than duplicated', () => {
    // A replay (ADR-015) can re-send a begin the renderer already has. Adding
    // it again would show one generation twice and evict a card still current.
    const cards = run([begin('1'), begin('2'), begin('1')]);
    expect(cards.map((c) => c.cardId)).toEqual(['card-1', 'card-2']);
  });
});

/** FR-004, FR-092, TC-112: a card is bullets, one element each, at most five. */
describe('lines on a card', () => {
  it('appends in buffer order, whatever order they arrive in', () => {
    const cards = run([begin('1'), line('1', 1, 'second'), line('1', 0, 'first')]);
    expect(cards[0]?.lines.map((l) => l.text)).toEqual(['first', 'second']);
  });

  it('never renders a sixth line (FR-004)', () => {
    const lines = Array.from({ length: 9 }, (_, i) => line('1', i, `bullet ${i}`));
    const cards = run([begin('1'), ...lines]);
    expect(cards[0]?.lines).toHaveLength(MAX_LINES_PER_CARD);
    expect(cards[0]?.lines.at(-1)?.text).toBe('bullet 4');
  });

  it('a replayed line is the same line, not a second copy', () => {
    const cards = run([begin('1'), line('1', 0, 'first'), line('1', 0, 'first')]);
    expect(cards[0]?.lines).toHaveLength(1);
  });

  it('ignores a line whose card was evicted or never began', () => {
    const cards = run([begin('1'), begin('2'), begin('3'), begin('4'), line('1', 0, 'orphan')]);
    expect(cards.flatMap((c) => c.lines)).toEqual([]);
  });

  it('a line for no card at all changes nothing and keeps the same array', () => {
    const before = run([begin('1')]);
    const after = reduceCards(before, line('9', 0, 'orphan'));
    // Identity, not just equality: a new array would re-render the stack and
    // restart the reveal on every bullet already on it (NFR-007, FR-092).
    expect(after).toBe(before);
  });
});

/** FR-076: three endings, none of them an error state. */
describe('a generation ending', () => {
  it('records each outcome on its own card without changing what it shows', () => {
    for (const status of ['complete', 'cancelled', 'nonconforming'] as const) {
      const cards = run([begin('1'), line('1', 0, 'salvaged'), end('1', status)]);
      expect(cards[0]?.status).toBe(status);
      // FR-004: the overlay still shows what was salvaged, whatever the ending.
      expect(cards[0]?.lines.map((l) => l.text)).toEqual(['salvaged']);
    }
  });

  it('a stale end for a generation no longer held is ignored', () => {
    const before = run([begin('1'), begin('2'), begin('3'), begin('4')]);
    expect(reduceCards(before, end('1', 'cancelled'))).toBe(before);
  });

  it('a repeated end changes nothing', () => {
    const before = run([begin('1'), end('1', 'complete')]);
    expect(reduceCards(before, end('1', 'complete'))).toBe(before);
  });
});

/** ADR-036: a session boundary clears the stack, so a cue cannot outlive it. */
describe('a session boundary', () => {
  it('empties the stack', () => {
    const cards = run([begin('1'), line('1', 0, 'a cue'), { kind: 'reset' }]);
    expect(cards).toEqual([]);
  });

  it('is a no-op on an already empty stack, so it cannot force a render', () => {
    const before: SuggestionCard[] = [];
    expect(reduceCards(before, { kind: 'reset' })).toBe(before);
  });
});

/** FR-090, FR-102, TC-110: the idle card is shown before any card and when paused. */
describe('TC-110 when the idle card is shown', () => {
  it('shows it before the first suggestion of a session', () => {
    expect(shouldShowIdle([], false)).toBe(true);
  });

  it('shows it whenever the trigger is paused, cards or no cards', () => {
    const cards = run([begin('1'), line('1', 0, 'a cue')]);
    expect(shouldShowIdle(cards, true)).toBe(true);
  });

  it('hides it once a card exists and the trigger is running', () => {
    expect(shouldShowIdle(run([begin('1')]), false)).toBe(false);
  });

  it('an extended silence is the idle card, never a state of its own (FR-102)', () => {
    // Nothing arrives for any length of time: the reducer is never called, so
    // the state is the one it started in and there is no third thing to be.
    expect(shouldShowIdle([], false)).toBe(true);
  });
});
