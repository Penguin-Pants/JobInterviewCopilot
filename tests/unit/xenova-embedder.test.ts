import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  modelDirectoryFor,
  XenovaEmbedder,
  type TransformersLibrary,
} from '../../src/main/rag/embed.js';
import {
  EMBEDDING_MODEL,
  findEmbeddingModel,
  EMBEDDING_REGISTRY,
} from '../../src/shared/registry/embedding.js';

/**
 * TASK-022. The `@xenova/transformers` adapter, driven through an injected
 * library rather than a 90 MB download.
 *
 * This is the same shape as the STT adapters: the transport is injected, so the
 * adapter is fully covered and only the one `import()` that reaches the real
 * package is out of a unit test's reach.
 */

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'icp-xenova-'));
}

/** Lay out a model cache the way transformers.js does. */
function seedModel(root: string, extra: Record<string, string> = {}): void {
  const dir = modelDirectoryFor(root, EMBEDDING_MODEL.id);
  mkdirSync(join(dir, 'onnx'), { recursive: true });
  writeFileSync(join(dir, 'tokenizer.json'), '{}');
  writeFileSync(join(dir, 'onnx', 'model_quantized.onnx'), 'weights');
  for (const [name, contents] of Object.entries(extra)) writeFileSync(join(dir, name), contents);
}

interface ProgressEvent {
  status: string;
  file?: string;
  loaded?: number;
  total?: number;
}

interface FakeLibOptions {
  /** Vector width the fake extractor returns. Defaults to the registry's. */
  width?: number;
  /** Events the weights phase emits, in order. */
  progress?: ProgressEvent[];
  /** Events the tokenizer phase emits, in order, before the weights start. */
  tokenizerProgress?: ProgressEvent[];
  /** Word pieces per word, before the special tokens are added back. */
  tokensPerWord?: number;
}

function fakeLibrary(options: FakeLibOptions = {}): {
  lib: TransformersLibrary;
  pipeline: ReturnType<typeof vi.fn>;
} {
  const width = options.width ?? EMBEDDING_MODEL.dimensions;

  const extractor = async (texts: string[]): Promise<{ data: Float32Array; dims: number[] }> => {
    const data = new Float32Array(texts.length * width);
    texts.forEach((text, row) => {
      // Deliberately unnormalized, so the adapter's own normalization is what
      // the assertions measure.
      for (let d = 0; d < width; d += 1) data[row * width + d] = (text.length + d) * 3;
    });
    return { data, dims: [texts.length, width] };
  };

  const pipeline = vi.fn(async (_task: string, _model: string, opts: Record<string, unknown>) => {
    const callback = opts.progress_callback as ((event: unknown) => void) | undefined;
    for (const event of options.progress ?? []) callback?.(event);
    return extractor;
  });

  return {
    pipeline,
    lib: {
      env: {},
      pipeline: pipeline as unknown as TransformersLibrary['pipeline'],
      AutoTokenizer: {
        from_pretrained: async (_model: string, opts: Record<string, unknown>) => {
          const callback = opts.progress_callback as ((event: unknown) => void) | undefined;
          for (const event of options.tokenizerProgress ?? []) callback?.(event);
          return {
            // `encode` includes the special tokens, as a BERT tokenizer does.
            encode: (text: string) =>
              new Array(
                text.split(/\s+/).filter(Boolean).length * (options.tokensPerWord ?? 1) +
                  EMBEDDING_MODEL.specialTokenCount,
              ).fill(0),
          };
        },
      },
    },
  };
}

