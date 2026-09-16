import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDocx, buildPdf } from '../fakes/documents.js';
import { makeHarness, NOTES_MD, RESUME_MD, withProfile } from '../fakes/rag-harness.js';
import type { Chunk } from '../../src/shared/types.js';

/**
 * TASK-020, TASK-021, TASK-022, TASK-023.
 * TC-060, TC-062, TC-063, TC-069, TC-070, TC-073, TC-074, TC-149.
 */

function chunksOf(harness: ReturnType<typeof makeHarness>, profileId: string, docId: string) {
  return harness.engine.store.readChunkSet(profileId, docId)?.chunks as Chunk[] | undefined;
}

describe('TC-060 format ingest', () => {
  it('ingests .md as-is with no derived file', async () => {
    const h = makeHarness();
    const profile = await withProfile(h);
    const source = h.writeSourceFile('resume.md', RESUME_MD);

    const [record] = await h.engine.importDocuments(profile.id, [source]);

    expect(record!.sourceFormat).toBe('md');
    expect(record!.state).toBe('ready');
    expect(record!.derivedMarkdownPath).toBeNull();
    expect(record!.extractionQuality).toBe('native');
    // The copy in kb/ is byte-identical: "as-is" means the file is not rewritten.
    expect(readFileSync(record!.originalPath, 'utf8')).toBe(RESUME_MD);
  });

  it('converts .pdf to derived/<docId>.md', async () => {
    const h = makeHarness();
    const profile = await withProfile(h);
    const source = h.writeSourceFile(
      'notes.pdf',
      buildPdf(['# Company', 'Founded in 2015 and headquartered in Berlin.']),
    );

    const [record] = await h.engine.importDocuments(profile.id, [source]);

    expect(record!.state).toBe('ready');
    expect(record!.sourceFormat).toBe('pdf');
    expect(record!.derivedMarkdownPath).toBe(
      h.engine.store.derivedMarkdownPath(profile.id, record!.id),
    );
    const derived = readFileSync(record!.derivedMarkdownPath!, 'utf8');
    expect(derived).toContain('# Company');
    expect(derived).toContain('Founded in 2015');
    // pdf-parse's page separator is chrome, not content.
    expect(derived).not.toMatch(/--\s*\d+\s+of\s+\d+\s*--/);
  }, 30000);

  it('converts .docx to derived/<docId>.md', async () => {
    const h = makeHarness();
    const profile = await withProfile(h);
    const source = h.writeSourceFile(
      'resume.docx',
      buildDocx([{ text: 'Experience', heading: 2 }, { text: 'Acme Corp, Senior Engineer' }]),
    );

    const [record] = await h.engine.importDocuments(profile.id, [source]);

    expect(record!.state).toBe('ready');
    expect(record!.sourceFormat).toBe('docx');
    expect(record!.extractionQuality).toBe('native');
    expect(readFileSync(record!.derivedMarkdownPath!, 'utf8')).toContain('## Experience');
  }, 30000);

  it('rejects an unsupported extension with a named reason rather than dropping it', async () => {
    const h = makeHarness();
    const profile = await withProfile(h);
    const source = h.writeSourceFile('notes.rtf', 'some text');

    const [record] = await h.engine.importDocuments(profile.id, [source]);

    expect(record!.state).toBe('error');
    expect(record!.errorMessage).toMatch(/Unsupported file type/);
  });

  it('does not overwrite an existing document with the same name', async () => {
    const h = makeHarness();
    const profile = await withProfile(h);
    const first = h.writeSourceFile('resume.md', RESUME_MD);

    await h.engine.importDocuments(profile.id, [first]);
    writeFileSync(first, `${RESUME_MD}\n\n## Extra\nMore.`);
    await h.engine.importDocuments(profile.id, [first]);

    const documents = h.engine.store.get(profile.id)!.documents;
    expect(documents).toHaveLength(2);
    expect(documents.map((d) => d.originalFileName).sort()).toEqual(['resume (1).md', 'resume.md']);
  });
});

describe('TC-062 best-effort label', () => {
  it('sets extractionQuality to best-effort for every pdf', async () => {
    const h = makeHarness();
    const profile = await withProfile(h);
    const source = h.writeSourceFile('notes.pdf', buildPdf(['# Company', 'Clean extraction.']));

    const [record] = await h.engine.importDocuments(profile.id, [source]);

    expect(record!.extractionQuality).toBe('best-effort');
  }, 30000);

  it('leaves md and docx as native', async () => {
    const h = makeHarness();
    const profile = await withProfile(h);
    const md = h.writeSourceFile('a.md', RESUME_MD);
    const docx = h.writeSourceFile('b.docx', buildDocx([{ text: 'Body text here.' }]));

    const records = await h.engine.importDocuments(profile.id, [md, docx]);

    expect(records.map((r) => r.extractionQuality)).toEqual(['native', 'native']);
  }, 30000);
});

