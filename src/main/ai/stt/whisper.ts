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

/**
 * How long one request may take. `NFR-017` allows 10 s at p95 from turn end to
 * the first bullet, so a window answered later than that has missed the budget
 * anyway. Without a limit, one request that never answered held Stop forever,
 * because `close` waits for every request.
 */
export const WHISPER_REQUEST_TIMEOUT_MS = 10_000;

/** The pause before the one retry of a transient failure (the ladder's first rung). */
export const WHISPER_RETRY_DELAY_MS = 250;

/**
 * Windows that may wait behind the request in flight. A slow provider must not
 * grow the backlog for the rest of the interview (ADR-027). When it is full the
 * oldest waiting window is dropped: it is the one least likely to still matter.
 */
export const WHISPER_MAX_QUEUED_WINDOWS = 2;

/**
 * How long `close` waits for the tail before it gives up on it. One request's
 * timeout, so a healthy tail always lands and a hung one cannot hold Stop.
 */
export const WHISPER_CLOSE_TIMEOUT_MS = WHISPER_REQUEST_TIMEOUT_MS;

export type PostWav = (
  body: FormData,
  key: string,
  /** Aborted when the request times out or the session gives up on it. */
  signal?: AbortSignal,
) => Promise<{ ok: boolean; status: number; text: string }>;

type Handlers = {
  transcript: ((t: TranscriptEvent) => void)[];
  error: ((e: ProviderError) => void)[];
};

