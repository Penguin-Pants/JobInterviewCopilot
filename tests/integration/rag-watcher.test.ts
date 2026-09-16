import { readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeHarness, NOTES_MD, RESUME_MD, type Harness } from '../fakes/rag-harness.js';
import { KB_CEILING } from '../../src/shared/defaults.js';
import { withinReembedCeiling } from '../../src/main/rag.js';

/**
 * TASK-025. TC-079 watcher behavior, TC-140 adoption and reconciliation,
 * TC-141 chunk and vector integrity, TC-163 the bounded re-embed SLA.
 *
 * The watcher is driven by hand rather than by chokidar. What these cases assert
 * is what the engine does with an event, not whether chokidar reports one; the
 * debounce and the coalescing are unit-tested with fake timers in
 * `tests/unit/ingest-queue.test.ts`.
 */

/** Emit a file event into the engine's watcher for a profile and wait for it to settle. */
async function fire(
  h: Harness,
  profileId: string,
  kind: 'add' | 'change' | 'unlink',
  path: string,
): Promise<void> {
  const watcher = h.watchers.get(h.engine.store.kbDir(profileId));
  if (!watcher) throw new Error(`No watcher for profile ${profileId}.`);
  watcher.emit(kind, path);
  await h.engine.drain();
}

describe('TC-079 watcher behavior', () => {
  it('an add adopts the file and makes it queryable', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const path = h.writeKbFile(profile.id, 'dropped.md', NOTES_MD);

    await fire(h, profile.id, 'add', path);

    const documents = h.engine.store.get(profile.id)!.documents;
    expect(documents).toHaveLength(1);
    expect(documents[0]!.state).toBe('ready');
    expect((await h.engine.query(profile.id, 'competitors Berlin', 3)).length).toBeGreaterThan(0);
  });

  it('a change re-processes only that file', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const a = h.writeKbFile(profile.id, 'a.md', RESUME_MD);
    const b = h.writeKbFile(profile.id, 'b.md', NOTES_MD);
    await fire(h, profile.id, 'add', a);
    await fire(h, profile.id, 'add', b);
    h.embedder.reset();

    writeFileSync(a, `${RESUME_MD}\n\n## Awards\nEmployee of the year.`);
    await fire(h, profile.id, 'change', a);

    // Every embedded text belongs to a.md's new content, so b.md was untouched.
    expect(h.embedder.embeddedCount).toBeGreaterThan(0);
    expect(h.embedder.calls.flat().some((t) => t.includes('Employee of the year'))).toBe(true);
    expect(h.embedder.calls.flat().some((t) => t.includes('Series B'))).toBe(false);
  });

  it('a delete removes the record, the chunks and the vectors', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const path = h.writeKbFile(profile.id, 'a.md', RESUME_MD);
    await fire(h, profile.id, 'add', path);
    const docId = h.engine.store.get(profile.id)!.documents[0]!.id;

    rmSync(path);
    await fire(h, profile.id, 'unlink', path);

    expect(h.engine.store.get(profile.id)!.documents).toEqual([]);
    expect(h.engine.store.readChunkSet(profile.id, docId)).toBeNull();
    expect(await h.engine.query(profile.id, 'Acme Corp', 3)).toEqual([]);
  });

  it('a file with an unsupported extension is ignored, not errored', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const path = h.writeKbFile(profile.id, 'photo.png', 'not a document');

    await fire(h, profile.id, 'add', path);

    expect(h.engine.store.get(profile.id)!.documents).toEqual([]);
  });

  it('an add for a file that has already vanished does not create a record', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const path = h.writeKbFile(profile.id, 'gone.md', RESUME_MD);
    rmSync(path);

    await fire(h, profile.id, 'add', path);

    expect(h.engine.store.get(profile.id)!.documents).toEqual([]);
  });
});

