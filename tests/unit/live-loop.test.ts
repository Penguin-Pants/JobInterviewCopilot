/**
 * TASK-044. The live session loop's failure paths, against stubs.
 *
 * The end-to-end behaviour is proved in `tests/integration/live-session.test.ts`
 * with the real components behind it. What is proved here is the other half of
 * ADR-032: that every failure the loop can meet is **reported** rather than
 * swallowed, and that none of them takes the session down with it.
 *
 * Stubs rather than real components on purpose. Each case below is one
 * collaborator failing, and arranging a real `SessionManager` or a real socket
 * to fail on demand would make the arrangement the subject of the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../src/shared/defaults.js';
import type {
  AudioChunk,
  HealthState,
  ProviderChoice,
  ProviderError,
  Settings,
  TranscriptEvent,
  TranscriptSource,
} from '../../src/shared/types.js';
import type { SttSession } from '../../src/main/ai/stt.js';
import { TriggerMachine, type TurnFired } from '../../src/main/ai/trigger.js';
import {
  CLASSIFICATION_TIMEOUT_MS,
  LiveSessionLoop,
  STALE_DISCARD_MS,
  type LiveSessionLoopOptions,
} from '../../src/main/live.js';
import type {
  GenerationOutcome,
  LlmChunk,
  LlmProvider,
  TokenUsage,
} from '../../src/main/ai/llm.js';
import type { GatedMessage } from '../../src/main/overlay-gate.js';

const PROFILE_ID = 'p1';

class StubSttSession implements SttSession {
  closed = 0;
  closeError: Error | null = null;
  /** A batch adapter answers from inside `close`; this is how that is staged. */
  onClose: (() => void) | null = null;
  readonly transcript: ((t: TranscriptEvent) => void)[] = [];
  readonly endpoints: (() => void)[] = [];
  readonly errors: ((e: ProviderError) => void)[] = [];

  constructor(
    readonly source: TranscriptSource,
    readonly choice: ProviderChoice,
  ) {}

  push(_chunk: AudioChunk): void {}

  emit(text: string, isFinal = true): void {
    for (const h of this.transcript) {
      h({ source: this.source, text, isFinal, timestamp: 0, providerId: this.choice.providerId });
    }
  }

  close(): Promise<void> {
    this.closed += 1;
    this.onClose?.();
    return this.closeError ? Promise.reject(this.closeError) : Promise.resolve();
  }

  on(e: 'transcript', h: (t: TranscriptEvent) => void): void;
  on(e: 'endpoint', h: () => void): void;
  on(e: 'error', h: (err: ProviderError) => void): void;
  on(e: 'transcript' | 'endpoint' | 'error', h: (...args: never[]) => void): void {
    if (e === 'transcript') this.transcript.push(h as (t: TranscriptEvent) => void);
    if (e === 'endpoint') this.endpoints.push(h as () => void);
    if (e === 'error') this.errors.push(h as (err: ProviderError) => void);
  }
}

function outcome(over: Partial<GenerationOutcome> = {}): GenerationOutcome {
  return {
    generationId: 'g1',
    cardId: 'card-g1',
    status: 'complete',
    bullets: ['one'],
    usage: { inputTokens: 10, outputTokens: 2 },
    error: null,
    ...over,
  };
}

function turn(over: Partial<TurnFired> = {}): TurnFired {
  return {
    generationId: 'g1',
    question: 'Tell me about a time you shipped something hard',
    candidateContext: '',
    signal: new AbortController().signal,
    firedAt: Date.now(),
    ...over,
  };
}

interface StubOptions {
  settings?: Partial<Settings>;
  audioStart?: () => Promise<void>;
  audioStop?: () => Promise<void>;
  openStt?: LiveSessionLoopOptions['openStt'];
  keyFor?: (providerId: string) => string | undefined;
  retrieve?: LiveSessionLoopOptions['retrieve'];
  generate?: LiveSessionLoopOptions['generate'];
  resolveLlmProvider?: (choice: ProviderChoice) => LlmProvider;
  runFor?: LiveSessionLoopOptions['health']['runFor'];
  /** The LLM primary's credential state, which is what gates the classifier. */
  llmHealth?: HealthState;
  appendTurn?: (source: TranscriptSource, text: string) => Promise<number>;
  appendSuggestion?: (entry: { status: string }) => Promise<number>;
  /** Makes the one call that sits outside the loop's own try blocks throw. */
  settleThrows?: boolean;
}

function makeLoop(stub: StubOptions = {}) {
  const errors: { message: string; detail?: unknown }[] = [];
  const infos: string[] = [];
  const opened: StubSttSession[] = [];
  const settled: string[] = [];
  const noted: { generationId: string; choice: ProviderChoice; usage: TokenUsage }[] = [];
  const pushes: string[] = [];
  /** The same pushes, whole, for the cases that assert a payload (TASK-062). */
  const messages: GatedMessage[] = [];
  const appended: { status: string }[] = [];
  const endpoints: number[] = [];
  const settings: Settings = { ...defaultSettings(), ...stub.settings };

  const loop = new LiveSessionLoop({
    audio: {
      start: stub.audioStart ?? (() => Promise.resolve()),
      stop: stub.audioStop ?? (() => Promise.resolve()),
    },
    trigger: {
      start: () => {},
      stop: () => {},
      handleTranscript: () => {},
      handleEndpoint: () => endpoints.push(1),
      noteGenerationSettled: (id: string) => {
        settled.push(id);
        if (stub.settleThrows) throw new Error('the machine threw');
      },
    },
    sessions: {
      appendTurn: stub.appendTurn ?? ((): Promise<number> => Promise.resolve(0)),
      appendSuggestion:
        stub.appendSuggestion ??
        ((entry) => {
          appended.push(entry);
          return Promise.resolve(1);
        }),
    },
    cost: {
      noteAudio: () => {},
      noteGeneration: (generationId, choice, usage) => noted.push({ generationId, choice, usage }),
    },
    health: {
      // The health policy itself is TASK-014's. The default here is the
      // identity, so a test asserts what the loop does rather than what the
      // ladder does; a case that is about the ladder supplies its own.
      runFor: stub.runFor ?? ((_capability, fn) => fn('primary')),
      // `for` is required rather than optional: an omitted one used to disable
      // the classifier silently instead of failing.
      for: () => ({ current: stub.llmHealth ?? { kind: 'using-primary' } }),
    },
    settings: () => settings,
    retrieve: stub.retrieve ?? (() => Promise.resolve([])),
    keyFor: stub.keyFor ?? (() => 'k'),
    onTranscript: () => {},
    onSuggestion: (push) => {
      pushes.push(push.channel);
      messages.push(push);
    },
    onSttChoice: () => {},
    onError: (message, detail) => errors.push({ message, detail }),
    onInfo: (message) => infos.push(message),
    openStt:
      stub.openStt ??
      ((choice, source) => {
        const session = new StubSttSession(source, choice);
        opened.push(session);
        return Promise.resolve(session);
      }),
    generate: stub.generate ?? (() => Promise.resolve(outcome())),
    resolveLlmProvider: stub.resolveLlmProvider ?? (() => ({}) as LlmProvider),
  });

  return {
    loop,
    errors,
    infos,
    opened,
    settled,
    noted,
    endpoints,
    settings,
    pushes,
    messages,
    appended,
  };
}

