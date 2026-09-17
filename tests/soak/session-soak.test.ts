/**
 * TASK-050, TC-131. `NFR-004`: steady-state main-process resident memory during
 * a 60-minute session stays under 600 MB, with no upward trend across the last
 * 30 minutes.
 *
 * Not part of `npm test`. It runs on its own config (`vitest.soak.config.ts`)
 * off the nightly job, because an hour is not a price a pull request should pay
 * (`04-test-strategy.md` section 5).
 *
 * The workload is the live session loop under synthetic transcript events: real
 * audio chunks into real provider sessions, real turns through the real trigger,
 * real generations through the real line buffer and overlay gate, and a real
 * transcript appended to a real file. Only the three boundaries that would reach
 * the outside world are scripted, exactly as in every other live-session test.
 *
 * Two numbers come out, and both are asserted:
 *
 * - the ceiling, `peak RSS < 600 MB`, and
 * - the trend across the trailing half of the run, which must not climb.
 *
 * The trend is fitted over bucket medians rather than raw samples. A garbage
 * collector that happens to run late produces a single tall sample, and a
 * least-squares line through raw samples turns that one sample into a slope.
 *
 * `SOAK_MINUTES` shortens the run for a local smoke check. The nightly job
 * leaves it unset and gets the full hour `NFR-004` names.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearSttProviders } from '../../src/main/ai/stt.js';
import { anthropicScript } from '../fakes/llm.js';
import { harness, retrieved, speak, startSession, stopSession } from '../fakes/live-harness.js';
import { soakMinutes } from './duration.js';

/** `NFR-004`'s ceiling. */
const RSS_CEILING_MB = 600;

/**
 * The trailing-window slope budget. A real retention leak in this loop grows by
 * megabytes per turn; this is set well below that and well above the drift a
 * collector's timing produces over half an hour.
 */
const TREND_BUDGET_MB_PER_MIN = 1.0;

/** `NFR-004` measures the trend across the last 30 minutes, which is half the run. */
const TREND_WINDOW_FRACTION = 0.5;

const DURATION_MINUTES = soakMinutes();
const DURATION_MS = DURATION_MINUTES * 60_000;

/**
 * One second of audio per stream per tick, which is the rate `CH-303` really
 * sends at (`FR-041`). Running it faster would measure a workload the app never
 * sees; over an hour this is 3600 chunks a stream, the 220 MiB of interview
 * audio `ADR-027` exists to keep out of memory.
 */
const TICK_MS = 1000;

/** A turn every twenty seconds, so an hour is roughly 180 questions. */
const TICKS_PER_TURN = 20;

/**
 * Fixed sample count, so a smoke run and the full hour both fit the same trend
 * arithmetic and neither is measured from four points.
 */
const SAMPLE_COUNT = 120;
const SAMPLE_MS = Math.max(TICK_MS, Math.round(DURATION_MS / SAMPLE_COUNT));

