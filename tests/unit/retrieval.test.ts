import { describe, expect, it } from 'vitest';
import { topK, type ChunkSet } from '../../src/main/rag/store.js';
import type { Chunk, DocType } from '../../src/shared/types.js';

/**
 * TASK-024. TC-076 no doc-type weighting, TC-077 empty profile, TC-078
 * retrieval performance.
 */

const DIMENSIONS = 8;

function chunk(id: string, docType: DocType, text = id): Chunk {
  return {
    id,
    docId: id.split('#')[0] ?? id,
    profileId: 'p1',
    index: 0,
    text,
    headerPath: ['Section'],
    docType,
    sourceFile: 'file.md',
    tokenCount: 1,
  };
}

/** Build a chunk set whose every row is the same unit vector. */
function setOf(entries: { chunk: Chunk; vector: number[] }[]): ChunkSet {
  const vectors = new Float32Array(entries.length * DIMENSIONS);
  entries.forEach((entry, row) => vectors.set(entry.vector, row * DIMENSIONS));
  return { chunks: entries.map((e) => e.chunk), vectors };
}

const UNIT_0 = [1, 0, 0, 0, 0, 0, 0, 0];
const UNIT_1 = [0, 1, 0, 0, 0, 0, 0, 0];

describe('TC-076 no doc-type weighting', () => {
  it('scores two chunks with identical vectors and different doc types identically', () => {
    const set = setOf([
      { chunk: chunk('a#0', 'resume'), vector: UNIT_0 },
      { chunk: chunk('b#0', 'company-notes'), vector: UNIT_0 },
      { chunk: chunk('c#0', 'job-description'), vector: UNIT_0 },
    ]);

    const results = topK(Float32Array.from(UNIT_0), [set], 3, DIMENSIONS);
    expect(results).toHaveLength(3);
    expect(new Set(results.map((r) => r.score))).toHaveLength(1);
    expect(results[0]!.score).toBeCloseTo(1, 6);
  });

  it('breaks a tie by chunk id, so the order is stable across runs', () => {
    const set = setOf([
      { chunk: chunk('zeta#0', 'resume'), vector: UNIT_0 },
      { chunk: chunk('alpha#0', 'job-description'), vector: UNIT_0 },
    ]);

    const first = topK(Float32Array.from(UNIT_0), [set], 2, DIMENSIONS);
    const second = topK(Float32Array.from(UNIT_0), [set], 2, DIMENSIONS);
    expect(first.map((r) => r.chunk.id)).toEqual(['alpha#0', 'zeta#0']);
    expect(second.map((r) => r.chunk.id)).toEqual(first.map((r) => r.chunk.id));
  });

  it('ranks by similarity alone', () => {
    const set = setOf([
      { chunk: chunk('far#0', 'resume'), vector: UNIT_1 },
      { chunk: chunk('near#0', 'company-notes'), vector: UNIT_0 },
    ]);

    const results = topK(Float32Array.from(UNIT_0), [set], 2, DIMENSIONS);
    expect(results.map((r) => r.chunk.id)).toEqual(['near#0', 'far#0']);
  });
});

describe('TC-077 empty profile', () => {
  it('returns [] for no candidates and does not throw', () => {
    expect(topK(Float32Array.from(UNIT_0), [], 3, DIMENSIONS)).toEqual([]);
  });

  it('returns [] for a chunk set with no rows', () => {
    const empty: ChunkSet = { chunks: [], vectors: new Float32Array(0) };
    expect(topK(Float32Array.from(UNIT_0), [empty], 3, DIMENSIONS)).toEqual([]);
  });

  it('returns [] for k of zero and for a query of the wrong width', () => {
    const set = setOf([{ chunk: chunk('a#0', 'resume'), vector: UNIT_0 }]);
    expect(topK(Float32Array.from(UNIT_0), [set], 0, DIMENSIONS)).toEqual([]);
    expect(topK(new Float32Array(4), [set], 3, DIMENSIONS)).toEqual([]);
  });

  it('returns everything it has when k exceeds the corpus', () => {
    const set = setOf([{ chunk: chunk('a#0', 'resume'), vector: UNIT_0 }]);
    expect(topK(Float32Array.from(UNIT_0), [set], 10, DIMENSIONS)).toHaveLength(1);
  });
});