describe('start and stop', () => {
  it('refuses to start twice, because two loops would share one transcript', async () => {
    const { loop } = makeLoop();
    await loop.start(PROFILE_ID);
    await expect(loop.start(PROFILE_ID)).rejects.toThrow(/already running/);
    await loop.stop();
  });

  it('stopping a loop that never started does nothing', async () => {
    const { loop, errors } = makeLoop();
    await loop.stop();
    expect(errors).toEqual([]);
    expect(loop.isRunning).toBe(false);
  });

  it('reports a capture failure and still brings transcription up', async () => {
    const { loop, errors, opened } = makeLoop({
      audioStart: () => Promise.reject(new Error('no loopback device')),
    });

    await loop.start(PROFILE_ID);

    // Section 10: the loopback failure is a Dashboard matter. The session, its
    // transcript and its timer are not taken down by it.
    expect(errors.map((e) => e.message)).toEqual(['audio capture could not be started']);
    expect(opened).toHaveLength(2);
    expect(loop.isRunning).toBe(true);
    await loop.stop();
  });

  it('reports a capture teardown failure rather than leaving stop half-done', async () => {
    const { loop, errors, opened } = makeLoop({
      audioStop: () => Promise.reject(new Error('the worker was already gone')),
    });
    await loop.start(PROFILE_ID);
    await loop.stop();

    // The sockets still closed: the order is close, then stop capture.
    expect(opened.every((s) => s.closed === 1)).toBe(true);
    expect(errors.map((e) => e.message)).toEqual(['audio capture could not be stopped cleanly']);
  });

  it('reports a socket that will not close and still closes the rest', async () => {
    const { loop, errors, opened } = makeLoop();
    await loop.start(PROFILE_ID);
    opened[0]!.closeError = new Error('the socket was already gone');

    await loop.stop();

    expect(opened.every((s) => s.closed === 1)).toBe(true);
    expect(errors.map((e) => e.message)).toEqual([
      'the interviewer transcription stream did not close cleanly',
    ]);
  });

  /**
   * ADR-036. `session:start` tells the renderers the session is live before
   * awaiting the loop, so Stop can arrive while capture or a socket is still
   * coming up. Torn down from underneath, the start's own continuation then
   * opened the pair again and started the trigger, leaving sockets live against
   * a transcript the Session Manager had already compacted.
   */
  it('a stop during the bring-up leaves nothing open behind it', async () => {
    let releaseCapture = (): void => {};
    const capture = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });

    const { loop, opened } = makeLoop({ audioStart: () => capture });

    const starting = loop.start(PROFILE_ID);
    // Stop arrives while `audio.start()` is still pending.
    const stopping = loop.stop();
    releaseCapture();
    await Promise.all([starting, stopping]);

    // Whatever the start opened, the stop closed. Nothing is live.
    expect(loop.isRunning).toBe(false);
    expect(loop.openStreamCount).toBe(0);
    expect(opened.every((s) => s.closed === 1)).toBe(true);
  });

  it('dispose releases the streams without awaiting, for will-quit', async () => {
    const { loop, opened } = makeLoop();
    await loop.start(PROFILE_ID);

    loop.dispose();

    // The quit path cannot hold the app open, so `dispose` returns at once. The
    // close is already issued by then; only the bookkeeping after it is not.
    expect(loop.isRunning).toBe(false);
    expect(opened.every((s) => s.closed === 1)).toBe(true);

    // The bookkeeping after the closes settles on its own turn of the loop,
    // which is precisely what `dispose` does not wait for.
    await new Promise((resolve) => setImmediate(resolve));
    expect(loop.activeSttChoice).toBeNull();
  });

  it('names the model that is serving, so the trigger can be rebound to it', async () => {
    const { loop, settings } = makeLoop();
    await loop.start(PROFILE_ID);
    expect(loop.activeSttChoice).toEqual(settings.providers.stt.primary);
    await loop.stop();
  });
});

describe('a transcription target that cannot be used', () => {
  it('says so when the model is not in the registry, and opens nothing', async () => {
    const { loop, errors, opened } = makeLoop({
      settings: {
        ...defaultSettings(),
        providers: {
          ...defaultSettings().providers,
          stt: { primary: { providerId: 'deepgram', modelId: 'nova-999' }, backup: null },
        },
      },
    });

    await loop.start(PROFILE_ID);

    expect(opened).toEqual([]);
    expect(loop.openStreamCount).toBe(0);
    expect(errors.map((e) => e.message)).toEqual([
      'the primary speech-to-text model is not in the registry, so it cannot be opened',
      'transcription is unavailable: the speech-to-text model is not usable. ' +
        'The session is running, but nothing will be transcribed.',
    ]);
    await loop.stop();
  });

  it('says so when no key is saved, rather than opening a socket without one', async () => {
    const { loop, infos, opened } = makeLoop({ keyFor: () => undefined });
    await loop.start(PROFILE_ID);

    expect(opened).toEqual([]);
    expect(infos).toContain('no key is saved for the primary speech-to-text provider');
    await loop.stop();
  });

  it('leaves nothing half-open when the second stream fails to open', async () => {
    const opened: StubSttSession[] = [];
    const { loop, errors } = makeLoop({
      openStt: (choice, source) => {
        if (source === 'candidate') return Promise.reject(new Error('the socket refused'));
        const session = new StubSttSession(source, choice);
        opened.push(session);
        return Promise.resolve(session);
      },
    });

    await loop.start(PROFILE_ID);

    // One stream transcribing and one silently not would read as a provider
    // that cannot hear the candidate rather than as the failure it is.
    expect(loop.openStreamCount).toBe(0);
    expect(opened[0]?.closed).toBe(1);
    expect(errors.map((e) => e.message)).toContain(
      'the speech-to-text provider could not be reached',
    );
    await loop.stop();
  });
});