describe('TC-063 failure isolation', () => {
  it('a corrupt file in a three-file batch errors alone; the other two reach ready', async () => {
    const h = makeHarness();
    const profile = await withProfile(h);
    const good1 = h.writeSourceFile('resume.md', RESUME_MD);
    // A .pdf header with no body. pdfjs rejects it; the batch must not.
    const corrupt = h.writeSourceFile('broken.pdf', Buffer.from('%PDF-1.4\nnot a pdf at all'));
    const good2 = h.writeSourceFile('notes.md', NOTES_MD);

    const records = await h.engine.importDocuments(profile.id, [good1, corrupt, good2]);

    expect(records).toHaveLength(3);
    expect(records[0]!.state).toBe('ready');
    expect(records[2]!.state).toBe('ready');
    expect(records[1]!.state).toBe('error');
    expect(records[1]!.errorMessage).toBeTruthy();
    expect(records[1]!.errorMessage).not.toMatch(/\n\s+at /); // A sentence, not a stack.
  }, 30000);

  it('an embedding failure leaves no half-written chunk pair behind', async () => {
    const h = makeHarness();
    const profile = await withProfile(h);
    h.embedder.failNext = new Error('ONNX session crashed');
    const source = h.writeSourceFile('resume.md', RESUME_MD);

    const [record] = await h.engine.importDocuments(profile.id, [source]);

    expect(record!.state).toBe('error');
    expect(record!.errorMessage).toMatch(/Embedding failed/);
    expect(existsSync(h.engine.store.chunksPath(profile.id, record!.id))).toBe(false);
    expect(existsSync(h.engine.store.vectorsPath(profile.id, record!.id))).toBe(false);
  });
});

describe('TC-069 and TC-070 the embedding cache', () => {
  it('a second ingest of an unchanged file performs zero embedding calls', async () => {
    const h = makeHarness();
    const profile = await withProfile(h);
    const source = h.writeSourceFile('resume.md', RESUME_MD);
    const [record] = await h.engine.importDocuments(profile.id, [source]);

    expect(h.embedder.embeddedCount).toBeGreaterThan(0);
    h.embedder.reset();

    await h.engine.processFile(profile.id, record!.originalPath);

    expect(h.embedder.calls).toEqual([]);
    expect(h.engine.store.findDocument(profile.id, record!.id)!.state).toBe('ready');
  });

  it('a changed file is re-embedded', async () => {
    const h = makeHarness();
    const profile = await withProfile(h);
    const source = h.writeSourceFile('resume.md', RESUME_MD);
    const [record] = await h.engine.importDocuments(profile.id, [source]);
    h.embedder.reset();

    writeFileSync(record!.originalPath, `${RESUME_MD}\n\n## Awards\nEmployee of the year.`);
    await h.engine.processFile(profile.id, record!.originalPath);

    expect(h.embedder.embeddedCount).toBeGreaterThan(0);
  });

  it('a different chunker version invalidates the cache with no manual purge', async () => {
    const h = makeHarness();
    const profile = await withProfile(h);
    const source = h.writeSourceFile('resume.md', RESUME_MD);
    const [record] = await h.engine.importDocuments(profile.id, [source]);

    // Simulate the bump: the stored key is what a previous chunker produced.
    const stale = h.engine.store.findDocument(profile.id, record!.id)!;
    h.engine.store.upsertDocument({
      ...stale,
      embeddingKey: stale.embeddingKey.replace(/:(\d+):/, ':0:'),
    });
    h.embedder.reset();

    await h.engine.processFile(profile.id, record!.originalPath);

    expect(h.embedder.embeddedCount).toBeGreaterThan(0);
    expect(h.engine.store.findDocument(profile.id, record!.id)!.embeddingKey).toBe(
      stale.embeddingKey,
    );
  });

  it('a ready record whose vectors are missing is re-embedded rather than trusted', async () => {
    const h = makeHarness();
    const profile = await withProfile(h);
    const source = h.writeSourceFile('resume.md', RESUME_MD);
    const [record] = await h.engine.importDocuments(profile.id, [source]);

    h.engine.store.deleteChunkSet(profile.id, record!.id);
    h.embedder.reset();

    await h.engine.processFile(profile.id, record!.originalPath);

    expect(h.embedder.embeddedCount).toBeGreaterThan(0);
    expect(h.engine.store.readChunkSet(profile.id, record!.id)).not.toBeNull();
  });
});

