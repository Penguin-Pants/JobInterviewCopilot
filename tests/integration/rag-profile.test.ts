import {
  cpSync,
  existsSync,
  mkdirSync as mkdirSyncReal,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RagEngine } from '../../src/main/rag.js';
import { buildPdf } from '../fakes/documents.js';
import { FakeEmbedder } from '../fakes/embedder.js';
import { makeHarness, ManualWatcher, NOTES_MD, RESUME_MD } from '../fakes/rag-harness.js';

/**
 * TASK-020. TC-160 profile deletion cascade (FR-069).
 */

/** Every file under a directory, as repo-relative-ish paths for readable failures. */
function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe('TC-160 profile deletion cascade', () => {
  it('removes the directory and every trace of the profile under userData', async () => {
    const h = makeHarness();
    const doomed = await h.engine.createProfile('Doomed');
    const keeper = await h.engine.createProfile('Keeper');

    await h.engine.importDocuments(doomed.id, [
      h.writeSourceFile('resume.md', RESUME_MD),
      h.writeSourceFile('notes.md', NOTES_MD),
    ]);
    await h.engine.importDocuments(keeper.id, [h.writeSourceFile('keep.md', NOTES_MD)]);

    // A transcript, which FR-069 names alongside documents and vectors.
    const transcript = join(h.engine.store.sessionsDir(doomed.id), 'session-1.json');
    mkdirSyncReal(h.engine.store.sessionsDir(doomed.id), { recursive: true });
    writeFileSync(
      transcript,
      JSON.stringify({ id: 'session-1', entries: [{ text: 'a secret answer' }] }),
    );

    const doomedDocs = h.engine.store.get(doomed.id)!.documents;
    expect(doomedDocs).toHaveLength(2);
    expect(doomedDocs.every((d) => d.state === 'ready')).toBe(true);

    await h.engine.deleteProfile(doomed.id);

    expect(existsSync(h.engine.store.profileDir(doomed.id))).toBe(false);
    expect(h.engine.store.get(doomed.id)).toBeNull();
    expect(h.engine.listProfiles().map((p) => p.id)).toEqual([keeper.id]);

    // A recursive scan of userData finds nothing belonging to the deleted profile.
    const survivors = walk(h.dir).filter((p) => !p.startsWith(join(h.dir, 'sources')));
    for (const file of survivors) {
      expect(file, `${relative(h.dir, file)} still names the deleted profile`).not.toContain(
        doomed.id,
      );
    }
    for (const docId of doomedDocs.map((d) => d.id)) {
      expect(survivors.some((p) => p.includes(docId))).toBe(false);
    }
    const contents = survivors.map((p) => readFileSync(p, 'utf8')).join('\n');
    expect(contents).not.toContain('a secret answer');
    expect(contents).not.toContain(doomed.id);

    // The other profile is untouched.
    expect(h.engine.store.get(keeper.id)!.documents).toHaveLength(1);
    expect((await h.engine.query(keeper.id, 'Berlin competitors', 3)).length).toBeGreaterThan(0);
  });

  it('a delete interrupted before the record is removed leaves no orphaned content', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Doomed');
    await h.engine.importDocuments(profile.id, [h.writeSourceFile('resume.md', RESUME_MD)]);
    const docId = h.engine.store.get(profile.id)!.documents[0]!.id;

    // Content is removed first and the record last, so the only state an
    // interruption can leave is "record present, content gone". Simulated by
    // removing exactly what the delete removes before the record.
    const { rmSync } = await import('node:fs');
    for (const child of ['kb', 'derived', 'sessions']) {
      rmSync(join(h.engine.store.profileDir(profile.id), child), { recursive: true, force: true });
    }

    // The record survives, which is the recoverable half of FR-069.
    expect(h.engine.store.get(profile.id)).not.toBeNull();
    // No document content or vectors are left behind.
    expect(existsSync(h.engine.store.chunksPath(profile.id, docId))).toBe(false);
    expect(existsSync(h.engine.store.vectorsPath(profile.id, docId))).toBe(false);

    // Reconciliation rebuilds the index from the now-empty kb/, as ADR-014 says.
    await h.engine.reconcile(profile.id);
    expect(h.engine.store.get(profile.id)!.documents).toEqual([]);

    // A second delete finishes the job.
    await h.engine.deleteProfile(profile.id);
    expect(existsSync(h.engine.store.profileDir(profile.id))).toBe(false);
  });

  it('deleting a profile that does not exist is a no-op', async () => {
    const h = makeHarness();
    const { randomUUID } = await import('node:crypto');
    await expect(h.engine.deleteProfile(randomUUID())).resolves.toBeUndefined();
  });

  it('refuses an id that could escape the profiles directory', async () => {
    const h = makeHarness();
    const survivor = await h.engine.createProfile('Survivor');

    // `path.join` resolves `..` rather than rejecting it, so an unvalidated id
    // of '..' would have `delete` remove the whole profiles/ directory.
    for (const hostile of ['..', '../..', 'a/../..', '/etc', 'C:\\Windows', '']) {
      await expect(h.engine.deleteProfile(hostile)).resolves.toBeUndefined();
      expect(h.engine.store.get(hostile)).toBeNull();
    }

    expect(h.engine.listProfiles().map((p) => p.id)).toEqual([survivor.id]);
    expect(existsSync(h.engine.store.profileDir(survivor.id))).toBe(true);
  });

  it('refuses a document id that could escape the derived directory', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');

    expect(() => h.engine.store.chunksPath(profile.id, '../../escape')).toThrow(/not a uuid/);
    expect(() => h.engine.store.vectorsPath(profile.id, '..')).toThrow(/not a uuid/);
    expect(() => h.engine.store.derivedMarkdownPath(profile.id, 'a/b')).toThrow(/not a uuid/);
  });

  it('an ingest that finishes after its profile is deleted writes nothing (FR-069)', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Doomed');
    const path = h.writeKbFile(profile.id, 'resume.md', RESUME_MD);

    // Hold the ingest inside the embed, which is past every earlier guard and
    // immediately before the chunk-pair write. Only then delete the profile.
    // Deleting sooner makes the ingest fail on the vanished source file, which
    // proves nothing about the write.
    let reachedEmbed = (): void => {};
    const atEmbed = new Promise<void>((resolve) => {
      reachedEmbed = resolve;
    });
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const realEmbed = h.embedder.embed.bind(h.embedder);
    h.embedder.embed = async (texts: string[]) => {
      reachedEmbed();
      await held;
      return realEmbed(texts);
    };

    const ingesting = h.engine.processFile(profile.id, path);
    await atEmbed;
    await h.engine.deleteProfile(profile.id);
    release();
    await ingesting;

    // Without the store's guard the ingest's own mkdirSync recreates
    // profiles/<id>/derived/ and fills it with vectors no record and no UI can
    // reach, which is exactly what FR-069 forbids.
    expect(existsSync(h.engine.store.profileDir(profile.id))).toBe(false);
    expect(walk(h.dir).filter((f) => f.includes(profile.id))).toEqual([]);
  });

  it('closes the profile watcher before removing anything', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Doomed');
    const watcher = h.watchers.get(h.engine.store.kbDir(profile.id))!;

    await h.engine.deleteProfile(profile.id);

    expect(watcher.closed).toBe(true);
  });

  it('every document belongs to exactly one profile (FR-069)', async () => {
    const h = makeHarness();
    const a = await h.engine.createProfile('A');
    const b = await h.engine.createProfile('B');

    const [inA] = await h.engine.importDocuments(a.id, [h.writeSourceFile('resume.md', RESUME_MD)]);
    const [inB] = await h.engine.importDocuments(b.id, [h.writeSourceFile('notes.md', NOTES_MD)]);

    expect(inA!.profileId).toBe(a.id);
    expect(inB!.profileId).toBe(b.id);
    expect(h.engine.store.findDocument(a.id, inB!.id)).toBeNull();
    expect(h.engine.store.findDocument(b.id, inA!.id)).toBeNull();
    expect(inA!.originalPath.startsWith(h.engine.store.kbDir(a.id))).toBe(true);
    expect(inB!.originalPath.startsWith(h.engine.store.kbDir(b.id))).toBe(true);
  });

  it('lists profiles in creation order, stably', async () => {
    const h = makeHarness();
    const first = await h.engine.createProfile('First');
    const second = await h.engine.createProfile('Second');

    const ids = h.engine.listProfiles().map((p) => p.id);
    expect(ids).toEqual([first.id, second.id]);
    expect(h.engine.listProfiles().map((p) => p.id)).toEqual(ids);
  });

  it('recomputes kbPath on read, so a moved userData still resolves', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');

    const file = join(h.engine.store.profileDir(profile.id), 'profile.json');
    writeFileSync(
      file,
      JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), kbPath: 'C:/old/install/kb' }),
    );

    expect(h.engine.store.get(profile.id)!.kbPath).toBe(h.engine.store.kbDir(profile.id));
  });

  it('recovers a profile whose index is unreadable instead of losing it', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    await h.engine.importDocuments(profile.id, [h.writeSourceFile('resume.md', RESUME_MD)]);

    // A truncated write. `profile.json` is a derived index and `kb/` is the
    // authority (ADR-014), so returning null here dropped the whole profile from
    // `list`: its kb/ was never scanned, no watcher started, and every document
    // in it became invisible.
    writeFileSync(join(h.engine.store.profileDir(profile.id), 'profile.json'), '{ broken');

    const recovered = h.engine.store.get(profile.id);
    expect(recovered).not.toBeNull();
    expect(recovered!.id).toBe(profile.id);
    expect(recovered!.documents).toEqual([]);
    expect(h.engine.listProfiles().map((p) => p.id)).toEqual([profile.id]);

    // Reconciliation refills the index from the folder, which is the whole point.
    await h.engine.reconcile(profile.id);
    expect(h.engine.store.get(profile.id)!.documents).toHaveLength(1);
    expect((await h.engine.query(profile.id, 'Acme Corp billing', 3)).length).toBeGreaterThan(0);
  });

  it('does not resurrect a profile whose delete was interrupted', () => {
    const h = makeHarness();
    // `delete` removes kb/ before the record, so a directory with no kb/ is a
    // delete in progress and must stay deleted rather than coming back empty.
    const id = '11111111-2222-4333-8444-555555555555';
    mkdirSyncReal(h.engine.store.profileDir(id), { recursive: true });

    expect(h.engine.store.get(id)).toBeNull();
    expect(h.engine.listProfiles().map((p) => p.id)).toEqual([]);
  });

  it('keeps the real name when a truncated index is recovered and then written', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme Interview');
    await h.engine.importDocuments(profile.id, [h.writeSourceFile('resume.md', RESUME_MD)]);
    const file = join(h.engine.store.profileDir(profile.id), 'profile.json');
    const full = readFileSync(file, 'utf8');

    // Cut inside `documents`, after the name and the creation time.
    writeFileSync(file, full.slice(0, full.indexOf('"documents"') + 20));

    expect(h.engine.store.get(profile.id)!.name).toBe('Acme Interview');
    // Reconciliation writes the index. The placeholder name used to be written
    // with it, and the real name was then gone for good.
    await h.engine.reconcile(profile.id);
    const after = h.engine.store.get(profile.id)!;
    expect(after.name).toBe('Acme Interview');
    expect(after.createdAt).toBe(profile.createdAt);
    expect(after.documents).toHaveLength(1);
  });

  it('uses the placeholder only when no name can be read back', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    writeFileSync(join(h.engine.store.profileDir(profile.id), 'profile.json'), '{ broken');

    expect(h.engine.store.get(profile.id)!.name).toBe('Recovered profile');
  });

  it('a profile folder copied under a new id addresses its own folder', async () => {
    const h = makeHarness();
    const original = await h.engine.createProfile('Original');
    await h.engine.importDocuments(original.id, [h.writeSourceFile('resume.md', RESUME_MD)]);
    const copyId = '11111111-2222-4333-8444-555555555555';
    cpSync(h.engine.store.profileDir(original.id), h.engine.store.profileDir(copyId), {
      recursive: true,
    });

    const copy = h.engine.store.get(copyId)!;
    // The copy's profile.json still names the original id. Trusting it sent
    // every write for the copy into the original's folder.
    expect(copy.id).toBe(copyId);
    expect(copy.documents.every((d) => d.profileId === copyId)).toBe(true);
    expect(copy.documents[0]!.originalPath).toBe(join(h.engine.store.kbDir(copyId), 'resume.md'));

    await h.engine.reconcile(copyId);
    expect(h.engine.store.get(original.id)!.name).toBe('Original');
    expect(h.engine.store.get(copyId)!.documents).toHaveLength(1);
  });

  it("a copied profile's chunks carry the copy's id, without a re-embed", async () => {
    const h = makeHarness();
    const original = await h.engine.createProfile('Original');
    await h.engine.importDocuments(original.id, [h.writeSourceFile('resume.md', RESUME_MD)]);
    const copyId = '11111111-2222-4333-8444-555555555555';
    cpSync(h.engine.store.profileDir(original.id), h.engine.store.profileDir(copyId), {
      recursive: true,
    });
    const embedCalls = h.embedder.calls.length;

    // The records were rebased, but the copied chunks.json still named the
    // original profile, and reconcile read the pair as a cache hit.
    await h.engine.reconcile(copyId);
    await h.engine.drain();

    const hits = await h.engine.query(copyId, 'Acme Corp billing', 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.chunk.profileId === copyId)).toBe(true);
    // Only the query itself was embedded. The vectors do not depend on the id.
    expect(h.embedder.calls.length).toBe(embedCalls + 1);
  });

  it('removes the derived files of a dropped row once its file is adopted again', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const [record] = await h.engine.importDocuments(profile.id, [
      h.writeSourceFile('notes.pdf', buildPdf(['# Company', 'Founded in 2015 in Berlin.'])),
    ]);
    const store = h.engine.store;
    expect(existsSync(store.chunksPath(profile.id, record!.id))).toBe(true);
    const file = join(store.profileDir(profile.id), 'profile.json');
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { documents: { state: string }[] };
    parsed.documents[0]!.state = 'not-a-state';
    writeFileSync(file, JSON.stringify(parsed));

    await h.engine.reconcile(profile.id);

    const [adopted] = store.get(profile.id)!.documents;
    expect(adopted!.id).not.toBe(record!.id);
    // Nothing owns these any more, and nothing else would ever remove them.
    expect(existsSync(store.derivedMarkdownPath(profile.id, record!.id))).toBe(false);
    expect(existsSync(store.chunksPath(profile.id, record!.id))).toBe(false);
    expect(existsSync(store.vectorsPath(profile.id, record!.id))).toBe(false);
    expect(existsSync(store.chunksPath(profile.id, adopted!.id))).toBe(true);
  }, 30000);

  it('drops an invalid document row instead of failing reconciliation', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    await h.engine.importDocuments(profile.id, [h.writeSourceFile('resume.md', RESUME_MD)]);
    const file = join(h.engine.store.profileDir(profile.id), 'profile.json');
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { documents: unknown[] };
    parsed.documents.unshift(null, { id: 'not-a-uuid' }, 42);
    parsed.documents.push({
      ...(parsed.documents[3] as object),
      id: '11111111-2222-4333-8444-555555555555',
      originalFileName: '../../escape.md',
    });
    writeFileSync(file, JSON.stringify(parsed));

    const documents = h.engine.store.get(profile.id)!.documents;
    expect(documents).toHaveLength(1);
    expect(documents[0]!.originalFileName).toBe('resume.md');
    // A null row made `.find` throw out of reconcile and out of `start`.
    await expect(h.engine.reconcile(profile.id)).resolves.toBeUndefined();
    expect(h.engine.store.get(profile.id)!.documents).toHaveLength(1);
  });
});