describe('the wiring of one open stream', () => {
  it('passes a native endpoint from the interviewer to the machine', async () => {
    const { loop, opened, endpoints } = makeLoop();
    await loop.start(PROFILE_ID);

    opened.find((s) => s.source === 'interviewer')?.endpoints.forEach((h) => h());
    expect(endpoints).toHaveLength(1);

    // FR-055: the candidate has no endpoint listener at all.
    expect(opened.find((s) => s.source === 'candidate')?.endpoints).toHaveLength(0);
    await loop.stop();
  });

  /**
   * A streaming adapter's `open` resolves as soon as it has asked its socket to
   * connect, so a refused or revoked connection is reported on this event after
   * the adapter's own ladder is spent. Logging it was not enough: the health
   * machine never saw the failure, so a dead primary never failed over and the
   * session transcribed nothing for the rest of the interview (ADR-036).
   */
  it('raises a stream failure into the health machine and re-opens the pair', async () => {
    const targets: ('primary' | 'backup')[] = [];
    const { loop, opened, errors } = makeLoop({
      runFor: async (_capability, fn) => {
        // One retry, which is all this test needs of the real ladder.
        try {
          targets.push('primary');
          return await fn('primary');
        } catch {
          targets.push('primary');
          return await fn('primary');
        }
      },
    });
    await loop.start(PROFILE_ID);
    expect(opened).toHaveLength(2);

    const err = new Error('the socket closed') as ProviderError;
    err.class = 'network';
    err.providerId = 'deepgram';
    err.retryable = true;
    opened[0]?.errors.forEach((h) => h(err));
    await loop.whenReopened();

    expect(errors.map((e) => e.message)).toContain('the interviewer transcription stream failed');
    // The failure was raised into the machine, and the re-open followed it.
    expect(targets.length).toBeGreaterThan(1);
    expect(opened).toHaveLength(4);
    expect(loop.openStreamCount).toBe(2);
    await loop.stop();
  });

  it('reports an append that fails rather than losing a turn quietly', async () => {
    const { loop, opened, errors } = makeLoop({
      appendTurn: () => Promise.reject(new Error('ENOSPC')),
    });
    await loop.start(PROFILE_ID);

    opened[0]?.transcript.forEach((h) =>
      h({
        source: 'interviewer',
        text: 'Tell me about your proudest project',
        isFinal: true,
        timestamp: 0,
        providerId: 'deepgram',
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(errors.map((e) => e.message)).toContain('a transcript turn could not be appended');
    await loop.stop();
  });

  /**
   * ADR-036. A batch adapter posts its remaining buffer inside `close` and
   * answers with the last thing the interviewer said. Clearing the stream map
   * before the close resolved made the loop drop exactly that segment, so every
   * session recorded with a batch model lost its final turn.
   */
  it('routes a transcript a stream emits while it is closing', async () => {
    const appended: string[] = [];
    const opened: StubSttSession[] = [];
    const { loop } = makeLoop({
      appendTurn: (_source, text) => {
        appended.push(text);
        return Promise.resolve(appended.length - 1);
      },
      openStt: (choice, source) => {
        const session = new StubSttSession(source, choice);
        // A batch adapter's `close` posts the tail and answers from it.
        session.onClose = () => {
          session.emit('the last thing anyone said');
        };
        opened.push(session);
        return Promise.resolve(session);
      },
    });
    await loop.start(PROFILE_ID);

    await loop.stop();

    expect(appended).toContain('the last thing anyone said');
  });

  it('bills nothing for a chunk with no stream to send it to', async () => {
    const noteAudio = vi.fn();
    const { loop } = makeLoop();
    loop.handleChunk({
      source: 'interviewer',
      pcm: new ArrayBuffer(32000),
      timestamp: 0,
      sequence: 1,
    });
    expect(noteAudio).not.toHaveBeenCalled();
  });
});

describe('a backup the health machine believes in but the loop cannot use', () => {
  /**
   * ADR-036. The machine's binding says a backup exists; whether it is
   * **usable** is the loop's question. Falling back to the primary there ran the
   * provider that had just failed while the machine recorded `using-backup`, so
   * the Dashboard named a backup that never answered a request.
   */
  it('fails the backup attempt rather than silently re-running the primary', async () => {
    const attempts: ('primary' | 'backup')[] = [];
    const opens: ProviderChoice[] = [];
    const settings = defaultSettings();

    const { loop, errors } = makeLoop({
      settings: {
        providers: {
          ...settings.providers,
          stt: {
            primary: settings.providers.stt.primary,
            // Configured, but its key is missing, so the loop cannot use it.
            backup: { providerId: 'elevenlabs', modelId: 'scribe-v2-realtime' },
          },
        },
      },
      keyFor: (providerId) => (providerId === 'elevenlabs' ? undefined : 'k'),
      runFor: async (_capability, fn) => {
        attempts.push('primary');
        try {
          return await fn('primary');
        } catch {
          attempts.push('backup');
          return await fn('backup');
        }
      },
      openStt: (choice) => {
        opens.push(choice);
        return Promise.reject(new Error('the socket refused'));
      },
    });

    await loop.start(PROFILE_ID);

    expect(attempts).toEqual(['primary', 'backup']);
    // One open, from the primary attempt alone. The backup attempt opened
    // nothing: it refused, rather than re-running the provider that had just
    // failed under a target that says backup.
    expect(opens).toHaveLength(1);
    expect(opens[0]?.providerId).toBe(settings.providers.stt.primary.providerId);
    expect(errors.map((e) => e.message)).toContain(
      'the speech-to-text provider could not be reached',
    );
    await loop.stop();
  });
});

describe('answering a turn', () => {
  it('abandons the turn when no language model is usable, and says so', async () => {
    const { loop, errors, settled } = makeLoop({
      resolveLlmProvider: () => {
        throw new Error('no adapter is registered');
      },
    });
    await loop.start(PROFILE_ID);

    loop.onFire(turn());
    await loop.whenSettled();

    expect(errors.map((e) => e.message)).toEqual([
      'the primary language model is not usable',
      'no usable language model is configured, so this turn is not answered',
    ]);
    // The machine is freed either way, or the next question would never fire.
    expect(settled).toEqual(['g1']);
    await loop.stop();
  });

  it('records a generation that failed after salvaging what it produced', async () => {
    const failure = new Error('the provider hung up') as ProviderError;
    failure.class = 'server';
    failure.providerId = 'anthropic';
    failure.retryable = true;

    const appended: unknown[] = [];
    const { loop, errors, noted } = makeLoop({
      generate: () =>
        Promise.resolve(outcome({ status: 'cancelled', bullets: ['salvaged'], error: failure })),
      appendSuggestion: () => {
        appended.push(true);
        return Promise.resolve(1);
      },
    });
    await loop.start(PROFILE_ID);

    loop.onFire(turn());
    await loop.whenSettled();

    // FR-076: the failure reached the log, never the overlay, and what the
    // model did produce still reached the transcript and the meter.
    expect(errors.map((e) => e.message)).toEqual(['the language model failed']);
    expect(appended).toHaveLength(1);
    // Keyed per attempt: `noteGeneration` replaces by id, which is right for one
    // request reporting usage twice and wrong across a retry (ADR-036).
    expect(noted.map((n) => n.generationId)).toEqual(['g1#1']);
    await loop.stop();
  });

  it('reports a suggestion that could not be appended, and still bills it', async () => {
    const { loop, errors, noted } = makeLoop({
      appendSuggestion: () => Promise.reject(new Error('the handle is closed')),
    });
    await loop.start(PROFILE_ID);

    loop.onFire(turn());
    await loop.whenSettled();

    expect(errors.map((e) => e.message)).toEqual([
      'a suggestion could not be appended to the transcript',
    ]);
    // The tokens were spent whether or not the entry landed.
    expect(noted).toHaveLength(1);
    await loop.stop();
  });

  /**
   * ADR-036. `noteGeneration` replaces by id, which is right for one request
   * reporting usage twice (ADR-033) and wrong across a retry or a failover:
   * both requests are billable, possibly at different rates, and keying them
   * alike drops everything the earlier attempts cost.
   */
  it('accounts every attempt, not only the one that finally answered', async () => {
    const failure = new Error('the provider hung up') as ProviderError;
    failure.class = 'server';
    failure.providerId = 'anthropic';
    failure.retryable = true;

    let call = 0;
    const { loop, noted } = makeLoop({
      runFor: async (_capability, fn) => {
        try {
          return await fn('primary');
        } catch {
          return await fn('primary');
        }
      },
      generate: () => {
        call += 1;
        return Promise.resolve(
          call === 1
            ? outcome({
                status: 'cancelled',
                usage: { inputTokens: 400, outputTokens: 10 },
                error: failure,
              })
            : outcome({ usage: { inputTokens: 400, outputTokens: 55 } }),
        );
      },
    });
    await loop.start(PROFILE_ID);

    loop.onFire(turn());
    await loop.whenSettled();

    // Two billable requests, two keys, so neither is lost under the other.
    expect(noted.map((n) => n.generationId)).toEqual(['g1#1', 'g1#2']);
    await loop.stop();
  });

  /**
   * TASK-062. Checkpoint 1 belongs to this generation's **first** begin.
   *
   * `runFor` re-enters its closure on a retry and on a failover, and
   * `runGeneration` calls `onBegin` at the top of every attempt, so the
   * callback runs once per attempt rather than once per generation. Re-running
   * the staleness clock there stranded a card: a retry starting past the
   * threshold marked the whole generation stale, and the cancellation that
   * clears a card lives in `onLine` alone, so attempt 1's card had nothing left
   * to remove it. A retry of an already-begun generation is checkpoint 2's.
   */
  it('does not strand a card when a retry re-enters onBegin past the stale threshold', async () => {
    const firedAt = 1_000_000;
    let clock = firedAt;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);

    const failure = new Error('the provider hung up') as ProviderError;
    failure.class = 'server';
    failure.providerId = 'anthropic';
    failure.retryable = true;

    const statuses: string[] = [];
    let call = 0;
    const { loop, pushes } = makeLoop({
      appendSuggestion: (entry) => {
        statuses.push(entry.status);
        return Promise.resolve(1);
      },
      runFor: async (_capability, fn) => {
        try {
          return await fn('primary');
        } catch {
          // The retry starts well past the threshold, which is the whole point.
          clock = firedAt + STALE_DISCARD_MS + 1;
          return await fn('primary');
        }
      },
      generate: (_provider, _request, _signal, events) => {
        call += 1;
        events.onBegin({ generationId: 'g1', cardId: 'card-g1', question: 'q' });
        events.onLine({
          generationId: 'g1',
          cardId: 'card-g1',
          line: `one-${String(call)}`,
          index: 0,
        });
        if (call === 1) return Promise.reject(failure);
        events.onEnd({ generationId: 'g1', status: 'complete' });
        return Promise.resolve(outcome());
      },
    });
    await loop.start(PROFILE_ID);

    loop.onFire(turn({ firedAt }));
    await loop.whenSettled();

    // One begin, both attempts' lines, and the real end: nothing is suppressed
    // and no card is left on screen with no way to clear it.
    expect(pushes).toEqual([
      'suggestion:begin',
      'suggestion:line',
      'suggestion:line',
      'suggestion:end',
    ]);
    expect(statuses).toEqual(['complete']);

    await loop.stop();
    now.mockRestore();
  });

  /**
   * The other half of the same rule: a retry whose predecessor left no card.
   *
   * `runGeneration` resolves an attempt that failed before producing a bullet
   * as `'cancelled'`, and `reduceCards` removes a cancelled card outright
   * (`ADR-047`). Dropping the retry's `begin` as a duplicate would therefore
   * aim its lines at a card that no longer exists and the answer would never
   * reach the overlay, so the begin has to go out again.
   */
  it('re-sends begin when the failed attempt already removed the card', async () => {
    const failure = new Error('the provider hung up') as ProviderError;
    failure.class = 'server';
    failure.providerId = 'anthropic';
    failure.retryable = true;

    let call = 0;
    const { loop, pushes } = makeLoop({
      runFor: async (_capability, fn) => {
        try {
          return await fn('primary');
        } catch {
          return await fn('primary');
        }
      },
      generate: (_provider, _request, _signal, events) => {
        call += 1;
        events.onBegin({ generationId: 'g1', cardId: 'card-g1', question: 'q' });
        if (call === 1) {
          // No line: `resolveStatus` calls an empty failed attempt 'cancelled',
          // and that end is what takes the card off the overlay.
          events.onEnd({ generationId: 'g1', status: 'cancelled' });
          return Promise.reject(failure);
        }
        events.onLine({ generationId: 'g1', cardId: 'card-g1', line: 'one', index: 0 });
        events.onEnd({ generationId: 'g1', status: 'complete' });
        return Promise.resolve(outcome());
      },
    });
    await loop.start(PROFILE_ID);

    loop.onFire(turn());
    await loop.whenSettled();

    expect(pushes).toEqual([
      'suggestion:begin',
      'suggestion:end',
      'suggestion:begin',
      'suggestion:line',
      'suggestion:end',
    ]);

    await loop.stop();
  });

  /**
   * The converse: a retry that fails empty after an earlier attempt salvaged.
   *
   * An attempt that streamed a bullet and then failed ends `'complete'`, so
   * the salvage stays on the overlay (FR-004, ADR-036). A retry that then fails
   * before producing a bullet reports `'cancelled'`, which says only that *it*
   * salvaged nothing. Forwarding it would make `reduceCards` remove the card
   * (`ADR-047`) and take the earlier salvage with it, so it is held back. A
   * cancellation because a newer turn superseded this one is still forwarded,
   * because `FR-054` removes that partial output.
   */
  it('keeps an earlier attempt’s salvage when a retry fails empty', async () => {
    const failure = new Error('the provider hung up') as ProviderError;
    failure.class = 'server';
    failure.providerId = 'anthropic';
    failure.retryable = true;

    let call = 0;
    const { loop, messages } = makeLoop({
      runFor: async (_capability, fn) => {
        try {
          return await fn('primary');
        } catch {
          return await fn('primary');
        }
      },
      generate: (_provider, _request, _signal, events) => {
        call += 1;
        events.onBegin({ generationId: 'g1', cardId: 'card-g1', question: 'q' });
        if (call === 1) {
          events.onLine({ generationId: 'g1', cardId: 'card-g1', line: 'one', index: 0 });
          events.onEnd({ generationId: 'g1', status: 'complete' });
          return Promise.resolve(outcome({ error: failure }));
        }
        events.onEnd({ generationId: 'g1', status: 'cancelled' });
        return Promise.resolve(outcome({ status: 'cancelled', bullets: [], error: failure }));
      },
    });
    await loop.start(PROFILE_ID);

    loop.onFire(turn());
    await loop.whenSettled();

    expect(messages).toEqual([
      {
        channel: 'suggestion:begin',
        payload: { generationId: 'g1', cardId: 'card-g1', question: 'q' },
      },
      {
        channel: 'suggestion:line',
        payload: { generationId: 'g1', cardId: 'card-g1', line: 'one', index: 0 },
      },
      { channel: 'suggestion:end', payload: { generationId: 'g1', status: 'complete' } },
    ]);

    await loop.stop();
  });

  it('still clears a salvaged card when a newer turn cancels it', async () => {
    const controller = new AbortController();
    const { loop, messages } = makeLoop({
      generate: (_provider, _request, _signal, events) => {
        events.onBegin({ generationId: 'g1', cardId: 'card-g1', question: 'q' });
        events.onLine({ generationId: 'g1', cardId: 'card-g1', line: 'one', index: 0 });
        controller.abort();
        events.onEnd({ generationId: 'g1', status: 'cancelled' });
        return Promise.resolve(outcome({ status: 'cancelled' }));
      },
    });
    await loop.start(PROFILE_ID);

    loop.onFire(turn({ signal: controller.signal }));
    await loop.whenSettled();

    expect(messages.at(-1)).toEqual({
      channel: 'suggestion:end',
      payload: { generationId: 'g1', status: 'cancelled' },
    });

    await loop.stop();
  });

  it('does nothing for a turn that was already aborted before it was answered', async () => {
    const controller = new AbortController();
    controller.abort();
    const generate = vi.fn(() => Promise.resolve(outcome()));
    const { loop, settled } = makeLoop({ generate });
    await loop.start(PROFILE_ID);

    loop.onFire(turn({ signal: controller.signal }));
    await loop.whenSettled();

    expect(generate).not.toHaveBeenCalled();
    expect(settled).toEqual(['g1']);
    await loop.stop();
  });

  it('abandons the turn when the loop has already stopped', async () => {
    const generate = vi.fn(() => Promise.resolve(outcome()));
    const { loop } = makeLoop({ generate });
    await loop.start(PROFILE_ID);
    await loop.stop();

    loop.onFire(turn());
    await loop.whenSettled();

    expect(generate).not.toHaveBeenCalled();
  });

  /**
   * Nothing awaits the stored promise between one turn and the next, so a
   * rejection escaping `runTurn` would be an unhandled one: `NFR-009` would log
   * it only after it had already escaped, and a later turn would then await a
   * rejected chain.
   */
  it('never lets a turn become an unhandled rejection', async () => {
    const { loop, errors } = makeLoop({ settleThrows: true });
    await loop.start(PROFILE_ID);

    loop.onFire(turn());
    await loop.whenSettled();

    expect(errors.map((e) => e.message)).toContain('the turn could not be answered');

    // And the chain is usable again: the next turn is answered normally.
    loop.onFire(turn({ generationId: 'g2' }));
    await loop.whenSettled();
    await loop.stop();
  });
});

/* ------------------------------------------------------------------ *
 * TASK-062. The two staleness checkpoints.
 * ------------------------------------------------------------------ */

/** The line and end payloads of a generation, for the checkpoint cases. */
function streamOneCard(events: {
  onBegin: (p: { generationId: string; cardId: string; question: string }) => void;
  onLine: (p: { generationId: string; cardId: string; line: string; index: number }) => void;
  onEnd: (p: { generationId: string; status: 'complete' | 'cancelled' }) => void;
  betweenBeginAndFirstLine?: () => void;
}): void {
  events.onBegin({ generationId: 'g1', cardId: 'card-g1', question: 'q' });
  events.betweenBeginAndFirstLine?.();
  events.onLine({ generationId: 'g1', cardId: 'card-g1', line: 'one', index: 0 });
  events.onLine({ generationId: 'g1', cardId: 'card-g1', line: 'two', index: 1 });
  events.onEnd({ generationId: 'g1', status: 'complete' });
}

/**
 * TC-172. Checkpoint 1: the turn is already obsolete before the card exists.
 *
 * `runGeneration` calls `onBegin` synchronously, before it iterates the
 * provider, so this checkpoint is evaluated at roughly `firedAt` plus
 * retrieval. Over the threshold there, the overlay is told nothing at all --
 * no `begin`, no `line`, no `end` -- while the generation itself still runs to
 * completion behind it (`FR-103`, `FR-114`).
 */
describe('TC-172 staleness discard timing, checkpoint 1', () => {
  const firedAt = 1_000_000;

  it('pushes nothing at all for a turn already past the threshold', async () => {
    const clock = firedAt + STALE_DISCARD_MS + 1;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);

    const { loop, pushes, appended, noted } = makeLoop({
      generate: (_provider, _request, _signal, events) => {
        streamOneCard(events);
        return Promise.resolve(outcome());
      },
    });
    await loop.start(PROFILE_ID);

    loop.onFire(turn({ firedAt }));
    await loop.whenSettled();

    expect(pushes).toEqual([]);
    // The transcript records it as `'stale'`, which is not a wire value and is
    // distinct from `'cancelled'`.
    expect(appended.map((e) => e.status)).toEqual(['stale']);
    // The call was made and billed either way: only the overlay push is
    // suppressed, never the underlying request (`FR-103`).
    expect(noted.map((n) => n.generationId)).toEqual(['g1#1']);

    await loop.stop();
    now.mockRestore();
  });

  it('leaves a turn one millisecond under the threshold untouched', async () => {
    const clock = firedAt + STALE_DISCARD_MS - 1;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);

    const { loop, pushes, appended } = makeLoop({
      generate: (_provider, _request, _signal, events) => {
        streamOneCard(events);
        return Promise.resolve(outcome());
      },
    });
    await loop.start(PROFILE_ID);

    loop.onFire(turn({ firedAt }));
    await loop.whenSettled();

    expect(pushes).toEqual([
      'suggestion:begin',
      'suggestion:line',
      'suggestion:line',
      'suggestion:end',
    ]);
    expect(appended.map((e) => e.status)).toEqual(['complete']);

    await loop.stop();
    now.mockRestore();
  });
});

