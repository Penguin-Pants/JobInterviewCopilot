import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMBEDDING_MODEL, type EmbeddingModelDescriptor } from '../../shared/registry/embedding.js';
import { CHUNKER_VERSION } from './chunk.js';

/**
 * Local embeddings and the model download gate (TASK-022, FR-066, FR-067,
 * ADR-011, ADR-012, ADR-026).
 *
 * Embeddings are computed on this machine with `@xenova/transformers`. Nothing
 * here calls a provider, which is why ingestion survives every key being
 * rejected and why `NFR-008` can promise offline ingestion at all, for an
 * installation whose model is already cached (ADR-026).
 *
 * The library is imported lazily. It pulls an ONNX runtime, so importing it at
 * module scope would put that cost on every app start including the runs that
 * never ingest a document.
 */

/** What the rest of the RAG engine needs to know about the live model. */
export interface EmbeddingModelInfo {
  id: string;
  dimensions: number;
  /** Read from the downloaded model, not from a literal (FR-062, ADR-023). */
  maxSeqLength: number;
  specialTokenCount: number;
}

/**
 * Produces vectors and counts word pieces.
 *
 * An interface rather than a class so tests drive the chunker and the vector
 * store with a deterministic double: the real implementation needs a 90 MB
 * download, which CI has no business making (TC-068, TC-069).
 */
export interface Embedder {
  info(): EmbeddingModelInfo;
  /** Word pieces for one pre-tokenizer token, excluding special tokens. */
  countTokens(word: string): number;
  /** One L2-normalized vector per input, in input order. */
  embed(texts: string[]): Promise<Float32Array[]>;
  /**
   * Whether the model is usable without a download.
   *
   * True for a model already cached on disk, even before it is loaded into
   * memory. That distinction is the Dashboard's: "downloading 90 MB" and "warming
   * up a cached model" are not the same wait (ADR-011, ADR-026).
   */
  isReady(): boolean;
  /**
   * Make the model usable, downloading it if needed. Idempotent.
   *
   * Rejects with a reason the Dashboard can show. Part of the interface rather
   * than a concrete class's method, so the engine's model gate has one path and
   * a test can drive the unavailable branch without a network (TC-161).
   */
  ensureReady(): Promise<void>;
}

/** Download lifecycle, as the Dashboard sees it (ADR-011, ADR-026, CH-214). */
export type ModelDownloadState =
  | { kind: 'not-downloaded' }
  | { kind: 'downloading'; percent: number }
  | { kind: 'ready' }
  /** Terminal for this attempt. Carries a retry action in the Dashboard (TC-161). */
  | { kind: 'unavailable'; reason: string };

/**
 * L2-normalize a vector in place of the caller's copy (FR-066, TC-068).
 *
 * Done here rather than by asking the library for normalized output, because
 * the normalization is what makes retrieval a plain dot product and it is worth
 * owning and testing.
 *
 * Two degenerate inputs, and they need different answers:
 *
 * - **A zero vector**, which an empty chunk produces. Returned unchanged rather
 *   than divided by zero. It scores 0 against everything, which is right.
 * - **A vector carrying `NaN` or `Infinity`**, which a quantized ONNX underflow
 *   or an all-`[UNK]` chunk can produce. Returning it unchanged, as this
 *   function used to, wrote the poison straight to `vectors.bin`. Its dot
 *   product is then `NaN`, and `NaN` makes a comparator return `NaN`, which is
 *   falsy: the sort fell through to the id tie-break and **one bad chunk took
 *   the entire top 3 for every question in that profile, permanently**. It is
 *   zeroed instead, so it scores 0 and simply never wins.
 */
export function l2Normalize(vector: Float32Array): Float32Array {
  let sumOfSquares = 0;
  for (const value of vector) sumOfSquares += value * value;
  const norm = Math.sqrt(sumOfSquares);
  if (!Number.isFinite(norm)) return new Float32Array(vector.length);
  if (norm === 0) return vector;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) {
    const value = (vector[i] ?? 0) / norm;
    // A single non-finite component survives a finite norm when the rest cancel.
    if (!Number.isFinite(value)) return new Float32Array(vector.length);
    out[i] = value;
  }
  return out;
}

/**
 * The cache key for a document's vectors (ADR-012, FR-067, TC-069, TC-070).
 *
 * `sha256(fileBytes):chunkerVersion:embeddingModelId`. Each part answers a
 * different question: the hash says the bytes are the same, the chunker version
 * says the chunk boundaries would be the same, and the model id says the vectors
 * would mean the same thing. A key that omitted any of the three would serve a
 * stale cache after a change that silently altered every vector.
 */
