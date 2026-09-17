/**
 * TASK-050, TC-132. `NFR-008`: with no network **and the embedding model
 * already cached**, the app starts, manages profiles, ingests documents and
 * computes embeddings, and a session start warns that transcription is
 * unavailable.
 *
 * "No network" is modelled the only way a test can model it honestly: nothing
 * here is allowed to reach outside. The embedder is the cached local model
 * (`FakeEmbedder`, ready), and every path that would have opened a socket
 * either is never called or rejects the way a dead network makes it reject.
 *
 * `TC-161` covers the other half of `NFR-008`, the fresh install with no cached
 * model, and lives in `rag-model-gate.test.ts`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearSttProviders } from '../../src/main/ai/stt.js';
import { FakeEmbedder } from '../fakes/embedder.js';
import { RESUME_MD, makeHarness } from '../fakes/rag-harness.js';
import { PROFILE, harness, startSession, stopSession } from '../fakes/live-harness.js';

let userData: string;
/** The RAG harness makes its own directory, removed here so a failing assertion still cleans up. */
let ragDir: string | null;

beforeEach(() => {
  clearSttProviders();
  userData = mkdtempSync(join(tmpdir(), 'icp-offline-'));
  ragDir = null;
});

afterEach(() => {
  clearSttProviders();
  rmSync(userData, { recursive: true, force: true });
  if (ragDir) rmSync(ragDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * The knowledge base, offline
 * ------------------------------------------------------------------ */

describe('TC-132 with no network and a cached model the knowledge base still works', () => {
  it('starts, manages profiles, imports documents and embeds them', async () => {
    // Cached: the model is on disk, so the gate never reaches for the network.
    const embedder = new FakeEmbedder();
    embedder.ready = true;
    const h = makeHarness({}, embedder);
    ragDir = h.dir;

    // Profiles.
    const profile = await h.engine.createProfile('Acme');
    expect(h.engine.listProfiles().map((p) => p.name)).toEqual(['Acme']);

    // Ingest and embed.
    const [record] = await h.engine.importDocuments(profile.id, [
      h.writeSourceFile('resume.md', RESUME_MD),
    ]);
    expect(record!.state).toBe('ready');
    expect(record!.errorMessage).toBeNull();
    expect(embedder.embeddedCount).toBeGreaterThan(0);

    // The model gate stayed on the cached model rather than trying to fetch it.
    expect(h.engine.getModelState()).toEqual({ kind: 'ready' });
    expect(embedder.ensureReadyCalls).toBeGreaterThan(0);

    // And retrieval, the thing embeddings exist for, answers offline.
    const hits = await h.engine.query(profile.id, 'What did you ship at Acme?', 3);
    expect(hits.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * Session start, offline
 * ------------------------------------------------------------------ */

describe('TC-132 a session start with no network warns that transcription is unavailable', () => {
  it('names transcription as unavailable when no model can be opened', async () => {
    // No key reaches the vault, so no speech-to-text model resolves. This is
    // the branch that carries the sentence NFR-008 asks for.
    const h = harness(userData, { keyFor: () => undefined });
    await startSession(h);

    // The exact sentence `index.ts` forwards on `CH-217`, which the Dashboard
    // renders and the E2E half of TC-132 asserts is on screen. Pinned here so
    // the two cannot drift apart silently.
    expect(h.errors.map((e) => e.message)).toEqual([
      'transcription is unavailable: the speech-to-text model is not usable. ' +
        'The session is running, but nothing will be transcribed.',
    ]);

    // Warned, not refused. The transcript, the timer and the knowledge base all
    // still work, so the session runs (FR-102, ADR-032).
    expect(h.live.isRunning).toBe(true);
    expect(h.sessions.isActive).toBe(true);
    expect(h.live.openStreamCount).toBe(0);

    // The Cost Meter is still counting the session, and stop still compacts a
    // real session file.
    h.tick(3);
    const session = await stopSession(h);
    expect(session).not.toBeNull();
    expect(session!.profileId).toBe(PROFILE.id);
    expect(session!.endReason).toBe('user');
  });

  it('warns and stays live when every socket refuses, as a dead network makes them', async () => {
    // Every open rejects with a retryable network error, which is what a socket
    // to a provider does with the cable out. The health machine spends its
    // retries and its failover, then reports.
    const h = harness(userData, { failFirstSttOpens: Number.MAX_SAFE_INTEGER });
    await startSession(h);

    expect(h.errors.map((e) => e.message)).toEqual([
      'the speech-to-text provider could not be reached',
    ]);
    expect(h.live.isRunning).toBe(true);
    expect(h.sessions.isActive).toBe(true);
    expect(h.live.openStreamCount).toBe(0);

    const session = await stopSession(h);
    expect(session).not.toBeNull();
  });
});
