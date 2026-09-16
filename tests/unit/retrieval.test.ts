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
    topK(query, [set], 3, WIDE);

    const started = performance.now();
    const results = topK(query, [set], 3, WIDE);
    const elapsed = performance.now() - started;

    expect(results).toHaveLength(3);
    expect(results[0]!.score).toBeCloseTo(1, 6);
    expect(elapsed).toBeLessThan(50);
  });
});