describe('TC-073, TC-074 and TC-149 doc-type override', () => {
  it('an override updates chunk metadata in place with zero embedding calls', async () => {
    const h = makeHarness();
    const profile = await withProfile(h);
    const source = h.writeSourceFile('untitled.md', RESUME_MD);
    const [record] = await h.engine.importDocuments(profile.id, [source]);
    expect(record!.docType).toBe('resume');
    expect(record!.docTypeSource).toBe('auto');

    const before = h.engine.store.readChunkSet(profile.id, record!.id)!;
    h.embedder.reset();

    const updated = await h.engine.setDocType(profile.id, record!.id, 'company-notes');

    expect(h.embedder.calls).toEqual([]);
    expect(updated!.docType).toBe('company-notes');
    expect(updated!.docTypeSource).toBe('user');
    const after = h.engine.store.readChunkSet(profile.id, record!.id)!;
    expect(after.chunks.every((c) => c.docType === 'company-notes')).toBe(true);
    // The vectors are untouched: doc type is metadata, not an embedding input.
    expect([...after.vectors]).toEqual([...before.vectors]);
  });

  it('a file change re-embeds but keeps the user override', async () => {
    const h = makeHarness();
    const profile = await withProfile(h);
    const source = h.writeSourceFile('untitled.md', RESUME_MD);
    const [record] = await h.engine.importDocuments(profile.id, [source]);
    await h.engine.setDocType(profile.id, record!.id, 'job-description');
    h.embedder.reset();

    writeFileSync(record!.originalPath, `${RESUME_MD}\n\n## Awards\nEmployee of the year.`);
    await h.engine.processFile(profile.id, record!.originalPath);

    const after = h.engine.store.findDocument(profile.id, record!.id)!;
    expect(h.embedder.embeddedCount).toBeGreaterThan(0);
    expect(after.state).toBe('ready');
    expect(after.docType).toBe('job-description');
    expect(after.docTypeSource).toBe('user');
    expect(chunksOf(h, profile.id, record!.id)!.every((c) => c.docType === 'job-description')).toBe(
      true,
    );
  });

  it('resetting to auto re-runs the guess without re-embedding', async () => {
    const h = makeHarness();
    const profile = await withProfile(h);
    const source = h.writeSourceFile('untitled.md', RESUME_MD);
    const [record] = await h.engine.importDocuments(profile.id, [source]);
    await h.engine.setDocType(profile.id, record!.id, 'job-description');
    h.embedder.reset();

    const reset = await h.engine.setDocType(profile.id, record!.id, 'auto');

    expect(h.embedder.calls).toEqual([]);
    expect(reset!.docTypeSource).toBe('auto');
    expect(reset!.docType).toBe('resume');
    expect(chunksOf(h, profile.id, record!.id)!.every((c) => c.docType === 'resume')).toBe(true);
  });

  it('a document in error retries from the Dashboard without re-import', async () => {
    const h = makeHarness();
    const profile = await withProfile(h);
    h.embedder.failNext = new Error('ONNX session crashed');
    const source = h.writeSourceFile('resume.md', RESUME_MD);
    const [record] = await h.engine.importDocuments(profile.id, [source]);
    expect(record!.state).toBe('error');

    const retried = await h.engine.retryDocument(profile.id, record!.id);

    expect(retried!.state).toBe('ready');
    expect(retried!.errorMessage).toBeNull();
    expect(retried!.id).toBe(record!.id);
    expect(h.engine.store.readChunkSet(profile.id, record!.id)).not.toBeNull();
  });

  it('setDocType and retryDocument return null for an unknown document', async () => {
    const h = makeHarness();
    const profile = await withProfile(h);

    expect(await h.engine.setDocType(profile.id, 'nope', 'resume')).toBeNull();
    expect(await h.engine.retryDocument(profile.id, 'nope')).toBeNull();
  });

  it('deleting a document removes its record, its files and the source in kb/', async () => {
    const h = makeHarness();
    const profile = await withProfile(h);
    const source = h.writeSourceFile('resume.md', RESUME_MD);
    const [record] = await h.engine.importDocuments(profile.id, [source]);

    await h.engine.deleteDocument(profile.id, record!.id);

    expect(h.engine.store.findDocument(profile.id, record!.id)).toBeNull();
    expect(existsSync(record!.originalPath)).toBe(false);
    expect(existsSync(h.engine.store.chunksPath(profile.id, record!.id))).toBe(false);
    expect(existsSync(h.engine.store.vectorsPath(profile.id, record!.id))).toBe(false);
  });
});