export function embeddingKeyFor(
  fileBytes: Buffer | Uint8Array,
  modelId: string = EMBEDDING_MODEL.id,
  chunkerVersion: string = CHUNKER_VERSION,
): string {
  const hash = createHash('sha256').update(fileBytes).digest('hex');
  return `${hash}:${chunkerVersion}:${modelId}`;
}

/** sha256 of a document's original bytes, the `contentHash` on its record. */
export function contentHashFor(fileBytes: Buffer | Uint8Array): string {
  return createHash('sha256').update(fileBytes).digest('hex');
}

/**
 * Where a model's files land under `<userData>/models`.
 *
 * transformers.js lays its cache out as `<cacheDir>/<org>/<name>/`, mirroring
 * the repository id, which is the path `docs/02-architecture.md` section 2
 * already documents.
 */
export function modelDirectoryFor(modelsRoot: string, modelId: string): string {
  return join(modelsRoot, ...modelId.split('/'));
}

/**
 * Whether a model is on disk and usable without a network (ADR-026).
 *
 * Checks for the ONNX weights and the tokenizer, the two files that make the
 * difference between a usable cache and a directory that merely exists. A
 * half-finished download leaves the directory in place, so its presence proves
 * nothing on its own.
 */
/** The ONNX build `loadOnce` requests. Must match the `quantized` flag it passes. */
export const QUANTIZED_WEIGHTS = 'model_quantized.onnx';

export function isModelCached(modelsRoot: string, modelId: string): boolean {
  const dir = modelDirectoryFor(modelsRoot, modelId);
  if (!existsSync(dir)) return false;
  const tokenizer = existsSync(join(dir, 'tokenizer.json'));
  // The quantized build specifically: `loadOnce` passes `quantized: true`, so a
  // cache holding only `model.onnx` reported ready and then failed to load,
  // which offline (ADR-026) is a "ready" model that can never be used.
  const weights = existsSync(join(dir, 'onnx', QUANTIZED_WEIGHTS));
  return tokenizer && weights;
}

/**
 * The model's maximum input length (FR-062, ADR-023, TC-066).
 *
 * The descriptor's `maxSeqLength` is a ceiling and a config on disk can only
 * lower it. That asymmetry is not a preference, it is forced by what
 * `@xenova/transformers` actually downloads:
 *
 * - It fetches `tokenizer.json`, `tokenizer_config.json` and `config.json`.
 * - It never fetches `sentence_bert_config.json`, which is where
 *   sentence-transformers records MiniLM's real 256-token limit. That file is a
 *   Python artifact and is not requested by any code path in the library.
 *
 * So on a real install the only limit on disk is `tokenizer_config.json`'s
 * `model_max_length`, which for this model is the BERT backbone's **512**. Taking
 * the smaller of what happens to be present therefore returned 512, the chunker
 * packed chunks of up to 510 word pieces, and every chunk past 256 was silently
 * truncated at embed time: precisely the failure ADR-023 exists to prevent, and
 * invisible because nothing errors.
 *
 * Clamping with the descriptor fixes that without weakening ADR-023's intent. A
 * model swap still cannot reintroduce truncation, because the new model's
 * registry entry carries its own limit and any config that claims less still
 * wins.
 *
 * @returns the descriptor's limit, lowered by any config on disk that is stricter.
 */
export function readMaxSeqLength(
  modelsRoot: string,
  model: EmbeddingModelDescriptor = EMBEDDING_MODEL,
): number {
  const dir = modelDirectoryFor(modelsRoot, model.id);
  const limits: number[] = [];

  for (const [file, field] of [
    ['sentence_bert_config.json', 'max_seq_length'],
    ['tokenizer_config.json', 'model_max_length'],
  ] as const) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    try {
      const value: unknown = (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)[
        field
      ];
      // A sentinel such as 1e30 means "no limit set", not a real limit.
      if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1_000_000) {
        limits.push(Math.floor(value));
      }
    } catch {
      // An unreadable config falls through to the shipped default below.
    }
  }

  return Math.min(model.maxSeqLength, ...limits);
}

/* ------------------------------------------------------------------ *
 * The transformers.js implementation
 * ------------------------------------------------------------------ */

/**
 * Longest word the token memo keeps.
 *
 * Comfortably above any real word in any language this app sees, and far below
 * the slice lengths the chunker asks about when hard-splitting.
 */
const MEMOIZED_WORD_MAX_CHARS = 64;

/** The subset of the library's progress events this app reacts to. */
interface ProgressEvent {
  status: string;
  file?: string;
  loaded?: number;
  total?: number;
}

