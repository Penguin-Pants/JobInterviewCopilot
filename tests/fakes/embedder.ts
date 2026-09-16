import type { Embedder, EmbeddingModelInfo } from '../../src/main/rag/embed.js';
import { l2Normalize } from '../../src/main/rag/embed.js';

/**
 * A deterministic stand-in for `XenovaEmbedder` (TC-068, TC-069, TC-074).
 *
 * The real embedder needs a 90 MB download and an ONNX runtime, which CI has no
 * business doing and which would make every timing assertion depend on a network
 * fetch. This double satisfies the same interface and counts its calls, which is
 * how "performs zero embedding calls" is asserted at all.
 *
 * Vectors come from a bag-of-words hash. Two properties matter and both hold:
 * the same text always produces the same vector, and texts sharing words score
 * higher against each other than texts sharing none. That is enough for every
 * retrieval assertion in this milestone; none of them tests semantic quality,
 * which is the model's business rather than this app's.
 */
export class FakeEmbedder implements Embedder {
  /** Every text this embedder has been asked to embed, in order. */
  readonly calls: string[][] = [];
  /** Set to make the next `embed` reject, for the failure paths. */
  failNext: Error | null = null;
  /** Set to drive the model gate's `not-downloaded` and `unavailable` branches (TC-161). */
  ready = true;
  /** Why `ensureReady` should reject. Null means it resolves. */
  unavailableReason: string | null = null;
  /** How many times the model gate asked for the model. */
  ensureReadyCalls = 0;

  constructor(
    private readonly modelInfo: EmbeddingModelInfo = {
      id: 'fake/mini',
      dimensions: 8,
      maxSeqLength: 32,
      specialTokenCount: 2,
    },
  ) {}

  info(): EmbeddingModelInfo {
    return this.modelInfo;
  }

  isReady(): boolean {
    return this.ready;
  }

  async ensureReady(): Promise<void> {
    this.ensureReadyCalls += 1;
    if (this.unavailableReason) throw new Error(this.unavailableReason);
    this.ready = true;
  }

  /** How many texts have been embedded across every call. */
  get embeddedCount(): number {
    return this.calls.reduce((sum, batch) => sum + batch.length, 0);
  }

  reset(): void {
    this.calls.length = 0;
  }

  /**
   * One word piece per four characters, at least one.
   *
   * Deliberately not the MiniLM tokenizer. A test that pinned real word-piece
   * counts would be asserting the tokenizer's behavior, and the property under
   * test is that the chunker respects whatever budget it is given (TC-066).
   */
  countTokens(word: string): number {
    return Math.max(1, Math.ceil(word.length / 4));
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls.push([...texts]);
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    return texts.map((text) => this.vectorFor(text));
  }

  /** Exposed so a test can build the vector it expects to retrieve. */
  vectorFor(text: string): Float32Array {
    const vector = new Float32Array(this.modelInfo.dimensions);
    for (const word of text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)) {
      const slot = hash(word) % this.modelInfo.dimensions;
      vector.set([(vector[slot] ?? 0) + 1], slot);
    }
    // A text with no words would otherwise be the zero vector, which scores 0
    // against everything and makes a tie look like a miss.
    if (vector.every((v) => v === 0)) vector.set([1], 0);
    return l2Normalize(vector);
  }
}

/** FNV-1a. Stable across runs and across platforms, unlike a string hash built from Math. */
function hash(word: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < word.length; i += 1) {
    value ^= word.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}
