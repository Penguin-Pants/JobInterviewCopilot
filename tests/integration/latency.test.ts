/**
 * TASK-050, TC-133. The latency harness.
 *
 * `NFR-001` is an end-to-end budget (p50 under 2.5 s, p95 under 4.0 s) against
 * real providers on a real connection, and only `MW-06` can measure it. What CI
 * can measure, and what this does, is the part of that budget the app itself
 * owns: with every provider replaced by a scripted fake at a *fixed* delay, the
 * time from turn end to the first bullet reaching the overlay minus those fixed
 * delays is the app's own overhead. `TASK-050` budgets it at under 150 ms.
 *
 * Measured on wall-clock time, so no fake timers here. The turn end is the
 * provider's own endpoint signal, which fires immediately and takes the trigger's
 * local gap timer out of the measurement: the gap is the user's setting, not
 * app overhead (`FR-050`).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearSttProviders } from '../../src/main/ai/stt.js';
import { anthropicScript } from '../fakes/llm.js';
import { harness, retrieved, speak, startSession, stopSession } from '../fakes/live-harness.js';

/** The app-side overhead budget for the turn-end to first-line path (TASK-050). */
const OVERHEAD_BUDGET_MS = 150;

/**
 * A ceiling for the single worst turn. The budget above is the claim; this
 * catches a regression that only shows on one turn without failing the suite
 * over one scheduler hiccup on a loaded runner.
 */
const WORST_TURN_CEILING_MS = 3 * OVERHEAD_BUDGET_MS;

/** Fixed provider delays, subtracted from each measurement. */
const RETRIEVE_MS = 30;
const FIRST_FRAME_MS = 40;
const SCRIPTED_MS = RETRIEVE_MS + FIRST_FRAME_MS;

const TURNS = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  // Clamped at both ends. `p = 0` produces an index of -1 unclamped, and
  // `sorted[-1]` is `undefined`, which a `<` comparison then reports as false
  // rather than as a failure.
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))]!;
}

let userData: string;

beforeEach(() => {
  clearSttProviders();
  userData = mkdtempSync(join(tmpdir(), 'icp-latency-'));
});

afterEach(() => {
  clearSttProviders();
  rmSync(userData, { recursive: true, force: true });
});

describe('TC-133 app-side overhead on the turn-end to first-line path', () => {
  it(`adds under ${OVERHEAD_BUDGET_MS} ms with scripted fakes at fixed delays`, async () => {
    const h = harness(userData, {
      // One bullet per frame. Only the first one is measured.
      llmChunks: anthropicScript(['first cue\n', 'second cue\n']),
      // The delay a retrieval would cost, held constant.
      retrieve: async () => {
        await sleep(RETRIEVE_MS);
        return [retrieved()];
      },
      // The delay the model's first token would cost, on the first frame only.
      beforeChunk: (index) => (index === 0 ? sleep(FIRST_FRAME_MS) : undefined),
    });
    h.gate.noteReady();

    await startSession(h);
    const stream = h.stt.opened.find((s) => s.source === 'interviewer');
    expect(stream).toBeDefined();

    const overheads: number[] = [];

    for (let turn = 0; turn < TURNS; turn += 1) {
      const before = h.sentAt.length;
      speak(h, `Question number ${turn}`);

      // Turn end. Everything after this instant is the app's own work plus the
      // two fixed delays above.
      const turnEnd = Date.now();
      stream!.emitEndpoint();
      await h.live.whenSettled();

      const firstLineAt = h.sentAt
        .slice(before)
        .find((_, i) => h.sent[before + i]?.channel === 'suggestion:line');
      expect(firstLineAt).toBeDefined();

      overheads.push(firstLineAt! - turnEnd - SCRIPTED_MS);
    }

    const sorted = [...overheads].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const worst = sorted[sorted.length - 1]!;

    // Recorded so a run that passes still says by how much (TASK-050, MW-06
    // takes the end-to-end numbers from here).
    console.info(
      `TC-133 app-side overhead over ${TURNS} turns: ` +
        `p50 ${p50} ms, worst ${worst} ms, budget ${OVERHEAD_BUDGET_MS} ms`,
    );

    expect(p50).toBeLessThan(OVERHEAD_BUDGET_MS);
    expect(worst).toBeLessThan(WORST_TURN_CEILING_MS);

    // Every turn really produced a card, so the numbers are not measuring a
    // path that short-circuited.
    expect(h.sent.filter((m) => m.channel === 'suggestion:begin')).toHaveLength(TURNS);

    await stopSession(h);
  });
});

