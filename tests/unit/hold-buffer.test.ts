import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  reduceCards,
  type CardEvent,
  type SuggestionCard,
} from '../../src/renderer/overlay/cards.js';
import { HoldBuffer } from '../../src/renderer/overlay/holdBuffer.js';

const begin = (id: string): CardEvent => ({
  kind: 'begin',
  payload: { generationId: id, cardId: `card-${id}`, question: id },
});
const line = (id: string, index = 0): CardEvent => ({
  kind: 'line',
  payload: { generationId: id, cardId: `card-${id}`, line: id, index },
});
const end = (id: string, status: 'complete' | 'cancelled' = 'complete'): CardEvent => ({
  kind: 'end',
  payload: { generationId: id, status },
});

describe('TC-174 through TC-177 and TC-186 hold buffer', () => {
  afterEach(() => vi.useRealTimers());

  it('holds replacement and preserves the original event spacing', () => {
    vi.useFakeTimers();
    const seen: CardEvent[] = [];
    const buffer = new HoldBuffer((event) => seen.push(event), { minHoldMs: 1500 });
    buffer.onEvent(begin('one'));
    vi.advanceTimersByTime(100);
    buffer.onEvent(begin('two'));
    vi.advanceTimersByTime(100);
    buffer.onEvent(line('two'));
    vi.advanceTimersByTime(1300);
    expect(seen).toEqual([begin('one'), begin('two')]);
    vi.advanceTimersByTime(100);
    expect(seen).toEqual([begin('one'), begin('two'), line('two')]);
  });

  it('dispatches own events, and drops cancelled or superseded queued cards', () => {
    vi.useFakeTimers();
    const seen: CardEvent[] = [];
    const buffer = new HoldBuffer((event) => seen.push(event), { minHoldMs: 1500 });
    buffer.onEvent(begin('one'));
    buffer.onEvent(line('one'));
    buffer.onEvent(begin('two'));
    buffer.onEvent(end('two', 'cancelled'));
    buffer.onEvent(begin('three'));
    buffer.onEvent(begin('four'));
    vi.advanceTimersByTime(1500);
    expect(seen).toEqual([begin('one'), line('one'), begin('four')]);
    buffer.onEvent(end('four', 'cancelled'));
    expect(seen.at(-1)).toEqual(end('four', 'cancelled'));
  });

  it('lets a different card through at once when the shown one has had its hold', () => {
    vi.useFakeTimers();
    const seen: CardEvent[] = [];
    const buffer = new HoldBuffer((event) => seen.push(event), { minHoldMs: 1500 });
    buffer.onEvent(begin('one'));
    vi.advanceTimersByTime(1500);
    buffer.onEvent(begin('two'));
    buffer.onEvent(line('two'));
    expect(seen).toEqual([begin('one'), begin('two'), line('two')]);
  });

  /**
   * The hold protects the card on screen. Once that card is cancelled nothing
   * is shown, so a candidate already queued behind it is promoted at once, at
   * its original spacing, rather than at the cancelled card's old deadline.
   */
  it('promotes a queued card at once when the shown card is cancelled', () => {
    vi.useFakeTimers();
    const seen: CardEvent[] = [];
    const buffer = new HoldBuffer((event) => seen.push(event), { minHoldMs: 1500 });
    buffer.onEvent(begin('one'));
    vi.advanceTimersByTime(100);
    buffer.onEvent(begin('two'));
    vi.advanceTimersByTime(50);
    buffer.onEvent(line('two'));
    vi.advanceTimersByTime(50);
    buffer.onEvent(end('one', 'cancelled'));
    expect(seen).toEqual([begin('one'), end('one', 'cancelled'), begin('two')]);
    vi.advanceTimersByTime(50);
    expect(seen).toEqual([begin('one'), end('one', 'cancelled'), begin('two'), line('two')]);

    // 'two' is the shown card now, so its own hold runs from its promotion at
    // 200 ms: 'three', arriving at 250 ms, waits until 1700 ms.
    buffer.onEvent(begin('three'));
    vi.advanceTimersByTime(1449);
    expect(seen.at(-1)).toEqual(line('two'));
    vi.advanceTimersByTime(1);
    expect(seen.at(-1)).toEqual(begin('three'));
  });

  /**
   * Discarding a queued candidate must not cancel the shown card's own replays.
   *
   * The queued candidate's deadline and the paced replays of the card being
   * promoted shared one timer array once, so cancelling a newly queued
   * generation cleared the promoted card's pending lines with it and that card
   * silently lost bullets the renderer had already received.
   */
  it("keeps the promoted card's paced lines when a later candidate is discarded", () => {
    vi.useFakeTimers();
    const seen: CardEvent[] = [];
    const buffer = new HoldBuffer((event) => seen.push(event), { minHoldMs: 1500 });

    // 'one' is shown, then 'two' queues behind it with a line 100 ms later.
    buffer.onEvent(begin('one'));
    buffer.onEvent(begin('two'));
    vi.advanceTimersByTime(100);
    buffer.onEvent(line('two', 1));

    // The hold elapses: 'two' is promoted and its line is scheduled, not flushed.
    vi.advanceTimersByTime(1400);
    expect(seen).toEqual([begin('one'), begin('two')]);

    // 'three' queues behind the freshly shown 'two', then is cancelled before
    // it is ever shown. That must take only its own entries with it.
    buffer.onEvent(begin('three'));
    buffer.onEvent(end('three', 'cancelled'));

    vi.advanceTimersByTime(100);
    expect(seen).toEqual([begin('one'), begin('two'), line('two', 1)]);
  });

  it('reset and pause discard queued work and let the next card through', () => {
    vi.useFakeTimers();
    const seen: CardEvent[] = [];
    const buffer = new HoldBuffer((event) => seen.push(event), { minHoldMs: 1500 });
    buffer.onEvent(begin('one'));
    buffer.onEvent(begin('two'));
    buffer.onEvent({ kind: 'reset' });
    buffer.onEvent(begin('three'));
    buffer.onEvent(begin('four'));
    buffer.onPause();
    buffer.onEvent(begin('five'));
    vi.runAllTimers();
    expect(seen).toEqual([begin('one'), { kind: 'reset' }, begin('three'), begin('five')]);
  });
});

