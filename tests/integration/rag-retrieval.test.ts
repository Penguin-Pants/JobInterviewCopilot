import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { RetrievalUnavailableError } from '../../src/main/rag.js';
import { describe, expect, it } from 'vitest';
import { makeHarness, NOTES_MD, RESUME_MD } from '../fakes/rag-harness.js';

/**
 * TASK-024. TC-075 retrieval scoping, plus the empty-profile and
 * no-doc-type-weighting behavior at the facade rather than at the scan.
 */

describe('TC-075 retrieval scoping', () => {
  it('returns only chunks from the requested profile', async () => {
    const h = makeHarness();
    const acme = await h.engine.createProfile('Acme');
    const other = await h.engine.createProfile('Other Co');

    await h.engine.importDocuments(acme.id, [h.writeSourceFile('acme.md', RESUME_MD)]);
    await h.engine.importDocuments(other.id, [
      h.writeSourceFile('other.md', '# Other\n\nCompletely different words entirely.'),
    ]);

    const fromAcme = await h.engine.query(acme.id, 'distributed systems experience', 5);
    const fromOther = await h.engine.query(other.id, 'distributed systems experience', 5);

    expect(fromAcme.length).toBeGreaterThan(0);
    expect(fromAcme.every((r) => r.chunk.profileId === acme.id)).toBe(true);
    expect(fromAcme.every((r) => r.chunk.sourceFile === 'acme.md')).toBe(true);

    expect(fromOther.length).toBeGreaterThan(0);
    expect(fromOther.every((r) => r.chunk.profileId === other.id)).toBe(true);
    expect(fromOther.every((r) => r.chunk.sourceFile === 'other.md')).toBe(true);
  });

  it('defaults to the top 3 (FR-065)', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const sections = Array.from(
      { length: 10 },
      (_, i) => `# Section ${i}\n\nBody about topic ${i}.`,
    );
    await h.engine.importDocuments(profile.id, [
      h.writeSourceFile('many.md', sections.join('\n\n')),
    ]);

    expect(await h.engine.query(profile.id, 'topic 4')).toHaveLength(3);
  });

  it('carries the chunk metadata retrieval is meant to surface (FR-063)', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    await h.engine.importDocuments(profile.id, [h.writeSourceFile('resume.md', RESUME_MD)]);

    const [top] = await h.engine.query(profile.id, 'Acme Corp billing pipeline', 1);

    expect(top!.chunk.headerPath.length).toBeGreaterThan(0);
    expect(top!.chunk.sourceFile).toBe('resume.md');
    expect(top!.chunk.docType).toBe('resume');
    expect(typeof top!.score).toBe('number');
  });
});

describe('TC-077 empty and degenerate queries', () => {
  it('a profile with no ready documents returns [] and does not throw', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Empty');

    await expect(h.engine.query(profile.id, 'anything')).resolves.toEqual([]);
  });

  it('an unknown profile returns [] rather than throwing', async () => {
    const h = makeHarness();
    await expect(h.engine.query('no-such-profile', 'anything')).resolves.toEqual([]);
  });

  it('an empty question returns [] without embedding it', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    await h.engine.importDocuments(profile.id, [h.writeSourceFile('resume.md', RESUME_MD)]);
    h.embedder.reset();

    expect(await h.engine.query(profile.id, '   ')).toEqual([]);
    expect(h.embedder.calls).toEqual([]);
  });

  it('a document in error contributes nothing to a query', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    h.embedder.failNext = new Error('ONNX session crashed');
    await h.engine.importDocuments(profile.id, [h.writeSourceFile('bad.md', RESUME_MD)]);
    await h.engine.importDocuments(profile.id, [h.writeSourceFile('good.md', NOTES_MD)]);

    const results = await h.engine.query(profile.id, 'competitors in Berlin', 5);

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.chunk.sourceFile === 'good.md')).toBe(true);
  });

  /**
   * Changed in TASK-044 and recorded as ADR-036. This case used to assert `[]`,
   * so that a failure could not throw into a session. It reached the live loop
   * as "no relevant notes", and the loop then built a suggestion the overlay
   * renders identically to a grounded one, which is the plausible value ADR-032
   * forbids. Empty and failed are different answers now; the loop abandons the
   * turn on the throw, which is neither a crash nor a fabricated answer.
   */
  it('a failing query embedding throws rather than reporting an empty result', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    await h.engine.importDocuments(profile.id, [h.writeSourceFile('resume.md', RESUME_MD)]);

    h.embedder.failNext = new Error('ONNX session crashed');
    await expect(h.engine.query(profile.id, 'anything')).rejects.toThrow(RetrievalUnavailableError);
  });
});

