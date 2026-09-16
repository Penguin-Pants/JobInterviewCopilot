import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RagEngine, RetrievalUnavailableError } from '../../src/main/rag.js';
import { modelDirectoryFor, XenovaEmbedder } from '../../src/main/rag/embed.js';
import { EMBEDDING_MODEL } from '../../src/shared/registry/embedding.js';
import { FakeEmbedder } from '../fakes/embedder.js';
import { makeHarness, RESUME_MD } from '../fakes/rag-harness.js';

/**
 * TASK-022. TC-161 fresh install with no network and no model, and the
 * ingestion-blocking half of TC-071.
 *
 * Neither case touches the network. `XenovaEmbedder` is constructed with
 * `allowDownload: false`, which is what a machine with no network amounts to
 * from the engine's point of view, and what keeps this suite deterministic.
 */

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'icp-model-'));
}

describe('TC-161 fresh install, no network, no model', () => {
  it('starts and manages profiles with no model present', async () => {
    const dir = tmp();
    const engine = new RagEngine({
      userDataDir: dir,
      embedder: new XenovaEmbedder({ modelsRoot: join(dir, 'models'), allowDownload: false }),
      watcherFactory: () => ({ on: () => ({}) as never, close: async () => {} }),
    });

    const profile = await engine.createProfile('Acme');
    expect(engine.listProfiles().map((p) => p.name)).toEqual(['Acme']);
    await engine.deleteProfile(profile.id);
    expect(engine.listProfiles()).toEqual([]);
  });

  it('reports not-downloaded, then unavailable with a reason and no hang', async () => {
    const dir = tmp();
    const states: unknown[] = [];
    const engine = new RagEngine({
      userDataDir: dir,
      embedder: new XenovaEmbedder({ modelsRoot: join(dir, 'models'), allowDownload: false }),
      watcherFactory: () => ({ on: () => ({}) as never, close: async () => {} }),
      onModelState: (state) => states.push(state),
    });

    expect(engine.getModelState()).toEqual({ kind: 'not-downloaded' });

    const result = await engine.ensureModelReady();

    expect(result.kind).toBe('unavailable');
    expect(result).toMatchObject({ reason: expect.stringMatching(/not downloaded/i) });
    // The Dashboard sees the attempt and then the named failure, so it can show
    // a sentence and a retry rather than a spinner (ADR-026).
    expect(states.map((s) => (s as { kind: string }).kind)).toEqual(['downloading', 'unavailable']);
  });

  it('the retry action gets a real second attempt, not the first failure cached', async () => {
    const dir = tmp();
    const embedder = new XenovaEmbedder({
      modelsRoot: join(dir, 'models'),
      allowDownload: false,
    });
    const engine = new RagEngine({
      userDataDir: dir,
      embedder,
      watcherFactory: () => ({ on: () => ({}) as never, close: async () => {} }),
    });

    expect((await engine.ensureModelReady()).kind).toBe('unavailable');
    expect((await engine.ensureModelReady()).kind).toBe('unavailable');

    // The memoized load promise was cleared, so a later attempt is a real one.
    await expect(embedder.load()).rejects.toThrow(/not downloaded/i);
  });

  it('reads as ready once the model is cached on disk (ADR-026)', () => {
    const dir = tmp();
    const modelsRoot = join(dir, 'models');
    const modelDir = modelDirectoryFor(modelsRoot, EMBEDDING_MODEL.id);
    mkdirSync(join(modelDir, 'onnx'), { recursive: true });
    writeFileSync(join(modelDir, 'tokenizer.json'), '{}');
    writeFileSync(join(modelDir, 'onnx', 'model_quantized.onnx'), 'weights');

    const engine = new RagEngine({
      userDataDir: dir,
      embedder: new XenovaEmbedder({ modelsRoot, allowDownload: false }),
      watcherFactory: () => ({ on: () => ({}) as never, close: async () => {} }),
    });

    expect(engine.getModelState()).toEqual({ kind: 'ready' });
  });

  it('countTokens refuses before the model is loaded rather than guessing', () => {
    const dir = tmp();
    const embedder = new XenovaEmbedder({ modelsRoot: join(dir, 'models'), allowDownload: false });
    expect(() => embedder.countTokens('word')).toThrow(/not loaded/i);
  });
});

