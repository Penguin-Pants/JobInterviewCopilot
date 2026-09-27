/**
 * Two Dashboard rows carried to TASK-050 and fixed in the follow-up sweep.
 *
 * The renderer has no DOM in this suite, so each rule is asserted on the pure
 * function the component calls. `guardrails.test.ts` pins that every button
 * and the drop zone actually call it.
 */
import { describe, expect, it, vi } from 'vitest';
import { createInFlightGate } from '../../src/renderer/dashboard/inFlight.js';
import { dragLeftZone } from '../../src/renderer/dashboard/sections/CompanyProfiles.js';

/** A promise the test settles by hand, so "still pending" is a real state. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('an action button runs its action once per intent (FR-030, FR-079, FR-087)', () => {
  it('refuses a second run while the first is pending', async () => {
    const busy: boolean[] = [];
    const run = createInFlightGate((b) => busy.push(b));
    const first = deferred();
    const action = vi.fn(() => first.promise);

    const one = run(action);
    // The second click arrives before the first round trip has answered.
    const two = run(action);
    await two;

    expect(action).toHaveBeenCalledTimes(1);
    expect(busy).toEqual([true]);

    first.resolve();
    await one;
    expect(busy).toEqual([true, false]);
  });

  it('refuses rather than queues, so the second click never runs later', async () => {
    const run = createInFlightGate(() => undefined);
    const first = deferred();
    const later = vi.fn(async () => undefined);

    const one = run(() => first.promise);
    void run(later);
    first.resolve();
    await one;

    expect(later).not.toHaveBeenCalled();
  });

  it('opens again once the action has answered', async () => {
    const run = createInFlightGate(() => undefined);
    const action = vi.fn(async () => undefined);

    await run(action);
    await run(action);

    expect(action).toHaveBeenCalledTimes(2);
  });

  it('opens again when the action throws, and the caller still sees the throw', async () => {
    const busy: boolean[] = [];
    const run = createInFlightGate((b) => busy.push(b));
    const failing = deferred();

    const one = run(() => failing.promise);
    failing.reject(new Error('the call failed'));
    await expect(one).rejects.toThrow('the call failed');
    expect(busy).toEqual([true, false]);

    const next = vi.fn(async () => undefined);
    await run(next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('keeps separate gates apart, so a long retry does not lock Remove document', async () => {
    const retrying = createInFlightGate(() => undefined);
    const removing = createInFlightGate(() => undefined);
    const retry = deferred();
    const remove = vi.fn(async () => undefined);

    const pending = retrying(() => retry.promise);
    await removing(remove);
    expect(remove).toHaveBeenCalledTimes(1);

    retry.resolve();
    await pending;
  });
});

describe('the drop zone highlight survives a drag across its own children (ADR-037)', () => {
  // Stand-ins for DOM nodes. Only `contains` is read, and these tests are about
  // the rule, not about Chromium: that `dragleave` carries the element being
  // entered as `relatedTarget` was checked in Chromium 141 by hand.
  const child = { name: 'child' } as unknown as Node;
  const outside = { name: 'outside' } as unknown as Node;
  const zone = { contains: (other: Node | null) => other === child };

  it('does not end the drag when the pointer crosses onto a child', () => {
    expect(dragLeftZone(zone, child)).toBe(false);
  });

  it('ends it when the pointer moves to an element outside the zone', () => {
    expect(dragLeftZone(zone, outside)).toBe(true);
  });

  it('ends it when the drag leaves the window, which has no related target', () => {
    expect(dragLeftZone(zone, null)).toBe(true);
  });
});