/** How one attempt ended: a transcript to emit, or a failure to retry or raise. */
type Attempt = { text: string } | { error: ProviderError };

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
  /** Set when `close` stopped waiting: what is still running is abandoned. */
  private abandoned = false;
  private inFlight = 0;
  private sent = 0;

  /**
   * Full windows waiting for the request in flight, oldest first.
   *
   * One request at a time, so windows are emitted in the order they were
   * spoken. Concurrent requests emitted whichever answered first, and a slow
   * window landed after the one that followed it.
   */
  private readonly queue: ArrayBuffer[][] = [];

  /**
   * The loop posting the queue, so `close` can wait for the tail.
   *
   * A batch model answers once per window, so the last thing said before Stop
   * is sitting in a request that has not come back yet. Closing without waiting
   * discarded it, and the final spoken segment of every interview went missing
   * (ADR-036).
   */
  private draining: Promise<void> | null = null;
  private current: AbortController | null = null;

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

  /**
   * PCM bytes posted, each window counted once (`FR-103`, ADR-036). A window
   * dropped from a full backlog was never sent and is never billed; a retry
   * resends audio already counted.
   */
  get sentBytes(): number {
    return this.sent;
  }

  push(chunk: AudioChunk): void {
    if (this.closed) return;
    this.buffer.push(chunk.pcm);
    if (this.buffer.length < this.bufferChunks) return;
    this.flush();
  }

  /** Queues whatever is buffered and releases it. Safe to call with a partial buffer. */
  private flush(): void {
    if (this.buffer.length === 0) return;
    // Hand the array off and replace it, so the queue holds the only reference
    // and the buffer retains nothing.
    this.queue.push(this.buffer);
    this.buffer = [];
    while (this.queue.length > WHISPER_MAX_QUEUED_WINDOWS) this.queue.shift();
    this.draining ??= this.drain();
  }

  private async drain(): Promise<void> {
    try {
      for (let window = this.queue.shift(); window; window = this.queue.shift()) {
        if (this.abandoned) return;
        await this.transcribe(window);
      }
    } finally {
      // Cleared in the same step that finds the queue empty, so a window queued
      // after it always starts a new loop rather than waiting behind a dead one.
      this.draining = null;
    }
  }

  private async transcribe(window: ArrayBuffer[]): Promise<void> {
    this.inFlight += 1;
    try {
      const wav = encodeWav(window);
      this.sent += window.reduce((bytes, pcm) => bytes + pcm.byteLength, 0);
      let attempt = await this.attempt(wav);
      // One retry for a transient failure. Raising it at once made the session
      // reopen both streams and lose this window over a single 429 or 5xx.
      if ('error' in attempt && attempt.error.retryable && !this.abandoned) {
        await new Promise((resolve) => setTimeout(resolve, WHISPER_RETRY_DELAY_MS));
        if (this.abandoned) return;
        attempt = await this.attempt(wav);
      }
      if (this.abandoned) return;
      if ('error' in attempt) {
        this.fail(attempt.error);
        return;
      }
      if (attempt.text === '' || this.closed) return;
      const event: TranscriptEvent = {
        source: this.source,
        text: attempt.text,
        // Whisper has no interim state. Everything it returns is final.
        isFinal: true,
        timestamp: Date.now(),
        providerId: this.choice.providerId,
      };
      for (const h of this.handlers.transcript) h(event);
    } finally {
      this.inFlight -= 1;
    }
  }

  /** One request, bounded by `WHISPER_REQUEST_TIMEOUT_MS`. Never throws. */
  private async attempt(wav: Uint8Array): Promise<Attempt> {
    const form = new FormData();
    // A Blob, never a path and never a stream. Nothing here can touch disk.
    form.append('file', new Blob([wav as BlobPart], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', this.choice.modelId);
    form.append('response_format', 'text');

    const controller = new AbortController();
    this.current = controller;
    const timedOut = providerError(
      this.choice.providerId,
      'timeout',
      `OpenAI did not answer within ${String(WHISPER_REQUEST_TIMEOUT_MS)} ms.`,
    );
    const timer = setTimeout(() => {
      controller.abort(timedOut);
    }, WHISPER_REQUEST_TIMEOUT_MS);
    // Raced as well as passed, so a transport that ignores the signal still
    // cannot hold the queue.
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(controller.signal.reason as Error);
      });
    });
    try {
      const res = await Promise.race([this.post(form, this.key, controller.signal), aborted]);
      if (!res.ok) {
        const cls = classifyStatus(res.status);
        const message = res.text || `OpenAI returned ${String(res.status)}.`;
        return { error: providerError(this.choice.providerId, cls, message) };
      }
      return { text: res.text.trim() };
    } catch {
      return controller.signal.reason === timedOut
        ? { error: timedOut }
        : {
            error: providerError(
              this.choice.providerId,
              'network',
              'OpenAI could not be reached while transcribing.',
            ),
          };
    } finally {
      clearTimeout(timer);
      if (this.current === controller) this.current = null;
    }
  }

  private fail(err: ProviderError): void {
    if (this.closed) return;
    for (const h of this.handlers.error) h(err);
  }

  /**
   * Post the tail, wait for the queue to drain, then close (ADR-036).
   *
   * `closed` is set **after** the wait, not before it. Set first, it made
   * `transcribe` discard the very response this flush exists to collect, so the
   * last thing the interviewer said before Stop was posted, paid for, answered,
   * and thrown away.
   *
   * The wait is bounded by `WHISPER_CLOSE_TIMEOUT_MS`. Past it, the queue is
   * dropped and the request in flight aborted, so a provider that never answers
   * cannot keep Stop, the transcript compaction and the session lock waiting.
   */
  async close(): Promise<void> {
    // The tail of the last turn is worth one more request, not worth dropping.
    this.flush();
    const draining = this.draining;
    if (draining) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, WHISPER_CLOSE_TIMEOUT_MS);
      });
      await Promise.race([draining, expired]);
      clearTimeout(timer);
    }
    this.abandoned = true;
    this.queue.length = 0;
    this.current?.abort(new Error('The session closed before OpenAI answered.'));
    this.closed = true;
    this.buffer = [];
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

/**
 * The real transport (`NFR-002`, `ADR-019`).
 *
 * `url` is a parameter so `TC-137` can point the **production** transport at a
 * loopback server. Injecting a fake `post` instead would skip `fetch` and the
 * multipart serialization underneath it, which is precisely where a third-party
 * spool to a temp file would happen, so the test that exists to catch one would
 * never execute the code that could commit it.
 */
export function postWavToOpenAi(url: string = WHISPER_TRANSCRIBE_URL): PostWav {
  return async (body, key, signal) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body,
      signal,
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