describe('one file, one document record', () => {
  it('two concurrent ingests of one path produce one record, not two', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const path = h.writeKbFile(profile.id, 'a.md', RESUME_MD);

    // `importDocuments` and `reconcile` call `processFile` directly, so the
    // queue's per-path serialization does not cover them. Before the in-flight
    // guard this produced two records with two uuids for one file, and the query
    // returned every chunk twice.
    await Promise.all([
      h.engine.processFile(profile.id, path),
      h.engine.processFile(profile.id, path),
    ]);

    const documents = h.engine.store.get(profile.id)!.documents;
    expect(documents).toHaveLength(1);

    const hits = await h.engine.query(profile.id, 'Acme Corp billing pipeline', 10);
    expect(new Set(hits.map((r) => r.chunk.id)).size).toBe(hits.length);
  });

  it('stays at one record at three-way concurrency', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const path = h.writeKbFile(profile.id, 'a.md', RESUME_MD);

    // Two callers that merely awaited the same in-flight run would then both
    // start, so the third concurrent caller brought the race back.
    await Promise.all([
      h.engine.processFile(profile.id, path),
      h.engine.processFile(profile.id, path),
      h.engine.processFile(profile.id, path),
    ]);

    expect(h.engine.store.get(profile.id)!.documents).toHaveLength(1);
  });

  it('an import racing the watcher event for the same file stays at one record', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const source = h.writeSourceFile('resume.md', RESUME_MD);

    const importing = h.engine.importDocuments(profile.id, [source]);
    // The watcher sees the copy land while the import is still embedding.
    const watcher = h.watchers.get(h.engine.store.kbDir(profile.id))!;
    watcher.emit('add', join(h.engine.store.kbDir(profile.id), 'resume.md'));

    await importing;
    await h.engine.drain();

    expect(h.engine.store.get(profile.id)!.documents).toHaveLength(1);
  });

  it('a second ingest after the first finishes is still a cache hit', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const path = h.writeKbFile(profile.id, 'a.md', RESUME_MD);

    await h.engine.processFile(profile.id, path);
    h.embedder.reset();
    await h.engine.processFile(profile.id, path);

    expect(h.embedder.calls).toEqual([]);
  });
});

describe('TC-140 adoption and reconciliation', () => {
  it('adopts a file copied into kb/ outside doc:import', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    h.writeKbFile(profile.id, 'dropped-by-explorer.md', RESUME_MD);

    await h.engine.start();

    const documents = h.engine.store.get(profile.id)!.documents;
    expect(documents).toHaveLength(1);
    expect(documents[0]!.originalFileName).toBe('dropped-by-explorer.md');
    expect(documents[0]!.docType).toBe('resume'); // auto-tagged
    expect(documents[0]!.state).toBe('ready'); // embedded
    expect(h.engine.store.readChunkSet(profile.id, documents[0]!.id)).not.toBeNull();
  });

  it('resets a document left in converting or embedding to pending and re-processes it', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const path = h.writeKbFile(profile.id, 'a.md', RESUME_MD);
    await fire(h, profile.id, 'add', path);
    const record = h.engine.store.get(profile.id)!.documents[0]!;

    for (const stuck of ['converting', 'embedding', 'pending'] as const) {
      h.engine.store.upsertDocument({ ...record, state: stuck });
      h.embedder.reset();

      await h.engine.reconcile(profile.id);

      const after = h.engine.store.findDocument(profile.id, record.id)!;
      expect(after.state, `recovering from ${stuck}`).toBe('ready');
      expect(h.embedder.embeddedCount, `recovering from ${stuck}`).toBeGreaterThan(0);
    }
  });

  it('drops a record whose file is gone', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const path = h.writeKbFile(profile.id, 'a.md', RESUME_MD);
    await fire(h, profile.id, 'add', path);
    rmSync(path);

    await h.engine.reconcile(profile.id);

    expect(h.engine.store.get(profile.id)!.documents).toEqual([]);
  });

  it('leaves a ready document alone, so a relaunch costs no embedding calls', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    h.writeKbFile(profile.id, 'a.md', RESUME_MD);
    await h.engine.start();
    h.embedder.reset();

    await h.engine.reconcile(profile.id);

    expect(h.embedder.calls).toEqual([]);
  });

  it('leaves a document in error alone until the user retries it (FR-079)', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    h.embedder.failNext = new Error('ONNX session crashed');
    const path = h.writeKbFile(profile.id, 'a.md', RESUME_MD);
    await fire(h, profile.id, 'add', path);
    const docId = h.engine.store.get(profile.id)!.documents[0]!.id;
    h.embedder.reset();

    await h.engine.reconcile(profile.id);

    expect(h.engine.store.findDocument(profile.id, docId)!.state).toBe('error');
    expect(h.embedder.calls).toEqual([]);
  });
});

