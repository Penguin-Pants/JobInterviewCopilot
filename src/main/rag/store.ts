import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { documentRecordSchema } from '../../shared/ipc.js';
import type { Chunk, DocumentRecord, Profile } from '../../shared/types.js';

/**
 * Profile, chunk and vector persistence (TASK-020, TASK-022, TASK-024,
 * FR-063, FR-067, FR-069, FR-077, FR-078, ADR-014).
 *
 * The on-disk layout is `docs/02-architecture.md` section 2:
 *
 * ```
 * profiles/<profileId>/
 *   profile.json
 *   kb/
 *   derived/<docId>.md, <docId>.chunks.json, <docId>.vectors.bin
 *   sessions/
 * ```
 *
 * `kb/` is the authority for which documents exist; `profile.json` is a derived
 * index that the reconciliation pass rebuilds when the two disagree (ADR-014).
 * This module owns the bytes. It does not convert, chunk or embed, and it never
 * decides that a document needs re-processing.
 */

/** One retrieval hit (`docs/02-architecture.md` section 3.4). */
export interface RetrievedChunk {
  chunk: Chunk;
  score: number;
}

/** A document's chunks and their vectors, always read and written as a pair (FR-078). */
export interface ChunkSet {
  chunks: Chunk[];
  /** Flat, row-major, `chunks.length * dimensions` values, L2-normalized. */
  vectors: Float32Array;
}

/**
 * What `chunks.json` holds on disk (FR-078, ADR-014).
 *
 * The array used to be the whole file. It is wrapped now so the pair can carry a
 * `pairId`: see {@link ProfileStore.writeChunkSet} for why a row count alone is
 * not enough to tell a matched pair from a torn one.
 */
interface ChunkFile {
  pairId: string;
  chunks: Chunk[];
}

/** Bytes of `pairId` written as a trailer on `vectors.bin`. A uuid without dashes. */
const PAIR_ID_BYTES = 32;

/** Where the profiles live, and how wide a vector row is (FR-066, FR-069). */
export interface ProfileStoreOptions {
  /** `app.getPath('userData')`. Injected so tests never touch a real profile. */
  userDataDir: string;
  /** Vector width. Checked against every file read, so a model swap cannot alias rows. */
  dimensions: number;
}

/**
 * A uuid v4, the only shape this app mints for a profile or a document id.
 *
 * Every id that reaches a path here arrives from a renderer over IPC, and
 * `path.join` resolves `..` rather than rejecting it, so an id of `..` would
 * make `delete` remove the whole `profiles/` directory. Validating the shape
 * rather than merely stripping separators keeps the check total: `%2e%2e`, a
 * `\u0000` truncation and a Windows drive letter all fail it too.
 */
const SAFE_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Raised when an id could escape the directory it is supposed to address. */
export class UnsafeIdError extends Error {
  constructor(kind: 'profile' | 'document', value: string) {
    super(`Refusing to use "${value}" as a ${kind} id: it is not a uuid.`);
    this.name = 'UnsafeIdError';
  }
}

function assertSafeId(kind: 'profile' | 'document', value: string): string {
  if (!SAFE_ID.test(value)) throw new UnsafeIdError(kind, value);
  return value;
}

/**
 * The bytes under `profiles/<id>/` (FR-063, FR-067, FR-069, FR-077, FR-078).
 *
 * Owns profile indexes, document records, derived Markdown, `chunks.json` and
 * `vectors.bin`. It does not convert, chunk or embed, and it never decides that
 * a document needs re-processing.
 */
export class ProfileStore {
  private readonly root: string;
  /** Profiles recovered from an index that exists but could not be read. Never written. */
  private readonly unreadable = new WeakSet<Profile>();

  constructor(private readonly options: ProfileStoreOptions) {
    this.root = join(options.userDataDir, 'profiles');
    mkdirSync(this.root, { recursive: true });
  }

