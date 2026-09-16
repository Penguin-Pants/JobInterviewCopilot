/**
 * The Session Manager (`CMP-08`). Mirrors `docs/02-architecture.md` section 2.5
 * (TASK-040, FR-088, FR-101, FR-105, FR-106, FR-107, FR-108, ADR-003, ADR-013,
 * ADR-018).
 *
 * This component is the **sole writer of a session file**. It holds the only
 * file handle, assigns every `seq`, and owns the session lock. The Cost Meter
 * hands usage over in memory and never touches disk (ADR-018).
 *
 * No audio reaches it. `TranscriptEntry` has no variant that can carry binary,
 * which is the type-level guarantee `TC-107` asserts rather than a check this
 * file performs (`FR-101`, NFR-002).
 */
import { constants as fsConstants } from 'node:fs';
import { open, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Session,
  SessionSummary,
  TranscriptEntry,
  TranscriptSource,
  UsageRecord,
} from '../shared/types.js';

/**
 * One entry before the Session Manager stamps its `seq` (`FR-106`).
 *
 * Distributive, so each variant of the union keeps its own fields. A plain
 * `Omit<TranscriptEntry, 'seq'>` collapses the two variants into their common
 * keys and would reject `source` on a turn.
 */
export type TranscriptEntryInput = TranscriptEntry extends infer E
  ? E extends TranscriptEntry
    ? Omit<E, 'seq'>
    : never
  : never;

/** A fresh, zeroed usage record. The Cost Meter replaces it (TASK-041). */
export function emptyUsage(priceTableVersion = ''): UsageRecord {
  return {
    sttAudioSeconds: { interviewer: 0, candidate: 0 },
    llmInputTokens: 0,
    llmOutputTokens: 0,
    estimatedUsd: 0,
    priceTableVersion,
    warningsIssued: [],
  };
}

/**
 * Why a start was refused (`FR-088`, TC-104).
 *
 * Each value is distinct and named, because "could not start" tells the user
 * nothing about which of four things to go and fix.
 */
export type StartRefusal =
  'session-active' | 'no-active-profile' | 'stt-key-missing' | 'llm-key-missing';

export const START_REFUSAL_MESSAGES: Record<StartRefusal, string> = {
  'session-active': 'A session is already running. Stop it before starting another.',
  'no-active-profile': 'No company profile is active. Create or select one first.',
  'stt-key-missing': 'No speech-to-text key is saved for the selected provider.',
  'llm-key-missing': 'No language-model key is saved for the selected provider.',
};

/** Thrown by `start`. Carries the reason as data, not only as prose. */
export class SessionStartRefused extends Error {
  constructor(readonly reason: StartRefusal) {
    super(START_REFUSAL_MESSAGES[reason]);
    this.name = 'SessionStartRefused';
  }
}

/**
 * What the caller must establish before a session may start.
 *
 * Passed in rather than read here: `CMP-08` does not reach into the config
 * store, the vault or the knowledge base, so the refusal rules stay testable
 * without any of them.
 */
export interface StartRequest {
  profile: { id: string; name: string } | null;
  sttKeyPresent: boolean;
  llmKeyPresent: boolean;
}

/** One live session, as the manager tracks it in memory. */
export interface ActiveSession {
  id: string;
  profileId: string;
  profileNameSnapshot: string;
  startedAt: string;
}

export interface SessionManagerOptions {
  userDataDir: string;
  /** Injected so a test asserts on a stable id and a stable clock. */
  newSessionId?: () => string;
  now?: () => Date;
  onError?: (message: string, detail?: unknown) => void;
}

/** Where a session's files live. Sessions belong to a profile (ADR-013). */
function sessionsDir(userDataDir: string, profileId: string): string {
  return join(userDataDir, 'profiles', profileId, 'sessions');
}

/**
 * The lock that enforces one session across process restarts (`FR-108`).
 *
 * At the `userData` root, not inside a profile. The architecture writes it as
 * "next to the sessions folder", and there is one such folder per profile,
 * which would allow one concurrent session per profile. `FR-108` and `ADR-013`
 * both say one session, full stop. Recorded in the architecture document and in
 * the task notes (DoD 9).
 */