describe('path matching survives a differently spelled path (FR-077, FR-078)', () => {
  it('a watcher event with a non-normalized path finds the existing record', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const kb = h.engine.store.kbDir(profile.id);
    h.writeKbFile(profile.id, 'a.md', RESUME_MD);
    await fire(h, profile.id, 'add', join(kb, 'a.md'));
    const docId = h.engine.store.get(profile.id)!.documents[0]!.id;

    // The same file named through a redundant segment. A strict string compare
    // reads this as a different file and mints a second record.
    await fire(h, profile.id, 'change', join(kb, '.', 'sub', '..', 'a.md'));

    const documents = h.engine.store.get(profile.id)!.documents;
    expect(documents).toHaveLength(1);
    expect(documents[0]!.id).toBe(docId);
  });

  it('reconcile keeps a record whose stored path is spelled differently', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const kb = h.engine.store.kbDir(profile.id);
    h.writeKbFile(profile.id, 'a.md', RESUME_MD);
    await fire(h, profile.id, 'add', join(kb, 'a.md'));

    const record = h.engine.store.get(profile.id)!.documents[0]!;
    h.engine.store.upsertDocument({
      ...record,
      originalPath: join(kb, '.', 'a.md'),
    });
    h.embedder.reset();

    await h.engine.reconcile(profile.id);

    // Dropping the record here would re-adopt the file and re-embed the whole
    // knowledge base on every launch.
    expect(h.engine.store.get(profile.id)!.documents).toHaveLength(1);
    expect(h.engine.store.get(profile.id)!.documents[0]!.id).toBe(record.id);
    expect(h.embedder.calls).toEqual([]);
  });
});

