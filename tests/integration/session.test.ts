/**
 * TASK-040. The Session Manager against a real temporary `userData`.
 *
 * Integration rather than unit because every guarantee here is about what is on
 * disk after a crash, and a fake filesystem would prove only that the fake
 * agrees with the code.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session, TranscriptEntry } from '../../src/shared/types.js';
import {
  SessionManager,
  SessionStartRefused,
  deleteSession,
  emptyUsage,
  listSessions,
  readNdjson,
  readSession,
  type StartRequest,
} from '../../src/main/session.js';

let userData: string;
const PROFILE = { id: 'p1', name: 'Acme' };

function manager(over: Partial<ConstructorParameters<typeof SessionManager>[0]> = {}) {
  return new SessionManager({ userDataDir: userData, newSessionId: () => 's1', ...over });
}

function request(over: Partial<StartRequest> = {}): StartRequest {
  return { profile: PROFILE, sttKeyPresent: true, llmKeyPresent: true, ...over };
}

function sessionsDir(profileId = PROFILE.id): string {
  return join(userData, 'profiles', profileId, 'sessions');
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'icp-session-'));
});

afterEach(() => {
  rmSync(userData, { recursive: true, force: true });
});

/** TC-104: four refusals, each with its own named reason. */
describe('TC-104 start refusals', () => {
  it('refuses with no active profile', async () => {
    await expect(manager().start(request({ profile: null }))).rejects.toMatchObject({
      reason: 'no-active-profile',
    });
  });

  it('refuses with no STT key and with no LLM key, distinctly', async () => {
    await expect(manager().start(request({ sttKeyPresent: false }))).rejects.toMatchObject({
      reason: 'stt-key-missing',
    });
    await expect(manager().start(request({ llmKeyPresent: false }))).rejects.toMatchObject({
      reason: 'llm-key-missing',
    });
  });

  it('refuses a second session while one is active', async () => {
    const m = manager();
    await m.start(request());
    await expect(m.start(request())).rejects.toMatchObject({ reason: 'session-active' });
    await m.stop();
  });

  it('gives every refusal a distinct message the user can act on', async () => {
    const reasons: string[] = [];
    for (const req of [
      request({ profile: null }),
      request({ sttKeyPresent: false }),
      request({ llmKeyPresent: false }),
    ]) {
      await manager()
        .start(req)
        .catch((err: SessionStartRefused) => reasons.push(err.message));
    }
    expect(new Set(reasons).size).toBe(3);
    for (const message of reasons) expect(message.length).toBeGreaterThan(20);
  });

  it('a live lock refuses a start from a second manager (FR-108)', async () => {
    const first = manager();
    await first.start(request());

    // A separate instance is what a second window or a second process would be.
    const second = new SessionManager({ userDataDir: userData, newSessionId: () => 's2' });
    await expect(second.start(request())).rejects.toMatchObject({ reason: 'session-active' });
    await first.stop();
  });
});