/**
 * TC-189. Checkpoint 2: the model's first token was the slow part.
 *
 * Checkpoint 1 cannot catch this, because it runs before any of the response
 * has arrived. A provider whose first token takes 25 seconds passes checkpoint
 * 1 immediately and would stream its obsolete answer in full. The card is
 * already on screen by then, so the discard has to clear it: exactly one
 * `suggestion:end` at wire status `'cancelled'`, which is the path a superseded
 * generation's cancellation already uses, while the transcript still records
 * `'stale'`. The transcript and the overlay are allowed to disagree here.
 */
describe('TC-189 staleness discard timing, checkpoint 2', () => {
  const firedAt = 1_000_000;

  it('sends begin, no line, and one cancelled end when the first token is late', async () => {
    let clock = firedAt;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);

    const { loop, pushes, messages, appended } = makeLoop({
      generate: (_provider, _request, _signal, events) => {
        streamOneCard({
          ...events,
          // The whole point of the second checkpoint: `begin` went out inside
          // the budget and the first delta did not.
          betweenBeginAndFirstLine: () => {
            clock = firedAt + STALE_DISCARD_MS + 1;
          },
        });
        return Promise.resolve(outcome());
      },
    });
    await loop.start(PROFILE_ID);

    loop.onFire(turn({ firedAt }));
    await loop.whenSettled();

    expect(pushes).toEqual(['suggestion:begin', 'suggestion:end']);
    const end = messages.at(-1);
    expect(end?.channel).toBe('suggestion:end');
    expect(end?.payload).toEqual({ generationId: 'g1', status: 'cancelled' });
    // `'stale'` in the transcript, `'cancelled'` on the wire.
    expect(appended.map((e) => e.status)).toEqual(['stale']);

    await loop.stop();
    now.mockRestore();
  });

  it('leaves a generation whose first token arrives in time untouched', async () => {
    let clock = firedAt;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);

    const { loop, pushes, appended } = makeLoop({
      generate: (_provider, _request, _signal, events) => {
        streamOneCard({
          ...events,
          betweenBeginAndFirstLine: () => {
            clock = firedAt + STALE_DISCARD_MS - 1;
          },
        });
        return Promise.resolve(outcome());
      },
    });
    await loop.start(PROFILE_ID);

    loop.onFire(turn({ firedAt }));
    await loop.whenSettled();

    expect(pushes).toEqual([
      'suggestion:begin',
      'suggestion:line',
      'suggestion:line',
      'suggestion:end',
    ]);
    expect(appended.map((e) => e.status)).toEqual(['complete']);

    await loop.stop();
    now.mockRestore();
  });
});