  /* ---------------------------------------------------------------- *
   * Paths
   * ---------------------------------------------------------------- */

  profileDir(profileId: string): string {
    return join(this.root, assertSafeId('profile', profileId));
  }

  /** The watched knowledge base folder. The user drops files here (FR-068, FR-077). */
  kbDir(profileId: string): string {
    return join(this.profileDir(profileId), 'kb');
  }

  derivedDir(profileId: string): string {
    return join(this.profileDir(profileId), 'derived');
  }

  sessionsDir(profileId: string): string {
    return join(this.profileDir(profileId), 'sessions');
  }

  private profileFile(profileId: string): string {
    return join(this.profileDir(profileId), 'profile.json');
  }

  /* ---------------------------------------------------------------- *
   * Profiles
   * ---------------------------------------------------------------- */

  /**
   * Create a profile and its whole directory tree (FR-069).
   *
   * `createdAt` is forced to be strictly later than every existing profile's.
   * Two profiles created in the same millisecond, which a "create three
   * profiles" click-through easily produces, would otherwise share a timestamp
   * and fall back to comparing random uuids, so the Dashboard's profile list
   * would reorder itself between launches for no visible reason.
   */
  create(name: string, id: string = randomUUID()): Profile {
    const newest = this.list().reduce<number>(
      (max, p) => Math.max(max, Date.parse(p.createdAt) || 0),
      0,
    );
    const createdAt = new Date(Math.max(Date.now(), newest + 1)).toISOString();

    const profile: Profile = {
      id,
      name,
      createdAt,
      kbPath: this.kbDir(id),
      documents: [],
    };
    for (const dir of [this.kbDir(id), this.derivedDir(id), this.sessionsDir(id)]) {
      mkdirSync(dir, { recursive: true });
    }
    this.write(profile);
    return profile;
  }

  /**
   * Read one profile.
   *
   * Every path in the result is computed from `profileId` and this store's
   * root, never read from the file. userData can move between installs and a
   * profile folder can be copied under a new id. Trusting the stored `id`
   * sent a copy's writes into the original's folder, and trusting a stored
   * `originalPath` made reconciliation see every document as gone after a move:
   * it dropped and re-embedded all of them and lost every doc type override.
   *
   * @returns null when the profile does not exist. An unreadable index is not
   * fatal: `kb/` is the authority, so the reconciliation pass can rebuild the
   * index from the folder (ADR-014).
   */
  get(profileId: string): Profile | null {
    // An unsafe id is answered as "no such profile" rather than thrown, so the
    // IPC guard that calls this reads as a lookup miss and the renderer gets the
    // same message for a malicious id as for a stale one.
    if (!SAFE_ID.test(profileId)) return null;
    let text: string;
    try {
      text = readFileSync(this.profileFile(profileId), 'utf8');
    } catch (err) {
      const recovered = this.recover(profileId, '');
      // Missing means there is no name to lose. Any other failure, an antivirus
      // lock or a permission change, may be hiding a good one, so this copy is
      // listed but never written back over the file (ADR-014).
      if (recovered && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.unreadable.add(recovered);
      }
      return recovered;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return this.recover(profileId, text);
    }
    const fields = (parsed ?? {}) as Partial<Record<keyof Profile, unknown>>;
    if (typeof fields.name !== 'string') return this.recover(profileId, text);
    return {
      id: profileId,
      name: fields.name,
      createdAt:
        typeof fields.createdAt === 'string' ? fields.createdAt : new Date(0).toISOString(),
      kbPath: this.kbDir(profileId),
      // A missing or non-array `documents` made every later `.find` and
      // `.findIndex` throw a TypeError up through `reconcile` and out of
      // `start`. `kb/` is the authority, so an empty index is not a loss:
      // reconciliation rebuilds it (ADR-014).
      documents: Array.isArray(fields.documents)
        ? this.readDocuments(profileId, fields.documents)
        : [],
    };
  }