describe('TC-076 no doc-type weighting at the facade', () => {
  it('two documents of different types with the same body rank on similarity alone', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const body = '# Shared\n\nIdentical body text about billing pipelines.';

    await h.engine.importDocuments(profile.id, [h.writeSourceFile('resume.md', body)]);
    await h.engine.importDocuments(profile.id, [h.writeSourceFile('company-notes.md', body)]);

    const documents = h.engine.store.get(profile.id)!.documents;
    expect(new Set(documents.map((d) => d.docType)).size).toBe(2);

    const results = await h.engine.query(profile.id, 'billing pipelines', 2);
    expect(results).toHaveLength(2);
    expect(results[0]!.score).toBeCloseTo(results[1]!.score, 10);
  });
});

describe('the query cache tracks ingests', () => {
  it('a re-embedded document is visible to the next query', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const [record] = await h.engine.importDocuments(profile.id, [
      h.writeSourceFile('notes.md', '# Notes\n\nOriginal content about widgets.'),
    ]);

    expect(await h.engine.query(profile.id, 'widgets', 1)).toHaveLength(1);

    writeFileSync(record!.originalPath, '# Notes\n\nReplaced content about sprockets.');
    await h.engine.processFile(profile.id, record!.originalPath);

    const [top] = await h.engine.query(profile.id, 'sprockets', 1);
    expect(top!.chunk.text).toContain('sprockets');
  });

  it('a deleted document disappears from query results', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const [record] = await h.engine.importDocuments(profile.id, [
      h.writeSourceFile('resume.md', RESUME_MD),
    ]);

    expect((await h.engine.query(profile.id, 'Acme Corp', 5)).length).toBeGreaterThan(0);
    await h.engine.deleteDocument(profile.id, record!.id);
    expect(await h.engine.query(profile.id, 'Acme Corp', 5)).toEqual([]);
  });
});

describe('the query cache stays off the live path (NFR-001, TC-078)', () => {
  it('is rebuilt after an ingest, so the next query reads nothing from disk', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    await h.engine.importDocuments(profile.id, [
      h.writeSourceFile('resume.md', RESUME_MD),
      h.writeSourceFile('notes.md', NOTES_MD),
    ]);
    await h.engine.drain();

    const real = h.engine.store.readChunkSet.bind(h.engine.store);
    let reads = 0;
    h.engine.store.readChunkSet = (profileId: string, docId: string) => {
      reads += 1;
      return real(profileId, docId);
    };

    // The ingest cleared the cache, and the first question after it decoded
    // every vector file synchronously on the main thread, inside the budget.
    expect((await h.engine.query(profile.id, 'Acme Corp', 3)).length).toBeGreaterThan(0);
    expect(reads).toBe(0);
  });

  it('reads back exactly the vectors that were written', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const [record] = await h.engine.importDocuments(profile.id, [
      h.writeSourceFile('resume.md', RESUME_MD),
    ]);
    const set = (await h.engine.store.readChunkSet(profile.id, record!.id))!;
    const vectors = Float32Array.from(set.vectors, (_, i) => (i % 7) - 3.25 + i / 1024);

    expect(h.engine.store.writeChunkSet(profile.id, record!.id, set.chunks, vectors)).toBe(true);

    const reread = (await h.engine.store.readChunkSet(profile.id, record!.id))!;
    expect(Array.from(reread.vectors)).toEqual(Array.from(vectors));
  });

  it('a vectors file that cannot be read is a failure, not an empty result', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const [record] = await h.engine.importDocuments(profile.id, [
      h.writeSourceFile('resume.md', RESUME_MD),
    ]);
    await h.engine.drain();
    const vectors = h.engine.store.vectorsPath(profile.id, record!.id);
    rmSync(vectors);
    mkdirSync(vectors);
    // An unrelated change clears the cache, so the next query has to read.
    await h.engine.importDocuments(profile.id, [h.writeSourceFile('notes.md', NOTES_MD)]);

    await expect(h.engine.query(profile.id, 'Acme Corp', 3)).rejects.toThrow(
      RetrievalUnavailableError,
    );
  });

  it('a pair deleted under the reader is skipped, not thrown', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const [record] = await h.engine.importDocuments(profile.id, [
      h.writeSourceFile('resume.md', RESUME_MD),
    ]);
    rmSync(h.engine.store.vectorsPath(profile.id, record!.id));

    await expect(h.engine.store.readChunkSet(profile.id, record!.id)).resolves.toBeNull();
  });
});
