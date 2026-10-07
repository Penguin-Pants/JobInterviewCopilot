/**
 * Two Dashboard rows carried to TASK-050 and fixed in the follow-up sweep, and
 * the rules the renderer UX audit of 2026-10-04 extracted from the sections.
 *
 * The renderer has no DOM in this suite, so each rule is asserted on the pure
 * function the component calls. `guardrails.test.ts` pins that every button
 * and the drop zone actually call it.
 */
import { describe, expect, it, vi } from 'vitest';
import { focusWithin } from '../../src/renderer/dashboard/focus.js';
import { createInFlightGate } from '../../src/renderer/dashboard/inFlight.js';
import {
  announcedPercent,
  createPromptSelection,
  dragLeftZone,
} from '../../src/renderer/dashboard/sections/CompanyProfiles.js';
import { parseThresholds } from '../../src/renderer/dashboard/sections/CostAndUsage.js';
import { withStoredBinding } from '../../src/renderer/dashboard/sections/Hotkeys.js';
import { pendingDeleteAfter } from '../../src/renderer/dashboard/sections/SessionHistory.js';
import { DEFAULT_PROMPT_ID } from '../../src/shared/prompts.js';
import type { SessionSummary } from '../../src/shared/types.js';

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
    /** Answers write `i` once it has been sent. Writes go one at a time. */
    async function answer(i: number, ok: boolean): Promise<void> {
      await vi.waitFor(() => {
        expect(answers[i]).toBeDefined();
      });
      answers[i]?.(ok);
    }
    return { selection, sent, answer };
  }

  it('sends one write at a time', async () => {
    const { selection, sent, answer } = harness({});
    const one = selection.select('profile-a', 'prompt-1');
    const two = selection.select('profile-b', 'prompt-2');
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    await answer(0, true);
    await answer(1, true);
    await Promise.all([one, two]);
    expect(sent).toHaveLength(2);
  });

  it('merges the second change with the first', async () => {
    const { selection, sent, answer } = harness({});
    const one = selection.select('profile-a', 'prompt-1');
    const two = selection.select('profile-b', 'prompt-2');
    await answer(0, true);
    await answer(1, true);
    await Promise.all([one, two]);
    expect(sent[1]).toEqual({ 'profile-a': 'prompt-1', 'profile-b': 'prompt-2' });
  });

  it('ignores a stored value that arrives while a write is pending', async () => {
    const { selection, sent, answer } = harness({});
    const one = selection.select('profile-a', 'prompt-1');
    // The reload after an earlier write answers before this one has landed.
    selection.sync({});
    const two = selection.select('profile-b', 'prompt-2');
    await answer(0, true);
    await answer(1, true);
    await Promise.all([one, two]);
    expect(sent[1]).toEqual({ 'profile-a': 'prompt-1', 'profile-b': 'prompt-2' });
  });

  it('drops a refused change, so the next write does not send it again', async () => {
    const { selection, sent, answer } = harness({ 'profile-a': 'prompt-1' });
    const one = selection.select('profile-b', 'prompt-2');
    await answer(0, false);
    await one;
    const two = selection.select('profile-c', 'prompt-3');
    await answer(1, true);
    await two;
    expect(sent[1]).toEqual({ 'profile-a': 'prompt-1', 'profile-c': 'prompt-3' });
  });

  it('does not save a refused change through a write that overlapped it', async () => {
    // Audit regression: the second write carried the first change before the
    // first was answered, so a refused first change was saved by the second.
    const { selection, sent, answer } = harness({});
    const one = selection.select('profile-a', 'prompt-1');
    const two = selection.select('profile-b', 'prompt-2');
    await answer(0, false);
    await answer(1, true);
    await Promise.all([one, two]);
    expect(sent[1]).toEqual({ 'profile-b': 'prompt-2' });
  });

  it('keeps a saved change when a later overlapping write is refused', async () => {
    // Audit regression: a refusal put back the last reload, which predated
    // the first saved change, so a third change overwrote it.
    const { selection, sent, answer } = harness({});
    const one = selection.select('profile-a', 'prompt-1');
    const two = selection.select('profile-b', 'prompt-2');
    const three = selection.select('profile-c', 'prompt-3');
    await answer(0, true);
    await answer(1, false);
    await answer(2, true);
    await Promise.all([one, two, three]);
    expect(sent[2]).toEqual({ 'profile-a': 'prompt-1', 'profile-c': 'prompt-3' });
  });

  it('removes the entry when the default prompt is chosen', async () => {
    const { selection, sent, answer } = harness({ 'profile-a': 'prompt-1' });
    const one = selection.select('profile-a', DEFAULT_PROMPT_ID);
    await answer(0, true);
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

describe('a transcript delete in flight cannot be cancelled or replaced (FR-110)', () => {
  function summary(id: string): SessionSummary {
    return {
      id,
      profileId: 'profile-a',
      profileNameSnapshot: 'Acme',
      startedAt: '2026-10-04T10:00:00.000Z',
      endedAt: '2026-10-04T10:30:00.000Z',
      entryCount: 3,
      estimatedUsd: 0,
      endReason: 'user',
    };
  }

  it('opens the confirmation for a row and closes it on Keep it when nothing is deleting', () => {
    const asked = pendingDeleteAfter(null, false, { kind: 'ask', summary: summary('s-1') });
    expect(asked?.id).toBe('s-1');
    expect(pendingDeleteAfter(asked, false, { kind: 'keep' })).toBeNull();
  });

  it('keeps the confirmation open on Keep it while its delete is in flight', () => {
    // Closed here, the dialog looked like a cancel while the delete went on.
    const open = summary('s-1');
    expect(pendingDeleteAfter(open, true, { kind: 'keep' })).toBe(open);
  });

  it('opens no other confirmation while a delete is in flight', () => {
    const open = summary('s-1');
    expect(pendingDeleteAfter(open, true, { kind: 'ask', summary: summary('s-2') })).toBe(open);
  });

  it('lets a settled delete close only its own confirmation', () => {
    const newer = summary('s-2');
    expect(pendingDeleteAfter(newer, false, { kind: 'settled', sessionId: 's-1' })).toBe(newer);
    expect(pendingDeleteAfter(newer, false, { kind: 'settled', sessionId: 's-2' })).toBeNull();
  });
});

describe('a closing dialog moves focus only when the user is still there (NFR-010)', () => {
  const node = {} as Node;
  const holding = { contains: (n: Node | null) => n === node };
  const elsewhere = { contains: () => false };

  it('moves focus when it is inside one of the regions', () => {
    expect(focusWithin(node, [elsewhere, holding])).toBe(true);
  });

  it('leaves focus alone when the user moved it out of every region', () => {
    expect(focusWithin(node, [elsewhere, null, undefined])).toBe(false);
  });

  it('leaves focus alone when nothing has focus', () => {
    expect(focusWithin(null, [{ contains: () => true }])).toBe(false);
  });
});