/**
 * TC-175. A cancelled generation that never made it onto the overlay.
 *
 * Distinct from cancelling the card already on screen (`TC-177`): here the
 * generation is still waiting out someone else's hold, so the buffer has to
 * drop its queued entries rather than pass a cancellation on for a card
 * `reduceCards` has never been told about.
 */
describe('TC-175 a cancelled queued generation never reaches reduceCards', () => {
  afterEach(() => vi.useRealTimers());

  it('discards the queued entries and dispatches nothing from that generation', () => {
    vi.useFakeTimers();
    const seen: CardEvent[] = [];
    let cards: SuggestionCard[] = [];
    const buffer = new HoldBuffer(
      (event) => {
        seen.push(event);
        cards = reduceCards(cards, event);
      },
      { minHoldMs: 1500 },
    );

    buffer.onEvent(begin('one'));
    buffer.onEvent(line('one', 0));

    // 'two' arrives inside 'one''s hold, streams a bullet, and is then
    // cancelled before the hold elapses.
    buffer.onEvent(begin('two'));
    vi.advanceTimersByTime(100);
    buffer.onEvent(line('two', 0));
    buffer.onEvent(end('two', 'cancelled'));

    vi.runAllTimers();

    // Nothing carrying 'two' was ever dispatched, so `reduceCards` never saw
    // it: not its begin, not its line, and not the cancellation itself.
    expect(seen.filter((e) => e.kind !== 'reset' && e.payload.generationId === 'two')).toEqual([]);
    expect(seen).toEqual([begin('one'), line('one', 0)]);
    expect(cards.map((card) => card.generationId)).toEqual(['one']);
  });
});

/**
 * TC-176. The two ways a session boundary overrides the hold.
 *
 * A `'reset'` is unconditional in both directions: it dispatches at once and
 * takes the queue with it. A pause discards the queue whatever state those
 * generations reached, including one that finished streaming while it waited,
 * and clears "a card is shown" so the first suggestion after the resume is not
 * held behind a card that is no longer there (`CH-212`).
 */
describe('TC-176 reset bypasses the buffer and pause discards what is queued', () => {
  afterEach(() => vi.useRealTimers());

  it('dispatches a reset immediately and clears the queued candidate with it', () => {
    vi.useFakeTimers();
    const seen: CardEvent[] = [];
    const buffer = new HoldBuffer((event) => seen.push(event), { minHoldMs: 1500 });

    buffer.onEvent(begin('one'));
    buffer.onEvent(begin('two'));
    buffer.onEvent({ kind: 'reset' });

    // The reset is out before any timer runs: it was never held.
    expect(seen).toEqual([begin('one'), { kind: 'reset' }]);

    vi.runAllTimers();
    // And the queued 'two' went with it rather than surfacing after a session
    // boundary had already cleared the overlay.
    expect(seen).toEqual([begin('one'), { kind: 'reset' }]);
  });

  it('discards a queued generation that had already completed, and unholds the next', () => {
    vi.useFakeTimers();
    const seen: CardEvent[] = [];
    const buffer = new HoldBuffer((event) => seen.push(event), { minHoldMs: 1500 });

    buffer.onEvent(begin('one'));
    buffer.onEvent(begin('two'));
    vi.advanceTimersByTime(100);
    buffer.onEvent(line('two', 0));
    // 'two' finished streaming while it was still queued. A completed
    // generation is discarded by the pause exactly as a mid-stream one is.
    buffer.onEvent(end('two', 'complete'));

    buffer.onPause();
    vi.runAllTimers();
    expect(seen).toEqual([begin('one')]);

    // The pause cleared "a card is shown", so the first suggestion after the
    // resume is not held behind 'one'.
    buffer.onEvent(begin('three'));
    expect(seen).toEqual([begin('one'), begin('three')]);
  });
});