describe('FR-067 reconciliation revalidates what it trusts', () => {
  it('re-embeds a file edited while the app was not running', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const path = h.writeKbFile(profile.id, 'a.md', '# A\n\noriginal widgets content');
    await fire(h, profile.id, 'add', path);

    // The app is closed, the file is edited, the app relaunches. The watcher
    // starts with `ignoreInitial`, so reconciliation is the only thing that can
    // notice: skipping `ready` because its chunk pair merely loads trusted the
    // bytes without ever comparing them, and the pre-edit chunks were served
    // for the rest of the process.
    writeFileSync(path, '# A\n\nreplaced sprockets content');
    h.embedder.reset();
    await h.engine.reconcile(profile.id);

    expect(h.embedder.embeddedCount).toBeGreaterThan(0);
    const hits = await h.engine.query(profile.id, 'sprockets', 3);
    expect(hits.some((r) => r.chunk.text.includes('sprockets'))).toBe(true);
    expect(
      (await h.engine.query(profile.id, 'widgets', 3)).some((r) =>
        r.chunk.text.includes('widgets'),
      ),
    ).toBe(false);
  });

  it('a relaunch over unchanged files still costs zero embedding calls (FR-067)', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    h.writeKbFile(profile.id, 'a.md', RESUME_MD);
    h.writeKbFile(profile.id, 'b.md', NOTES_MD);
    await h.engine.start();
    h.embedder.reset();

    await h.engine.reconcile(profile.id);

    // Revalidating costs one read and one hash per document, never an embed.
    expect(h.embedder.calls).toEqual([]);
  });

  it('a chunker or model change still invalidates on relaunch (TC-070)', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const path = h.writeKbFile(profile.id, 'a.md', RESUME_MD);
    await fire(h, profile.id, 'add', path);

    const stale = h.engine.store.get(profile.id)!.documents[0]!;
    h.engine.store.upsertDocument({
      ...stale,
      embeddingKey: stale.embeddingKey.replace(/:(\d+):/, ':0:'),
    });
    h.embedder.reset();

    await h.engine.reconcile(profile.id);

    expect(h.embedder.embeddedCount).toBeGreaterThan(0);
    expect(h.engine.store.findDocument(profile.id, stale.id)!.embeddingKey).toBe(
      stale.embeddingKey,
    );
  });

  it('keeps a record whose file could not be stat-ed, rather than deleting it', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const path = h.writeKbFile(profile.id, 'a.md', RESUME_MD);
    await fire(h, profile.id, 'add', path);
    const docId = h.engine.store.get(profile.id)!.documents[0]!.id;

    // A self-referential symlink: `readdir` still lists it, `stat` fails ELOOP.
    // A real non-ENOENT failure, which is what an EACCES file or an
    // antivirus-locked one looks like from here. Treating it as a deletion
    // removed the record, chunks, vectors and derived Markdown, and the
    // watcher's `ignoreInitial` meant a file that was still there might never
    // come back for the rest of the process.
    rmSync(path);
    symlinkSync('a.md', path);

    await h.engine.reconcile(profile.id);

    expect(h.engine.store.findDocument(profile.id, docId)).not.toBeNull();
    expect(h.engine.store.readChunkSet(profile.id, docId)).not.toBeNull();
  });

  it('still removes a record whose file is genuinely gone', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const path = h.writeKbFile(profile.id, 'a.md', RESUME_MD);
    await fire(h, profile.id, 'add', path);
    const docId = h.engine.store.get(profile.id)!.documents[0]!.id;

    // ENOENT is the one answer that really does mean deleted (FR-077).
    rmSync(path);
    await h.engine.reconcile(profile.id);

    expect(h.engine.store.findDocument(profile.id, docId)).toBeNull();
    expect(h.engine.store.readChunkSet(profile.id, docId)).toBeNull();
  });
});