/* ------------------------------------------------------------------ *
 * TASK-060. The `classify` closure `live.ts` hands the trigger.
 * ------------------------------------------------------------------ */

interface FakeLlm {
  provider: LlmProvider;
  requests: { generationId: string; system: string | undefined; maxTokens: number | undefined }[];
  signals: AbortSignal[];
}

/**
 * A language model that answers the classification prompt.
 *
 * `delayMs` is scripted through `setTimeout`, so every case below drives it on
 * fake timers rather than waiting out a real 800 ms budget.
 */
function fakeLlm(script: { reply?: string; usage?: TokenUsage; delayMs?: number } = {}): FakeLlm {
  const requests: FakeLlm['requests'] = [];
  const signals: AbortSignal[] = [];
  const provider: LlmProvider = {
    id: 'anthropic',
    generate: (req, signal): AsyncIterable<LlmChunk> => {
      requests.push({
        generationId: req.generationId,
        system: req.promptOverride?.system,
        maxTokens: req.promptOverride?.maxTokens,
      });
      signals.push(signal);
      return (async function* () {
        if (script.delayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, script.delayMs));
        }
        if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        yield { delta: script.reply ?? 'ACTIONABLE' };
        yield { usage: script.usage ?? { inputTokens: 120, outputTokens: 2 } };
      })();
    },
    validateKey: () => Promise.resolve({ ok: true }),
  };
  return { provider, requests, signals };
}