describe('a moved userData keeps its index (ADR-014)', () => {
  it('rebases document paths, keeps overrides and re-embeds nothing', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const [md] = await h.engine.importDocuments(profile.id, [
      h.writeSourceFile('resume.md', RESUME_MD),
    ]);
    const [notes] = await h.engine.importDocuments(profile.id, [
      h.writeSourceFile('notes.md', NOTES_MD),
    ]);
    await h.engine.setDocType(profile.id, md!.id, 'job-description');
    await h.engine.stop();

    const moved = `${h.dir}-moved`;
    renameSync(h.dir, moved);
    const embedder = new FakeEmbedder();
    const engine = new RagEngine({
      userDataDir: moved,
      embedder,
      watcherFactory: () => new ManualWatcher(),
    });
    const kb = engine.store.kbDir(profile.id);

    await engine.reconcile(profile.id);

    const documents = engine.store.get(profile.id)!.documents;
    expect(documents.map((d) => d.id).sort()).toEqual([md!.id, notes!.id].sort());
    const resume = documents.find((d) => d.id === md!.id)!;
    expect(resume.originalPath).toBe(join(kb, 'resume.md'));
    expect(resume.docType).toBe('job-description');
    expect(resume.docTypeSource).toBe('user');
    // Every record matched its file, so nothing was dropped and re-embedded.
    expect(embedder.calls).toEqual([]);

    await engine.deleteDocument(profile.id, md!.id);
    expect(existsSync(join(kb, 'resume.md'))).toBe(false);
  });

  it('rebases the derived Markdown path of a converted document', async () => {
    const h = makeHarness();
    const profile = await h.engine.createProfile('Acme');
    const [record] = await h.engine.importDocuments(profile.id, [
      h.writeSourceFile('resume.md', RESUME_MD),
    ]);
    const file = join(h.engine.store.profileDir(profile.id), 'profile.json');
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      documents: { derivedMarkdownPath: string | null; sourceFormat: string }[];
    };
    parsed.documents[0]!.derivedMarkdownPath = 'C:/old/install/derived/x.md';
    writeFileSync(file, JSON.stringify(parsed));

    expect(h.engine.store.findDocument(profile.id, record!.id)!.derivedMarkdownPath).toBe(
      h.engine.store.derivedMarkdownPath(profile.id, record!.id),
    );
  });
});