describe('races between an ingest and the user', () => {
  /** Hold the ingest inside the embed so a concurrent action lands mid-pipeline. */
  function holdAtEmbed(h: ReturnType<typeof makeHarness>): {
    atEmbed: Promise<void>;
    release: () => void;
  } {
    let reached = (): void => {};
    const atEmbed = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = h.embedder.embed.bind(h.embedder);
    h.embedder.embed = async (texts: string[]) => {
      reached();
      await held;
      return real(texts);
    };
    return { atEmbed, release };
  }

  it('keeps a doc-type override set while the document was still embedding', async () => {
    const h = makeHarness();
    const profile = await withProfile(h);
    const path = h.writeKbFile(profile.id, 'untitled.md', RESUME_MD);
    // Seed a record so the override has something to address mid-ingest.
    await h.engine.processFile(profile.id, path);
    const docId = h.engine.store.get(profile.id)!.documents[0]!.id;
    writeFileSync(path, `${RESUME_MD}\n\n## Awards\nEmployee of the year.`);

    const { atEmbed, release } = holdAtEmbed(h);
    const ingesting = h.engine.processFile(profile.id, path);
    await atEmbed;
    await h.engine.setDocType(profile.id, docId, 'job-description');
    release();
    await ingesting;

    // The ingest published from a snapshot taken before three awaits, so the
    // override silently reverted to the guess and the chunk metadata with it.
    const after = h.engine.store.findDocument(profile.id, docId)!;
    expect(after.docTypeSource).toBe('user');
    expect(after.docType).toBe('job-description');
    expect(after.state).toBe('ready');
    expect(chunksOf(h, profile.id, docId)!.every((c) => c.docType === 'job-description')).toBe(
      true,
    );
  });

  it('does not resurrect a document deleted during its FIRST ingest', async () => {
    const h = makeHarness();
    const profile = await withProfile(h);
    const path = h.writeKbFile(profile.id, 'a.md', RESUME_MD);

    // No prior record, so the pipeline's pre-await snapshot is null. Gating the
    // cancel on that snapshot meant a first ingest could not be cancelled at
    // all: the document came back `ready`, with its kb/ file gone and its chunks
    // queryable (FR-077).
    const { atEmbed, release } = holdAtEmbed(h);
    const ingesting = h.engine.processFile(profile.id, path);
    await atEmbed;
    const docId = h.engine.store.get(profile.id)!.documents[0]!.id;
    await h.engine.deleteDocument(profile.id, docId);
    release();
    await ingesting;

    expect(h.engine.store.get(profile.id)!.documents).toEqual([]);
    expect(existsSync(path)).toBe(false);
    expect(await h.engine.query(profile.id, 'Acme Corp', 5)).toEqual([]);
  });

  it('does not resurrect a document deleted while it was embedding', async () => {
    const h = makeHarness();
    const profile = await withProfile(h);
    const path = h.writeKbFile(profile.id, 'a.md', RESUME_MD);
    await h.engine.processFile(profile.id, path);
    const docId = h.engine.store.get(profile.id)!.documents[0]!.id;
    writeFileSync(path, `${RESUME_MD}\n\n## Extra\nMore.`);

    const { atEmbed, release } = holdAtEmbed(h);
    const ingesting = h.engine.processFile(profile.id, path);
    await atEmbed;
    await h.engine.deleteDocument(profile.id, docId);
    release();
    await ingesting;

    // It came back as `ready` with no file behind it, and its chunks were served.
    expect(h.engine.store.findDocument(profile.id, docId)).toBeNull();
    expect(h.engine.store.get(profile.id)!.documents).toEqual([]);
    expect(await h.engine.query(profile.id, 'Acme Corp', 3)).toEqual([]);
  });

  it('setDocType does not write back a record that changed while it read', async () => {
    const h = makeHarness();
    const profile = await withProfile(h);
    const path = h.writeKbFile(profile.id, 'a.md', RESUME_MD);
    await h.engine.processFile(profile.id, path);
    const docId = h.engine.store.get(profile.id)!.documents[0]!.id;
    const ready = h.engine.store.findDocument(profile.id, docId)!;

    // The document is mid-ingest when the user picks "Auto", and the ingest
    // finishes during the await inside setDocType. `upsertDocument` replaces the
    // whole record, so writing back the copy read before that await sent a ready
    // document back to `embedding` with chunkCount 0, where it span forever.
    h.engine.store.upsertDocument({
      ...ready,
      state: 'embedding',
      chunkCount: 0,
      embeddingKey: '',
    });

    const realFind = h.engine.store.findDocument.bind(h.engine.store);
    let reads = 0;
    h.engine.store.findDocument = (p: string, d: string) => {
      const result = realFind(p, d);
      reads += 1;
      // After setDocType's first read, the held ingest publishes `ready`.
      if (reads === 1) h.engine.store.upsertDocument(ready);
      return result;
    };

    await h.engine.setDocType(profile.id, docId, 'auto');
    h.engine.store.findDocument = realFind;

    const after = h.engine.store.findDocument(profile.id, docId)!;
    expect(after.state).toBe('ready');
    expect(after.chunkCount).toBe(ready.chunkCount);
    expect(after.embeddingKey).toBe(ready.embeddingKey);
    expect(after.docTypeSource).toBe('auto');
  });

  it('does not re-guess a doc type from a binary it cannot read as text', async () => {
    const h = makeHarness();
    const profile = await withProfile(h);
    const source = h.writeSourceFile('scan.pdf', Buffer.from('%PDF-1.4\nnot a pdf'));
    const [record] = await h.engine.importDocuments(profile.id, [source]);
    expect(record!.state).toBe('error');
    expect(record!.derivedMarkdownPath).toBeNull();

    // Falling back to originalPath fed raw PDF bytes to the guesser as UTF-8.
    const reset = await h.engine.setDocType(profile.id, record!.id, 'auto');
    expect(reset!.docTypeSource).toBe('auto');
    expect(reset!.docType).toBe(record!.docType);
  }, 30000);
});