describe('XenovaEmbedder loading', () => {
  it('points the library at the app cache and allows remote fetches by default', async () => {
    const root = tmp();
    const { lib } = fakeLibrary();
    const embedder = new XenovaEmbedder({ modelsRoot: root, loadLibrary: async () => lib });

    await embedder.ensureReady();

    expect(lib.env).toMatchObject({
      cacheDir: root,
      localModelPath: root,
      allowLocalModels: true,
      allowRemoteModels: true,
    });
  });

  it('refuses a network fetch when downloading is disabled and nothing is cached', async () => {
    const { lib } = fakeLibrary();
    const embedder = new XenovaEmbedder({
      modelsRoot: tmp(),
      allowDownload: false,
      loadLibrary: async () => lib,
    });

    await expect(embedder.load()).rejects.toThrow(/not downloaded/i);
  });

  it('loads from a cold cache when downloading is disabled but the model is present', async () => {
    const root = tmp();
    seedModel(root);
    const { lib } = fakeLibrary();
    const embedder = new XenovaEmbedder({
      modelsRoot: root,
      allowDownload: false,
      loadLibrary: async () => lib,
    });

    await embedder.ensureReady();

    expect(lib.env.allowRemoteModels).toBe(false);
    expect(embedder.isReady()).toBe(true);
  });

  it('loads once for concurrent callers rather than starting two downloads', async () => {
    const root = tmp();
    const { lib, pipeline } = fakeLibrary();
    const embedder = new XenovaEmbedder({ modelsRoot: root, loadLibrary: async () => lib });

    await Promise.all([embedder.load(), embedder.load(), embedder.load()]);

    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  it('clears the memo on failure, so a retry is a real second attempt', async () => {
    const root = tmp();
    const loadLibrary = vi
      .fn<() => Promise<TransformersLibrary>>()
      .mockRejectedValueOnce(new Error('network down'))
      .mockImplementation(async () => fakeLibrary().lib);
    const embedder = new XenovaEmbedder({ modelsRoot: root, loadLibrary });

    await expect(embedder.load()).rejects.toThrow('network down');
    await expect(embedder.load()).resolves.toBeUndefined();
    expect(loadLibrary).toHaveBeenCalledTimes(2);
  });

  it('reads the real max_seq_length off the loaded model (ADR-023)', async () => {
    const root = tmp();
    seedModel(root, {
      'sentence_bert_config.json': JSON.stringify({ max_seq_length: 192 }),
      'tokenizer_config.json': JSON.stringify({ model_max_length: 512 }),
    });
    const { lib } = fakeLibrary();
    const embedder = new XenovaEmbedder({ modelsRoot: root, loadLibrary: async () => lib });

    expect(embedder.info().maxSeqLength).toBe(EMBEDDING_MODEL.maxSeqLength);
    await embedder.ensureReady();
    expect(embedder.info().maxSeqLength).toBe(192);
  });
});

describe('XenovaEmbedder download progress (FR-066)', () => {
  /** Run the loader and collect every percent it reported, in order. */
  async function percentsFor(options: FakeLibOptions): Promise<number[]> {
    const onProgress = vi.fn();
    const { lib } = fakeLibrary(options);
    await new XenovaEmbedder({
      modelsRoot: tmp(),
      onProgress,
      loadLibrary: async () => lib,
    }).ensureReady();
    return onProgress.mock.calls.map((c) => c[0] as number);
  }

  it('never goes backwards, stays in range and ends at 100', async () => {
    const percents = await percentsFor({
      tokenizerProgress: [
        { status: 'progress', file: 'tokenizer.json', loaded: 350_000, total: 700_000 },
        { status: 'progress', file: 'tokenizer.json', loaded: 700_000, total: 700_000 },
      ],
      progress: [
        { status: 'progress', file: 'model_quantized.onnx', loaded: 0, total: 90_000_000 },
        { status: 'progress', file: 'model_quantized.onnx', loaded: 45_000_000, total: 90_000_000 },
        { status: 'progress', file: 'model_quantized.onnx', loaded: 90_000_000, total: 90_000_000 },
      ],
    });

    expect(percents.every((p) => p >= 0 && p <= 100)).toBe(true);
    expect([...percents].sort((a, b) => a - b)).toEqual(percents);
    expect(percents[percents.length - 1]).toBe(100);
  });

  it('keeps moving through the weights instead of parking at 99', async () => {
    // The tokenizer is a few hundred kilobytes and the weights are about 90 MB.
    // One shared byte-ratio drove the bar to 99 on the tokenizer; clamping it
    // monotonically then held it there for the entire real download, which is a
    // nominally determinate bar that tells the user nothing.
    const percents = await percentsFor({
      tokenizerProgress: [
        { status: 'progress', file: 'tokenizer.json', loaded: 700_000, total: 700_000 },
      ],
      progress: [
        { status: 'progress', file: 'model_quantized.onnx', loaded: 9_000_000, total: 90_000_000 },
        { status: 'progress', file: 'model_quantized.onnx', loaded: 45_000_000, total: 90_000_000 },
        { status: 'progress', file: 'model_quantized.onnx', loaded: 81_000_000, total: 90_000_000 },
      ],
    });

    // The tokenizer may not claim more than its share of the bar.
    expect(percents[0]).toBeLessThanOrEqual(5);
    // And the weights phase reports several distinct, rising values.
    const duringWeights = percents.slice(1, -1);
    expect(duringWeights.length).toBeGreaterThanOrEqual(3);
    expect(new Set(duringWeights).size).toBe(duringWeights.length);
    expect(Math.max(...duringWeights)).toBeGreaterThan(50);
  });

  it('ignores events with no file or no known total rather than reporting NaN', async () => {
    const percents = await percentsFor({
      progress: [
        { status: 'initiate', file: 'model.onnx' },
        { status: 'progress', loaded: 10, total: 100 },
        { status: 'progress', file: 'model.onnx', loaded: 10, total: 0 },
      ],
    });

    // Only the completion call, and nothing that could render as NaN percent.
    expect(percents).toEqual([100]);
  });

  it('never reports 100 from byte progress alone, so the bar does not finish early', async () => {
    const percents = await percentsFor({
      progress: [{ status: 'progress', file: 'model.onnx', loaded: 100, total: 100 }],
    });

    // The byte-driven event caps at 99; only loading finishing reports 100.
    expect(percents).toEqual([99, 100]);
  });
});

describe('XenovaEmbedder tokenizing and embedding', () => {
  it('counts word pieces excluding the special tokens the encoder adds', async () => {
    const { lib } = fakeLibrary({ tokensPerWord: 3 });
    const embedder = new XenovaEmbedder({ modelsRoot: tmp(), loadLibrary: async () => lib });
    await embedder.ensureReady();

    expect(embedder.countTokens('hello')).toBe(3);
    // Memoized: a second call returns the same number without re-encoding.
    expect(embedder.countTokens('hello')).toBe(3);
  });

  it('never returns zero tokens for a word', async () => {
    const lib = fakeLibrary().lib;
    lib.AutoTokenizer.from_pretrained = async () => ({ encode: () => [] });
    const embedder = new XenovaEmbedder({ modelsRoot: tmp(), loadLibrary: async () => lib });
    await embedder.ensureReady();

    // A word that costs nothing would let the chunk packer accept unboundedly
    // many of them and produce a chunk over the model's cap.
    expect(embedder.countTokens('anything')).toBe(1);
  });

  it('returns one L2-normalized vector per input, in input order', async () => {
    const { lib } = fakeLibrary();
    const embedder = new XenovaEmbedder({ modelsRoot: tmp(), loadLibrary: async () => lib });

    const vectors = await embedder.embed(['one', 'two words', 'three words here']);

    expect(vectors).toHaveLength(3);
    for (const vector of vectors) {
      expect(vector).toHaveLength(EMBEDDING_MODEL.dimensions);
      let sum = 0;
      for (const value of vector) sum += value * value;
      expect(Math.abs(Math.sqrt(sum) - 1)).toBeLessThan(1e-6);
    }
    // Different inputs produce different vectors, so rows were not aliased.
    expect([...vectors[0]!]).not.toEqual([...vectors[2]!]);
  });

  it('embeds nothing for an empty batch and does not load the model for it', async () => {
    const loadLibrary = vi.fn(async () => fakeLibrary().lib);
    const embedder = new XenovaEmbedder({ modelsRoot: tmp(), loadLibrary });

    expect(await embedder.embed([])).toEqual([]);
    expect(loadLibrary).not.toHaveBeenCalled();
  });

  it('refuses a model whose width disagrees with the registry', async () => {
    const { lib } = fakeLibrary({ width: 128 });
    const embedder = new XenovaEmbedder({ modelsRoot: tmp(), loadLibrary: async () => lib });

    // Silently accepting 128 would write rows the vector store reads at a
    // 384-value stride, so every chunk after the first would be garbage.
    await expect(embedder.embed(['text'])).rejects.toThrow(/does not match the registry/);
  });

  it('loads on demand when embed is called before ensureReady', async () => {
    const { lib, pipeline } = fakeLibrary();
    const embedder = new XenovaEmbedder({ modelsRoot: tmp(), loadLibrary: async () => lib });

    await embedder.embed(['text']);

    expect(pipeline).toHaveBeenCalledTimes(1);
  });
});

describe('the embedding registry', () => {
  it('finds a model by id and reports nothing for an unknown one', () => {
    expect(findEmbeddingModel(EMBEDDING_MODEL.id)).toBe(EMBEDDING_MODEL);
    expect(findEmbeddingModel('nope/nothing')).toBeUndefined();
  });

  it('lists the v1 model', () => {
    expect(EMBEDDING_REGISTRY).toEqual([EMBEDDING_MODEL]);
    expect(EMBEDDING_MODEL.id).toBe('Xenova/all-MiniLM-L6-v2');
    expect(EMBEDDING_MODEL.maxSeqLength).toBe(256);
  });
});