  /**
   * The valid rows of a stored `documents` array, with their paths rebased.
   *
   * A row that fails the schema is dropped, not repaired. A `null` row made
   * `.find` throw out of reconcile, and the file is still in `kb/`, so the next
   * reconciliation adopts it again (ADR-014).
   */
  private readDocuments(profileId: string, rows: unknown[]): DocumentRecord[] {
    const documents: DocumentRecord[] = [];
    for (const row of rows) {
      const result = documentRecordSchema.safeParse(row);
      if (!result.success) continue;
      const record = result.data;
      // Both feed a path below, so both must stay inside their folder.
      if (!SAFE_ID.test(record.id) || !isPlainFileName(record.originalFileName)) continue;
      documents.push({
        ...record,
        profileId,
        originalPath: join(this.kbDir(profileId), record.originalFileName),
        derivedMarkdownPath:
          record.derivedMarkdownPath === null
            ? null
            : this.derivedMarkdownPath(profileId, record.id),
      });
    }
    return documents;
  }

  /**
   * Rebuild a profile whose index is missing or unreadable (ADR-014, FR-077).
   *
   * `profile.json` is a derived index and `kb/` is the authority, so a truncated
   * or corrupt index must not take the profile with it. Returning null here
   * dropped the whole profile from `list`, so reconciliation never scanned its
   * `kb/`, no watcher was started for it, `ensureActiveProfile` quietly selected
   * a different one, and every document in it became invisible.
   *
   * The presence of `kb/` is what distinguishes a real profile with a damaged
   * index from a leftover directory: `delete` removes `kb/` before it removes
   * the record, so an interrupted delete has no `kb/` and stays deleted.
   *
   * The name and creation time are read back from the damaged text where they
   * survive. The next write persists whatever this returns, so a placeholder
   * here used to replace the user's name for good. `write` puts both fields
   * before `documents`, so a truncated file almost always still has them.
   *
   * @returns a profile with an empty document list, which reconciliation refills
   * from `kb/`, or null when there is nothing to recover.
   */
  private recover(profileId: string, damaged: string): Profile | null {
    const kb = this.kbDir(profileId);
    if (!existsSync(kb)) return null;
    return {
      id: profileId,
      name: salvageString(damaged, 'name') ?? 'Recovered profile',
      createdAt: salvageString(damaged, 'createdAt') ?? new Date(0).toISOString(),
      kbPath: kb,
      documents: [],
    };
  }

  list(): Profile[] {
    if (!existsSync(this.root)) return [];
    return (
      readdirSync(this.root)
        .filter((entry) => {
          const full = join(this.root, entry);
          return existsSync(full) && statSync(full).isDirectory();
        })
        .map((id) => this.get(id))
        .filter((p): p is Profile => p !== null)
        // Creation order. The id tie-break is a last resort that `create` makes
        // unreachable for profiles this app created; it only orders a hand-edited
        // directory deterministically rather than arbitrarily.
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    );
  }

  /** Persist a profile index. Atomic: write to temp, then rename (FR-078). */
  write(profile: Profile): void {
    mkdirSync(this.profileDir(profile.id), { recursive: true });
    writeAtomic(this.profileFile(profile.id), JSON.stringify(profile, null, 2));
  }

  /** Whether this profile still has an index on disk. Public for the engine's guards. */
  hasProfile(profileId: string): boolean {
    return this.exists(profileId);
  }