describe('one bad file never aborts a batch or a launch', () => {
  it('an import continues past a file whose write fails', async () => {
    const h = makeHarness();
    const profile = await withProfile(h);
    const sources = [
      h.writeSourceFile('a.md', RESUME_MD),
      h.writeSourceFile('b.md', NOTES_MD),
      h.writeSourceFile('c.md', RESUME_MD),
    ];

    // `publish` and `writeChunkSet` sit outside the pipeline's own try blocks, so
    // an ENOSPC or an antivirus lock on a .tmp rejected out of importDocuments
    // and every later file got no record at all (TC-063).
    const realWrite = h.engine.store.writeChunkSet.bind(h.engine.store);
    let calls = 0;
    h.engine.store.writeChunkSet = ((...args: Parameters<typeof realWrite>) => {
      calls += 1;
      if (calls === 2) throw new Error('ENOSPC: no space left on device');
      return realWrite(...args);
    }) as typeof realWrite;

    const records = await h.engine.importDocuments(profile.id, sources);

    expect(records).toHaveLength(3);
    expect(records[0]!.state).toBe('ready');
    expect(records[1]!.state).toBe('error');
    expect(records[2]!.state).toBe('ready');
  });

  it('reconcile skips an entry it cannot stat rather than rejecting', async () => {
    const h = makeHarness();
    const profile = await withProfile(h);
    h.writeKbFile(profile.id, 'good.md', RESUME_MD);
    // A dangling symlink, which a knowledge base folder on a removable drive
    // really produces. Unguarded, its ENOENT rejected out of reconcile and out
    // of start, so bootstrap never registered window-all-closed or will-quit.
    symlinkSync(join(h.dir, 'nowhere.md'), join(h.engine.store.kbDir(profile.id), 'dangling.md'));

    await expect(h.engine.start()).resolves.toBeUndefined();

    const documents = h.engine.store.get(profile.id)!.documents;
    expect(documents).toHaveLength(1);
    expect(documents[0]!.originalFileName).toBe('good.md');
  });

  it('a profile is still created when its watcher cannot start', async () => {
    const h = makeHarness({
      watcherFactory: () => {
        throw new Error('ENOSPC: System limit for number of file watchers reached');
      },
    });

    // Rejecting here returned "The request failed." while the profile existed,
    // so the user clicked Create again and got a duplicate.
    const profile = await h.engine.createProfile('Acme');
    expect(h.engine.listProfiles().map((p) => p.id)).toEqual([profile.id]);
  });
});

describe('CH-213 ingest progress', () => {
  it('reports converting, embedding and ready in order for one document', async () => {
    const h = makeHarness();
    const profile = await withProfile(h);
    const source = h.writeSourceFile('resume.md', RESUME_MD);

    await h.engine.importDocuments(profile.id, [source]);

    const states = h.progress.map((p) => p.state);
    expect(states).toEqual(['converting', 'embedding', 'ready']);
    expect(h.progress.map((p) => p.percent)).toEqual([25, 60, 100]);
  });
});
