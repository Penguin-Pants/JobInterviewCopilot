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
import { join } from 'node:path';
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
   * @returns null when the profile does not exist or its index is unreadable. An
   * unreadable index is not fatal: `kb/` is the authority, so the reconciliation
   * pass can rebuild the index from the folder (ADR-014).
   */
  get(profileId: string): Profile | null {
    // An unsafe id is answered as "no such profile" rather than thrown, so the
    // IPC guard that calls this reads as a lookup miss and the renderer gets the
    // same message for a malicious id as for a stale one.
    if (!SAFE_ID.test(profileId)) return null;
    const file = this.profileFile(profileId);
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Profile>;
      if (typeof parsed?.id !== 'string' || typeof parsed.name !== 'string') return null;
      return {
        id: parsed.id,
        name: parsed.name,
        createdAt:
          typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date(0).toISOString(),
        // kbPath is absolute and userData can move between installs, so it is
        // recomputed on every read rather than trusted from the file.
        kbPath: this.kbDir(profileId),
        // A missing or non-array `documents` made every later `.find` and
        // `.findIndex` throw a TypeError up through `reconcile` and out of
        // `start`. `kb/` is the authority, so an empty index is not a loss:
        // reconciliation rebuilds it (ADR-014).
        documents: Array.isArray(parsed.documents) ? parsed.documents : [],
      };
    } catch {
      return null;
    }
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
   * @returns the stored record, or null when the profile is gone. A document
   * whose profile was deleted mid-import is dropped rather than recreating the
   * profile directory the user just asked to be removed.
   */
  upsertDocument(record: DocumentRecord): DocumentRecord | null {
    const profile = this.get(record.profileId);
    if (!profile) return null;
    const stamped: DocumentRecord = { ...record, updatedAt: new Date().toISOString() };
    const index = profile.documents.findIndex((d) => d.id === record.id);
    if (index === -1) profile.documents.push(stamped);
    else profile.documents[index] = stamped;
    this.write(profile);
    return stamped;
  }

  /** Remove a document record and the derived files that belong to it (FR-077). */
  removeDocument(profileId: string, docId: string): void {
    const profile = this.get(profileId);
    if (profile) {
      profile.documents = profile.documents.filter((d) => d.id !== docId);
      this.write(profile);
    }
    this.deleteChunkSet(profileId, docId);
    rmSync(this.derivedMarkdownPath(profileId, docId), { force: true });
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
   * @returns null when either file is missing, unparseable, when the two files
   * carry different `pairId`s, when the vector row count disagrees with the
   * chunk count, or when a chunk row is not a chunk. The caller discards both and
   * re-embeds. Serving a partial result would answer a query with vectors that
   * belong to different text, which looks like a bad model rather than a bad
   * read.
   */
  readChunkSet(profileId: string, docId: string): ChunkSet | null {
    const chunksPath = this.chunksPath(profileId, docId);
    const vectorsPath = this.vectorsPath(profileId, docId);
    if (!existsSync(chunksPath) || !existsSync(vectorsPath)) return null;

    let chunks: Chunk[];
    let pairId: string;
    try {
      const parsed: unknown = JSON.parse(readFileSync(chunksPath, 'utf8'));
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

    const bytes = readFileSync(vectorsPath);
    const stride = this.options.dimensions;
    const vectorBytes = chunks.length * stride * Float32Array.BYTES_PER_ELEMENT;
    if (bytes.byteLength !== vectorBytes + PAIR_ID_BYTES) return null;
    // The identity check, not the size check, is what catches a crash between
    // the two renames when the edit did not change the chunk count.
    if (bytes.subarray(vectorBytes).toString('ascii') !== pairId) return null;

    // Copy rather than view the Buffer: a Node Buffer can be a slice of a shared
    // pool, so a view would read whatever else that pool holds.
    const vectors = new Float32Array(chunks.length * stride);
    for (let i = 0; i < vectors.length; i += 1) {
      vectors[i] = bytes.readFloatLE(i * Float32Array.BYTES_PER_ELEMENT);
    }
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