function lockPath(userDataDir: string): string {
  return join(userDataDir, 'session.lock');
}

interface LockContents {
  sessionId: string;
  profileId: string;
  pid: number;
  startedAt: string;
}

export class SessionManager {
  private readonly userDataDir: string;
  private readonly newSessionId: () => string;
  private readonly now: () => Date;
  private readonly onError: (message: string, detail?: unknown) => void;

  private active: ActiveSession | null = null;
  private handle: FileHandle | null = null;
  private seq = 0;
  private usage: UsageRecord = emptyUsage();

  /**
   * Serializes appends. Every write goes on the end of this chain, so entries
   * reach disk in `seq` order even when two callers append concurrently, which
   * is exactly what a cancelled generation racing its replacement does
   * (`FR-106`, TC-134).
   */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: SessionManagerOptions) {
    this.userDataDir = options.userDataDir;
    this.newSessionId = options.newSessionId ?? (() => randomUUID());
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError ?? (() => {});
  }

  get current(): ActiveSession | null {
    return this.active;
  }

  get isActive(): boolean {
    return this.active !== null;
  }

  /** The next `seq` that will be assigned. Exposed for tests and for recovery. */
  get nextSeq(): number {
    return this.seq;
  }

  /**
   * Start a session, or refuse with a named reason (`FR-088`, TC-104).
   *
   * The profile is bound here and never changes for the life of the session
   * (ADR-013): the transcript belongs to the profile whose notes produced it.
   */
  async start(request: StartRequest): Promise<ActiveSession> {
    if (this.active !== null) throw new SessionStartRefused('session-active');
    if (!request.profile) throw new SessionStartRefused('no-active-profile');
    if (!request.sttKeyPresent) throw new SessionStartRefused('stt-key-missing');
    if (!request.llmKeyPresent) throw new SessionStartRefused('llm-key-missing');

    const id = this.newSessionId();
    const startedAt = this.now().toISOString();
    const dir = sessionsDir(this.userDataDir, request.profile.id);
    await mkdir(dir, { recursive: true });

    // The lock is taken before the file is opened. A lock held by a live
    // process refuses the start; a stale one is the recovery pass's to clear,
    // never this path's, or a crashed session would be silently overwritten.
    await this.acquireLock({
      sessionId: id,
      profileId: request.profile.id,
      pid: process.pid,
      startedAt,
    });

    try {
      this.handle = await open(join(dir, `${id}.ndjson`), 'a');
    } catch (err) {
      await rm(lockPath(this.userDataDir), { force: true });
      throw err;
    }

    this.seq = 0;
    this.usage = emptyUsage();
    this.active = {
      id,
      profileId: request.profile.id,
      profileNameSnapshot: request.profile.name,
      startedAt,
    };
    return this.active;
  }

  /**
   * Append one entry and resolve when it is on disk (`FR-105`, `FR-106`).
   *
   * Awaitable because the LLM layer has to await the cancelled generation's
   * append before the replacing one starts, and because "within 2 seconds" is
   * met by writing now rather than by a flush timer that can be outlived by a
   * crash.
   */
  append(entry: TranscriptEntryInput): Promise<number> {
    if (!this.active || !this.handle) {
      return Promise.reject(new Error('No session is active.'));
    }
    const seq = this.seq;
    this.seq += 1;
    const line = `${JSON.stringify({ seq, ...entry } as TranscriptEntry)}\n`;
    const handle = this.handle;

    // One `write()` of one complete line, so a crash can lose a line but cannot
    // tear one (FR-107).
    this.writeChain = this.writeChain.then(async () => {
      await handle.write(line);
    });
    return this.writeChain.then(() => seq);
  }

  /** A transcript turn. Text only: the type cannot express audio (FR-101). */
  appendTurn(source: TranscriptSource, text: string): Promise<number> {
    return this.append({ kind: 'turn', source, text, at: this.now().toISOString() });
  }

  /** A generated suggestion, including a cancelled one and its partial bullets. */
  appendSuggestion(entry: {
    forQuestion: string;
    bullets: string[];
    model: string;
    providerId: string;
    status: 'complete' | 'cancelled' | 'nonconforming';
  }): Promise<number> {
    return this.append({ kind: 'suggestion', ...entry, at: this.now().toISOString() });
  }

  /** The Cost Meter hands usage over in memory. It never writes (ADR-018). */
  noteUsage(usage: UsageRecord): void {
    this.usage = usage;
  }

  /**
   * Stop cleanly: compact the `.ndjson` into `<sessionId>.json`, delete it, and
   * release the lock.
   */
  async stop(endReason: 'user' = 'user'): Promise<Session | null> {
    const active = this.active;
    if (!active || !this.handle) return null;

    // Every pending append lands before the handle closes, or the last entry of
    // the session is the one that goes missing.
    await this.writeChain.catch(() => {});
    await this.handle.close();
    this.handle = null;
    this.active = null;

    const session = await compactSession({
      dir: sessionsDir(this.userDataDir, active.profileId),
      id: active.id,
      profileId: active.profileId,
      profileNameSnapshot: active.profileNameSnapshot,
      startedAt: active.startedAt,
      endedAt: this.now().toISOString(),
      endReason,
      usage: this.usage,
    });

    await rm(lockPath(this.userDataDir), { force: true });
    return session;
  }

  /**
   * Startup recovery (`FR-105`, `FR-107`, `FR-108`).
   *
   * Any `.ndjson` left on disk means the process died during a session. Each is
   * compacted with `endReason: 'crash-recovered'` so it appears in Session
   * History rather than being lost or left as a file nothing reads. A stale
   * lock is cleared here, which is the only place it is cleared.
   */
  async recover(profileIds: readonly string[]): Promise<Session[]> {
    const recovered: Session[] = [];

    for (const profileId of profileIds) {
      const dir = sessionsDir(this.userDataDir, profileId);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        // A profile with no sessions folder has nothing to recover.
        continue;
      }

      for (const name of names) {
        if (!name.endsWith('.ndjson')) continue;
        const id = name.slice(0, -'.ndjson'.length);
        try {
          const session = await this.recoverOne(dir, id);
          if (session) recovered.push(session);
        } catch (err) {
          // One unreadable session must not stop the rest from being recovered.
          this.onError('session recovery failed', { profileId, id, err });
        }
      }
    }

    // Cleared unconditionally: reaching recovery means no session of ours is
    // running, so any lock on disk is from a process that is gone (FR-108).
    await rm(lockPath(this.userDataDir), { force: true });
    return recovered;
  }

  private async recoverOne(dir: string, id: string): Promise<Session | null> {
    const jsonPath = join(dir, `${id}.json`);
    const ndjsonPath = join(dir, `${id}.ndjson`);

    // A clean stop that died between writing the .json and deleting the
    // .ndjson. The .json wins and the .ndjson goes (FR-107).
    const existing = await readJsonSession(jsonPath);
    if (existing) {
      await rm(ndjsonPath, { force: true });
      return null;
    }

    const parsed = await readNdjson(ndjsonPath);
    const session: Session = {
      id,
      profileId: parsed.profileId,
      profileNameSnapshot: parsed.profileNameSnapshot,
      startedAt: parsed.startedAt ?? this.now().toISOString(),
      endedAt: this.now().toISOString(),
      entries: parsed.entries,
      usage: emptyUsage(),
      endReason: 'crash-recovered',
    };
    await writeSessionJson(dir, session);
    await rm(ndjsonPath, { force: true });
    return session;
  }

  /**
   * Takes the lock, or refuses when a live process holds it.
   *
   * `wx` is the check and the write in one step, so two starts racing cannot
   * both believe they won.
   */
  private async acquireLock(contents: LockContents): Promise<void> {
    const path = lockPath(this.userDataDir);
    try {
      const handle = await open(
        path,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      );
      await handle.write(JSON.stringify(contents));
      await handle.close();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new SessionStartRefused('session-active');
      }
      throw err;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Compaction and reading
 * ------------------------------------------------------------------ */

/** The fields a compacted session needs that the `.ndjson` does not carry. */
interface CompactRequest {
  dir: string;
  id: string;
  profileId: string;
  profileNameSnapshot: string;
  startedAt: string;
  endedAt: string;
  endReason: 'user' | 'crash-recovered';
  usage: UsageRecord;
}

async function compactSession(request: CompactRequest): Promise<Session> {
  const parsed = await readNdjson(join(request.dir, `${request.id}.ndjson`));
  const session: Session = {
    id: request.id,
    profileId: request.profileId,
    profileNameSnapshot: request.profileNameSnapshot,
    startedAt: request.startedAt,
    endedAt: request.endedAt,
    entries: parsed.entries,
    usage: request.usage,
    endReason: request.endReason,
  };
  await writeSessionJson(request.dir, session);
  await rm(join(request.dir, `${request.id}.ndjson`), { force: true });
  return session;
}

/**
 * Written through a temporary file and renamed, so a crash during compaction
 * cannot leave a half-written `.json` that the `.ndjson` has already been
 * deleted for.
 */
async function writeSessionJson(dir: string, session: Session): Promise<void> {
  const finalPath = join(dir, `${session.id}.json`);
  const tempPath = `${finalPath}.tmp`;
  await writeFile(tempPath, JSON.stringify(session, null, 2), 'utf8');
  await rename(tempPath, finalPath);
}

interface ParsedNdjson {
  entries: TranscriptEntry[];
  profileId: string;
  profileNameSnapshot: string;
  startedAt: string | null;
}

/**
 * Reads an `.ndjson` transcript, discarding an unparseable final line
 * (`FR-107`, TC-135).
 *
 * Only the **final** line may be discarded. A torn line anywhere else would
 * mean the writer did not write whole lines, which is a defect rather than a
 * crash, and silently dropping it would hide that.
 */
export async function readNdjson(path: string): Promise<ParsedNdjson> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { entries: [], profileId: '', profileNameSnapshot: '', startedAt: null };
  }

  const lines = raw.split('\n').filter((line) => line.trim() !== '');
  const entries: TranscriptEntry[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const entry = parseEntry(lines[i] ?? '');
    if (entry) {
      entries.push(entry);
      continue;
    }
    // A torn tail is the crash signature: the process died mid-write.
    if (i === lines.length - 1) break;
    throw new Error(`Transcript line ${String(i + 1)} is malformed, and it is not the last line.`);
  }

  // Order is `seq` order, not file order (ADR-018).
  entries.sort((a, b) => a.seq - b.seq);
  return {
    entries,
    profileId: '',
    profileNameSnapshot: '',
    startedAt: entries[0]?.at ?? null,
  };
}

