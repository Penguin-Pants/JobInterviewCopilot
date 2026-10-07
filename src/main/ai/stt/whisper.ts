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
import type { SttLog } from './socket-session.js';
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
 * Requests that may be open at once. A window is posted when it fills, not
 * when the one before it answers: one at a time made the time between
 * transcripts equal to the provider's latency, and past the trigger's window
 * plus gap that read as silence and split one question in two. Three windows
 * cover one request's timeout. Past the cap a new window is not sent, so a slow
 * provider cannot grow the work for the rest of the interview (ADR-027).
 */
export const WHISPER_MAX_IN_FLIGHT = 3;

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
  /**
   * Set when `close` stopped waiting, or when a failure was raised: what is
   * still running is abandoned and nothing more is posted.
   */
  private abandoned = false;
  private inFlight = 0;
  private sent = 0;

  /**
   * Every window's result, delivered in the order the windows were spoken.
   *
   * Requests run at once, so they answer in any order. Each window's delivery
   * waits for the one before it, and a slow window no longer lands after the
   * one that followed it. `close` waits on this for the tail (ADR-036): a batch
   * model answers once per window, so the last thing said before Stop is
   * sitting in a request that has not come back yet.
   */
  private delivered: Promise<void> = Promise.resolve();
  /** One per open request, so a failure or `close` can abort them all. */
  private readonly controllers = new Set<AbortController>();

  private readonly handlers: Handlers = { transcript: [], error: [] };

  constructor(opts: {
    source: TranscriptSource;
    choice: ProviderChoice;
    key: string;
    post: PostWav;
    /** The window this model buffers, from its registry entry (ADR-022). */
    bufferChunks?: number;
    /** Where a throwing listener is reported. Passed in, never imported (NFR-002). */
    log?: SttLog;
  }) {
    this.source = opts.source;
    this.choice = opts.choice;
    this.key = opts.key;
    this.post = opts.post;
    this.bufferChunks = opts.bufferChunks ?? WHISPER_BUFFER_CHUNKS;
    this.log = opts.log ?? (() => undefined);
  }

  private readonly key: string;
  private readonly log: SttLog;
  private readonly post: PostWav;
  private readonly bufferChunks: number;

  get bufferedChunks(): number {
    return this.buffer.length;
  }

  get requestsInFlight(): number {
    return this.inFlight;
  }

  /**
   * PCM bytes posted (`FR-103`, ADR-036), counted per upload: a retry sends
   * the window again, and the provider bills it again. A window refused at the
   * cap, or dropped after a failure, was never sent and is never billed.
   */
  get sentBytes(): number {
    return this.sent;
  }

  push(chunk: AudioChunk): void {
    if (this.closed || this.abandoned) return;
    this.buffer.push(chunk.pcm);
    if (this.buffer.length < this.bufferChunks) return;
    this.flush();
  }

  /** Posts whatever is buffered and releases it. Safe to call with a partial buffer. */
  private flush(): void {
    if (this.buffer.length === 0) return;
    // Hand the array off and replace it, so the request holds the only
    // reference and the buffer retains nothing.
    const window = this.buffer;
    this.buffer = [];
    if (this.abandoned || this.inFlight >= WHISPER_MAX_IN_FLIGHT) return;
    const result = this.transcribe(window);
    this.delivered = this.delivered.then(async () => {
      this.deliver(await result);
    });
  }

  /** One window, retried once on a transient failure. Never throws. */
  private async transcribe(window: ArrayBuffer[]): Promise<Attempt | null> {
    this.inFlight += 1;
    try {
      const wav = encodeWav(window);
      const pcmBytes = window.reduce((bytes, pcm) => bytes + pcm.byteLength, 0);
      let attempt = await this.attempt(wav, pcmBytes);
      // One retry for a transient failure. Raising it at once made the session
      // reopen both streams and lose this window over a single 429 or 5xx.
      if ('error' in attempt && attempt.error.retryable && !this.abandoned) {
        await new Promise((resolve) => setTimeout(resolve, WHISPER_RETRY_DELAY_MS));
        if (this.abandoned) return null;
        attempt = await this.attempt(wav, pcmBytes);
      }
      return this.abandoned ? null : attempt;
    } finally {
      this.inFlight -= 1;
    }
  }

  /** Emits one window's result, in its turn. */
  private deliver(attempt: Attempt | null): void {
    if (attempt === null || this.abandoned) return;
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
    // A listener that throws must not break the delivery chain: every later
    // window, and the tail `close` waits for, would be dropped with it.
    for (const h of this.handlers.transcript) {
      try {
        h(event);
      } catch (err) {
        this.log('error', `a ${this.source} transcription listener threw`, err);
      }
    }
  }

  /** One request, bounded by `WHISPER_REQUEST_TIMEOUT_MS`. Never throws. */
  private async attempt(wav: Uint8Array, pcmBytes: number): Promise<Attempt> {
    this.sent += pcmBytes;
    const form = new FormData();
    // A Blob, never a path and never a stream. Nothing here can touch disk.
    form.append('file', new Blob([wav as BlobPart], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', this.choice.modelId);
    form.append('response_format', 'text');

    const controller = new AbortController();
    this.controllers.add(controller);
    const timedOut = providerError(
      this.choice.providerId,
      'timeout',
      `OpenAI did not answer within ${String(WHISPER_REQUEST_TIMEOUT_MS)} ms.`,
    );
    const timer = setTimeout(() => {
      controller.abort(timedOut);
    }, WHISPER_REQUEST_TIMEOUT_MS);
    // Raced as well as passed, so a transport that ignores the signal still
    // cannot hold delivery.
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
      this.controllers.delete(controller);
    }
  }

  /**
   * Raises a failure the retry did not cure, after stopping everything else.
   *
   * The handler starts the live loop's reopen, and the reopen closes this
   * session, which waits for delivery. Left running, the other requests held
   * that close open, and more windows were posted even after a terminal 401,
   * so failover waited up to `WHISPER_CLOSE_TIMEOUT_MS`.
   */
  private fail(err: ProviderError): void {
    if (this.closed) return;
    this.abandon(new Error('An earlier window failed, so this one was abandoned.'));
    for (const h of this.handlers.error) h(err);
  }

  /** Posts nothing more, drops the buffer and aborts every open request. */
  private abandon(reason: Error): void {
    this.abandoned = true;
    this.buffer = [];
    for (const controller of this.controllers) controller.abort(reason);
  }

  /**
   * Post the tail, wait for every window to be delivered, then close (ADR-036).
   *
   * `closed` is set **after** the wait, not before it. Set first, it made
   * delivery discard the very response this flush exists to collect, so the
   * last thing the interviewer said before Stop was posted, paid for, answered,
   * and thrown away.
   *
   * The wait is bounded by `WHISPER_CLOSE_TIMEOUT_MS`. Past it, every open
   * request is aborted, so a provider that never answers cannot keep Stop, the
   * transcript compaction and the session lock waiting.
   */
  async close(): Promise<void> {
    // The tail of the last turn is worth one more request, not worth dropping.
    this.flush();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, WHISPER_CLOSE_TIMEOUT_MS);
    });
    await Promise.race([this.delivered, expired]);
    clearTimeout(timer);
    this.abandon(new Error('The session closed before OpenAI answered.'));
    this.closed = true;
  }

  on(e: 'transcript', h: (t: TranscriptEvent) => void): void;
  on(e: 'endpoint', h: () => void): void;
  on(e: 'speech', h: () => void): void;
  on(e: 'error', h: (err: ProviderError) => void): void;
  on(e: 'transcript' | 'endpoint' | 'speech' | 'error', h: (...args: never[]) => void): void {
    if (e === 'transcript') this.handlers.transcript.push(h as (t: TranscriptEvent) => void);
    else if (e === 'error') this.handlers.error.push(h as (err: ProviderError) => void);
    // 'endpoint' and 'speech' are accepted and never called. A non-streaming model has no turn
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

export function createWhisperProvider(
  post: PostWav = postWavToOpenAi(),
  log?: SttLog,
): SttProvider {
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
          ...(log ? { log } : {}),
        }),
      );
    },
    // One OpenAI key, one check, whichever transport is selected (ADR-017).
    validateKey: validateOpenAiKey,
  };
}
