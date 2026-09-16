/**
 * The STT facade (`CMP-04`). Mirrors `docs/02-architecture.md` section 3.1.
 *
 * This file and `src/main/ai/stt/**` are on the reachable audio path, so the
 * ESLint rule in `eslint.config.mjs` forbids importing any filesystem module
 * here. Neutering the worker's buffer does not stop an adapter from writing the
 * bytes it receives, so the ban has to reach this far (NFR-002).
 *
 * Nothing outside this directory and the registry may branch on a provider id.
 * Callers ask `openSttSession` for a `ProviderChoice` and get a session back.
 */
import type {
  AudioChunk,
  ErrorClass,
  ProviderChoice,
  ProviderDescriptor,
  ProviderError,
  SttModelDescriptor,
  TranscriptEvent,
  TranscriptSource,
  ValidationResult,
} from '../../shared/types.js';
import { STT_REGISTRY, findSttModel } from '../../shared/registry/stt.js';

export interface SttSessionOptions {
  /**
   * The user's chosen turn-end gap, passed to whichever parameter the provider
   * uses for it. Never hard-coded by an adapter (FR-050, TC-159).
   */
  turnEndGapMs: number;
}

export interface SttSession {
  readonly source: TranscriptSource;
  readonly choice: ProviderChoice;
  push(chunk: AudioChunk): void;
  /**
   * PCM bytes this session has actually put on the wire, if it can say
   * (`FR-103`, ADR-036).
   *
   * The Cost Meter bills audio "actually sent to a provider". A streaming
   * adapter drops queued chunks during an outage rather than buffering without
   * bound (ADR-027), so only the adapter knows what really went. Optional
   * because an adapter that sends everything it is handed has nothing to
   * correct; the caller then bills the chunk it handed over.
   */
  readonly sentBytes?: number;
  close(): Promise<void>;
  on(e: 'transcript', h: (t: TranscriptEvent) => void): void;
  /** Provider-native turn end. */
  on(e: 'endpoint', h: () => void): void;
  on(e: 'error', h: (err: ProviderError) => void): void;
}

export interface SttProvider {
  readonly id: string;
  open(
    choice: ProviderChoice,
    source: TranscriptSource,
    key: string,
    options: SttSessionOptions,
  ): Promise<SttSession>;
  validateKey(key: string, modelId: string): Promise<ValidationResult>;
}

/** 'auth' and 'client' are the caller's fault and will fail identically forever. */
export function isRetryable(errorClass: ErrorClass): boolean {
  return errorClass !== 'auth' && errorClass !== 'client';
}

export function providerError(
  providerId: string,
  errorClass: ErrorClass,
  message: string,
): ProviderError {
  const err = new Error(message) as ProviderError;
  err.class = errorClass;
  err.providerId = providerId;
  err.retryable = isRetryable(errorClass);
  return err;
}

/**
 * Maps an HTTP or WebSocket close status onto an error class. Shared by every
 * adapter so a 401 means the same thing whoever returned it (ADR-010).
 */
export function classifyStatus(status: number): ErrorClass {
  if (status === 401 || status === 403) return 'auth';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate-limit';
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  return 'network';
}

/**
 * The adapter tables. One row per provider id, in the class the model calls for.
 *
 * Two tables rather than one because a provider can ship models of both
 * classes: a realtime socket and a REST endpoint under a single provider id.
 * The class is read off the selected model's registry entry, never off the
 * provider id, so this stays registry-driven (FR-037, TC-056, TC-151).
 */
export type SttTransportClass = 'streaming' | 'batch';

const ADAPTERS: Record<SttTransportClass, Map<string, SttProvider>> = {
  streaming: new Map(),
  batch: new Map(),
};

export function registerSttProvider(
  provider: SttProvider,
  transport: SttTransportClass = 'streaming',
): void {
  ADAPTERS[transport].set(provider.id, provider);
}

export function getSttProvider(
  providerId: string,
  transport: SttTransportClass = 'streaming',
): SttProvider | null {
  return ADAPTERS[transport].get(providerId) ?? null;
}

/** Test seam: drop every registered adapter. */
export function clearSttProviders(): void {
  ADAPTERS.streaming.clear();
  ADAPTERS.batch.clear();
}

export async function openSttSession(
  choice: ProviderChoice,
  source: TranscriptSource,
  key: string,
  options: SttSessionOptions,
  registry: ProviderDescriptor<SttModelDescriptor>[] = STT_REGISTRY,
): Promise<SttSession> {
  const model = findSttModel(choice, registry);
  if (!model) {
    throw providerError(
      choice.providerId,
      'client',
      `"${choice.providerId}:${choice.modelId}" is not in the speech-to-text registry.`,
    );
  }

  const transport: SttTransportClass = model.streaming ? 'streaming' : 'batch';
  const provider = getSttProvider(choice.providerId, transport);
  if (!provider) {
    throw providerError(
      choice.providerId,
      'client',
      `No ${transport} speech-to-text adapter is registered for "${choice.providerId}".`,
    );
  }
  return provider.open(choice, source, key, options);
}
