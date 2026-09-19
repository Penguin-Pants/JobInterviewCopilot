/**
 * TASK-060 and TASK-062, end to end through the live session loop.
 *
 * `TC-173` is the half of the staleness rule that is *not* about the overlay:
 * a discarded generation is still a generation, so its transcript entry and
 * its spend both have to survive the discard. `TC-190` follows that entry onto
 * disk and back, because a `'stale'` status `sessionSchema` does not know about
 * would take the whole interview out of Session History on the next read.
 * `TC-188` is the teardown ordering the classifier added.
 *
 * Driven on fake timers: `STALE_DISCARD_MS` is 20 seconds, and no test in this
 * suite may wait one.
 */
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionSchema } from '../../src/shared/ipc.js';
import { clearSttProviders } from '../../src/main/ai/stt.js';
import { STALE_DISCARD_MS } from '../../src/main/live.js';
import { readSession } from '../../src/main/session.js';
import {
  GAP,
  PROFILE,
  harness,
  retrieved,
  speak,
  startSession,
  stopSession,
  type Harness,
} from '../fakes/live-harness.js';

/** A turn neither lexicon resolves, so the classifier is the one who answers. */
const UNRESOLVED = 'I was reading your resume on the train last night';

const SESSION_FILE = (userData: string): string =>
  join(userData, 'profiles', PROFILE.id, 'sessions', 's1.json');

let userData: string;

beforeEach(() => {
  clearSttProviders();
  userData = mkdtempSync(join(tmpdir(), 'icp-stale-'));
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  clearSttProviders();
  rmSync(userData, { recursive: true, force: true });
});

/** A `retrieve` a test releases by hand, so the clock can run inside it. */
function gatedRetrieve(): {
  retrieve: () => Promise<ReturnType<typeof retrieved>[]>;
  release: () => void;
} {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release: () => release(),
    retrieve: async () => {
      await gate;
      return [retrieved()];
    },
  };
}

/**
 * TC-173. The overlay is the only thing a stale discard takes away.
 *
 * The request was made, the tokens were spent and the model answered, so the
 * transcript records what it said and the Cost Meter still counts it
 * (`FR-103`). Only the push is suppressed or truncated.
 */
describe('TC-173 a stale generation still reaches the transcript and the meter', () => {
  it('records status stale and its usage when checkpoint 1 discards it', async () => {
    const { retrieve, release } = gatedRetrieve();
    const h = harness(userData, { retrieve });
    h.gate.noteReady();
    await startSession(h);

    speak(h, 'Tell me about a time you shipped something hard');
    await vi.advanceTimersByTimeAsync(GAP);

    // The turn has fired and is waiting on retrieval. The interview moves on
    // for longer than the discard budget while it waits.
    await vi.advanceTimersByTimeAsync(STALE_DISCARD_MS + 1);
    release();
    await h.live.whenSettled();

    // Nothing reached the overlay at all: checkpoint 1 runs before `begin`.
    expect(h.sent).toEqual([]);

    const session = await stopSession(h);
    const entry = session?.entries.find((e) => e.kind === 'suggestion');
    expect(entry).toMatchObject({ kind: 'suggestion', status: 'stale' });
    // The bullets the model produced are kept, not blanked: the answer was
    // real, it was simply too late to show.
    expect(entry?.kind === 'suggestion' && entry.bullets).toEqual(['first cue', 'second cue']);

    // And the spend is the session's spend, discard or no discard.
    expect(session?.usage.llmInputTokens).toBe(412);
    expect(session?.usage.llmOutputTokens).toBe(57);
    expect(h.errors).toEqual([]);
  });

  it('records status stale when checkpoint 2 discards it after begin went out', async () => {
    let release = (): void => {};
    const firstDelta = new Promise<void>((resolve) => {
      release = resolve;
    });

    const h = harness(userData, {
      retrieve: () => Promise.resolve([retrieved()]),
      // Index 0 is the `message_start` frame; index 1 is the first bullet. The
      // card is on screen by then, so this is the slow-first-token case.
      beforeChunk: (index) => (index === 1 ? firstDelta : undefined),
    });
    h.gate.noteReady();
    await startSession(h);

    speak(h, 'Tell me about a time you shipped something hard');
    await vi.advanceTimersByTimeAsync(GAP);
    expect(h.sent.map((m) => m.channel)).toEqual(['suggestion:begin']);

    await vi.advanceTimersByTimeAsync(STALE_DISCARD_MS + 1);
    release();
    await h.live.whenSettled();

    // One begin, no line, and the cancellation that clears the card.
    expect(h.sent.map((m) => m.channel)).toEqual(['suggestion:begin', 'suggestion:end']);
    expect(h.sent.at(-1)?.payload).toMatchObject({ status: 'cancelled' });

    const session = await stopSession(h);
    // The overlay was told `'cancelled'`; the transcript records `'stale'`.
    expect(session?.entries.find((e) => e.kind === 'suggestion')).toMatchObject({
      status: 'stale',
    });
    expect(session?.usage.llmOutputTokens).toBe(57);
  });
});

