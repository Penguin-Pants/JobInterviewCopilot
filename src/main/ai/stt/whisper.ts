/**
 * The non-streaming STT class, and its one v1 member, `openai:whisper-1`.
 * No filesystem imports (NFR-002).
 *
 * Whisper REST cannot stream, so this buffers whole seconds of PCM, wraps each
 * buffer in an in-memory WAV and posts one request per buffer. It emits
 * `isFinal: true` and nothing else: there are no interims to emit and no turn
 * signal to report (ADR-022, NFR-017).
 */
import type {
  AudioChunk,
  ProviderChoice,
  ProviderError,
  TranscriptEvent,
  TranscriptSource,
} from '../../../shared/types.js';
import { findSttModel } from '../../../shared/registry/stt.js';
import { classifyStatus, providerError } from '../stt.js';
import type { SttProvider, SttSession, SttSessionOptions } from '../stt.js';
import { validateOpenAiKey } from './openai-realtime.js';
import { encodeWav } from './wav.js';

/**
 * The fallback buffer window, used only for a batch model whose registry entry
 * declares none. Every v1 batch model declares one (ADR-022).
 */
export const WHISPER_BUFFER_MS = 4000;

/** One chunk is 1000 ms (FR-041), so a window of N ms is N/1000 chunks. */
export function bufferChunksFor(batchIntervalMs: number): number {
  return Math.max(1, Math.round(batchIntervalMs / 1000));
}

export const WHISPER_BUFFER_CHUNKS = bufferChunksFor(WHISPER_BUFFER_MS);

export const WHISPER_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';

export type PostWav = (
  body: FormData,
  key: string,
) => Promise<{ ok: boolean; status: number; text: string }>;

type Handlers = {
  transcript: ((t: TranscriptEvent) => void)[];
  error: ((e: ProviderError) => void)[];
};

export class WhisperSttSession implements SttSession {
  readonly source: TranscriptSource;
  readonly choice: ProviderChoice;

  /**
   * At most `bufferChunks` chunks, cleared the moment a buffer is full.
   * Exported through `bufferedChunks` so the bound is asserted from outside
   * rather than inferred (FR-043, ADR-027).
   */
  private buffer: ArrayBuffer[] = [];
  private closed = false;
  private inFlight = 0;

  private readonly handlers: Handlers = { transcript: [], error: [] };

  constructor(opts: {
    source: TranscriptSource;
    choice: ProviderChoice;
    key: string;
    post: PostWav;
    /** The window this model buffers, from its registry entry (ADR-022). */
    bufferChunks?: number;
  }) {
    this.source = opts.source;
    this.choice = opts.choice;
    this.key = opts.key;
    this.post = opts.post;
    this.bufferChunks = opts.bufferChunks ?? WHISPER_BUFFER_CHUNKS;
  }

  private readonly key: string;
  private readonly post: PostWav;
  private readonly bufferChunks: number;

  get bufferedChunks(): number {
    return this.buffer.length;
  }

  get requestsInFlight(): number {
    return this.inFlight;
  }

  push(chunk: AudioChunk): void {
    if (this.closed) return;
    this.buffer.push(chunk.pcm);
    if (this.buffer.length < this.bufferChunks) return;
    this.flush();
  }

  /** Posts whatever is buffered and releases it. Safe to call with a partial buffer. */
  private flush(): void {
    if (this.buffer.length === 0) return;
    // Hand the array off and replace it, so the request holds the only
    // reference and the session retains nothing.
    const pending = this.buffer;
    this.buffer = [];
    void this.transcribe(encodeWav(pending));
  }

  private async transcribe(wav: Uint8Array): Promise<void> {
    this.inFlight += 1;
    try {
      const form = new FormData();
      // A Blob, never a path and never a stream. Nothing here can touch disk.
      form.append('file', new Blob([wav as BlobPart], { type: 'audio/wav' }), 'audio.wav');
      form.append('model', this.choice.modelId);
      form.append('response_format', 'text');

      const res = await this.post(form, this.key);
      if (!res.ok) {
        this.fail(classifyStatus(res.status), res.text || `OpenAI returned ${String(res.status)}.`);
        return;
      }
      const text = res.text.trim();
      if (text === '' || this.closed) return;
      const event: TranscriptEvent = {
        source: this.source,
        text,
        // Whisper has no interim state. Everything it returns is final.
        isFinal: true,
        timestamp: Date.now(),
        providerId: this.choice.providerId,
      };
      for (const h of this.handlers.transcript) h(event);
    } catch {
      this.fail('network', 'OpenAI could not be reached while transcribing.');
    } finally {
      this.inFlight -= 1;
    }
  }

  private fail(cls: ProviderError['class'], message: string): void {
    if (this.closed) return;
    const err = providerError(this.choice.providerId, cls, message);
    for (const h of this.handlers.error) h(err);
  }

  close(): Promise<void> {
    // The tail of the last turn is worth one more request, not worth dropping.
    this.flush();
    this.closed = true;
    this.buffer = [];
    return Promise.resolve();
  }

  on(e: 'transcript', h: (t: TranscriptEvent) => void): void;
  on(e: 'endpoint', h: () => void): void;
  on(e: 'error', h: (err: ProviderError) => void): void;
  on(e: 'transcript' | 'endpoint' | 'error', h: (...args: never[]) => void): void {
    if (e === 'transcript') this.handlers.transcript.push(h as (t: TranscriptEvent) => void);
    else if (e === 'error') this.handlers.error.push(h as (err: ProviderError) => void);
    // 'endpoint' is accepted and never called. A non-streaming model has no turn
    // signal, so CMP-05 runs the local timer; the registry entry says so with
    // supportsEndpointing: false and nothing here needs to know.
  }
}

export function postWavToOpenAi(): PostWav {
  return async (body, key) => {
    const res = await fetch(WHISPER_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body,
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  };
}

export function createWhisperProvider(post: PostWav = postWavToOpenAi()): SttProvider {
  return {
    id: 'openai',
    open(
      choice: ProviderChoice,
      source: TranscriptSource,
      key: string,
      _options: SttSessionOptions,
    ): Promise<SttSession> {
      // turnEndGapMs is deliberately unused. This model has no endpointing to
      // configure, and the registry says so rather than this file asserting it.
      //
      // The buffer window does come from the registry, because `CMP-05` adds
      // the same number to the turn-end gap. Two components deriving one window
      // from two constants is how they drift apart.
      const model = findSttModel(choice);
      return Promise.resolve(
        new WhisperSttSession({
          source,
          choice,
          key,
          post,
          bufferChunks: bufferChunksFor(model?.batchIntervalMs ?? WHISPER_BUFFER_MS),
        }),
      );
    },
    // One OpenAI key, one check, whichever transport is selected (ADR-017).
    validateKey: validateOpenAiKey,
  };
}