describe('an index unreadable at startup is reconciled once it reads again (ADR-014)', () => {
  /** Timers a test fires by hand. */
  function manualTimers(): {
    timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };
    pending: Map<number, { fn: () => void; ms: number }>;
  } {
    const pending = new Map<number, { fn: () => void; ms: number }>();
    let next = 0;
    return {
      pending,
      timers: {
        setTimeout(fn, ms) {
          next += 1;
          pending.set(next, { fn, ms });
          return next;
        },
        clearTimeout(handle) {
          pending.delete(handle as number);
        },
      },
    };
  }

  /** A profile whose `profile.json` is a directory: it exists and cannot be read. */
  async function blockedProfile(): Promise<{ dir: string; id: string; restore: () => void }> {
    const first = makeHarness();
    const profile = await first.engine.createProfile('Acme');
    await first.engine.stop();
    // Added while the app was closed. Only reconciliation can adopt it, because
    // the watcher starts with `ignoreInitial`.
    first.writeKbFile(profile.id, 'resume.md', RESUME_MD);
    const file = join(first.engine.store.profileDir(profile.id), 'profile.json');
    const saved = readFileSync(file, 'utf8');
    rmSync(file);
    mkdirSyncReal(file);
    return {
      dir: first.dir,
      id: profile.id,
      restore: () => {
        rmSync(file, { recursive: true });
        writeFileSync(file, saved);
      },
    };
  }

  it('retries the pass and adopts the documents it could not write', async () => {
    const blocked = await blockedProfile();
    const clock = manualTimers();
    const h = makeHarness({ userDataDir: blocked.dir, timers: clock.timers });

    await h.engine.start();
    expect(h.embedder.calls).toEqual([]);
    expect(clock.pending.size).toBe(1);

    blocked.restore();
    const retry = [...clock.pending.values()][0];
    clock.pending.clear();
    retry!.fn();

    await vi.waitFor(() => {
      expect(h.engine.store.get(blocked.id)!.documents.map((d) => d.state)).toEqual(['ready']);
    });
    expect(clock.pending.size).toBe(0);
    await h.engine.stop();
  });

  it('gives up after a bounded number of attempts and says so', async () => {
    const blocked = await blockedProfile();
    const clock = manualTimers();
    const errors: string[] = [];
    const h = makeHarness({
      userDataDir: blocked.dir,
      timers: clock.timers,
      onError: (message) => errors.push(message),
    });

    await h.engine.start();
    const gaveUp = 'the profile index stayed unreadable, so it was not reconciled';
    const delays: number[] = [];
    for (let attempt = 0; attempt < 20 && clock.pending.size > 0; attempt += 1) {
      const [id, retry] = [...clock.pending][0]!;
      clock.pending.delete(id);
      delays.push(retry.ms);
      retry.fn();
      await vi.waitFor(() => {
        expect(clock.pending.size > 0 || errors.includes(gaveUp)).toBe(true);
      });
    }

    expect(delays.length).toBeGreaterThan(0);
    expect(delays.length).toBeLessThan(10);
    // Each wait is longer than the one before it.
    expect([...delays].sort((a, b) => a - b)).toEqual(delays);
    expect(clock.pending.size).toBe(0);
    expect(errors).toContain(gaveUp);
    await h.engine.stop();
  });

  it('stop cancels a pending retry', async () => {
    const blocked = await blockedProfile();
    const clock = manualTimers();
    const h = makeHarness({ userDataDir: blocked.dir, timers: clock.timers });

    await h.engine.start();
    expect(clock.pending.size).toBe(1);
    await h.engine.stop();
    expect(clock.pending.size).toBe(0);
  });
});