describe('a corrupted vector row cannot take the whole result', () => {
  it('drops a NaN-scoring row instead of ranking it', () => {
    // NaN makes `b.score - a.score` return NaN, which is falsy, so the sort fell
    // through to the id tie-break and the poisoned rows won every position.
    const poison = [NaN, 0, 0, 0, 0, 0, 0, 0];
    const set = setOf([
      { chunk: chunk('aaa#0', 'resume'), vector: poison },
      { chunk: chunk('aaa#1', 'resume'), vector: poison },
      { chunk: chunk('aaa#2', 'resume'), vector: poison },
      { chunk: chunk('zzz#0', 'company-notes'), vector: UNIT_0 },
    ]);

    const results = topK(Float32Array.from(UNIT_0), [set], 3, DIMENSIONS);

    expect(results.map((r) => r.chunk.id)).toEqual(['zzz#0']);
    expect(results.every((r) => Number.isFinite(r.score))).toBe(true);
  });

  it('drops an Infinity-scoring row too', () => {
    const set = setOf([
      { chunk: chunk('aaa#0', 'resume'), vector: [Infinity, 0, 0, 0, 0, 0, 0, 0] },
      { chunk: chunk('zzz#0', 'resume'), vector: UNIT_0 },
    ]);

    const results = topK(Float32Array.from(UNIT_0), [set], 3, DIMENSIONS);
    expect(results.map((r) => r.chunk.id)).toEqual(['zzz#0']);
  });
});

describe('TC-078 retrieval performance', () => {
  /**
   * Measurements to take. The budget is asserted against the fastest.
   *
   * The test strategy's determinism rule says an intermittent failure is a
   * defect in the test, never a flake to retry, and a single wall-clock reading
   * on a shared CI runner is exactly that: the scan costs 2 to 3 ms here and one
   * reading on the runner came back at 54.9 ms, so that reading measured the
   * runner being descheduled, not the code.
   *
   * The minimum over several runs estimates what the algorithm actually costs.
   * It still fails loudly on a real regression, because code that genuinely
   * cannot meet the budget is slow on every run, not on one in ten.
   */
  const MEASUREMENTS = 5;

  it('returns the top 3 of 5000 chunks in under 50 ms', () => {
    const WIDE = 384;
    const COUNT = 5000;

    const chunks: Chunk[] = [];
    const vectors = new Float32Array(COUNT * WIDE);
    for (let row = 0; row < COUNT; row += 1) {
      chunks.push(chunk(`doc#${row}`, 'resume'));
      // A unit vector on one axis, so scores are known and the scan is real.
      vectors[row * WIDE + (row % WIDE)] = 1;
    }
    const set: ChunkSet = { chunks, vectors };

    const query = new Float32Array(WIDE);
    query[7] = 1;

    // One warm-up so the measurement is not the JIT's first pass.
    const results = topK(query, [set], 3, WIDE);

    const timings: number[] = [];
    for (let run = 0; run < MEASUREMENTS; run += 1) {
      const started = performance.now();
      topK(query, [set], 3, WIDE);
      timings.push(performance.now() - started);
    }
    const fastest = Math.min(...timings);

    expect(results).toHaveLength(3);
    expect(results[0]!.score).toBeCloseTo(1, 6);
    expect(
      fastest,
      `fastest of ${MEASUREMENTS} runs was ${fastest.toFixed(1)}ms (all: ${timings
        .map((t) => t.toFixed(1))
        .join(', ')})`,
    ).toBeLessThan(50);
  });

  it('scales linearly, so a regression to a quadratic scan is caught', () => {
    // The wall-clock budget above can only ever say "fast enough on this
    // machine". This says the scan's cost is proportional to the corpus, which
    // is the property that actually keeps 5000 chunks inside the budget on a
    // machine slower than any runner.
    const WIDE = 384;

    const build = (count: number): ChunkSet => {
      const chunks: Chunk[] = [];
      const vectors = new Float32Array(count * WIDE);
      for (let row = 0; row < count; row += 1) {
        chunks.push(chunk(`doc#${row}`, 'resume'));
        vectors[row * WIDE + (row % WIDE)] = 1;
      }
      return { chunks, vectors };
    };

    const query = new Float32Array(WIDE);
    query[7] = 1;

    const timeOf = (set: ChunkSet): number => {
      topK(query, [set], 3, WIDE);
      const runs: number[] = [];
      for (let i = 0; i < MEASUREMENTS; i += 1) {
        const started = performance.now();
        topK(query, [set], 3, WIDE);
        runs.push(performance.now() - started);
      }
      return Math.min(...runs);
    };

    const small = timeOf(build(2000));
    const large = timeOf(build(8000));

    // Four times the corpus. Linear would be about 4x; quadratic would be 16x.
    // Eight leaves generous room for measurement noise while still failing a
    // quadratic scan by a wide margin.
    const ratio = large / Math.max(small, 0.01);
    expect(ratio, `8000 chunks cost ${ratio.toFixed(1)}x what 2000 did`).toBeLessThan(8);
  });
});