  /**
   * Delete a profile and everything belonging to it (FR-069, TC-160).
   *
   * Content first, record last. An interrupted delete must never leave document
   * or transcript content on disk with the profile record already gone: that
   * state is unreachable by any UI, so nothing would ever clean it up. The
   * reverse, a record whose content is partly gone, is recoverable because `kb/`
   * is the authority and reconciliation rebuilds the index from it (ADR-014).
   */
  delete(profileId: string): void {
    const dir = this.profileDir(profileId);
    if (!existsSync(dir)) return;
    // Belt and braces: `profileDir` already refused a non-uuid, and this method
    // is the one that calls `rmSync` recursively.
    assertSafeId('profile', profileId);

    for (const child of ['kb', 'derived', 'sessions']) {
      rmSync(join(dir, child), { recursive: true, force: true });
    }
    // Anything else the directory picked up, still before the record.
    for (const entry of readdirSync(dir)) {
      if (entry === 'profile.json') continue;
      rmSync(join(dir, entry), { recursive: true, force: true });
    }
    rmSync(this.profileFile(profileId), { force: true });
    rmSync(dir, { recursive: true, force: true });
  }

  /* ---------------------------------------------------------------- *
   * Document records
   * ---------------------------------------------------------------- */

  findDocument(profileId: string, docId: string): DocumentRecord | null {
    return this.get(profileId)?.documents.find((d) => d.id === docId) ?? null;
  }

  /**
   * Insert or replace one document record, stamping `updatedAt`.
   *
   * The engine inserts only to adopt a file that had no record. A later
   * transition goes through {@link updateDocument}.
   *
   * @returns the stored record, or null when the profile is gone or its index
   * cannot be read. A document whose profile was deleted mid-import is dropped
   * rather than recreating the profile directory the user just asked to be
   * removed.
   */
  upsertDocument(record: DocumentRecord): DocumentRecord | null {
    const profile = this.writable(record.profileId);
    if (!profile) return null;
    const stamped: DocumentRecord = { ...record, updatedAt: new Date().toISOString() };
    const index = profile.documents.findIndex((d) => d.id === record.id);
    if (index === -1) profile.documents.push(stamped);
    else profile.documents[index] = stamped;
    this.write(profile);
    return stamped;
  }

  /**
   * Replace one existing document record, stamping `updatedAt`.
   *
   * Every mid-ingest transition goes through here rather than through
   * {@link upsertDocument}. An ingest runs across several awaits, and a document
   * deleted during one of them must stay deleted: an insert brought it back,
   * embedded it and published it `ready` (FR-077).
   *
   * @returns the stored record, or null when the profile or the record is gone,
   * or the index cannot be read.
   */
  updateDocument(record: DocumentRecord): DocumentRecord | null {
    const profile = this.writable(record.profileId);
    if (!profile) return null;
    const index = profile.documents.findIndex((d) => d.id === record.id);
    if (index === -1) return null;
    const stamped: DocumentRecord = { ...record, updatedAt: new Date().toISOString() };
    profile.documents[index] = stamped;
    this.write(profile);
    return stamped;
  }

  /**
   * True when the profile's index exists but cannot be read right now (ADR-014).
   *
   * Every write is refused while this holds, so a reconciliation pass would
   * convert and embed every document only to discard the result. The engine
   * waits and tries the pass again instead.
   */
  isIndexUnreadable(profileId: string): boolean {
    const profile = this.get(profileId);
    return profile !== null && this.unreadable.has(profile);
  }

  /** {@link get}, or null when writing the result back would overwrite an unreadable index. */
  private writable(profileId: string): Profile | null {
    const profile = this.get(profileId);
    return profile && !this.unreadable.has(profile) ? profile : null;
  }

  /** Remove a document record and the derived files that belong to it (FR-077). */
  removeDocument(profileId: string, docId: string): void {
    const profile = this.writable(profileId);
    if (profile) {
      profile.documents = profile.documents.filter((d) => d.id !== docId);
      this.write(profile);
    }
    this.deleteChunkSet(profileId, docId);
    rmSync(this.derivedMarkdownPath(profileId, docId), { force: true });
  }