/** TC-105: every entry is on disk when its append resolves. */
describe('TC-105 transcript durability', () => {
  it('has the entry on disk by the time append resolves', async () => {
    const m = manager();
    await m.start(request());
    await m.appendTurn('interviewer', 'Tell me about a hard project');

    // No timer to wait out: the append itself is the write (FR-105).
    const raw = await readFile(join(sessionsDir(), 's1.ndjson'), 'utf8');
    expect(raw).toContain('Tell me about a hard project');
    expect(raw.endsWith('\n')).toBe(true);
    await m.stop();
  });

  it('writes one complete line per entry (FR-107)', async () => {
    const m = manager();
    await m.start(request());
    await m.appendTurn('interviewer', 'first');
    await m.appendTurn('candidate', 'second');

    const raw = await readFile(join(sessionsDir(), 's1.ndjson'), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    await m.stop();
  });

  it('compacts into <sessionId>.json on a clean stop and deletes the ndjson', async () => {
    const m = manager();
    await m.start(request());
    await m.appendTurn('interviewer', 'a question long enough to keep');
    const session = await m.stop();

    expect(session?.endReason).toBe('user');
    expect(session?.entries).toHaveLength(1);

    const names = await readdir(sessionsDir());
    expect(names).toEqual(['s1.json']);
    expect(m.isActive).toBe(false);
  });

  it('releases the lock on a clean stop, so the next session starts', async () => {
    const m = manager();
    await m.start(request());
    await m.stop();
    const next = new SessionManager({ userDataDir: userData, newSessionId: () => 's2' });
    await expect(next.start(request())).resolves.toMatchObject({ id: 's2' });
    await next.stop();
  });
});

/** TC-106: an orphan ndjson at startup is a crash. */
describe('TC-106 crash recovery', () => {
  it('compacts an orphan ndjson with endReason crash-recovered', async () => {
    const dir = sessionsDir();
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'dead.ndjson'),
      [
        JSON.stringify({ seq: 0, kind: 'turn', source: 'interviewer', text: 'q', at: 'T0' }),
        JSON.stringify({ seq: 1, kind: 'turn', source: 'candidate', text: 'a', at: 'T1' }),
        '',
      ].join('\n'),
      'utf8',
    );

    const recovered = await manager().recover([PROFILE.id]);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.endReason).toBe('crash-recovered');
    expect(recovered[0]?.entries).toHaveLength(2);

    // It appears in Session History, which is the point of recovering it.
    const history = await listSessions(userData, PROFILE.id);
    expect(history.map((s) => s.id)).toEqual(['dead']);
    expect(await readdir(dir)).toEqual(['dead.json']);
  });

  it('recovers nothing when there is nothing to recover', async () => {
    await expect(manager().recover([PROFILE.id])).resolves.toEqual([]);
  });

  it('one unreadable session does not stop the others being recovered', async () => {
    const dir = sessionsDir();
    await mkdir(dir, { recursive: true });
    // A line that is not the last one and is not parseable: a writer defect,
    // not a crash, so this session throws and the other still recovers.
    await writeFile(join(dir, 'bad.ndjson'), 'not json\n{"seq":1}\n', 'utf8');
    await writeFile(
      join(dir, 'good.ndjson'),
      `${JSON.stringify({ seq: 0, kind: 'turn', source: 'interviewer', text: 'q', at: 'T0' })}\n`,
      'utf8',
    );

    const errors: unknown[] = [];
    const m = new SessionManager({
      userDataDir: userData,
      onError: (_m, detail) => errors.push(detail),
    });
    const recovered = await m.recover([PROFILE.id]);

    expect(recovered.map((s) => s.id)).toEqual(['good']);
    expect(errors).toHaveLength(1);
  });
});

/** TC-134: ordering under cancellation. */
describe('TC-134 transcript ordering under cancellation', () => {
  it('appends the cancelled entry before its replacement, with no seq gaps', async () => {
    const m = manager();
    await m.start(request());

    // The cancelled generation's append is started first and awaited by the LLM
    // layer, exactly as FR-106 requires, while the replacement is already in
    // flight. Both are issued without awaiting, to race them on purpose.
    const cancelled = m.appendSuggestion({
      forQuestion: 'Q1',
      bullets: ['partial bullet'],
      model: 'claude-haiku-4-5-20251001',
      providerId: 'anthropic',
      status: 'cancelled',
    });
    const replacement = m.appendSuggestion({
      forQuestion: 'Q2',
      bullets: ['full bullet'],
      model: 'claude-haiku-4-5-20251001',
      providerId: 'anthropic',
      status: 'complete',
    });
    expect(await cancelled).toBe(0);
    expect(await replacement).toBe(1);

    const session = await m.stop();
    const entries = session?.entries ?? [];
    expect(entries.map((e) => e.seq)).toEqual([0, 1]);

    const first = entries[0];
    const second = entries[1];
    expect(first?.kind === 'suggestion' && first.status).toBe('cancelled');
    expect(first?.kind === 'suggestion' && first.bullets).toEqual(['partial bullet']);
    expect(second?.kind === 'suggestion' && second.forQuestion).toBe('Q2');
  });

  it('seq is strictly increasing with no gaps across many concurrent appends', async () => {
    const m = manager();
    await m.start(request());
    const seqs = await Promise.all(
      Array.from({ length: 50 }, (_, i) => m.appendTurn('interviewer', `turn ${String(i)}`)),
    );
    expect(seqs).toEqual([...Array(50).keys()]);

    const session = await m.stop();
    expect(session?.entries.map((e) => e.seq)).toEqual([...Array(50).keys()]);
  });
});