describe('TC-071 ingestion is blocked until the model is ready', () => {
  it('a document stays pending, not error, while the model is unavailable', async () => {
    const embedder = new FakeEmbedder();
    embedder.ready = false;
    embedder.unavailableReason = 'The embedding model is not downloaded.';
    const h = makeHarness({}, embedder);
    const profile = await h.engine.createProfile('Acme');

    const [record] = await h.engine.importDocuments(profile.id, [
      h.writeSourceFile('resume.md', RESUME_MD),
    ]);

    // Pending and not error: the document is waiting on the model, and the next
    // reconciliation pass picks it up once the model arrives (ADR-011, FR-078).
    expect(record!.state).toBe('pending');
    expect(record!.errorMessage).toBeNull();
    expect(embedder.calls).toEqual([]);
    expect(h.engine.getModelState().kind).toBe('unavailable');
  });

  it('the blocked document is ingested once the model becomes available', async () => {
    const embedder = new FakeEmbedder();
    embedder.ready = false;
    embedder.unavailableReason = 'The embedding model is not downloaded.';
    const h = makeHarness({}, embedder);
    const profile = await h.engine.createProfile('Acme');
    const [record] = await h.engine.importDocuments(profile.id, [
      h.writeSourceFile('resume.md', RESUME_MD),
    ]);
    expect(record!.state).toBe('pending');

    // The user fixes the network and clicks Retry. A reconciliation on its own
    // deliberately does not retry the model any more: an automatic retry made
    // an offline five-file import attempt five full downloads and left
    // `doc:import` unresolved through every one of them.
    embedder.unavailableReason = null;
    expect((await h.engine.ensureModelReady({ userInitiated: true })).kind).toBe('ready');
    await h.engine.reconcile(profile.id);

    const after = h.engine.store.findDocument(profile.id, record!.id)!;
    expect(after.state).toBe('ready');
    expect(h.engine.getModelState()).toEqual({ kind: 'ready' });
    expect((await h.engine.query(profile.id, 'Acme Corp billing', 3)).length).toBeGreaterThan(0);
  });

  it('an offline import of five files makes one download attempt, not five', async () => {
    const embedder = new FakeEmbedder();
    embedder.ready = false;
    embedder.unavailableReason = 'The embedding model is not downloaded.';
    const h = makeHarness({}, embedder);
    const profile = await h.engine.createProfile('Acme');
    const sources = Array.from({ length: 5 }, (_, i) =>
      h.writeSourceFile(`doc-${i}.md`, RESUME_MD),
    );

    const records = await h.engine.importDocuments(profile.id, sources);

    expect(records).toHaveLength(5);
    expect(records.every((r) => r.state === 'pending')).toBe(true);
    // Each attempt waits out the library's own network timeout with doc:import
    // unresolved, which is the hang NFR-008 and ADR-026 forbid.
    expect(embedder.ensureReadyCalls).toBe(1);
    // And CH-214 does not flap downloading/unavailable once per file.
    expect(h.modelStates.map((s) => (s as { kind: string }).kind)).toEqual([
      'downloading',
      'unavailable',
    ]);
  });

  it('a user-initiated retry gets a real attempt after a terminal failure', async () => {
    const embedder = new FakeEmbedder();
    embedder.ready = false;
    embedder.unavailableReason = 'offline';
    const h = makeHarness({}, embedder);

    expect((await h.engine.ensureModelReady()).kind).toBe('unavailable');
    expect((await h.engine.ensureModelReady()).kind).toBe('unavailable');
    expect(embedder.ensureReadyCalls).toBe(1);

    embedder.unavailableReason = null;
    expect((await h.engine.ensureModelReady({ userInitiated: true })).kind).toBe('ready');
    expect(embedder.ensureReadyCalls).toBe(2);
  });

  it('a query never starts a download on the live session path (ADR-011)', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    await h.engine.importDocuments(profile.id, [h.writeSourceFile('resume.md', RESUME_MD)]);
    expect((await h.engine.query(profile.id, 'Acme Corp', 3)).length).toBeGreaterThan(0);

    // The model cache is cleared after the documents were embedded, which a disk
    // cleanup or a failed update really does.
    h.embedder.ready = false;
    h.embedder.reset();
    const loadsBefore = h.embedder.ensureReadyCalls;

    // It throws rather than answering `[]`: these documents are ready, so their
    // notes exist and cannot be reached, which is a failure and not an empty
    // result. The live loop abandons the turn on it (ADR-036).
    await expect(h.engine.query(profile.id, 'Acme Corp', 3)).rejects.toThrow(
      RetrievalUnavailableError,
    );
    // No embed call, so no load, so no 90 MB download inside the
    // question-to-suggestion budget.
    expect(h.embedder.calls).toEqual([]);
    expect(h.embedder.ensureReadyCalls).toBe(loadsBefore);
  });

  it('progress is determinate: a percent, not a spinner (FR-066)', async () => {
    const embedder = new FakeEmbedder();
    embedder.ready = false;
    const h = makeHarness({}, embedder);

    await h.engine.ensureModelReady();

    const downloading = h.modelStates.filter(
      (s) => (s as { kind: string }).kind === 'downloading',
    ) as { percent: number }[];
    expect(downloading.length).toBeGreaterThan(0);
    for (const state of downloading) {
      expect(typeof state.percent).toBe('number');
      expect(state.percent).toBeGreaterThanOrEqual(0);
      expect(state.percent).toBeLessThanOrEqual(100);
    }
    expect(h.engine.getModelState()).toEqual({ kind: 'ready' });
  });

  it('asks the embedder to load even when the model already reads as ready', async () => {
    const embedder = new FakeEmbedder();
    const h = makeHarness({}, embedder);

    // A cached model reads ready but is not yet in memory, so the tokenizer the
    // chunker needs does not exist until `ensureReady` has run.
    expect(h.engine.getModelState()).toEqual({ kind: 'ready' });
    await h.engine.ensureModelReady();
    expect(embedder.ensureReadyCalls).toBe(1);
  });
});
