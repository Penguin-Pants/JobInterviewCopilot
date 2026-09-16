import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHUNKER_VERSION } from '../../src/main/rag/chunk.js';
import {
  contentHashFor,
  embeddingKeyFor,
  isModelCached,
  l2Normalize,
  modelDirectoryFor,
  readMaxSeqLength,
} from '../../src/main/rag/embed.js';
import { EMBEDDING_MODEL, contentTokenBudget } from '../../src/shared/registry/embedding.js';

/**
 * TASK-022. TC-068 vector shape, plus the cache key and the model-config read
 * that TC-069, TC-070 and TC-066 depend on.
 */

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'icp-embed-'));
}

/** Lay out a model cache the way transformers.js does. */
function seedModel(
  root: string,
  files: Record<string, string> = {},
  modelId = EMBEDDING_MODEL.id,
): string {
  const dir = modelDirectoryFor(root, modelId);
  mkdirSync(join(dir, 'onnx'), { recursive: true });
  writeFileSync(join(dir, 'tokenizer.json'), '{}');
  writeFileSync(join(dir, 'onnx', 'model_quantized.onnx'), 'weights');
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
  }
  return dir;
}

describe('TC-068 vector shape', () => {
  it('normalizes to an L2 norm within 1e-6 of 1.0', () => {
    const raw = Float32Array.from({ length: 384 }, (_, i) => Math.sin(i) * (i % 7) + 0.5);
    const normalized = l2Normalize(raw);

    expect(normalized).toHaveLength(384);
    let sum = 0;
    for (const value of normalized) sum += value * value;
    expect(Math.abs(Math.sqrt(sum) - 1)).toBeLessThan(1e-6);
  });

  it('preserves direction, so cosine similarity is unchanged', () => {
    const raw = Float32Array.from([3, 4, 0, 0]);
    const normalized = l2Normalize(raw);
    expect(normalized[0]).toBeCloseTo(0.6, 6);
    expect(normalized[1]).toBeCloseTo(0.8, 6);
  });

  it('zeroes a vector carrying NaN or Infinity rather than storing the poison', () => {
    // A quantized ONNX underflow or an all-[UNK] chunk produces one. Stored raw,
    // its dot product is NaN, NaN makes the comparator falsy, and one bad chunk
    // took the whole top 3 for every question in the profile, permanently.
    for (const poison of [NaN, Infinity, -Infinity]) {
      const raw = Float32Array.from([1, 2, poison, 4]);
      const result = l2Normalize(raw);
      expect([...result], String(poison)).toEqual([0, 0, 0, 0]);
    }
  });

  it('returns a zero vector unchanged rather than dividing by zero', () => {
    const zero = new Float32Array(8);
    const result = l2Normalize(zero);
    expect([...result]).toEqual([...zero]);
    expect([...result].every((v) => Number.isFinite(v))).toBe(true);
  });

  it('the registry declares 384 dimensions (FR-066)', () => {
    expect(EMBEDDING_MODEL.dimensions).toBe(384);
  });
});

describe('ADR-012 cache key', () => {
  const bytes = Buffer.from('# Resume\n\nBody.');

  it('is sha256(fileBytes):chunkerVersion:embeddingModelId', () => {
    const key = embeddingKeyFor(bytes);
    const [hash, chunker, ...model] = key.split(':');

    expect(hash).toBe(contentHashFor(bytes));
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(chunker).toBe(CHUNKER_VERSION);
    expect(model.join(':')).toBe(EMBEDDING_MODEL.id);
  });

  it('changes when the bytes change', () => {
    expect(embeddingKeyFor(bytes)).not.toBe(embeddingKeyFor(Buffer.from('# Resume\n\nOther.')));
  });

  it('changes when the chunker version changes, with no manual purge (TC-070)', () => {
    expect(embeddingKeyFor(bytes, EMBEDDING_MODEL.id, '1')).not.toBe(
      embeddingKeyFor(bytes, EMBEDDING_MODEL.id, '2'),
    );
  });

  it('changes when the embedding model changes', () => {
    expect(embeddingKeyFor(bytes, 'other/model')).not.toBe(embeddingKeyFor(bytes));
  });

  it('is stable for identical bytes', () => {
    expect(embeddingKeyFor(bytes)).toBe(embeddingKeyFor(Buffer.from('# Resume\n\nBody.')));
  });
});