/** TC-135: a torn write, a .json that wins, and a stale lock. */
describe('TC-135 torn write and lock recovery', () => {
  it('keeps every complete line when the final one is truncated mid-object', async () => {
    const dir = sessionsDir();
    await mkdir(dir, { recursive: true });
    const whole = [0, 1, 2].map((seq) =>
      JSON.stringify({
        seq,
        kind: 'turn',
        source: 'interviewer',
        text: `t${String(seq)}`,
        at: 'T',
      }),
    );
    await writeFile(
      join(dir, 'torn.ndjson'),
      `${whole.join('\n')}\n{"seq":3,"kind":"turn","sour`,
      'utf8',
    );

    const recovered = await manager().recover([PROFILE.id]);
    expect(recovered[0]?.entries.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('the .json wins when both exist, and the .ndjson is deleted', async () => {
    const dir = sessionsDir();
    await mkdir(dir, { recursive: true });
    const clean: Session = {
      id: 'both',
      profileId: PROFILE.id,
      profileNameSnapshot: PROFILE.name,
      startedAt: 'T0',
      endedAt: 'T1',
      entries: [{ seq: 0, kind: 'turn', source: 'interviewer', text: 'kept', at: 'T0' }],
      usage: emptyUsage(),
      endReason: 'user',
    };
    await writeFile(join(dir, 'both.json'), JSON.stringify(clean), 'utf8');
    await writeFile(
      join(dir, 'both.ndjson'),
      `${JSON.stringify({ seq: 0, kind: 'turn', source: 'interviewer', text: 'discarded', at: 'T0' })}\n`,
      'utf8',
    );

    const recovered = await manager().recover([PROFILE.id]);
    // Nothing is recovered: the clean stop already produced the .json.
    expect(recovered).toEqual([]);
    expect(await readdir(dir)).toEqual(['both.json']);

    const read = await readSession(userData, PROFILE.id, 'both');
    expect(read?.entries[0]?.kind === 'turn' && read.entries[0].text).toBe('kept');
  });

  it('clears a stale lock from a killed process rather than blocking the next session', async () => {
    // What a crash leaves behind: a lock naming a pid that is gone.
    await writeFile(
      join(userData, 'session.lock'),
      JSON.stringify({ sessionId: 'dead', profileId: PROFILE.id, pid: 999999, startedAt: 'T0' }),
      'utf8',
    );

    const m = manager();
    await m.recover([PROFILE.id]);
    await expect(stat(join(userData, 'session.lock'))).rejects.toThrow();

    // And the next session starts, which is the whole point of clearing it.
    await expect(m.start(request())).resolves.toMatchObject({ id: 's1' });
    await m.stop();
  });

  it('a malformed line that is not the last one is a defect, not a crash', async () => {
    const dir = sessionsDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'x.ndjson'), 'garbage\n{"seq":1,"kind":"turn"}\n', 'utf8');
    await expect(readNdjson(join(dir, 'x.ndjson'))).rejects.toThrow(/not the last line/);
  });
});

describe('session history', () => {
  it('lists newest first and reads and deletes one session', async () => {
    const m = manager({ newSessionId: () => 'older' });
    await m.start(request());
    await m.appendTurn('interviewer', 'first session');
    await m.stop();

    const m2 = new SessionManager({
      userDataDir: userData,
      newSessionId: () => 'newer',
      now: () => new Date('2030-01-01T00:00:00.000Z'),
    });
    await m2.start(request());
    await m2.stop();

    const history = await listSessions(userData, PROFILE.id);
    expect(history.map((s) => s.id)).toEqual(['newer', 'older']);
    expect(history[1]?.entryCount).toBe(1);
    expect(history[1]?.profileNameSnapshot).toBe('Acme');

    await deleteSession(userData, PROFILE.id, 'older');
    expect((await listSessions(userData, PROFILE.id)).map((s) => s.id)).toEqual(['newer']);
  });

  it('an empty profile has no history rather than an error', async () => {
    await expect(listSessions(userData, 'never-used')).resolves.toEqual([]);
  });
});

describe('the session binds its profile at start (ADR-013)', () => {
  it('snapshots the profile name, so a later rename does not rewrite history', async () => {
    const m = manager();
    const active = await m.start(request());
    expect(active.profileId).toBe(PROFILE.id);
    expect(active.profileNameSnapshot).toBe('Acme');

    const session = await m.stop();
    expect(session?.profileNameSnapshot).toBe('Acme');
  });

  it('refuses an append with no session rather than writing somewhere plausible', async () => {
    await expect(manager().appendTurn('interviewer', 'nowhere')).rejects.toThrow(/No session/);
  });
});

/** TC-107 is a type-level assertion; it lives in the unit suite. */
describe('the writer never receives audio (FR-101, NFR-002)', () => {
  it('stores only text for a turn', async () => {
    const m = manager();
    await m.start(request());
    await m.appendTurn('interviewer', 'text only');
    const session = await m.stop();

    const entry = session?.entries[0] as TranscriptEntry;
    expect(Object.keys(entry).sort()).toEqual(['at', 'kind', 'seq', 'source', 'text']);
  });
});