const BYTES_PER_MB = 1024 * 1024;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Collect first, where the runner allows it, so a sample is not GC timing. */
function sampleRssMb(): number {
  (globalThis as { gc?: () => void }).gc?.();
  return process.memoryUsage().rss / BYTES_PER_MB;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Least-squares slope of y against x, in units of y per unit of x. */
function slope(points: { x: number; y: number }[]): number {
  if (points.length < 2) return 0;
  const meanX = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  let numerator = 0;
  let denominator = 0;
  for (const p of points) {
    numerator += (p.x - meanX) * (p.y - meanY);
    denominator += (p.x - meanX) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

/** Bucket medians, so one tall sample cannot become a trend. */
function bucketMedians(
  samples: { atMs: number; rssMb: number }[],
  buckets: number,
): { x: number; y: number }[] {
  const size = Math.ceil(samples.length / buckets);
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < samples.length; i += size) {
    const slice = samples.slice(i, i + size);
    if (slice.length === 0) continue;
    out.push({
      x: median(slice.map((s) => s.atMs)) / 60_000,
      y: median(slice.map((s) => s.rssMb)),
    });
  }
  return out;
}

let userData: string;

beforeEach(() => {
  clearSttProviders();
  userData = mkdtempSync(join(tmpdir(), 'icp-soak-'));
});

afterEach(() => {
  clearSttProviders();
  rmSync(userData, { recursive: true, force: true });
});

describe('TC-131 a long session holds its memory', () => {
  it(`keeps RSS under ${RSS_CEILING_MB} MB with no upward trend over ${DURATION_MINUTES} minutes`, async () => {
    const h = harness(userData, {
      llmChunks: anthropicScript(['first cue\n', 'second cue\n', 'third cue\n']),
      retrieve: () => Promise.resolve([retrieved()]),
    });
    h.gate.noteReady();
    await startSession(h);

    const stream = h.stt.opened.find((s) => s.source === 'interviewer');
    expect(stream).toBeDefined();

    const samples: { atMs: number; rssMb: number }[] = [];
    const startedAt = Date.now();
    let nextSampleAt = startedAt;
    let ticks = 0;
    let turns = 0;

    while (Date.now() - startedAt < DURATION_MS) {
      ticks += 1;

      // One second of audio on each stream, which the loop hands to its
      // provider session and releases (FR-043, ADR-027).
      h.sendChunk('interviewer', ticks);
      h.sendChunk('candidate', ticks);
      h.tick(1);

      if (ticks % TICKS_PER_TURN === 0) {
        turns += 1;
        speak(h, `Question number ${turns} about something you shipped`);
        stream!.emitEndpoint();
        await h.live.whenSettled();
      }

      if (Date.now() >= nextSampleAt) {
        // The harness's own recording arrays are the test, not the app. Left to
        // grow they would be the trend this test measures.
        h.sent.length = 0;
        h.sentAt.length = 0;
        h.transcripts.length = 0;
        h.retrievals.length = 0;
        h.triggerConfigs.length = 0;
        h.llmTransport.requests.length = 0;

        samples.push({ atMs: Date.now() - startedAt, rssMb: sampleRssMb() });
        nextSampleAt = Date.now() + SAMPLE_MS;
      }

      await sleep(TICK_MS);
    }

    await stopSession(h);

    /* -------------------------------------------------------------- *
     * The run did real work
     * -------------------------------------------------------------- */

    expect(turns).toBeGreaterThan(0);
    expect(samples.length).toBeGreaterThanOrEqual(8);

    /* -------------------------------------------------------------- *
     * The ceiling (NFR-004)
     * -------------------------------------------------------------- */

    const peak = Math.max(...samples.map((s) => s.rssMb));

    /* -------------------------------------------------------------- *
     * The trend across the trailing window (NFR-004)
     * -------------------------------------------------------------- */

    const windowStart = Math.floor(samples.length * (1 - TREND_WINDOW_FRACTION));
    const trailing = samples.slice(windowStart);
    const trend = slope(bucketMedians(trailing, 10));

    const first = median(trailing.slice(0, Math.ceil(trailing.length / 10)).map((s) => s.rssMb));
    const last = median(trailing.slice(-Math.ceil(trailing.length / 10)).map((s) => s.rssMb));

    console.info(
      [
        `TC-131 soak over ${DURATION_MINUTES} min: ${turns} turns, ${samples.length} samples`,
        `peak RSS ${peak.toFixed(1)} MB (ceiling ${RSS_CEILING_MB} MB)`,
        `trailing ${Math.round(DURATION_MINUTES * TREND_WINDOW_FRACTION)} min: ` +
          `${first.toFixed(1)} -> ${last.toFixed(1)} MB, ` +
          `slope ${trend.toFixed(3)} MB/min (budget ${TREND_BUDGET_MB_PER_MIN})`,
      ].join('\n'),
    );

    expect(peak).toBeLessThan(RSS_CEILING_MB);
    expect(trend).toBeLessThan(TREND_BUDGET_MB_PER_MIN);
  });
});