  /**
   * Remove derived files that no record in the index owns (FR-069, ADR-014).
   *
   * A row dropped by {@link readDocuments} loses its record, and its file in
   * `kb/` is adopted again under a new id. Nothing then names the old id, so
   * its Markdown, chunks and vectors stayed in `derived/` forever.
   *
   * Synchronous from the listing to the last removal, so no ingest can run in
   * between. An ingest stores its record before it writes a derived file, so a
   * file listed here whose id is not in the index really is an orphan. Skipped
   * when the index cannot be read, because its document list is then empty.
   */
  pruneDerived(profileId: string): void {
    const profile = this.writable(profileId);
    if (!profile) return;
    const owned = new Set(profile.documents.map((d) => d.id));
    const dir = this.derivedDir(profileId);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // No derived folder yet.
    }
    for (const entry of entries) {
      // `<docId>.md`, `<docId>.chunks.json`, `<docId>.vectors.bin`, each with
      // an optional `.tmp`. A name that is not ours is left alone.
      const id = entry.slice(0, entry.indexOf('.'));
      if (!SAFE_ID.test(id) || owned.has(id)) continue;
      rmSync(join(dir, entry), { force: true });
    }
  }

  /* ---------------------------------------------------------------- *
   * Chunks and vectors
   * ---------------------------------------------------------------- */

  chunksPath(profileId: string, docId: string): string {
    return join(this.derivedDir(profileId), `${assertSafeId('document', docId)}.chunks.json`);
  }

  vectorsPath(profileId: string, docId: string): string {
    return join(this.derivedDir(profileId), `${assertSafeId('document', docId)}.vectors.bin`);
  }

  derivedMarkdownPath(profileId: string, docId: string): string {
    return join(this.derivedDir(profileId), `${assertSafeId('document', docId)}.md`);
  }

  /**
   * True when the profile still has an index on disk.
   *
   * Every write below checks it. An ingest that started before a profile was
   * deleted keeps running afterwards, and its `mkdirSync` would recreate
   * `profiles/<id>/derived/` and fill it with chunks and vectors for a profile
   * the user just deleted. Nothing would ever clean that up, and `FR-069`
   * promises no document content survives anywhere under `userData`.
   */
  private exists(profileId: string): boolean {
    return SAFE_ID.test(profileId) && existsSync(this.profileFile(profileId));
  }

  /** Raised when a write arrives for a profile that has been deleted (FR-069). */
  static readonly DELETED = 'profile-deleted';

  writeDerivedMarkdown(profileId: string, docId: string, markdown: string): string | null {
    if (!this.exists(profileId)) return null;
    const path = this.derivedMarkdownPath(profileId, docId);
    mkdirSync(this.derivedDir(profileId), { recursive: true });
    writeAtomic(path, markdown);
    return path;
  }

  /**
   * Write a document's chunks and vectors as one pair (FR-078, ADR-014).
   *
   * Both files go to a temp name and are renamed only after both are fully
   * written. Rename is the atomic step on NTFS and ext4; `writeFileSync` is not.
   *
   * **Two renames are still not one atomic operation**, and the row-count check
   * on read does not close that window. Consider a ready document of 12 chunks
   * whose user fixes a typo and saves: the re-embed produces 12 new chunks and 12
   * new vectors, and a crash between the two renames leaves the new `chunks.json`
   * beside the old `vectors.bin`. The counts match, so the pair reads as valid
   * forever, retrieval ranks the new text by the old text's vectors, and nothing
   * anywhere reports an error. Every edit that preserves the chunk count is
   * invisible to a count check.
   *
   * So the pair carries an identity, not just a size. Each write mints a
   * `pairId`, stores it in `chunks.json` and appends it to `vectors.bin`; a read
   * that finds two different ids discards both and re-embeds, which is what
   * ADR-014 already prescribes for a torn pair.
   *
   * @returns false when the profile was deleted while this write was being
   * prepared, so nothing is written for a profile that no longer exists (FR-069).
   */
  writeChunkSet(profileId: string, docId: string, chunks: Chunk[], vectors: Float32Array): boolean {
    const expected = chunks.length * this.options.dimensions;
    if (vectors.length !== expected) {
      throw new Error(
        `Refusing to write ${docId}: ${chunks.length} chunks need ${expected} floats, ` +
          `received ${vectors.length}.`,
      );
    }
    // Deleted mid-ingest: writing now would recreate the directory tree the user
    // just removed and leave vectors nothing owns (FR-069).
    if (!this.exists(profileId)) return false;
    mkdirSync(this.derivedDir(profileId), { recursive: true });

    const pairId = randomUUID().replace(/-/g, '');
    const chunksTmp = `${this.chunksPath(profileId, docId)}.tmp`;
    const vectorsTmp = `${this.vectorsPath(profileId, docId)}.tmp`;

    try {
      const file: ChunkFile = { pairId, chunks };
      writeFileSync(chunksTmp, JSON.stringify(file));
      writeFileSync(
        vectorsTmp,
        Buffer.concat([
          Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength),
          Buffer.from(pairId, 'ascii'),
        ]),
      );
      renameSync(chunksTmp, this.chunksPath(profileId, docId));
      renameSync(vectorsTmp, this.vectorsPath(profileId, docId));
    } catch (err) {
      // A failed second write, ENOSPC being the usual one, would otherwise leave
      // an orphaned .tmp in derived/ that nothing ever collects.
      rmSync(chunksTmp, { force: true });
      rmSync(vectorsTmp, { force: true });
      throw err;
    }
    return true;
  }

  /**
   * Read a document's chunks and vectors (FR-078, TC-141).
   *
   * Async, because the query cache is rebuilt from here and a sync read of
   * every vector file blocked the main thread inside the question-to-suggestion
   * budget (NFR-001).
   *
   * @returns null when either file is missing, unparseable, when the two files
   * carry different `pairId`s, when the vector row count disagrees with the
   * chunk count, or when a chunk row is not a chunk. The caller discards both and
   * re-embeds. Serving a partial result would answer a query with vectors that
   * belong to different text, which looks like a bad model rather than a bad
   * read. Any read failure other than ENOENT throws, so a caller can tell "not
   * there" from "cannot be reached" (ADR-036).
   */
  async readChunkSet(profileId: string, docId: string): Promise<ChunkSet | null> {
    // No `existsSync` first. A delete between the check and the read threw a
    // raw ENOENT out of `query`; a missing file is simply a missing pair.
    const text = await readUnlessMissing(this.chunksPath(profileId, docId));
    if (text === null) return null;

    let chunks: Chunk[];
    let pairId: string;
    try {
      const parsed: unknown = JSON.parse(text.toString('utf8'));
      const file = parsed as Partial<ChunkFile>;
      if (typeof file?.pairId !== 'string' || !Array.isArray(file.chunks)) return null;
      // Every row, not just the array. A file truncated to a valid JSON prefix or
      // hand-edited passed the array check and the byte-length check, and the
      // first query then threw a TypeError out of `query` and past its try/catch,
      // onto the live-session IPC path.
      if (!file.chunks.every(isChunk)) return null;
      chunks = file.chunks;
      pairId = file.pairId;
    } catch {
      return null;
    }

    const bytes = await readUnlessMissing(this.vectorsPath(profileId, docId));
    if (bytes === null) return null;
    const stride = this.options.dimensions;
    const vectorBytes = chunks.length * stride * Float32Array.BYTES_PER_ELEMENT;
    if (bytes.byteLength !== vectorBytes + PAIR_ID_BYTES) return null;
    // The identity check, not the size check, is what catches a crash between
    // the two renames when the edit did not change the chunk count.
    if (bytes.subarray(vectorBytes).toString('ascii') !== pairId) return null;

    // One copy into a fresh, aligned buffer, then a typed view over it. A view
    // straight over the Buffer is unsafe: it can be a slice of a shared pool at
    // an offset that is not a multiple of 4. Byte order is native, which is how
    // `writeChunkSet` wrote it.
    const vectors = new Float32Array(chunks.length * stride);
    new Uint8Array(vectors.buffer).set(bytes.subarray(0, vectorBytes));
    return { chunks, vectors };
  }

  deleteChunkSet(profileId: string, docId: string): void {
    for (const path of [this.chunksPath(profileId, docId), this.vectorsPath(profileId, docId)]) {
      rmSync(path, { force: true });
      rmSync(`${path}.tmp`, { force: true });
    }
  }
}

