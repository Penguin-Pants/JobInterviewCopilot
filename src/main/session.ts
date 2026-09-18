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
import { open, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sessionSchema } from '../shared/ipc.js';
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
    estimateIncomplete: false,
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

/**
 * A session id that is safe to put in a path (`CH-115`, `CH-116`).
 *
 * The ids this app mints are uuids, but a session id also arrives from a
 * renderer and from the `id` field of a file on disk the user can edit.
 * Interpolating one straight into a path allows traversal: deleting a session
 * whose id is `../../../settings` would remove `settings.json` at the
 * `userData` root. No dot and no separator can appear, so no sequence of
 * components can leave the sessions folder.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafeSessionId(sessionId: string): boolean {
  return SAFE_SESSION_ID.test(sessionId);
}

function assertSafeSessionId(sessionId: string): string {
  if (!isSafeSessionId(sessionId)) {
    throw new Error(`"${sessionId}" is not a valid session id.`);
  }
  return sessionId;
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

/**
 * What a crash-recovered session cannot learn from its transcript (`FR-101`).
 *
 * Every `.ndjson` line is a transcript entry, so the profile the session was
 * bound to, the name it had at the time and the real start time are nowhere in
 * it. Recovering without them left every crash-recovered session with a blank
 * profile label in Session History and a `startedAt` of whenever the first turn
 * happened to be spoken, or of the recovery itself for a session that crashed
 * before anyone said anything.
 *
 * Written once at start, beside the transcript, and deleted on a clean stop.
 */
interface SessionMeta {
  profileId: string;
  profileNameSnapshot: string;
  startedAt: string;
}

function metaPath(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}.meta.json`);
}

async function readMeta(dir: string, sessionId: string): Promise<SessionMeta | null> {
  try {
    const parsed = JSON.parse(await readFile(metaPath(dir, sessionId), 'utf8')) as SessionMeta;
    if (typeof parsed.profileId !== 'string' || typeof parsed.startedAt !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
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

    const meta: SessionMeta = {
      profileId: request.profile.id,
      profileNameSnapshot: request.profile.name,
      startedAt,
    };

    try {
      // The sidecar first: a crash between these two writes leaves metadata
      // with no transcript, which recovery ignores, rather than a transcript
      // with no idea which profile it belongs to.
      await writeFile(metaPath(dir, id), JSON.stringify(meta), 'utf8');
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
    //
    // The chain is continued from a settled predecessor rather than from its
    // success. Attaching to `.then` alone poisons it: one rejected write skips
    // every later callback, so an ENOSPC that clears would still leave the rest
    // of the interview, and every later session in this process, writing
    // nothing. The caller still sees its own write's failure, because that is
    // the promise returned.
    const write = this.writeChain.then(
      () => handle.write(line),
      () => handle.write(line),
    );
    this.writeChain = write.then(
      () => undefined,
      () => undefined,
    );
    return write.then(() => seq);
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
    status: 'complete' | 'cancelled' | 'nonconforming' | 'stale';
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
    await this.writeChain;
    await this.handle.close();
    this.handle = null;

    // `active` is cleared only once compaction has succeeded. Clearing it first
    // left a failed compaction unrecoverable: `stop` saw no active session and
    // refused to retry, while `start` was refused by the lock the failure had
    // left behind, so the app could do neither until it was restarted.
    const dir = sessionsDir(this.userDataDir, active.profileId);
    let session: Session;
    try {
      session = await compactSession({
        dir,
        id: active.id,
        profileId: active.profileId,
        profileNameSnapshot: active.profileNameSnapshot,
        startedAt: active.startedAt,
        endedAt: this.now().toISOString(),
        endReason,
        usage: this.usage,
      });
    } catch (err) {
      // Re-open for append so a retry can still add to the transcript, and keep
      // the lock: the session is not over until its transcript is safe.
      this.handle = await open(join(dir, `${active.id}.ndjson`), 'a');
      throw err;
    }

    this.active = null;
    await rm(metaPath(dir, active.id), { force: true });
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
  async recover(profiles: readonly { id: string; name: string }[]): Promise<Session[]> {
    const recovered: Session[] = [];

    for (const profile of profiles) {
      const profileId = profile.id;
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
        if (!isSafeSessionId(id)) continue;
        try {
          const session = await this.recoverOne(dir, id, profile);
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

  private async recoverOne(
    dir: string,
    id: string,
    profile: { id: string; name: string },
  ): Promise<Session | null> {
    const jsonPath = join(dir, `${id}.json`);
    const ndjsonPath = join(dir, `${id}.ndjson`);

    // A clean stop that died between writing the .json and deleting the
    // .ndjson. The .json wins and the .ndjson goes (FR-107).
    const existing = await readJsonSession(jsonPath);
    if (existing) {
      await rm(ndjsonPath, { force: true });
      await rm(metaPath(dir, id), { force: true });
      return null;
    }

    const parsed = await readNdjson(ndjsonPath);

    // The sidecar is the authority on the three things the transcript cannot
    // carry. Its absence is not fatal: the folder names the profile, and the
    // profile's current name and the first entry's time are the best remaining
    // answers rather than a blank label and a recovery timestamp.
    const meta = await readMeta(dir, id);
    const session: Session = {
      id,
      profileId: meta?.profileId ?? profile.id,
      profileNameSnapshot: meta?.profileNameSnapshot ?? profile.name,
      startedAt: meta?.startedAt ?? parsed.startedAt ?? this.now().toISOString(),
      endedAt: this.now().toISOString(),
      entries: parsed.entries,
      usage: emptyUsage(),
      endReason: 'crash-recovered',
    };
    await writeSessionJson(dir, session);
    await rm(ndjsonPath, { force: true });
    await rm(metaPath(dir, id), { force: true });
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
      // `wx` writes and closes in one call, so there is no handle to leak if
      // the write fails between opening and closing.
      await writeFile(path, JSON.stringify(contents), { encoding: 'utf8', flag: 'wx' });
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
  } catch (err) {
    // Only a missing file is an empty transcript. Treating every read failure
    // as emptiness turned a transient EACCES or EIO into permanent loss:
    // compaction wrote an empty `.json` and then deleted the `.ndjson` that
    // still held every entry.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { entries: [], profileId: '', profileNameSnapshot: '', startedAt: null };
    }
    throw err;
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

/**
 * Reads a compacted session, or returns null.
 *
 * Validated rather than cast. A file that is merely *parseable*, which a
 * hand-edited or half-written `{}` is, used to reach `listSessions`, where
 * reading `entries.length` threw and took the whole profile's Session History
 * with it, valid sessions included.
 */
async function readJsonSession(path: string): Promise<Session | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
  const result = sessionSchema.safeParse(parsed);
  return result.success ? (result.data as Session) : null;
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
    if (!name.endsWith('.json') || name.endsWith('.meta.json')) continue;
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
  if (!isSafeSessionId(sessionId)) return null;
  return readJsonSession(join(sessionsDir(userDataDir, profileId), `${sessionId}.json`));
}

/** Delete one session and its transcript. The user owns the retention (ADR-003). */
export async function deleteSession(
  userDataDir: string,
  profileId: string,
  sessionId: string,
): Promise<void> {
  // Checked before any path is built, never after. `rm` with a traversing id
  // would delete a file outside the sessions folder entirely.
  assertSafeSessionId(sessionId);
  const dir = sessionsDir(userDataDir, profileId);
  await rm(join(dir, `${sessionId}.json`), { force: true });
  await rm(join(dir, `${sessionId}.ndjson`), { force: true });
  await rm(metaPath(dir, sessionId), { force: true });
}
