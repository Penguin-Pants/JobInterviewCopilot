/**
 * Two Dashboard rows carried to TASK-050 and fixed in the follow-up sweep, and
 * the rules the renderer UX audit of 2026-10-04 extracted from the sections.
 *
 * The renderer has no DOM in this suite, so each rule is asserted on the pure
 * function the component calls. `guardrails.test.ts` pins that every button
 * and the drop zone actually call it.
 */
import { describe, expect, it, vi } from 'vitest';
import { createInFlightGate } from '../../src/renderer/dashboard/inFlight.js';
import {
  announcedPercent,
  createPromptSelection,
  dragLeftZone,
} from '../../src/renderer/dashboard/sections/CompanyProfiles.js';
import { parseThresholds } from '../../src/renderer/dashboard/sections/CostAndUsage.js';
import { withStoredBinding } from '../../src/renderer/dashboard/sections/Hotkeys.js';
import { DEFAULT_PROMPT_ID } from '../../src/shared/prompts.js';

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

describe('a cost threshold is a number the user typed (FR-109)', () => {
  it('refuses an empty cost field rather than saving it as zero dollars', () => {
    expect(parseThresholds('', '60')).toBeNull();
    expect(parseThresholds('   ', '60')).toBeNull();
  });

  it('refuses an empty time field', () => {
    expect(parseThresholds('5', '')).toBeNull();
  });

  it('accepts a typed zero cost, which is a real choice', () => {
    expect(parseThresholds('0', '60')).toEqual({ costUsd: 0, timeMinutes: 60 });
  });

  it('refuses a negative cost, a zero time and text that is not a number', () => {
    expect(parseThresholds('-1', '60')).toBeNull();
    expect(parseThresholds('5', '0')).toBeNull();
    expect(parseThresholds('five', '60')).toBeNull();
  });
});

describe('a refused hotkey puts back only its own field (FR-030)', () => {
  it('keeps the other action captured but unapplied combination', () => {
    const draft = { toggleInteraction: 'Control+Alt+J', togglePause: 'Control+Alt+P' };
    const stored = { toggleInteraction: 'Control+Shift+I', togglePause: 'Control+Shift+P' };
    expect(withStoredBinding(draft, stored, 'toggleInteraction')).toEqual({
      toggleInteraction: 'Control+Shift+I',
      togglePause: 'Control+Alt+P',
    });
  });
});

describe('two quick prompt selections both reach the settings (FR-027)', () => {
  /** A write the test answers by hand, recording what each one carried. */
  function harness(stored: Record<string, string>) {
    const sent: Record<string, string>[] = [];
    const answers: ((ok: boolean) => void)[] = [];
    const selection = createPromptSelection(
      (ids) =>
        new Promise<boolean>((resolve) => {
          sent.push(ids);
          answers.push(resolve);
        }),
    );
    selection.sync(stored);
    return { selection, sent, answers };
  }

  it('merges the second change with the first while the first is in flight', async () => {
    const { selection, sent, answers } = harness({});
    const one = selection.select('profile-a', 'prompt-1');
    const two = selection.select('profile-b', 'prompt-2');
    answers[0]?.(true);
    answers[1]?.(true);
    await Promise.all([one, two]);
    expect(sent[1]).toEqual({ 'profile-a': 'prompt-1', 'profile-b': 'prompt-2' });
  });

  it('ignores a stored value that arrives while a write is pending', async () => {
    const { selection, sent, answers } = harness({});
    const one = selection.select('profile-a', 'prompt-1');
    // The reload after an earlier write answers before this one has landed.
    selection.sync({});
    const two = selection.select('profile-b', 'prompt-2');
    answers[0]?.(true);
    answers[1]?.(true);
    await Promise.all([one, two]);
    expect(sent[1]).toEqual({ 'profile-a': 'prompt-1', 'profile-b': 'prompt-2' });
  });

  it('drops a refused change, so the next write does not send it again', async () => {
    const { selection, sent, answers } = harness({ 'profile-a': 'prompt-1' });
    const one = selection.select('profile-b', 'prompt-2');
    answers[0]?.(false);
    await one;
    const two = selection.select('profile-c', 'prompt-3');
    answers[1]?.(true);
    await two;
    expect(sent[1]).toEqual({ 'profile-a': 'prompt-1', 'profile-c': 'prompt-3' });
  });

  it('removes the entry when the default prompt is chosen', async () => {
    const { selection, sent, answers } = harness({ 'profile-a': 'prompt-1' });
    const one = selection.select('profile-a', DEFAULT_PROMPT_ID);
    answers[0]?.(true);
    await one;
    expect(sent[0]).toEqual({});
  });
});

describe('the model download is announced in steps (NFR-010)', () => {
  it('announces only each quarter, so a screen reader is not read every tick', () => {
    expect([0, 1, 24.9, 25, 49, 50, 74, 75, 99, 100].map(announcedPercent)).toEqual([
      0, 0, 0, 25, 25, 50, 50, 75, 75, 100,
    ]);
  });
});
