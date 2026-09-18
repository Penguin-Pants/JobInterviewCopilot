import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CardEvent } from '../../src/renderer/overlay/cards.js';
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
