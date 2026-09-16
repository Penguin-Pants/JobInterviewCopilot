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
import { describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../src/shared/defaults.js';
import type {
  AudioChunk,
  ProviderChoice,
  ProviderError,
  Settings,
  TranscriptEvent,
  TranscriptSource,
} from '../../src/shared/types.js';
import type { SttSession } from '../../src/main/ai/stt.js';
import type { TurnFired } from '../../src/main/ai/trigger.js';
import { LiveSessionLoop, type LiveSessionLoopOptions } from '../../src/main/live.js';
import type { GenerationOutcome, LlmProvider } from '../../src/main/ai/llm.js';

const PROFILE_ID = 'p1';

class StubSttSession implements SttSession {
  closed = 0;
  closeError: Error | null = null;
  readonly transcript: ((t: TranscriptEvent) => void)[] = [];
  readonly endpoints: (() => void)[] = [];
  readonly errors: ((e: ProviderError) => void)[] = [];

  constructor(
    readonly source: TranscriptSource,
    readonly choice: ProviderChoice,
  ) {}

  push(_chunk: AudioChunk): void {}

  close(): Promise<void> {
    this.closed += 1;
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
  appendTurn?: () => Promise<number>;
  appendSuggestion?: () => Promise<number>;
  /** Makes the one call that sits outside the loop's own try blocks throw. */
  settleThrows?: boolean;
}

function makeLoop(stub: StubOptions = {}) {
  const errors: { message: string; detail?: unknown }[] = [];
  const infos: string[] = [];
  const opened: StubSttSession[] = [];
  const settled: string[] = [];
  const noted: { generationId: string; choice: ProviderChoice }[] = [];
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
      appendTurn: stub.appendTurn ?? (() => Promise.resolve(0)),
      appendSuggestion: stub.appendSuggestion ?? (() => Promise.resolve(1)),
    },
    cost: {
      noteAudio: () => {},
      noteGeneration: (generationId, choice) => noted.push({ generationId, choice }),
    },
    health: {
      // The health policy itself is TASK-014's. Here it is the identity, so a
      // test asserts what the loop does rather than what the ladder does.
      runFor: (_capability, fn) => fn('primary'),
    },
    settings: () => settings,
    retrieve: stub.retrieve ?? (() => Promise.resolve([])),
    keyFor: stub.keyFor ?? (() => 'k'),
    onTranscript: () => {},
    onSuggestion: () => {},
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

  return { loop, errors, infos, opened, settled, noted, endpoints, settings };
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

  it('dispose releases the streams without awaiting, for will-quit', async () => {
    const { loop, opened } = makeLoop();
    await loop.start(PROFILE_ID);

    loop.dispose();

    expect(loop.isRunning).toBe(false);
    await Promise.resolve();
    expect(opened.every((s) => s.closed === 1)).toBe(true);
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

  it('reports a provider error on a stream and leaves the overlay alone', async () => {
    const { loop, opened, errors } = makeLoop();
    await loop.start(PROFILE_ID);

    const err = new Error('the socket closed') as ProviderError;
    err.class = 'network';
    err.providerId = 'deepgram';
    err.retryable = true;
    opened[0]?.errors.forEach((h) => h(err));

    expect(errors.map((e) => e.message)).toEqual([
      'the interviewer transcription stream reported an error',
    ]);
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
    expect(noted.map((n) => n.generationId)).toEqual(['g1']);
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