interface FeatureExtractor {
  (
    texts: string[],
    options: { pooling: 'mean'; normalize: boolean },
  ): Promise<{ data: Float32Array | number[]; dims: number[] }>;
}

interface Tokenizer {
  encode(text: string): number[];
}

/**
 * The slice of `@xenova/transformers` this adapter uses.
 *
 * Declared structurally and loaded through {@link XenovaEmbedderOptions.loadLibrary}
 * so a test can drive the whole adapter without a 90 MB download, the same way
 * the STT adapters take an injected socket factory. Only the default loader,
 * which is one `import()` call, is then unreachable from a test.
 */
export interface TransformersLibrary {
  env: Record<string, unknown>;
  pipeline(
    task: string,
    model: string,
    options: Record<string, unknown>,
  ): Promise<FeatureExtractor>;
  AutoTokenizer: {
    from_pretrained(model: string, options: Record<string, unknown>): Promise<Tokenizer>;
  };
}

/** How to reach the model, and where to report the download (FR-066, ADR-011). */
export interface XenovaEmbedderOptions {
  /** `<userData>/models`. Injected so a test never writes to a real cache. */
  modelsRoot: string;
  descriptor?: EmbeddingModelDescriptor;
  /** Determinate progress, forwarded to CH-214 (FR-066, ADR-011). */
  onProgress?: (percent: number) => void;
  /** Set false to refuse a network fetch and fail fast on a cold cache (ADR-026). */
  allowDownload?: boolean;
  /** Injected in tests. Defaults to the real dynamic import. */
  loadLibrary?: () => Promise<TransformersLibrary>;
}

/**
 * The real library, imported lazily.
 *
 * At module scope this would pull an ONNX runtime into every app start,
 * including the runs that never ingest a document.
 */
async function importTransformers(): Promise<TransformersLibrary> {
  const mod: unknown = await import('@xenova/transformers');
  const namespace = ((mod as { default?: unknown }).default ?? mod) as Partial<TransformersLibrary>;
  // v2 exposes these as named exports; a CommonJS bundle sees them on `default`.
  const resolved = (
    typeof namespace.pipeline === 'function' ? namespace : (mod as Partial<TransformersLibrary>)
  ) as TransformersLibrary;
  if (typeof resolved.pipeline !== 'function' || !resolved.AutoTokenizer) {
    throw new Error('@xenova/transformers did not export pipeline and AutoTokenizer.');
  }
  return resolved;
}

/**
 * The real embedder (FR-066, ADR-011).
 *
 * Loading is idempotent and single-flight: two documents importing at once must
 * not each start a 90 MB download.
 */
export class XenovaEmbedder implements Embedder {
  private readonly descriptor: EmbeddingModelDescriptor;
  private loading: Promise<void> | null = null;
  private extractor: FeatureExtractor | null = null;
  private tokenizer: Tokenizer | null = null;
  private maxSeqLength: number;
  private readonly tokenMemo = new Map<string, number>();
  /** Per-file byte totals, so the reported percent spans the whole download. */
  private readonly progressByFile = new Map<string, { loaded: number; total: number }>();
  /** Highest percent reported so far. The bar never moves backwards. */
  private highestPercent = 0;

  constructor(private readonly options: XenovaEmbedderOptions) {
    this.descriptor = options.descriptor ?? EMBEDDING_MODEL;
    this.maxSeqLength = this.descriptor.maxSeqLength;
  }

  info(): EmbeddingModelInfo {
    return {
      id: this.descriptor.id,
      dimensions: this.descriptor.dimensions,
      maxSeqLength: this.maxSeqLength,
      specialTokenCount: this.descriptor.specialTokenCount,
    };
  }

  /** True once the model is on disk. Cheap: no library import (ADR-026). */
  isCached(): boolean {
    return isModelCached(this.options.modelsRoot, this.descriptor.id);
  }

  /** Loaded in this process, or at least cached on disk so loading needs no network. */
  isReady(): boolean {
    return (this.extractor !== null && this.tokenizer !== null) || this.isCached();
  }

  /** {@link Embedder.ensureReady}. An alias for {@link load}, which is already idempotent. */
  async ensureReady(): Promise<void> {
    return this.load();
  }

  /**
   * Download and load the model, at most once per process (ADR-011).
   *
   * The returned promise is memoized, so concurrent callers share one download.
   * A failure clears the memo, so the Dashboard retry action gets a real second
   * attempt rather than the first attempt's cached rejection (TC-161).
   */
  async load(): Promise<void> {
    if (this.extractor && this.tokenizer) return;
    if (!this.loading) {
      this.loading = this.loadOnce().catch((err: unknown) => {
        this.loading = null;
        throw err;
      });
    }
    return this.loading;
  }