/**
 * Whether a parsed row really is a `Chunk` (FR-063).
 *
 * Checks the fields retrieval and the prompt actually read, so a row that
 * survives is a row `topK` and the Dashboard can use without a type assertion
 * doing the work.
 */
function isChunk(value: unknown): value is Chunk {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Partial<Chunk>;
  return (
    typeof c.id === 'string' &&
    typeof c.docId === 'string' &&
    typeof c.profileId === 'string' &&
    typeof c.index === 'number' &&
    typeof c.text === 'string' &&
    Array.isArray(c.headerPath) &&
    c.headerPath.every((h) => typeof h === 'string') &&
    typeof c.docType === 'string' &&
    typeof c.sourceFile === 'string' &&
    typeof c.tokenCount === 'number'
  );
}

/** A whole file, or null when it does not exist. Any other failure throws. */
async function readUnlessMissing(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** A bare file name: no separator, no `.` or `..`, so a join stays in its folder. */
function isPlainFileName(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !/[\\/\0]/.test(name);
}

/** The first string value of `key` in possibly truncated JSON, or null. */
function salvageString(text: string, key: string): string | null {
  const match = new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(text);
  if (!match?.[1]) return null;
  try {
    const value: unknown = JSON.parse(match[1]);
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Write a text file through a temp name and one rename (FR-078). */
function writeAtomic(path: string, contents: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, contents, 'utf8');
  renameSync(tmp, path);
}

/**
 * Top-k by dot product over L2-normalized vectors (TASK-024, FR-065, ASM-006).
 *
 * A dot product of normalized vectors is the cosine similarity, which is why
 * normalization happens once at write time rather than per query.
 *
 * A row whose score is not finite is skipped rather than ranked, so a corrupted
 * `vectors.bin` costs that row and not the whole result.
 *
 * No doc-type weighting exists here, deliberately (ASM-006, TC-076): two chunks
 * with equal similarity and different doc types score identically. Ordering
 * among equal scores falls back to chunk id, so the result is stable across runs
 * rather than depending on directory iteration order.
 *
 * Brute force over the profile's chunks. At the 5000-chunk ceiling that is about
 * two million multiply-adds, comfortably inside the 50 ms budget (TC-078), and
 * an index would be a data structure to invalidate on every file change.
 */
export function topK(
  query: Float32Array,
  candidates: ChunkSet[],
  k: number,
  dimensions: number,
): RetrievedChunk[] {
  if (k <= 0 || query.length !== dimensions) return [];

  const scored: RetrievedChunk[] = [];
  for (const set of candidates) {
    for (let row = 0; row < set.chunks.length; row += 1) {
      const chunk = set.chunks[row];
      if (!chunk) continue;
      const base = row * dimensions;
      let score = 0;
      for (let d = 0; d < dimensions; d += 1) {
        score += (query[d] ?? 0) * (set.vectors[base + d] ?? 0);
      }
      // A non-finite score is dropped, not ranked. `NaN` makes the comparator
      // below return `NaN`, which is falsy, so the sort falls through to the id
      // tie-break and one poisoned row takes the whole top k for every question.
      // `l2Normalize` keeps NaN out of what this app writes; `vectors.bin` is
      // still a file on disk that something else can corrupt.
      if (!Number.isFinite(score)) continue;
      scored.push({ chunk, score });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));
  return scored.slice(0, k);
}
