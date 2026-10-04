import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { KB_INGEST_LIMITS } from '../shared/defaults.js';
import { EMBEDDING_MODEL } from '../shared/registry/embedding.js';
import type { DocType, DocumentRecord, DocumentState, Profile } from '../shared/types.js';
import { guessDocType } from './rag/autotag.js';
import { CHUNKER_VERSION, chunkMarkdown, ensureHeadings } from './rag/chunk.js';
import {
  ConversionError,
  convertToMarkdown,
  sourceFormatFor,
  SUPPORTED_EXTENSIONS,
  type ConversionResult,
  type SourceFormat,
} from './rag/convert.js';
import {
  contentHashFor,
  embeddingKeyFor,
  XenovaEmbedder,
  type Embedder,
  type ModelDownloadState,
} from './rag/embed.js';
import { ProfileStore, topK, type ChunkSet, type RetrievedChunk } from './rag/store.js';
import { IngestQueue, KnowledgeBaseWatcher, type WatcherFactory } from './rag/watch.js';

/**
 * The RAG engine facade (CMP-06, TASK-020 to TASK-025).
 *
 * The only public entry point into `src/main/rag/`. The ESLint `no-restricted-imports`
 * rule enforces that, so "the RAG engine must not know about sessions" stays a
 * linted property rather than a convention.
 *
 * The engine knows about profiles, documents, chunks and vectors. It does not
 * know about sessions, the trigger, the LLM or any renderer. Everything it wants
 * to tell a renderer leaves through the two callbacks below, which `index.ts`
 * forwards to `CH-213` and `CH-214`.
 */

/** One retrieval hit, re-exported so callers need not reach past the facade (FR-065). */
export type { RetrievedChunk } from './rag/store.js';

/**
 * The knowledge base could not be searched (ADR-036).
 *
 * Distinct from an empty result on purpose: `[]` says the notes were searched
 * and nothing matched, this says they could not be reached. The live loop
 * abandons the turn on it rather than answering from no notes (ADR-035).
 */
export class RetrievalUnavailableError extends Error {
  constructor(
    reason: string,
    readonly detail?: unknown,
  ) {
    super(reason);
    this.name = 'RetrievalUnavailableError';
  }
}
/** The embedding model's lifecycle, as CH-124 and CH-214 carry it (ADR-011, ADR-026). */
export type { ModelDownloadState } from './rag/embed.js';
export { KB_CEILING } from '../shared/defaults.js';
/**
 * The file extensions the knowledge base accepts (FR-060).
 *
 * Re-exported from the facade because the import dialog in the main process
 * needs the same list and may not deep-import `rag/convert.ts` (CMP-06). The
 * dialog had its own copy and it had already drifted: `.markdown` imported by
 * drag and drop and by a copy into `kb/`, but was greyed out in the picker.
 */
export { SUPPORTED_EXTENSIONS } from './rag/convert.js';

/** How a doc type was set. `'auto'` re-runs the guess (FR-079). */
export type DocTypeAssignment = DocType | 'auto';

/** Everything the engine needs, with the two real dependencies injectable (CMP-06). */
export interface RagEngineOptions {
  /** `app.getPath('userData')`. Injected so a test never touches a real profile. */
  userDataDir: string;
  /** Injected so tests need neither a 90 MB download nor an ONNX runtime. */
  embedder?: Embedder;
  /** Injected so a unit test drives file events without a real watcher. */
  watcherFactory?: WatcherFactory;
  /** Per-document ingest progress, forwarded to CH-213. */
  onDocumentProgress?: (docId: string, state: DocumentState, percent: number) => void;
  /** Model download lifecycle, forwarded to CH-214. */
  onModelState?: (state: ModelDownloadState) => void;
  onError?: (message: string, detail: unknown) => void;
  /** Debounce for the ingest queue. Lowered in tests (FR-068). */
  debounceMs?: number;
  /** Injected so a test can hold or stall a conversion. Defaults to the real converter. */
  convert?: typeof convertToMarkdown;
  /** How long one conversion may run before its document fails. Lowered in tests (ADR-055). */
  conversionTimeoutMs?: number;
}

/**
 * The knowledge base engine (CMP-06, TASK-020 to TASK-025).
 *
 * Owns profiles, documents, chunks and vectors: import and conversion (FR-060),
 * chunking (FR-062), auto-tagging (FR-064), local embeddings and their cache
 * (FR-066, FR-067), retrieval (FR-065), the `kb/` watcher (FR-068, FR-077) and
 * the startup reconciliation pass (FR-078).
 */