  private async loadOnce(): Promise<void> {
    const allowDownload = this.options.allowDownload ?? true;
    if (!allowDownload && !this.isCached()) {
      throw new Error('The embedding model is not downloaded and downloading is disabled.');
    }

    const lib = await (this.options.loadLibrary ?? importTransformers)();
    lib.env.cacheDir = this.options.modelsRoot;
    lib.env.localModelPath = this.options.modelsRoot;
    lib.env.allowLocalModels = true;
    lib.env.allowRemoteModels = allowDownload;

    const progress = (event: ProgressEvent): void => this.notifyProgress(event);

    // The tokenizer first: the chunker needs it before anything is embedded, and
    // a tokenizer failure is cheaper to surface than a weights failure.
    this.tokenizer = await lib.AutoTokenizer.from_pretrained(this.descriptor.id, {
      progress_callback: progress,
    });
    this.extractor = await lib.pipeline('feature-extraction', this.descriptor.id, {
      quantized: true,
      progress_callback: progress,
    });

    this.maxSeqLength = readMaxSeqLength(this.options.modelsRoot, this.descriptor);
    this.options.onProgress?.(100);
  }

  /**
   * Turn per-file byte counts into one determinate percent (FR-066).
   *
   * Monotonic by construction, not by hope. The denominator grows every time a
   * new file announces its size, and the tokenizer is loaded before the 90 MB
   * weights, so the honest ratio really does fall: the bar hit 99 percent on the
   * 700 KB tokenizer and then snapped back to 3 percent when the weights
   * appeared. A bar that goes backwards reads as a stall, so the highest percent
   * reported so far is held instead.
   */
  private notifyProgress(event: ProgressEvent): void {
    if (event.status !== 'progress' || !event.file) return;
    if (typeof event.total !== 'number' || event.total <= 0) return;
    this.progressByFile.set(event.file, {
      loaded: typeof event.loaded === 'number' ? event.loaded : 0,
      total: event.total,
    });

    let loaded = 0;
    let total = 0;
    for (const entry of this.progressByFile.values()) {
      loaded += Math.min(entry.loaded, entry.total);
      total += entry.total;
    }
    if (total === 0) return;
    const percent = Math.min(99, Math.round((loaded / total) * 100));
    if (percent <= this.highestPercent) return;
    this.highestPercent = percent;
    this.options.onProgress?.(percent);
  }

  /**
   * Word pieces for one word, excluding the special tokens the encoder adds.
   *
   * Memoized per word. A resume repeats its vocabulary heavily, and the memo is
   * what keeps chunking a large document linear.
   */
  countTokens(word: string): number {
    const cached = this.tokenMemo.get(word);
    if (cached !== undefined) return cached;
    if (!this.tokenizer) throw new Error('The embedding model is not loaded. Call load() first.');
    const encoded = this.tokenizer.encode(word).length - this.descriptor.specialTokenCount;
    // Never zero: a word that costs nothing would let the packer accept an
    // unbounded number of them and produce a chunk over the cap.
    const value = Math.max(1, encoded);

    // Only real words are memoized. The rationale for the memo is that a resume
    // repeats its vocabulary, and that only holds for words. The chunker also
    // asks about long slices when it splits a word that is over budget on its
    // own, and those are unique, unbounded in length and never asked about
    // twice: memoizing them made one pasted base64 blob retain hundreds of
    // megabytes of strings for the life of the process.
    if (word.length <= MEMOIZED_WORD_MAX_CHARS) this.tokenMemo.set(word, value);
    return value;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    await this.load();
    if (!this.extractor) throw new Error('The embedding model failed to load.');

    // `normalize: false` on purpose. Normalization is this app's step, so it is
    // this app's test (TC-068), and it happens once at write time (FR-066).
    const output = await this.extractor(texts, { pooling: 'mean', normalize: false });
    const width = output.dims[output.dims.length - 1] ?? this.descriptor.dimensions;
    if (width !== this.descriptor.dimensions) {
      throw new Error(
        `Embedding width ${width} does not match the registry's ${this.descriptor.dimensions} ` +
          `for ${this.descriptor.id}.`,
      );
    }

    const flat = output.data instanceof Float32Array ? output.data : Float32Array.from(output.data);
    const vectors: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 1) {
      vectors.push(l2Normalize(flat.slice(i * width, (i + 1) * width)));
    }
    return vectors;
  }
}