/**
 * TASK-060, TC-169. The LLM-confirm path's own budget.
 *
 * `TC-133` above measures a turn the actionability heuristic resolves on its
 * own, with no classification call in the path at all. This measures the other
 * path: a turn neither lexicon resolves, which costs a real network round trip
 * before the generation can even start. `NFR-018` budgets the app-side part of
 * that at 400 ms on top, again with every provider replaced by a scripted fake
 * at a fixed delay, so what is measured is the app's own work rather than the
 * model's.
 */
const CLASSIFIER_BUDGET_MS = 400;

/** The delay a classification round trip would cost, held constant. */
const CLASSIFY_MS = 20;

/** Neither lexicon resolves this, so the classifier is what answers it. */
const UNRESOLVED = 'I was reading your resume on the train last night';

describe('TC-169 the actionability classifier latency budget', () => {
  it(`adds under ${CLASSIFIER_BUDGET_MS} ms at p95 over the scripted delays`, async () => {
    // Every turn makes two LLM requests: the classification, then the
    // suggestion. Odd requests are classifications, even ones generations.
    let h: ReturnType<typeof harness>;
    const isClassification = (): boolean => h.llmTransport.requests.length % 2 === 1;

    h = harness(userData, {
      wireClassifier: true,
      llmChunks: anthropicScript(['first cue\n', 'second cue\n']),
      retrieve: async () => {
        await sleep(RETRIEVE_MS);
        return [retrieved()];
      },
      beforeChunk: (index) => {
        if (index !== 0) return undefined;
        return isClassification() ? sleep(CLASSIFY_MS) : sleep(FIRST_FRAME_MS);
      },
    });
    h.gate.noteReady();

    await startSession(h);
    const stream = h.stt.opened.find((s) => s.source === 'interviewer');
    expect(stream).toBeDefined();

    const overheads: number[] = [];

    for (let turn = 0; turn < TURNS; turn += 1) {
      const before = h.sentAt.length;
      speak(h, `${UNRESOLVED}, turn ${String(turn)}`);

      const turnEnd = Date.now();
      stream!.emitEndpoint();

      // Two awaits, not one: `whenSettled` returns once the classification has
      // settled, and the generation it allows only starts after that.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await h.live.whenSettled();
        if (h.sent.slice(before).some((m) => m.channel === 'suggestion:end')) break;
      }

      const firstLineAt = h.sentAt
        .slice(before)
        .find((_, i) => h.sent[before + i]?.channel === 'suggestion:line');
      expect(firstLineAt).toBeDefined();

      overheads.push(firstLineAt! - turnEnd - SCRIPTED_MS - CLASSIFY_MS);
    }

    // The classifier really was in the path: two requests per turn, and the
    // first of each pair carries the classification prompt rather than the
    // interview-cue one.
    expect(h.llmTransport.requests).toHaveLength(TURNS * 2);
    const first = h.llmTransport.requests[0]?.body as { system: string };
    expect(first.system).toContain('ACTIONABLE or NON_ACTIONABLE');

    const sorted = [...overheads].sort((a, b) => a - b);
    const p95 = percentile(sorted, 95);

    console.info(
      `TC-169 classifier-path overhead over ${TURNS} turns: ` +
        `p95 ${p95} ms, budget ${CLASSIFIER_BUDGET_MS} ms`,
    );

    expect(p95).toBeLessThan(CLASSIFIER_BUDGET_MS);
    expect(h.sent.filter((m) => m.channel === 'suggestion:begin')).toHaveLength(TURNS);

    await stopSession(h);
  });
});