describe('TC-141 chunk and vector integrity', () => {
  it('a vectors.bin whose row count disagrees discards both and re-embeds', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const path = h.writeKbFile(profile.id, 'a.md', RESUME_MD);
    await fire(h, profile.id, 'add', path);
    const record = h.engine.store.get(profile.id)!.documents[0]!;
    expect(record.chunkCount).toBeGreaterThan(1);

    // Truncate the vector file by one row, as a torn write would.
    const vectorsPath = h.engine.store.vectorsPath(profile.id, record.id);
    const stride = h.embedder.info().dimensions * Float32Array.BYTES_PER_ELEMENT;
    const { readFileSync } = await import('node:fs');
    const bytes = readFileSync(vectorsPath);
    writeFileSync(vectorsPath, bytes.subarray(0, bytes.byteLength - stride));

    expect(h.engine.store.readChunkSet(profile.id, record.id)).toBeNull();

    h.embedder.reset();
    await h.engine.reconcile(profile.id);

    expect(h.embedder.embeddedCount).toBeGreaterThan(0);
    const repaired = h.engine.store.readChunkSet(profile.id, record.id)!;
    expect(repaired.chunks).toHaveLength(record.chunkCount);
    expect(repaired.vectors).toHaveLength(record.chunkCount * h.embedder.info().dimensions);
  });

  it('serves no partial result from query while the pair is torn', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const path = h.writeKbFile(profile.id, 'a.md', RESUME_MD);
    await fire(h, profile.id, 'add', path);
    const record = h.engine.store.get(profile.id)!.documents[0]!;

    const { readFileSync } = await import('node:fs');
    const vectorsPath = h.engine.store.vectorsPath(profile.id, record.id);
    writeFileSync(vectorsPath, readFileSync(vectorsPath).subarray(0, 16));

    // A fresh engine over the same directory, so nothing is served from the cache.
    const fresh = makeHarness({ userDataDir: h.dir }, h.embedder);
    expect(await fresh.engine.query(profile.id, 'Acme Corp', 3)).toEqual([]);
  });

  it('an unparseable chunks.json is treated as a torn pair, not as a crash', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const path = h.writeKbFile(profile.id, 'a.md', RESUME_MD);
    await fire(h, profile.id, 'add', path);
    const record = h.engine.store.get(profile.id)!.documents[0]!;

    writeFileSync(h.engine.store.chunksPath(profile.id, record.id), '{ not json');

    expect(h.engine.store.readChunkSet(profile.id, record.id)).toBeNull();
    await h.engine.reconcile(profile.id);
    expect(h.engine.store.readChunkSet(profile.id, record.id)).not.toBeNull();
  });

  it('refuses to write a pair whose counts already disagree', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const chunks = [
      {
        id: 'd#0',
        docId: 'd',
        profileId: profile.id,
        index: 0,
        text: 'x',
        headerPath: [],
        docType: 'resume' as const,
        sourceFile: 'a.md',
        tokenCount: 1,
      },
    ];

    expect(() =>
      h.engine.store.writeChunkSet(profile.id, 'd', chunks, new Float32Array(3)),
    ).toThrow(/Refusing to write/);
  });

  it('leaves no .tmp files behind after a successful write', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const path = h.writeKbFile(profile.id, 'a.md', RESUME_MD);
    await fire(h, profile.id, 'add', path);

    const { readdirSync } = await import('node:fs');
    expect(
      readdirSync(h.engine.store.derivedDir(profile.id)).filter((n) => n.endsWith('.tmp')),
    ).toEqual([]);
  });
});

describe('TC-141 a torn pair the row count cannot see', () => {
  it('discards a chunks.json paired with the previous vectors.bin', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const path = h.writeKbFile(profile.id, 'a.md', '# A\n\nalpha\n\n# B\n\nbravo');
    await fire(h, profile.id, 'add', path);
    const record = h.engine.store.get(profile.id)!.documents[0]!;
    const vectorsBefore = readFileSync(h.engine.store.vectorsPath(profile.id, record.id));

    // An edit that keeps the chunk count. The user fixes a typo and saves.
    writeFileSync(path, '# A\n\nalphaa\n\n# B\n\nbravo');
    await fire(h, profile.id, 'change', path);
    const after = h.engine.store.get(profile.id)!.documents[0]!;
    expect(after.chunkCount).toBe(record.chunkCount);

    // A crash between the two renames: new chunks.json, old vectors.bin. The row
    // counts agree, so a size check sees nothing and retrieval would rank the new
    // text by the old text's vectors, forever, with no error anywhere.
    writeFileSync(h.engine.store.vectorsPath(profile.id, record.id), vectorsBefore);

    expect(h.engine.store.readChunkSet(profile.id, record.id)).toBeNull();

    h.embedder.reset();
    await h.engine.reconcile(profile.id);
    expect(h.embedder.embeddedCount).toBeGreaterThan(0);
    expect(h.engine.store.readChunkSet(profile.id, record.id)).not.toBeNull();
  });

  it('discards a chunks.json whose rows are not chunks', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const path = h.writeKbFile(profile.id, 'a.md', RESUME_MD);
    await fire(h, profile.id, 'add', path);
    const record = h.engine.store.get(profile.id)!.documents[0]!;

    // Valid JSON, an array, the right length: it passed both old checks, and the
    // first query then threw a TypeError out of `query` onto the IPC path.
    writeFileSync(
      h.engine.store.chunksPath(profile.id, record.id),
      JSON.stringify({ pairId: 'x'.repeat(32), chunks: [1, 2, 3] }),
    );

    expect(h.engine.store.readChunkSet(profile.id, record.id)).toBeNull();
    const fresh = makeHarness({ userDataDir: h.dir }, h.embedder);
    await expect(fresh.engine.query(profile.id, 'Acme Corp', 3)).resolves.toEqual([]);
  });

  it('leaves no orphaned .tmp behind when the second write fails', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const chunks = [
      {
        id: 'd#0',
        docId: 'd',
        profileId: profile.id,
        index: 0,
        text: 'x',
        headerPath: ['A'],
        docType: 'resume' as const,
        sourceFile: 'a.md',
        tokenCount: 1,
      },
    ];
    const vectors = new Float32Array(h.embedder.info().dimensions);
    // A Float32Array whose buffer is detached makes the Buffer.from throw part
    // way through, after the chunks temp file already exists.
    const doomed = new Float32Array(new ArrayBuffer(vectors.byteLength));
    structuredClone(doomed.buffer, { transfer: [doomed.buffer] });

    expect(() =>
      h.engine.store.writeChunkSet(
        profile.id,
        '11111111-2222-4333-8444-555555555555',
        chunks,
        doomed,
      ),
    ).toThrow();
    expect(
      readdirSync(h.engine.store.derivedDir(profile.id)).filter((n) => n.endsWith('.tmp')),
    ).toEqual([]);
  });
});