function parseEntry(line: string): TranscriptEntry | null {
  try {
    const value = JSON.parse(line) as Partial<TranscriptEntry>;
    if (typeof value.seq !== 'number') return null;
    if (value.kind !== 'turn' && value.kind !== 'suggestion') return null;
    return value as TranscriptEntry;
  } catch {
    return null;
  }
}

async function readJsonSession(path: string): Promise<Session | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Session;
  } catch {
    return null;
  }
}

/** Session History for one profile, newest first (`FR-101`). */
export async function listSessions(
  userDataDir: string,
  profileId: string,
): Promise<SessionSummary[]> {
  const dir = sessionsDir(userDataDir, profileId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const summaries: SessionSummary[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const session = await readJsonSession(join(dir, name));
    if (!session) continue;
    summaries.push({
      id: session.id,
      profileId: session.profileId,
      profileNameSnapshot: session.profileNameSnapshot,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      entryCount: session.entries.length,
      estimatedUsd: session.usage.estimatedUsd,
      endReason: session.endReason,
    });
  }
  return summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** One session's full transcript (`FR-101`). */
export async function readSession(
  userDataDir: string,
  profileId: string,
  sessionId: string,
): Promise<Session | null> {
  return readJsonSession(join(sessionsDir(userDataDir, profileId), `${sessionId}.json`));
}

/** Delete one session and its transcript. The user owns the retention (ADR-003). */
export async function deleteSession(
  userDataDir: string,
  profileId: string,
  sessionId: string,
): Promise<void> {
  const dir = sessionsDir(userDataDir, profileId);
  await rm(join(dir, `${sessionId}.json`), { force: true });
  await rm(join(dir, `${sessionId}.ndjson`), { force: true });
}