describe('ADR-026 model cache detection', () => {
  it('is false for a directory that does not exist', () => {
    expect(isModelCached(tmp(), EMBEDDING_MODEL.id)).toBe(false);
  });

  it('is false for a half-finished download that left the directory behind', () => {
    const root = tmp();
    mkdirSync(modelDirectoryFor(root, EMBEDDING_MODEL.id), { recursive: true });
    expect(isModelCached(root, EMBEDDING_MODEL.id)).toBe(false);
  });

  it('is true once the tokenizer and the weights are both present', () => {
    const root = tmp();
    seedModel(root);
    expect(isModelCached(root, EMBEDDING_MODEL.id)).toBe(true);
  });

  it('is false for a cache holding only the unquantized weights', () => {
    // `loadOnce` passes `quantized: true`, so accepting `model.onnx` reported a
    // model as ready that then failed to load. Offline (ADR-026) that is a
    // "ready" model the user can never actually use.
    const root = tmp();
    const dir = modelDirectoryFor(root, EMBEDDING_MODEL.id);
    mkdirSync(join(dir, 'onnx'), { recursive: true });
    writeFileSync(join(dir, 'tokenizer.json'), '{}');
    writeFileSync(join(dir, 'onnx', 'model.onnx'), 'weights');

    expect(isModelCached(root, EMBEDDING_MODEL.id)).toBe(false);
  });
});

describe('ADR-023 the cap comes from the model, not from a literal', () => {
  it('caps at 256 for the layout a real install actually has', () => {
    // This is the only layout that occurs in production. transformers.js fetches
    // tokenizer.json, tokenizer_config.json and config.json; it never fetches
    // sentence_bert_config.json, which is the Python artifact holding MiniLM's
    // real 256 limit. Taking the smaller of "what happens to be present"
    // therefore returned the BERT backbone's 512, and the chunker packed chunks
    // of 510 word pieces that the model silently truncated at 256.
    const root = tmp();
    seedModel(root, { 'tokenizer_config.json': JSON.stringify({ model_max_length: 512 }) });
    expect(readMaxSeqLength(root)).toBe(256);
  });

  it('caps at the shipped limit when no config is on disk at all', () => {
    const root = tmp();
    seedModel(root);
    expect(readMaxSeqLength(root)).toBe(EMBEDDING_MODEL.maxSeqLength);
  });

  it('lets a config on disk lower the cap', () => {
    const root = tmp();
    seedModel(root, { 'sentence_bert_config.json': JSON.stringify({ max_seq_length: 128 }) });
    expect(readMaxSeqLength(root)).toBe(128);

    const other = tmp();
    seedModel(other, { 'tokenizer_config.json': JSON.stringify({ model_max_length: 96 }) });
    expect(readMaxSeqLength(other)).toBe(96);
  });

  it('never lets a config raise the cap above the registry limit', () => {
    const root = tmp();
    seedModel(root, {
      'sentence_bert_config.json': JSON.stringify({ max_seq_length: 4096 }),
      'tokenizer_config.json': JSON.stringify({ model_max_length: 8192 }),
    });
    expect(readMaxSeqLength(root)).toBe(EMBEDDING_MODEL.maxSeqLength);
  });

  it('takes the smaller of two configs that both lower it', () => {
    const root = tmp();
    seedModel(root, {
      'sentence_bert_config.json': JSON.stringify({ max_seq_length: 200 }),
      'tokenizer_config.json': JSON.stringify({ model_max_length: 128 }),
    });
    expect(readMaxSeqLength(root)).toBe(128);
  });

  it('ignores a sentinel that means "no limit set"', () => {
    const root = tmp();
    seedModel(root, {
      'sentence_bert_config.json': JSON.stringify({ max_seq_length: 200 }),
      'tokenizer_config.json': JSON.stringify({ model_max_length: 1e30 }),
    });
    expect(readMaxSeqLength(root)).toBe(200);
  });

  it('falls back to the shipped default when a config is unreadable', () => {
    const root = tmp();
    seedModel(root, { 'sentence_bert_config.json': 'not json' });
    expect(readMaxSeqLength(root)).toBe(EMBEDDING_MODEL.maxSeqLength);
  });

  it('leaves room for the special tokens the encoder adds', () => {
    expect(contentTokenBudget(EMBEDDING_MODEL)).toBe(
      EMBEDDING_MODEL.maxSeqLength - EMBEDDING_MODEL.specialTokenCount,
    );
    expect(contentTokenBudget({ ...EMBEDDING_MODEL, maxSeqLength: 128 })).toBe(126);
  });
});