/**
 * TC-190. `'stale'` had to be added to three types, and the persisted schema is
 * the one whose omission would have been silent: nothing fails when the entry
 * is written, and the interview disappears from Session History the first time
 * the file is read back.
 */
describe('TC-190 a persisted session carrying a stale entry survives session:read', () => {
  it('parses the compacted file and keeps the status unchanged', async () => {
    const { retrieve, release } = gatedRetrieve();
    const h = harness(userData, { retrieve });
    h.gate.noteReady();
    await startSession(h);

    speak(h, 'Tell me about a time you shipped something hard');
    await vi.advanceTimersByTimeAsync(GAP);
    await vi.advanceTimersByTimeAsync(STALE_DISCARD_MS + 1);
    release();
    await h.live.whenSettled();
    await stopSession(h);

    // The schema itself, against the bytes on disk, which is what `session:read`
    // runs before it answers.
    const onDisk: unknown = JSON.parse(await readFile(SESSION_FILE(userData), 'utf8'));
    const parsed = sessionSchema.safeParse(onDisk);
    expect(parsed.success).toBe(true);

    const read = await readSession(userData, PROFILE.id, 's1');
    expect(read).not.toBeNull();
    expect(read?.entries.find((e) => e.kind === 'suggestion')).toMatchObject({
      kind: 'suggestion',
      status: 'stale',
    });
  });
});

/**
 * TC-188. `stop()` awaits the classification alongside the generation.
 *
 * The classification's own `try`/`finally` is where its cost is reported, so a
 * teardown that snapshotted usage and compacted ahead of it would drop a real,
 * billable request from the session estimate every time a user stopped while
 * the trigger was still `CLASSIFYING`.
 */
describe('TC-188 session stop awaits the in-flight classification accounting', () => {
  it('does not return or snapshot usage until the classification accounting lands', async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const h: Harness = harness(userData, {
      wireClassifier: true,
      retrieve: () => Promise.resolve([retrieved()]),
      // The classification is the first LLM request of the session, and this
      // holds its response open on the very first frame.
      beforeChunk: (index) => (index === 0 ? held : undefined),
    });
    h.gate.noteReady();
    await startSession(h);

    speak(h, UNRESOLVED);
    await vi.advanceTimersByTimeAsync(GAP);

    // The trigger is CLASSIFYING and the call is out but has answered nothing.
    expect(h.trigger.current).toBe('CLASSIFYING');
    expect(h.llmTransport.requests).toHaveLength(1);
    expect(h.costCalls).toEqual([]);

    let stopped = false;
    const stopping = stopSession(h).then((session) => {
      stopped = true;
      return session;
    });

    // Given every chance to finish early: microtasks flush, timers run, and
    // `stop()` is still waiting on the classification's own `finally`.
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    expect(h.costCalls).toEqual([]);

    release();
    const session = await stopping;
    expect(stopped).toBe(true);

    // The accounting landed, keyed as a classification, before `stop()` came
    // back -- so before usage was snapshotted and before the session was
    // compacted. Stopping aborts the call, so what it reports is what had
    // arrived: the `finally` is what makes it report at all.
    expect(h.costCalls.map((c) => c.generationId)).toEqual([
      expect.stringMatching(/^classify:/) as unknown as string,
    ]);
    expect(session?.usage.estimateIncomplete).toBe(false);

    // Stopping aborted the turn, so nothing was generated for it.
    expect(h.sent).toEqual([]);
    expect(h.errors).toEqual([]);
  });

  /**
   * The other half of the same claim: what the classification cost is part of
   * the session's total, not a separate number kept somewhere else. A
   * classification that answers normally is billed under its own key, so the
   * persisted total carries both it and the suggestion it allowed.
   */
  it('carries the classification tokens into the persisted session total', async () => {
    const h = harness(userData, {
      wireClassifier: true,
      retrieve: () => Promise.resolve([retrieved()]),
    });
    h.gate.noteReady();
    await startSession(h);

    speak(h, UNRESOLVED);
    await vi.advanceTimersByTimeAsync(GAP);
    await h.live.whenSettled();

    // Two billable requests: the classification, then the suggestion it let
    // through. Keyed apart, so neither replaces the other (ADR-033).
    expect(h.costCalls).toHaveLength(2);
    expect(h.costCalls[0]?.generationId).toMatch(/^classify:/);
    expect(h.costCalls[1]?.generationId).toMatch(/#1$/);

    const session = await stopSession(h);
    // 412 + 412 and 57 + 57: the classification's tokens are in the total the
    // user is shown, not dropped from it.
    expect(session?.usage.llmInputTokens).toBe(824);
    expect(session?.usage.llmOutputTokens).toBe(114);
    expect(h.errors).toEqual([]);
  });
});
