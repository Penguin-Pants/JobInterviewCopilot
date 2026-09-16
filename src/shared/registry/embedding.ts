/**
 * The embedding registry. Mirrors `docs/02-architecture.md` section 2.1a
 * (ADR-011, ADR-012, ADR-023).
 *
 * This file is data. It is the only place an embedding model is named, so a
 * model swap is one entry here and nothing else in the app branches on a model
 * id.
 *
 * `maxSeqLength` is the shipped default, not the authority. The authority is the
 * `max_seq_length` in the downloaded model's own config, read at ingest time by
 * `src/main/rag/embed.ts` and passed to the chunker. The value here is what the
 * app uses before a model is on disk, for example to size a preview. A model
 * that truncates beyond its sequence length would silently store a chunk tail
 * that contributes nothing to its vector, which is exactly what ADR-023 exists
 * to prevent, so the number is never hard-coded at the point of use.
 */
/** What the chunker and the vector store need to know about an embedding model. */
export interface EmbeddingModelDescriptor {
  /** Hugging Face repository id, also the `embeddingModelId` in the cache key (ADR-012). */
  id: string;
  displayName: string;
  /** Vector width. Row stride in `<docId>.vectors.bin` (FR-066). */
  dimensions: number;
  /**
   * Shipped default for the model's maximum input length in word pieces.
   * Superseded at runtime by the downloaded config (ADR-023, FR-062).
   */
  maxSeqLength: number;
  /**
   * Word pieces the tokenizer adds around every input, `[CLS]` and `[SEP]` for
   * a BERT-family model. Subtracted from the cap so a chunk that fills the
   * budget still fits once the tokenizer wraps it.
   */
  specialTokenCount: number;
  /** Approximate download size, shown next to the determinate bar (ADR-011). */
  approximateDownloadMb: number;
}

/**
 * The v1 embedding model (FR-066, ADR-011).
 *
 * Local and free: it needs no credential, which is why no entry here carries a
 * credential id. That is the reason embeddings keep working when every
 * provider key is rejected, and why `NFR-008` can promise offline ingestion at
 * all (ADR-026).
 */
export const EMBEDDING_MODEL: EmbeddingModelDescriptor = {
  id: 'Xenova/all-MiniLM-L6-v2',
  displayName: 'MiniLM L6 v2 (local)',
  dimensions: 384,
  maxSeqLength: 256,
  specialTokenCount: 2,
  approximateDownloadMb: 90,
};

/** Every embedding model this build can use. One entry in v1 (FR-066). */
export const EMBEDDING_REGISTRY: EmbeddingModelDescriptor[] = [EMBEDDING_MODEL];

/** Look a model up by its registry id (FR-066). @returns undefined when unknown. */
export function findEmbeddingModel(id: string): EmbeddingModelDescriptor | undefined {
  return EMBEDDING_REGISTRY.find((m) => m.id === id);
}

/**
 * How many word pieces of real content a chunk may carry (FR-062, ADR-023).
 *
 * Takes the descriptor rather than reading {@link EMBEDDING_MODEL} directly, so
 * the runtime value read from the downloaded config flows through and a test can
 * prove the cap is not hard-coded (TC-066).
 */
export function contentTokenBudget(model: EmbeddingModelDescriptor): number {
  return model.maxSeqLength - model.specialTokenCount;
}