export class RagEngine {
  readonly store: ProfileStore;
  private readonly embedder: Embedder;
  private readonly queue: IngestQueue;
  private readonly watcher: KnowledgeBaseWatcher;
  private modelState: ModelDownloadState;
  private readonly modelsRoot: string;
  /** Cached chunk sets per profile, so a query is not a directory scan (TC-078). */
  private readonly cache = new Map<string, ChunkSet[]>();
  /** The cache rebuild running per profile. A query awaits it rather than reading again. */
  private readonly rebuilds = new Map<string, Promise<ChunkSet[]>>();
  /** Bumped by every invalidation, so a rebuild that raced one reads again. */
  private readonly generations = new Map<string, number>();
  /**
   * In-flight ingests, keyed by file path.
   *
   * `IngestQueue` serializes the watcher's events, but `importDocuments` and
   * `reconcile` call {@link processFile} directly and bypass it. Two runs for one
   * path that both start before either writes its record each mint a fresh
   * `docId`, leaving two records for one file: the query then returns every chunk
   * twice and the loser's vectors are never cleaned up. Reproduced with a large
   * PDF, whose parse outlasts the watcher's 500 ms debounce.
   */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly options: RagEngineOptions) {
    this.modelsRoot = join(options.userDataDir, 'models');
    mkdirSync(this.modelsRoot, { recursive: true });

    const embedder =
      options.embedder ??
      new XenovaEmbedder({
        modelsRoot: this.modelsRoot,
        onProgress: (percent) => this.setModelState({ kind: 'downloading', percent }),
      });
    this.embedder = embedder;
    this.modelState = embedder.isReady() ? { kind: 'ready' } : { kind: 'not-downloaded' };

    this.store = new ProfileStore({
      userDataDir: options.userDataDir,
      dimensions: embedder.info().dimensions,
    });

    this.queue = new IngestQueue({
      process: (profileId, path) => this.processFile(profileId, path),
      remove: (profileId, path) => this.removeByPath(profileId, path),
      ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
      onError: (err, ctx) => options.onError?.('knowledge base ingest failed', { err, ...ctx }),
    });
    this.watcher = new KnowledgeBaseWatcher({
      queue: this.queue,
      ...(options.watcherFactory ? { factory: options.watcherFactory } : {}),
      onError: (err, profileId) => options.onError?.('watcher error', { err, profileId }),
    });
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  /**
   * Reconcile every profile, then start watching (FR-077, FR-078, ADR-014).
   *
   * Reconciliation runs before the watcher, not alongside it: a watcher started
   * first would race the reconciliation pass over the same files and process
   * some of them twice.
   */
  async start(): Promise<void> {
    for (const profile of this.store.list()) {
      // Per profile, so one unreadable folder or one exhausted inotify limit
      // does not cost every other profile its watcher, and does not reject out
      // of the caller's bootstrap.
      try {
        await this.reconcile(profile.id);
        await this.watcher.watch(profile.id, this.store.kbDir(profile.id));
      } catch (err) {
        this.options.onError?.('could not start the knowledge base for a profile', {
          err,
          profileId: profile.id,
        });
      }
    }
  }

  async stop(): Promise<void> {
    this.queue.dispose();
    await this.watcher.closeAll();
  }

  /**
   * Resolves once no file is queued or being processed, and the query cache
   * those ingests cleared has been rebuilt. Used by tests and shutdown.
   */
  async drain(): Promise<void> {
    await this.queue.drain();
    while (this.rebuilds.size > 0) await Promise.allSettled([...this.rebuilds.values()]);
  }

  /* ---------------------------------------------------------------- *
   * The embedding model gate (ADR-011, ADR-026)
   * ---------------------------------------------------------------- */

  getModelState(): ModelDownloadState {
    return this.modelState;
  }

  private setModelState(state: ModelDownloadState): void {
    this.modelState = state;
    this.options.onModelState?.(state);
  }

  /**
   * Make the embedding model usable, downloading it if needed (ADR-011, TC-071).
   *
   * Also the Dashboard's retry action for the "embedding model not downloaded"
   * state (ADR-026, TC-161). A failure lands in `unavailable` with a reason,
   * never in a generic error and never in a hang: the caller can always show a
   * sentence and a retry button.
   *
   * Session start never downloads through this. It calls {@link warmModel},
   * which only loads a model already on disk. A live session may start with no
   * model at all (ADR-011).
   */
  async ensureModelReady(options: { userInitiated?: boolean } = {}): Promise<ModelDownloadState> {
    // A failed attempt is terminal until someone asks again. Ingestion calls
    // this per file, and without the guard an offline import of five documents
    // made five full download attempts, each waiting out the library's own
    // network timeout with `doc:import` unresolved the whole time. That is the
    // hang NFR-008 and ADR-026 forbid, and CH-214 flapped
    // downloading/unavailable once per file while it happened.
    if (this.modelState.kind === 'unavailable' && !options.userInitiated) return this.modelState;

    // `ensureReady` is idempotent and cheap once loaded, so it is called every
    // time rather than short-circuiting on `ready`. A model that is on disk but
    // not yet in memory reads as ready to the Dashboard and still has to be
    // loaded before the tokenizer exists.
    if (!this.embedder.isReady()) this.setModelState({ kind: 'downloading', percent: 0 });
    try {
      await this.embedder.ensureReady();
      this.setModelState({ kind: 'ready' });
    } catch (err) {
      this.setModelState({ kind: 'unavailable', reason: (err as Error).message });
    }
    return this.modelState;
  }

  /**
   * Load a cached model into memory before the first question (NFR-001, ADR-011).
   *
   * `index.ts` calls this at startup and at session start for the active
   * profile. Reconciliation never loads the model when every document is a
   * cache hit, so without this the first question's `embed` loaded ONNX and the
   * tokenizer inside the question-to-suggestion budget.
   *
   * Never downloads: a model that is not on disk is left to the Dashboard's
   * retry action (ADR-026). Never throws, so a caller can fire and forget.
   */
  async warmModel(profileId: string): Promise<void> {
    if (!this.embedder.isReady()) return;
    if (!this.store.get(profileId)?.documents.some((d) => d.state === 'ready')) return;
    await this.ensureModelReady();
  }

  /* ---------------------------------------------------------------- *
   * Profiles
   * ---------------------------------------------------------------- */

  listProfiles(): Profile[] {
    return this.store.list();
  }

  async createProfile(name: string): Promise<Profile> {
    const profile = this.store.create(name);
    try {
      await this.watcher.watch(profile.id, this.store.kbDir(profile.id));
    } catch (err) {
      // `ENOSPC: System limit for number of file watchers reached` is routine on
      // Linux. Rejecting here returned "The request failed." to the Dashboard
      // while the profile existed and showed up in `profile:list`, so the user
      // clicked Create again and got a duplicate. The profile is real; only its
      // watcher is missing, and the next launch's `start` will try again.
      this.options.onError?.('profile created without a watcher', { err, profileId: profile.id });
    }
    return profile;
  }

  /**
   * Delete a profile and everything belonging to it (FR-069, TC-160).
   *
   * The watcher is closed before anything is removed. Deleting a watched folder
   * out from under chokidar emits unlink events for every file, each of which
   * would queue a removal against a profile that no longer exists.
   */
  async deleteProfile(profileId: string): Promise<void> {
    await this.watcher.unwatch(profileId);
    // A profile that does not exist, and an id that is not a uuid at all, are
    // both a no-op rather than a throw: deleting something already gone is the
    // caller getting what they asked for. `store.delete` still refuses an
    // unsafe id outright, so this is a contract, not the guard.
    if (this.store.get(profileId)) this.store.delete(profileId);
    this.invalidate(profileId);
  }

  /* ---------------------------------------------------------------- *
   * Import and ingest
   * ---------------------------------------------------------------- */

  /**
   * Copy files into the profile's `kb/` and ingest them (FR-060, CH-109).
   *
   * Copying rather than referencing in place is what makes `kb/` authoritative:
   * a document whose source lived on a removable drive would otherwise vanish
   * from the knowledge base when the drive was unplugged (ADR-014).
   *
   * One file's failure never stops the batch (TC-063). A file that cannot even
   * be copied gets an `error` record so the Dashboard shows a row rather than
   * silently dropping what the user selected.
   */
  async importDocuments(profileId: string, paths: string[]): Promise<DocumentRecord[]> {
    const profile = this.store.get(profileId);
    if (!profile) throw new Error(`Unknown profile ${profileId}.`);
    mkdirSync(this.store.kbDir(profileId), { recursive: true });

    const records: DocumentRecord[] = [];
    for (const source of paths) {
      const fileName = basename(source);
      if (!sourceFormatFor(fileName)) {
        records.push(
          this.storeErrorRecord(
            profileId,
            fileName,
            join(this.store.kbDir(profileId), fileName),
            `Unsupported file type. Supported: ${SUPPORTED_EXTENSIONS.join(', ')}.`,
          ),
        );
        continue;
      }

      // COPYFILE_EXCL, so the copy fails rather than overwriting. `existsSync`
      // in `uniqueKbPath` is a check, not a claim: two concurrent imports of the
      // same filename both miss and pick the same target, and a plain copy would
      // silently replace the first import with the second. EEXIST is therefore
      // the other import winning that name, so this one takes the next free
      // name rather than reporting an error. Bounded, so a folder that keeps
      // refilling cannot spin this loop forever.
      let target = '';
      let copyError: unknown = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        target = await this.uniqueKbPath(profileId, fileName);
        try {
          await copyFile(source, target, constants.COPYFILE_EXCL);
          copyError = null;
          break;
        } catch (err) {
          copyError = err;
          if (errnoOf(err) !== 'EEXIST') break;
        }
      }
      if (copyError !== null) {
        records.push(
          this.storeErrorRecord(
            profileId,
            basename(target),
            target,
            `Could not copy the file into the knowledge base (${errnoOf(copyError)}).`,
          ),
        );
        continue;
      }

      await this.processFile(profileId, target);
      const record = this.findByPath(profileId, target);
      if (record) records.push(record);
    }
    return records;
  }

  /**
   * Pick a name inside `kb/` that is not taken.
   *
   * Two documents may legitimately share a base name, and `kb/` is keyed by
   * path, so overwriting would silently replace the first import with the
   * second.
   */
  private async uniqueKbPath(profileId: string, fileName: string): Promise<string> {
    const dir = this.store.kbDir(profileId);
    const ext = extname(fileName);
    const stem = basename(fileName, ext);
    let candidate = join(dir, fileName);
    let suffix = 1;
    while (existsSync(candidate)) {
      candidate = join(dir, `${stem} (${suffix})${ext}`);
      suffix += 1;
    }
    return candidate;
  }

  /**
   * Convert, tag, chunk and embed one file (TASK-020 to TASK-023).
   *
   * Never throws. A failure is a document state with a message, so one bad file
   * in a batch of three leaves the other two reaching `ready` (TC-063, FR-079).
   *
   * Adoption is the default path, not a special case: a file with no record gets
   * one here whether it arrived through `doc:import` or through Explorer
   * (FR-077, ADR-014).
   */
  async processFile(profileId: string, path: string): Promise<void> {
    // Chained, not "await the current one then start": two callers that both
    // awaited the same in-flight run would then both start, and at three-way
    // concurrency the first two would race again. Chaining onto whatever is
    // tracked serializes every caller for this path, at any concurrency.
    //
    // Each caller still gets its own pass rather than sharing the in-flight
    // one: it asked because something changed, and the running pass may have
    // read the file before that change landed. A pass with nothing to do is a
    // cache hit, so the cost of being safe is one hash.
    // Keyed by the normalized path, matching `findByPath` and `reconcile`. Keyed
    // by the raw string, two callers naming one file differently, which is the
    // exact case `normalizePath` exists for, would slip past the guard.
    const key = normalizePath(path);
    const previous = this.inFlight.get(key) ?? Promise.resolve();
    const run: Promise<void> = previous
      .catch(() => undefined)
      .then(() => this.ingest(profileId, path))
      .finally(() => {
        if (this.inFlight.get(key) === run) this.inFlight.delete(key);
      });
    this.inFlight.set(key, run);
    return run;
  }

  private async ingest(profileId: string, path: string): Promise<void> {
    try {
      await this.ingestOrThrow(profileId, path);
    } catch (err) {
      // The contract above says this never throws, and several statements in
      // the pipeline sit outside their own try: `publish` writes profile.json,
      // `writeDerivedMarkdown` writes a file, and the embed catch itself
      // deletes one. ENOSPC, or an antivirus lock on a `.tmp` during rename,
      // made one bad file reject out of `importDocuments` and abandon every
      // later file in the batch with no record at all (TC-063).
      this.options.onError?.('ingest failed', { err, profileId, path });
      // Best effort: leave a row the user can see and retry, rather than a
      // document silently stuck mid-pipeline until the next relaunch (FR-079).
      // Update-only: with no record, the document was deleted mid-ingest or
      // its very first write failed, and neither should get a row back. The
      // errno, not the message: a Node fs message embeds the absolute path.
      try {
        const format = sourceFormatFor(basename(path));
        const existing = this.findByPath(profileId, path);
        if (format && existing) {
          this.fail(
            profileId,
            existing.id,
            basename(path),
            path,
            format,
            `Ingest failed (${errnoOf(err)}).`,
          );
        }
      } catch {
        // The profile is gone or the disk is full. Nothing more to record.
      }
    }
  }

  private async ingestOrThrow(profileId: string, path: string): Promise<void> {
    const fileName = basename(path);
    const format = sourceFormatFor(fileName);
    if (!format) return;

    const existing = this.findByPath(profileId, path);
    const docId = existing?.id ?? randomUUID();
    // Only a file with no record when this pass began may get one. Every later
    // write is update-only, so a document the user deletes while this pass
    // awaits stays deleted instead of being inserted again (FR-077). A file
    // with no record cannot be deleted from the Dashboard, so nothing can race
    // its first insert.
    const adopt = existing === null;

    // Stat, then read once, then convert those same bytes. The stat keeps a
    // multi-gigabyte file out of memory entirely, and a second read inside the
    // converter could see a different file than the one hashed below, so the
    // cache key would describe content that was never converted (ADR-055).
    let bytes: Buffer;
    try {
      if ((await stat(path)).size > KB_INGEST_LIMITS.maxFileBytes) {
        this.fail(profileId, docId, fileName, path, format, tooLargeMessage(), adopt);
        return;
      }
      bytes = await readFile(path);
    } catch (err) {
      // Gone is not a failure: the file was deleted, so its record goes too.
      if (errnoOf(err) === 'ENOENT') {
        await this.removeByPath(profileId, path);
        return;
      }
      // The errno, not the message: a Node fs message embeds the absolute path.
      const message = `Could not read the file (${errnoOf(err)}).`;
      this.fail(profileId, docId, fileName, path, format, message, adopt);
      return;
    }
    // The file can grow between the stat and the read.
    if (bytes.byteLength > KB_INGEST_LIMITS.maxFileBytes) {
      this.fail(profileId, docId, fileName, path, format, tooLargeMessage(), adopt);
      return;
    }

    const embeddingKey = embeddingKeyFor(bytes, this.embedder.info().id, CHUNKER_VERSION);

    // Cache hit: same bytes, same chunker, same model, and a readable pair on
    // disk. Zero embedding calls (FR-067, TC-069).
    if (
      existing &&
      existing.state === 'ready' &&
      existing.embeddingKey === embeddingKey &&
      (await this.store.readChunkSet(profileId, docId)) !== null
    ) {
      return;
    }

    // The tokenizer and the vectors both need the model, so ingestion waits for
    // it. A document left `pending` here is picked up by the next reconciliation
    // pass once the model arrives, which is why this is not an error (ADR-011).
    const model = await this.ensureModelReady();
    if (model.kind !== 'ready') {
      this.publish(
        profileId,
        {
          ...this.baseRecord(profileId, docId, fileName, path, format, existing),
          state: 'pending',
          errorMessage: null,
        },
        adopt,
      );
      return;
    }

    // A null publish means the profile, or this document, was deleted while
    // this ingest ran. Stop rather than writing derived files nothing owns
    // (FR-069, FR-077).
    if (
      !this.publish(
        profileId,
        {
          ...this.baseRecord(profileId, docId, fileName, path, format, existing),
          state: 'converting',
          errorMessage: null,
        },
        adopt,
      )
    ) {
      return;
    }

    let markdown: string;
    let extractionQuality: DocumentRecord['extractionQuality'];
    try {
      const converted = await this.convertWithTimeout(bytes, format);
      markdown = ensureHeadings(converted.markdown);
      extractionQuality = converted.extractionQuality;
    } catch (err) {
      if (!(err instanceof ConversionError)) {
        this.options.onError?.('conversion failed', { err, profileId });
      }
      const message = err instanceof ConversionError ? err.message : 'Conversion failed.';
      this.fail(profileId, docId, fileName, path, format, message);
      return;
    }

    // Re-read after the conversion's await. A delete during it must end this
    // pass here, before a derived file is written for a record that is gone,
    // and an override set during it must not be guessed over.
    const converted = this.findByPath(profileId, path);
    if (!converted) return;

    // A user override is never re-guessed, not even after the file changes
    // (FR-064, FR-079, TC-073).
    const docType: DocType =
      converted.docTypeSource === 'user' ? converted.docType : guessDocType(fileName, markdown);

    // No await between the check above and this write, so no delete can land
    // between them.
    const derivedMarkdownPath =
      format === 'md' ? null : this.store.writeDerivedMarkdown(profileId, docId, markdown);
    if (format !== 'md' && derivedMarkdownPath === null) return; // Deleted mid-ingest.

    if (
      !this.publish(profileId, {
        ...this.baseRecord(profileId, docId, fileName, path, format, converted),
        docType,
        docTypeSource: converted.docTypeSource,
        derivedMarkdownPath,
        extractionQuality,
        state: 'embedding',
        errorMessage: null,
      })
    ) {
      return;
    }

    try {
      const info = this.embedder.info();
      const chunks = chunkMarkdown(markdown, {
        docId,
        profileId,
        docType,
        sourceFile: fileName,
        maxTokens: info.maxSeqLength - info.specialTokenCount,
        countTokens: (word) => this.embedder.countTokens(word),
      });

      const vectors = await this.embedAll(
        chunks.map((c) => c.text),
        info.dimensions,
      );
      // Re-read rather than reusing the snapshot taken before the embed. During
      // a 30-second PDF the user can set the doc type, or delete the document
      // outright, and the stale snapshot silently overwrote both: the override
      // reverted to the guess, and a deleted document reappeared as `ready`
      // with no file behind it and its chunks served by `query`.
      const current = this.findByPath(profileId, path);
      if (!current) return;

      // The chunks carry the type known now, so an override that landed during
      // the embed needs no second write. Vectors do not depend on it (FR-064).
      const settledType = current.docTypeSource === 'user' ? current.docType : docType;
      const settled =
        settledType === docType ? chunks : chunks.map((c) => ({ ...c, docType: settledType }));
      if (!this.store.writeChunkSet(profileId, docId, settled, vectors)) return;
      this.publish(profileId, {
        ...this.baseRecord(profileId, docId, fileName, path, format, current),
        docType: settledType,
        docTypeSource: current.docTypeSource,
        derivedMarkdownPath,
        extractionQuality,
        contentHash: contentHashFor(bytes),
        embeddingKey,
        chunkCount: chunks.length,
        state: 'ready',
        errorMessage: null,
      });
      // After the `ready` record, not before: the rebuild reads which documents
      // are ready, and started earlier it cached this one's absence.
      this.invalidate(profileId);
    } catch (err) {
      // A half-written pair must not outlive the failure that produced it, and
      // neither must the memoized copy: `query` returned the previous content of
      // a document that is now `error` with no files on disk, for the rest of
      // the process.
      this.store.deleteChunkSet(profileId, docId);
      this.fail(
        profileId,
        docId,
        fileName,
        path,
        format,
        `Embedding failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Convert, failing rather than waiting forever (ADR-055).
   *
   * A parse with no bound left its document in `converting` for the rest of the
   * process, and `inFlight` queued every later pass for that path behind it. On
   * timeout the converter is told to stop, so a PDF parser releases its worker.
   */
  private async convertWithTimeout(bytes: Buffer, format: SourceFormat): Promise<ConversionResult> {
    const limitMs = this.options.conversionTimeoutMs ?? KB_INGEST_LIMITS.conversionTimeoutMs;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const seconds = Math.max(1, Math.round(limitMs / 1000));
        // Rejected before the abort, so this reason wins the race over
        // whatever the stopped converter rejects with.
        reject(
          new ConversionError(`Conversion took too long (over ${seconds} s) and was stopped.`),
        );
        controller.abort();
      }, limitMs);
    });
    try {
      const convert = this.options.convert ?? convertToMarkdown;
      return await Promise.race([convert(bytes, format, controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Embed every chunk, flattened into one row-major buffer.
   *
   * Batched so a 200-chunk document does not hand the ONNX runtime one tensor
   * with 200 rows, which is where memory use spikes on a low-end machine.
   */
  private async embedAll(texts: string[], dimensions: number): Promise<Float32Array> {
    const BATCH = 16;
    const out = new Float32Array(texts.length * dimensions);
    for (let start = 0; start < texts.length; start += BATCH) {
      const batch = texts.slice(start, start + BATCH);
      const vectors = await this.embedder.embed(batch);
      if (vectors.length !== batch.length) {
        throw new Error(`Expected ${batch.length} vectors, received ${vectors.length}.`);
      }
      for (let i = 0; i < vectors.length; i += 1) {
        const vector = vectors[i];
        if (!vector || vector.length !== dimensions) {
          throw new Error(`Vector ${start + i} is not ${dimensions} dimensions.`);
        }
        out.set(vector, (start + i) * dimensions);
      }
    }
    return out;
  }

  /** Drop the record, chunks, vectors and derived Markdown for a vanished file (FR-077). */
  private async removeByPath(profileId: string, path: string): Promise<void> {
    const record = this.findByPath(profileId, path);
    if (!record) return;
    this.store.removeDocument(profileId, record.id);
    this.invalidate(profileId);
    // No CH-213 push. Its `state` is a `DocumentState`, and a removed document
    // has none: reporting `ready` told the Dashboard to draw a row for a
    // document that no longer exists. The Dashboard re-reads `profile:list`.
    await Promise.resolve();
  }

  /* ---------------------------------------------------------------- *
   * Document operations (CH-110, CH-111, FR-079)
   * ---------------------------------------------------------------- */

  /**
   * Set or reset a document's type (FR-064, FR-079, TC-073, TC-074, TC-149).
   *
   * An explicit type sets `docTypeSource: 'user'` and is never re-guessed.
   * `'auto'` clears the override and re-runs the guess against the document's
   * current text.
   *
   * Neither path re-embeds. `docType` is chunk metadata carried alongside the
   * vector, not an input to it, so rewriting `chunks.json` is the whole update
   * and the vectors stay valid (FR-064).
   */
  async setDocType(
    profileId: string,
    docId: string,
    assignment: DocTypeAssignment,
  ): Promise<DocumentRecord | null> {
    const record = this.store.findDocument(profileId, docId);
    if (!record) return null;

    let docType: DocType;
    if (assignment === 'auto') {
      const markdown = await this.readDocumentMarkdown(record);
      docType =
        markdown === null ? record.docType : guessDocType(record.originalFileName, markdown);
    } else {
      docType = assignment;
    }

    // Re-read after the await. `updateDocument` replaces the whole record, so
    // writing back the copy read before `readDocumentMarkdown` sent a document
    // that had just finished embedding back to `state: 'embedding'` with
    // `chunkCount: 0`, where it span forever and contributed to no query until
    // the next launch's reconciliation.
    const latest = this.store.findDocument(profileId, docId);
    if (!latest) return null; // Deleted while we were reading its Markdown.

    const updated = this.store.updateDocument({
      ...latest,
      docType,
      docTypeSource: assignment === 'auto' ? 'auto' : 'user',
    });
    if (!updated) return null;

    const set = await this.store.readChunkSet(profileId, docId);
    // Checked again after the read. A delete during it must not get its chunk
    // files back, and a re-embed during it wrote a newer pair, already carrying
    // this type, that the stale one read here must not replace.
    const now = this.store.findDocument(profileId, docId);
    if (set && now && now.embeddingKey === updated.embeddingKey) {
      this.store.writeChunkSet(
        profileId,
        docId,
        set.chunks.map((chunk) => ({ ...chunk, docType })),
        set.vectors,
      );
      this.invalidate(profileId);
    }
    return updated;
  }

  /** The Markdown a document was last chunked from, for a re-guess (FR-079). */
  private async readDocumentMarkdown(record: DocumentRecord): Promise<string | null> {
    // Only a source that really is Markdown. A `pending` or `error` PDF has no
    // derived file yet, and falling back to `originalPath` fed the raw binary to
    // the guesser as UTF-8. The caller keeps the current type when this is null.
    const path =
      record.derivedMarkdownPath ?? (record.sourceFormat === 'md' ? record.originalPath : null);
    if (path === null || !existsSync(path)) return null;
    try {
      return ensureHeadings(await readFile(path, 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * Re-process a document without re-importing it (FR-079, TC-149).
   *
   * Used by the Dashboard retry on an `error` row, and by the reconciliation
   * pass on a document stuck in a non-terminal state.
   */
  async retryDocument(profileId: string, docId: string): Promise<DocumentRecord | null> {
    const record = this.store.findDocument(profileId, docId);
    if (!record) return null;

    // An import that failed before the file was copied, or one with an
    // unsupported extension, leaves a record pointing at a path that was never
    // written. Re-processing it deleted the row and returned null, which the IPC
    // handler turned into "The request failed." and the Dashboard into a row
    // that silently disappeared. Say what is wrong and leave the row, which the
    // next reconciliation drops anyway because `kb/` is the authority.
    if (!existsSync(record.originalPath)) {
      return (
        this.store.updateDocument({
          ...record,
          state: 'error',
          errorMessage:
            'The original file is no longer in the knowledge base folder. Import it again.',
        }) ?? record
      );
    }

    await this.processFile(profileId, record.originalPath);
    return this.store.findDocument(profileId, docId) ?? record;
  }

  async deleteDocument(profileId: string, docId: string): Promise<void> {
    const record = this.store.findDocument(profileId, docId);
    if (!record) return;
    this.store.removeDocument(profileId, docId);
    this.invalidate(profileId);
    // The file itself goes too: `kb/` is the authority, so leaving it there
    // would have the watcher adopt it straight back (ADR-014, FR-077).
    await rm(record.originalPath, { force: true });
  }

  /* ---------------------------------------------------------------- *
   * Reconciliation (FR-078, ADR-014)
   * ---------------------------------------------------------------- */

  /**
   * Rebuild one profile's index from its `kb/` folder (FR-077, FR-078, TC-140).
   *
   * Three jobs, in this order:
   *
   * 1. Drop records whose file is gone. Done first so an adopted file cannot
   *    collide with a stale record for the same path.
   * 2. Adopt files with no record.
   * 3. Reset every non-terminal state to `pending` and re-process it. A document
   *    the app was killed while embedding is otherwise stuck forever.
   *
   * A `ready` document whose chunk pair fails to load is also re-processed: the
   * row count check is what catches a torn write, and the answer to a torn write
   * is to re-embed, not to serve half of it (FR-078, TC-141).
   */
  async reconcile(profileId: string): Promise<void> {
    const profile = this.store.get(profileId);
    if (!profile) return;
    const kbDir = this.store.kbDir(profileId);
    mkdirSync(kbDir, { recursive: true });

    // Keyed by the normalized path, valued by the path as `readdir` spells it,
    // because that spelling is what a new record stores.
    const onDisk = new Map<string, string>();
    // Entries `readdir` listed but `stat` could not answer for. They are not
    // absent, only unknown, and the difference matters: treating an EACCES file
    // or an antivirus-locked one as deleted removed its record, chunks, vectors
    // and derived Markdown, and the watcher's `ignoreInitial` meant a file that
    // was still there might never come back for the rest of the process.
    const unreadable = new Set<string>();

    for (const entry of await readdir(kbDir)) {
      const full = join(kbDir, entry);
      if (!sourceFormatFor(entry)) continue;
      try {
        if (!(await stat(full)).isFile()) continue;
      } catch (err) {
        // Only a definitive "not there" counts as gone. Anything else, a
        // dangling symlink to an unmounted drive included, is preserved.
        // Unguarded this also rejected out of `reconcile` and out of `start`,
        // and bootstrap awaits `start` before registering `window-all-closed`
        // and `will-quit`.
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') unreadable.add(normalizePath(full));
        this.options.onError?.('skipping an unreadable knowledge base entry', { err, path: full });
        continue;
      }
      onDisk.set(normalizePath(full), full);
    }

    for (const record of [...profile.documents]) {
      const key = normalizePath(record.originalPath);
      if (!onDisk.has(key) && !unreadable.has(key)) {
        this.store.removeDocument(profileId, record.id);
      }
    }
    this.invalidate(profileId);

    const remaining = this.store.get(profileId)?.documents ?? [];
    const known = new Map(remaining.map((d) => [normalizePath(d.originalPath), d]));

    for (const [normalized, path] of onDisk) {
      const record = known.get(normalized);
      if (!record) {
        await this.processFile(profileId, path);
        continue;
      }
      if (record.state === 'error') continue; // Terminal until the user retries (FR-079).

      // Every non-error record goes through `processFile`, `ready` ones
      // included. Skipping `ready` because its chunk pair merely *loads* trusted
      // the bytes without ever comparing them: a file edited while the app was
      // shut down kept serving its pre-edit chunks forever, because the watcher
      // starts with `ignoreInitial` and no change event ever arrives for it. It
      // also defeated ADR-012's whole point, that bumping the chunker version or
      // the embedding model invalidates the cache on the next launch.
      //
      // The cost is one read and one hash per document at startup, which is
      // exactly what `processFile`'s cache check needs in order to decide. An
      // unchanged file still performs zero embedding calls (FR-067).
      if (record.state !== 'ready') {
        this.store.updateDocument({ ...record, state: 'pending', errorMessage: null });
      }
      await this.processFile(profileId, path);
    }
  }

  /* ---------------------------------------------------------------- *
   * Retrieval (TASK-024, FR-065)
   * ---------------------------------------------------------------- */

  /**
   * Top `k` chunks for a question, scoped to one profile (FR-065, ASM-006).
   *
   * Scoped by construction, not by filtering: only the requested profile's
   * directory is ever read, so a cross-profile leak would need a different code
   * path rather than a missing predicate (TC-075).
   *
   * **Empty and failed are different answers** (ADR-036). `[]` means the notes
   * were searched and nothing matched, or there was nothing to search: an empty
   * question, an unknown profile, a profile with no ready document. A failure to
   * *reach* notes that do exist **throws** `RetrievalUnavailableError`.
   *
   * TASK-024 collapsed both onto `[]` so a failure could not throw into a
   * session. It reached the live loop as "no relevant notes", and the loop then
   * built a suggestion the overlay renders identically to a grounded one, which
   * is the plausible value ADR-032 forbids. The loop abandons the turn on the
   * throw instead, which is neither a crash nor a fabricated answer (ADR-035).
   */
  async query(profileId: string, text: string, k = 3): Promise<RetrievedChunk[]> {
    if (text.trim().length === 0) return [];
    let candidates: ChunkSet[];
    try {
      candidates = await this.chunkSetsFor(profileId);
    } catch (err) {
      this.options.onError?.('query failed: the notes could not be read', err);
      throw new RetrievalUnavailableError('the notes could not be read', err);
    }
    // Nothing to search is genuinely empty, and it is checked first so a
    // profile with no documents never depends on the model at all (TC-077).
    if (candidates.length === 0) return [];

    // Never downloaded on the live path. If the model cache was cleared since
    // these documents were embedded, `embed` would start a 90 MB download
    // inside the question-to-suggestion budget. Reaching here means ready
    // documents exist and their notes cannot be searched, which is a failure
    // rather than an empty result (ADR-011, ADR-036). `isReady` is also true for
    // a model that is only on disk, which `embed` then loads; `warmModel` runs
    // at startup and at session start so that load is normally done already.
    if (!this.embedder.isReady()) {
      this.options.onError?.('query failed: the embedding model is not available', {
        state: this.modelState,
      });
      throw new RetrievalUnavailableError('the embedding model is not available');
    }

    let queryVector: Float32Array | undefined;
    try {
      [queryVector] = await this.embedder.embed([text]);
    } catch (err) {
      this.options.onError?.('query embedding failed', err);
      throw new RetrievalUnavailableError('the question could not be embedded', err);
    }
    if (!queryVector) {
      throw new RetrievalUnavailableError('the embedder returned no vector for the question');
    }

    return topK(queryVector, candidates, k, this.embedder.info().dimensions);
  }

  /**
   * Every ready document's chunk pair for a profile, memoized.
   *
   * Loaded once per profile and held until an ingest invalidates it. Reading
   * 5000 chunks from disk on every question would put file IO inside the
   * question-to-suggestion latency budget (NFR-001, TC-078).
   *
   * Concurrent callers share one rebuild. A rebuild that an invalidation raced
   * reads again before it resolves, so no caller gets sets read before the
   * change that invalidated them.
   */
  private chunkSetsFor(profileId: string): Promise<ChunkSet[]> {
    const cached = this.cache.get(profileId);
    if (cached) return Promise.resolve(cached);
    const running = this.rebuilds.get(profileId);
    if (running) return running;
    const rebuild = this.rebuildChunkSets(profileId).finally(() => {
      if (this.rebuilds.get(profileId) === rebuild) this.rebuilds.delete(profileId);
    });
    this.rebuilds.set(profileId, rebuild);
    return rebuild;
  }

  private async rebuildChunkSets(profileId: string): Promise<ChunkSet[]> {
    for (;;) {
      const generation = this.generations.get(profileId) ?? 0;
      const sets: ChunkSet[] = [];
      for (const record of this.store.get(profileId)?.documents ?? []) {
        if (record.state !== 'ready') continue;
        const set = await this.store.readChunkSet(profileId, record.id);
        // A pair that fails its row count is skipped rather than half-served.
        // The next reconciliation pass re-embeds it (FR-078, TC-141).
        if (set) sets.push(set);
      }
      if (generation !== (this.generations.get(profileId) ?? 0)) continue;
      if (this.store.get(profileId)) this.cache.set(profileId, sets);
      return sets;
    }
  }

  /**
   * Drop a profile's cached chunk sets and rebuild them now, off the live path.
   *
   * Clearing alone left the rebuild to the next question, which then decoded
   * every vector file inside the question-to-suggestion budget (NFR-001).
   */
  private invalidate(profileId: string): void {
    this.cache.delete(profileId);
    this.generations.set(profileId, (this.generations.get(profileId) ?? 0) + 1);
    this.chunkSetsFor(profileId).catch((err: unknown) => {
      // Nothing is cached, so the next query reads again and reports the
      // failure itself (ADR-036).
      this.options.onError?.('could not rebuild the knowledge base cache', { err, profileId });
    });
  }

  /* ---------------------------------------------------------------- *
   * Record helpers
   * ---------------------------------------------------------------- */

  private findByPath(profileId: string, path: string): DocumentRecord | null {
    const wanted = normalizePath(path);
    return (
      this.store.get(profileId)?.documents.find((d) => normalizePath(d.originalPath) === wanted) ??
      null
    );
  }

  /** The fields a record keeps across every state transition. */
  private baseRecord(
    profileId: string,
    docId: string,
    fileName: string,
    path: string,
    format: DocumentRecord['sourceFormat'],
    existing: DocumentRecord | null,
  ): DocumentRecord {
    return {
      id: docId,
      profileId,
      originalFileName: fileName,
      originalPath: path,
      sourceFormat: format,
      derivedMarkdownPath: existing?.derivedMarkdownPath ?? null,
      docType: existing?.docType ?? 'company-notes',
      docTypeSource: existing?.docTypeSource ?? 'auto',
      contentHash: existing?.contentHash ?? '',
      embeddingKey: existing?.embeddingKey ?? '',
      chunkCount: existing?.chunkCount ?? 0,
      state: 'pending',
      errorMessage: null,
      extractionQuality: existing?.extractionQuality ?? 'native',
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Store a record and report its state on CH-213.
   *
   * `adopt` inserts a record that is missing. Only the first write for a file
   * that had no record may pass it; every other transition is update-only, so
   * a document deleted mid-ingest stays deleted (FR-077).
   */
  private publish(profileId: string, record: DocumentRecord, adopt = false): DocumentRecord | null {
    const stored = adopt ? this.store.upsertDocument(record) : this.store.updateDocument(record);
    if (stored)
      this.options.onDocumentProgress?.(stored.id, stored.state, percentFor(stored.state));
    return stored;
  }

  private fail(
    profileId: string,
    docId: string,
    fileName: string,
    path: string,
    format: DocumentRecord['sourceFormat'],
    message: string,
    adopt = false,
  ): void {
    // Every failure path, not only the embed one. A conversion or read failure
    // leaves the previous chunk pair on disk and in the cache, so a query kept
    // answering from content the Dashboard shows as failed. Invalidated after
    // the record is written, because the rebuild starts by reading the records.
    const existing = this.findByPath(profileId, path);
    this.publish(
      profileId,
      {
        ...this.baseRecord(profileId, docId, fileName, path, format, existing),
        state: 'error',
        errorMessage: message,
      },
      adopt,
    );
    this.invalidate(profileId);
  }

  /** A record for a file that never got as far as being read (TC-063). */
  private storeErrorRecord(
    profileId: string,
    fileName: string,
    path: string,
    message: string,
  ): DocumentRecord {
    // The real format where the extension names one. `DocumentRecord` has no
    // value for "unsupported", so a genuinely unknown extension still records
    // `md`; the row carries the file name and an explicit message, which is what
    // the Dashboard shows.
    const format = sourceFormatFor(fileName) ?? 'md';
    const record: DocumentRecord = {
      ...this.baseRecord(profileId, randomUUID(), fileName, path, format, null),
      state: 'error',
      errorMessage: message,
    };
    return this.publish(profileId, record, true) ?? record;
  }
}

/**
 * A path in the one form this engine compares against (FR-077, FR-078).
 *
 * `reconcile` matches a `DocumentRecord.originalPath` against what `readdir`
 * reports, and `findByPath` matches it against what the watcher reports. Three
 * sources, and on Windows they can disagree on separators and on case while
 * naming the same file. A false mismatch is not a small bug there: reconcile
 * reads it as "the file is gone", drops the record, re-adopts the same file and
 * re-embeds the entire knowledge base on every launch.
 *
 * Case is folded only on win32. Doing it everywhere would make two genuinely
 * different files on a case-sensitive filesystem collide.
 */
export function normalizePath(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Coarse progress for CH-213. The states are ordered, so the bar only advances. */
function percentFor(state: DocumentState): number {
  switch (state) {
    case 'pending':
      return 0;
    case 'converting':
      return 25;
    case 'embedding':
      return 60;
    case 'ready':
      return 100;
    case 'error':
      return 100;
  }
}

/** The errno of a failure, never its message: a Node fs message embeds the absolute path. */
function errnoOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : 'unknown error';
}

/** The row text for a file above the hard per-file cap (ADR-055). */
function tooLargeMessage(): string {
  const megabytes = KB_INGEST_LIMITS.maxFileBytes / (1024 * 1024);
  return `This file is larger than the ${megabytes} MB limit for one document.`;
}

/** The embedding model this build ships with. Re-exported for the Dashboard badge. */
export { EMBEDDING_MODEL };