/**
 * TC-180. A classification call is real, billable spend (`FR-103`).
 *
 * It is keyed under `classify:<classificationId>` rather than under the turn's
 * own generation id, so it can never replace a suggestion's usage, and it is
 * reported from a `finally` so that an aborted or failed call is still counted
 * -- at zero, when no usage record ever arrived.
 */
describe('TC-180 classification call cost accounting', () => {
  it('reports a successful call under classify:<classificationId>', async () => {
    const llm = fakeLlm({ usage: { inputTokens: 120, outputTokens: 2 } });
    const { loop, noted, settings } = makeLoop({ resolveLlmProvider: () => llm.provider });
    await loop.start(PROFILE_ID);

    const verdict = await loop.classify('anything at all', new AbortController().signal);
    expect(verdict).toBe('actionable');

    expect(noted).toHaveLength(1);
    expect(noted[0]?.generationId).toMatch(/^classify:/);
    expect(noted[0]?.usage).toEqual({ inputTokens: 120, outputTokens: 2 });
    // Billed against the primary's own choice, which is what a price row is
    // keyed by.
    expect(noted[0]?.choice).toEqual(settings.providers.llm.primary);

    // The key carries the classification's own id, which is also the id the
    // request went out under, so the two can be matched up in a session record.
    expect(noted[0]?.generationId).toBe(`classify:${llm.requests[0]?.generationId ?? ''}`);

    await loop.stop();
  });

  it('still reports, at zero, when a newer turn aborts the call mid-flight', async () => {
    vi.useFakeTimers();
    try {
      // The response is still on its way when the turn that asked for it is
      // superseded, so no usage record ever arrives.
      const llm = fakeLlm({ delayMs: 200 });
      const { loop, noted } = makeLoop({ resolveLlmProvider: () => llm.provider });
      await loop.start(PROFILE_ID);

      const controller = new AbortController();
      const pending = loop.classify('anything at all', controller.signal);
      controller.abort();
      await vi.advanceTimersByTimeAsync(200);

      // A failure of any kind fails open (`TASK-060`), and the call is still
      // counted rather than silently dropped from the session estimate.
      await expect(pending).resolves.toBe('actionable');
      expect(llm.signals[0]?.aborted).toBe(true);
      expect(noted).toHaveLength(1);
      expect(noted[0]?.generationId).toMatch(/^classify:/);
      expect(noted[0]?.usage).toEqual({ inputTokens: 0, outputTokens: 0 });

      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still reports when the provider fails outright', async () => {
    const provider: LlmProvider = {
      id: 'anthropic',
      generate: (): AsyncIterable<LlmChunk> =>
        // eslint-disable-next-line require-yield
        (async function* () {
          throw new Error('the provider hung up');
        })(),
      validateKey: () => Promise.resolve({ ok: true }),
    };
    const { loop, noted } = makeLoop({ resolveLlmProvider: () => provider });
    await loop.start(PROFILE_ID);

    await expect(loop.classify('anything at all', new AbortController().signal)).resolves.toBe(
      'actionable',
    );
    expect(noted).toHaveLength(1);
    expect(noted[0]?.usage).toEqual({ inputTokens: 0, outputTokens: 0 });

    await loop.stop();
  });

  it('gives each call its own id, so two classifications never collide', async () => {
    const llm = fakeLlm();
    const { loop, noted } = makeLoop({ resolveLlmProvider: () => llm.provider });
    await loop.start(PROFILE_ID);

    await loop.classify('one', new AbortController().signal);
    await loop.classify('two', new AbortController().signal);

    expect(new Set(noted.map((n) => n.generationId)).size).toBe(2);
    await loop.stop();
  });
});

/**
 * TC-184. The health read is a plain property read, and the budget is local.
 *
 * `CredentialHealth` cannot answer "is `DEGRADED`'s backoff due yet", so the
 * gate is the positive one: only `'using-primary'` attempts a call. Every other
 * kind fails open immediately, with no network call and, crucially, without
 * routing anything through `runFor` -- a classification is not a probe and must
 * never drive credential health either way.
 */
describe('TC-184 classify health-check and timeout policy', () => {
  const skipped: HealthState[] = [
    { kind: 'retrying', attempt: 1 },
    { kind: 'using-backup' },
    { kind: 'degraded', reason: 'the provider hung up' },
    { kind: 'config-required', credentialId: 'anthropic', reason: 'the key was rejected' },
  ];

  for (const state of skipped) {
    it(`makes zero calls and resolves actionable at '${state.kind}'`, async () => {
      const llm = fakeLlm();
      let ladderCalls = 0;
      const { loop, noted } = makeLoop({
        llmHealth: state,
        resolveLlmProvider: () => llm.provider,
        runFor: (capability, fn) => {
          if (capability === 'llm') ladderCalls += 1;
          return fn('primary');
        },
      });
      await loop.start(PROFILE_ID);

      const verdict = await loop.classify('anything at all', new AbortController().signal);

      expect(verdict).toBe('actionable');
      expect(llm.requests).toEqual([]);
      expect(ladderCalls).toBe(0);
      // Nothing was spent, so nothing is reported either.
      expect(noted).toEqual([]);

      await loop.stop();
    });
  }

  it("attempts exactly one call at 'using-primary', against the primary's own choice", async () => {
    const llm = fakeLlm();
    let ladderCalls = 0;
    const { loop, settings } = makeLoop({
      resolveLlmProvider: (choice) => {
        expect(choice).toEqual(settings.providers.llm.primary);
        return llm.provider;
      },
      runFor: (capability, fn) => {
        if (capability === 'llm') ladderCalls += 1;
        return fn('primary');
      },
    });
    await loop.start(PROFILE_ID);

    await loop.classify('anything at all', new AbortController().signal);

    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.maxTokens).toBe(5);
    // The classification prompt, not the interview-cue system prompt.
    expect(llm.requests[0]?.system).toContain('ACTIONABLE or NON_ACTIONABLE');
    // Never routed through the retry/failover machinery (`CMP-12`).
    expect(ladderCalls).toBe(0);

    await loop.stop();
  });

  it('resolves actionable when the call runs past the 800 ms budget', async () => {
    vi.useFakeTimers();
    try {
      const llm = fakeLlm({ delayMs: CLASSIFICATION_TIMEOUT_MS + 1, reply: 'NON_ACTIONABLE' });
      let ladderCalls = 0;
      const { loop, noted } = makeLoop({
        resolveLlmProvider: () => llm.provider,
        runFor: (capability, fn) => {
          if (capability === 'llm') ladderCalls += 1;
          return fn('primary');
        },
      });
      await loop.start(PROFILE_ID);

      const pending = loop.classify('anything at all', new AbortController().signal);
      await vi.advanceTimersByTimeAsync(CLASSIFICATION_TIMEOUT_MS);

      // The verdict the provider would eventually have given is irrelevant: the
      // budget is up, so the turn fails open rather than waiting.
      await expect(pending).resolves.toBe('actionable');
      // The timeout aborts the request rather than leaving it running.
      expect(llm.signals[0]?.aborted).toBe(true);
      // Still accounted, at whatever arrived, and still not a probe.
      expect(noted).toHaveLength(1);
      expect(noted[0]?.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
      expect(ladderCalls).toBe(0);

      await vi.advanceTimersByTimeAsync(10);
      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves under the budget when the provider answers in time', async () => {
    vi.useFakeTimers();
    try {
      const llm = fakeLlm({ delayMs: CLASSIFICATION_TIMEOUT_MS - 1, reply: 'NON_ACTIONABLE' });
      const { loop } = makeLoop({ resolveLlmProvider: () => llm.provider });
      await loop.start(PROFILE_ID);

      const pending = loop.classify('anything at all', new AbortController().signal);
      await vi.advanceTimersByTimeAsync(CLASSIFICATION_TIMEOUT_MS);

      await expect(pending).resolves.toBe('non-actionable');
      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * TC-179. `firedAt` measures true turn-end-to-now.
 *
 * It is stamped the moment `FR-051`'s guard passes, before the confidence gate
 * and before the classifier, so a classifier that itself takes nearly the whole
 * budget leaves a fast generation over the threshold. Stamped after the
 * classifier instead -- the regression a second round of spec review found --
 * the same generation would look almost instantaneous and survive.
 */
describe('TC-179 firedAt includes the confidence gate and classifier cost', () => {
  /** Neither lexicon resolves this, so the injected classifier is asked. */
  const UNRESOLVED = 'I was reading your resume on the train last night';
  const GAP = defaultSettings().trigger.turnEndGapMs;
  const GENERATION_MS = 200;

  async function run(classifierMs: number) {
    const { loop, pushes, appended } = makeLoop({
      generate: async (_provider, _request, _signal, events) => {
        await new Promise((resolve) => setTimeout(resolve, GENERATION_MS));
        streamOneCard(events);
        return outcome();
      },
    });

    const machine = new TriggerMachine({
      config: {
        ...defaultSettings().trigger,
        supportsEndpointing: true,
        supportsConfidence: false,
        batchIntervalMs: 0,
      },
      onFire: (fired) => loop.onFire(fired),
      newGenerationId: () => 'g1',
      classify: () =>
        new Promise((resolve) => setTimeout(() => resolve('actionable'), classifierMs)),
    });

    await loop.start(PROFILE_ID);
    machine.start();
    machine.handleTranscript({
      source: 'interviewer',
      text: UNRESOLVED,
      isFinal: true,
      timestamp: 0,
      providerId: 'deepgram',
    });

    await vi.advanceTimersByTimeAsync(GAP + classifierMs + GENERATION_MS);
    await loop.whenSettled();
    await loop.stop();
    machine.dispose();
    return { pushes, appended };
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('discards a fast generation the classifier already spent the budget on', async () => {
    // Under the threshold on its own. Only together with the generation's own
    // time does the total cross it, which is what `firedAt` has to measure.
    const classifierMs = STALE_DISCARD_MS - 100;
    expect(classifierMs).toBeLessThan(STALE_DISCARD_MS);
    expect(classifierMs + GENERATION_MS).toBeGreaterThan(STALE_DISCARD_MS);

    const { pushes, appended } = await run(classifierMs);

    expect(pushes).toEqual([]);
    expect(appended.map((e) => e.status)).toEqual(['stale']);
  });

  it('leaves the same generation alone behind a quick classifier', async () => {
    const { pushes, appended } = await run(50);

    expect(pushes).toEqual([
      'suggestion:begin',
      'suggestion:line',
      'suggestion:line',
      'suggestion:end',
    ]);
    expect(appended.map((e) => e.status)).toEqual(['complete']);
  });
});