describe('TC-163 the re-embed SLA is bounded', () => {
  it('a document within the ceiling is queryable after the event settles', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const path = h.writeKbFile(profile.id, 'a.md', RESUME_MD);

    const started = Date.now();
    await fire(h, profile.id, 'add', path);
    const elapsed = Date.now() - started;

    const record = h.engine.store.get(profile.id)!.documents[0]!;
    expect(withinReembedCeiling(RESUME_MD.length, record.chunkCount)).toBe(true);
    expect((await h.engine.query(profile.id, 'Acme Corp', 3)).length).toBeGreaterThan(0);
    // The real budget is 5 s of wall clock with a real model; with the fake
    // embedder this only proves the pipeline does not sit on the event.
    expect(elapsed).toBeLessThan(KB_CEILING.reembedTargetMs);
  });

  it('a document above the ceiling still completes and still reports progress', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    // Well past the 200-chunk half of the ceiling.
    const sections = Array.from(
      { length: 400 },
      (_, i) => `# Section ${i}\n\nBody paragraph number ${i} about a topic.`,
    );
    const path = h.writeKbFile(profile.id, 'big.md', sections.join('\n\n'));

    await fire(h, profile.id, 'add', path);

    const record = h.engine.store.get(profile.id)!.documents[0]!;
    expect(record.state).toBe('ready');
    expect(record.chunkCount).toBeGreaterThan(KB_CEILING.maxChunks);
    expect(withinReembedCeiling(sections.join('\n\n').length, record.chunkCount)).toBe(false);
    expect(h.progress.filter((p) => p.docId === record.id).map((p) => p.state)).toEqual([
      'converting',
      'embedding',
      'ready',
    ]);
  });

  it('the ceiling constants are the ones FR-068 names', () => {
    expect(KB_CEILING.maxBytes).toBe(2 * 1024 * 1024);
    expect(KB_CEILING.maxChunks).toBe(200);
    expect(KB_CEILING.reembedTargetMs).toBe(5000);
    expect(withinReembedCeiling(KB_CEILING.maxBytes, KB_CEILING.maxChunks)).toBe(true);
    expect(withinReembedCeiling(KB_CEILING.maxBytes + 1, KB_CEILING.maxChunks)).toBe(false);
    expect(withinReembedCeiling(KB_CEILING.maxBytes, KB_CEILING.maxChunks + 1)).toBe(false);
  });
});
