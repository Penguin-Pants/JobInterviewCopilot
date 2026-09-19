/**
 * TASK-030. The turn-end state machine (`CMP-05`).
 *
 * Every timing assertion runs on fake timers: the test strategy forbids waiting
 * on a real gap, and a machine that needs 800 ms of wall clock per case is a
 * machine nobody runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../src/shared/defaults.js';
import type { TranscriptEvent } from '../../src/shared/types.js';
import {
  TriggerMachine,
  countWords,
  passesTurnGuard,
  renderContextRing,
  type TriggerConfig,
  type TriggerState,
  type TurnFired,
} from '../../src/main/ai/trigger.js';

const GAP = defaultSettings().trigger.turnEndGapMs;

function config(over: Partial<TriggerConfig> = {}): TriggerConfig {
  return {
    ...defaultSettings().trigger,
    supportsEndpointing: true,
    batchIntervalMs: 0,
    ...over,
  };
}

function event(over: Partial<TranscriptEvent> = {}): TranscriptEvent {
  return {
    source: 'interviewer',
    text: 'Tell me about a time you shipped something hard',
    isFinal: true,
    timestamp: 0,
    providerId: 'deepgram',
    ...over,
  };
}

interface Harness {
  trigger: TriggerMachine;
  fired: TurnFired[];
  states: TriggerState[];
  idleCards: number;
}

function harness(over: Partial<TriggerConfig> = {}): Harness {
  const fired: TurnFired[] = [];
  const states: TriggerState[] = [];
  const h: Harness = {
    fired,
    states,
    idleCards: 0,
    trigger: new TriggerMachine({
      config: config(over),
      onFire: (turn) => fired.push(turn),
      onStateChange: (state) => states.push(state),
      onOverlayIdle: () => {
        h.idleCards += 1;
      },
      newGenerationId: () => `gen-${String(fired.length + 1)}`,
    }),
  };
  h.trigger.start();
  return h;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** TC-080: one final, one gap of silence, exactly one fire. */
describe('TC-080 turn end fires', () => {
  it('fires once after the configured gap', () => {
    const h = harness();
    h.trigger.handleTranscript(event());
    expect(h.trigger.current).toBe('AWAITING_TURN_END');

    vi.advanceTimersByTime(GAP - 1);
    expect(h.fired).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]?.question).toContain('shipped something hard');
    expect(h.trigger.current).toBe('GENERATING');
  });

  it('does not fire a second time when no new final arrives', () => {
    const h = harness();
    h.trigger.handleTranscript(event());
    vi.advanceTimersByTime(GAP * 5);
    expect(h.fired).toHaveLength(1);
  });

  it('uses the configured gap rather than a hard-coded one', () => {
    const h = harness({ turnEndGapMs: 1400 });
    h.trigger.handleTranscript(event());
    vi.advanceTimersByTime(1399);
    expect(h.fired).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(h.fired).toHaveLength(1);
  });
});

/** TC-081: a new interim at gap - 1 ms resets the timer. */
describe('TC-081 timer reset', () => {
  it('restarts the gap on a later interim, so total elapsed exceeds one gap', () => {
    const h = harness();
    h.trigger.handleTranscript(event());

    vi.advanceTimersByTime(GAP - 1);
    h.trigger.handleTranscript(event({ isFinal: false, text: 'or maybe' }));
    vi.advanceTimersByTime(GAP - 1);
    expect(h.fired).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(h.fired).toHaveLength(1);
    // One gap would have fired at 800 ms. It fired at 1599 ms.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a second final also restarts it and both finals reach the question', () => {
    const h = harness();
    h.trigger.handleTranscript(event({ text: 'Tell me about' }));
    vi.advanceTimersByTime(GAP - 1);
    h.trigger.handleTranscript(event({ text: 'a hard project you shipped' }));
    vi.advanceTimersByTime(GAP);

    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]?.question).toBe('Tell me about a hard project you shipped');
  });
});

/** TC-082: a provider endpoint event fires immediately. */
describe('TC-082 endpoint bypass', () => {
  it('fires before the gap elapses', () => {
    const h = harness();
    h.trigger.handleTranscript(event());
    vi.advanceTimersByTime(10);

    h.trigger.handleEndpoint();
    expect(h.fired).toHaveLength(1);

    // And the cancelled timer does not fire a second one.
    vi.advanceTimersByTime(GAP * 2);
    expect(h.fired).toHaveLength(1);
  });

  it('ignores a native signal from a model whose registry entry cannot carry the gap', () => {
    // FR-050: a provider that cannot accept turnEndGapMs falls back to the
    // local timer, so its native signal must never preempt the user's value.
    const h = harness({ supportsEndpointing: false });
    h.trigger.handleTranscript(event());
    h.trigger.handleEndpoint();
    expect(h.fired).toHaveLength(0);

    vi.advanceTimersByTime(GAP);
    expect(h.fired).toHaveLength(1);
  });

  it('ignores an endpoint arriving with no turn assembled', () => {
    const h = harness();
    h.trigger.handleEndpoint();
    vi.advanceTimersByTime(GAP);
    expect(h.fired).toHaveLength(0);
    expect(h.trigger.current).toBe('LISTENING');
  });
});

/** TC-083: the short-turn guard (FR-051). */
describe('TC-083 short-turn guard', () => {
  it('"Okay" does not fire and returns to LISTENING', () => {
    const h = harness();
    h.trigger.handleTranscript(event({ text: 'Okay' }));
    vi.advanceTimersByTime(GAP);

    expect(h.fired).toHaveLength(0);
    expect(h.trigger.current).toBe('LISTENING');
  });

  it('"Tell me about yourself" does fire', () => {
    const h = harness();
    h.trigger.handleTranscript(event({ text: 'Tell me about yourself' }));
    vi.advanceTimersByTime(GAP);
    expect(h.fired).toHaveLength(1);
  });

  it('rejects a turn failing either half of the guard', () => {
    const cfg = config();
    // Three words, eleven characters: long enough by words, short by characters.
    expect(passesTurnGuard('a b cdefghi', cfg)).toBe(false);
    // Twelve characters in two words.
    expect(passesTurnGuard('abcdef ghijkl', cfg)).toBe(false);
    expect(passesTurnGuard('abcde fghij klmno', cfg)).toBe(true);
    expect(countWords('  one   two  ')).toBe(2);
  });
});

/** TC-084: the candidate stream can never trigger (FR-003, FR-055). */
describe('TC-084 candidate never triggers', () => {
  it('100 candidate finals produce zero fires and zero state changes', () => {
    const h = harness();
    const before = h.states.length;

    for (let i = 0; i < 100; i += 1) {
      h.trigger.handleTranscript(
        event({ source: 'candidate', text: `I led the migration, attempt ${String(i)}` }),
      );
      // Past the candidate grouping gap every time, so all 100 close as turns
      // and the timer that closes them is exercised, not skipped.
      vi.advanceTimersByTime(GAP);
    }

    expect(h.fired).toHaveLength(0);
    // The candidate grouping timer closes a ring entry and nothing else. It
    // carries no transition, which is what keeps this assertion true.
    expect(h.states.length).toBe(before);
    expect(h.trigger.current).toBe('LISTENING');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a candidate interim is not even added to the ring', () => {
    const h = harness();
    h.trigger.handleTranscript(event({ source: 'candidate', isFinal: false, text: 'umm' }));
    expect(h.trigger.candidateContext).toBe('');
  });
});

/** A candidate turn: its segments, then the silence that closes it (FR-052). */
function candidateTurn(h: Harness, ...segments: string[]): void {
  for (const text of segments) {
    h.trigger.handleTranscript(event({ source: 'candidate', text }));
  }
  vi.advanceTimersByTime(GAP);
}

/** TC-085: the context ring (FR-052, ASM-009). */
describe('TC-085 context ring', () => {
  it('keeps the last 2 of 5 candidate turns', () => {
    const h = harness();
    for (const n of [1, 2, 3, 4, 5]) candidateTurn(h, `turn ${String(n)}`);
    expect(h.trigger.candidateContext).toBe('turn 4\nturn 5');
  });

  /**
   * A streaming provider emits several `isFinal` segments for one spoken
   * answer: Deepgram sends `is_final` per segment and `speech_final` separately.
   * Treating each segment as a turn made the ring hold the last two segments of
   * one answer and evict everything said before it.
   */
  it('groups the segments of one spoken answer into one turn', () => {
    const h = harness();
    candidateTurn(h, 'I owned the rollout');
    candidateTurn(h, 'We cut latency', 'by sixty percent', 'over two quarters');

    expect(h.trigger.candidateContext).toBe(
      'I owned the rollout\nWe cut latency by sixty percent over two quarters',
    );
  });

  it('counts the turn still being spoken, before its silence closes it', () => {
    const h = harness();
    candidateTurn(h, 'first answer');
    h.trigger.handleTranscript(event({ source: 'candidate', text: 'still talking' }));

    // The candidate has said the words, so FR-052's "do not repeat this" covers
    // them whether or not the segments have been grouped yet.
    expect(h.trigger.candidateContext).toBe('first answer\nstill talking');
  });

  it('does not let the ring array grow for the length of the interview', () => {
    const h = harness();
    for (let i = 0; i < 50; i += 1) candidateTurn(h, `turn ${String(i)}`);
    expect(h.trigger.candidateContext).toBe('turn 48\nturn 49');
  });

  it('caps the pair at 400 characters, dropping the oldest content first', () => {
    const h = harness();
    const older = `OLDSTART${'o'.repeat(300)}`;
    const newer = 'n'.repeat(200);
    candidateTurn(h, older);
    candidateTurn(h, newer);

    const context = h.trigger.candidateContext;
    expect(context.length).toBe(400);
    // The newest turn survives whole; the oldest lost its opening.
    expect(context.endsWith(newer)).toBe(true);
    expect(context).not.toContain('OLDSTART');
  });

  it('drops an older turn entirely when the newest already fills the budget', () => {
    expect(renderContextRing(['old', 'x'.repeat(400)], 2, 400)).toBe('x'.repeat(400));
    expect(renderContextRing(['a', 'b'], 0, 400)).toBe('');
  });
});

/** TC-086: a new turn end during GENERATING aborts the in-flight generation. */
describe('TC-086 cancel on new turn', () => {
  it('fires the in-flight AbortSignal before the new generation starts', () => {
    const h = harness();
    const abortedWhenSecondFired: boolean[] = [];

    h.trigger.handleTranscript(event({ text: 'First question about your work' }));
    vi.advanceTimersByTime(GAP);
    const first = h.fired[0];
    expect(first?.signal.aborted).toBe(false);

    first?.signal.addEventListener('abort', () => {
      // The ordering claim: at the moment of the abort, the replacement has not
      // been handed over yet.
      abortedWhenSecondFired.push(h.fired.length === 1);
    });

    h.trigger.handleTranscript(event({ text: 'Second question about your work' }));
    vi.advanceTimersByTime(GAP);

    expect(first?.signal.aborted).toBe(true);
    expect(abortedWhenSecondFired).toEqual([true]);
    expect(h.fired).toHaveLength(2);
    expect(h.fired[1]?.signal.aborted).toBe(false);
    expect(h.trigger.current).toBe('GENERATING');
  });

  it('a short interjection during a generation neither cancels it nor changes state', () => {
    const h = harness();
    h.trigger.handleTranscript(event({ text: 'First question about your work' }));
    vi.advanceTimersByTime(GAP);

    h.trigger.handleTranscript(event({ text: 'Okay' }));
    vi.advanceTimersByTime(GAP);

    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]?.signal.aborted).toBe(false);
    expect(h.trigger.current).toBe('GENERATING');
  });

  it('a late settle report from a cancelled generation does not move the machine', () => {
    const h = harness();
    h.trigger.handleTranscript(event({ text: 'First question about your work' }));
    vi.advanceTimersByTime(GAP);
    h.trigger.handleTranscript(event({ text: 'Second question about your work' }));
    vi.advanceTimersByTime(GAP);

    h.trigger.noteGenerationSettled('gen-1');
    expect(h.trigger.current).toBe('GENERATING');

    h.trigger.noteGenerationSettled('gen-2');
    expect(h.trigger.current).toBe('LISTENING');
  });
});

/** TC-088: resume returns to LISTENING and the next turn fires normally. */
describe('TC-087 and TC-088 pause and resume', () => {
  it('pausing aborts the in-flight generation and pushes the idle card', () => {
    const h = harness();
    h.trigger.handleTranscript(event());
    vi.advanceTimersByTime(GAP);

    h.trigger.togglePause();
    expect(h.trigger.current).toBe('PAUSED');
    expect(h.trigger.isPaused).toBe(true);
    expect(h.fired[0]?.signal.aborted).toBe(true);
    expect(h.idleCards).toBe(1);
  });

  it('an interviewer final while paused starts no timer and fires nothing', () => {
    const h = harness();
    h.trigger.togglePause();
    h.trigger.handleTranscript(event());
    vi.advanceTimersByTime(GAP * 3);

    expect(h.fired).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the candidate ring keeps filling while paused, so resume has current context', () => {
    const h = harness();
    h.trigger.togglePause();
    h.trigger.handleTranscript(event({ source: 'candidate', text: 'I owned the rollout' }));
    vi.advanceTimersByTime(GAP);
    expect(h.trigger.candidateContext).toBe('I owned the rollout');
  });

  it('resuming returns to LISTENING and the next turn fires normally', () => {
    const h = harness();
    h.trigger.togglePause();
    h.trigger.togglePause();
    expect(h.trigger.current).toBe('LISTENING');

    h.trigger.handleTranscript(event());
    vi.advanceTimersByTime(GAP);
    expect(h.fired).toHaveLength(1);
  });

  it('a partial turn from before the pause is not resurrected on resume', () => {
    const h = harness();
    h.trigger.handleTranscript(event());
    h.trigger.togglePause();
    h.trigger.togglePause();

    vi.advanceTimersByTime(GAP * 3);
    expect(h.fired).toHaveLength(0);
  });

  it('IDLE is not pausable, so resuming cannot invent a session (ADR-031)', () => {
    const fired: TurnFired[] = [];
    const idle = new TriggerMachine({ config: config(), onFire: (t) => fired.push(t) });
    idle.togglePause();
    expect(idle.current).toBe('IDLE');
  });
});

/**
 * Regressions found by the Codex review on the pull request. Each one is a case
 * the original TASK-030 tests did not reach.
 */
describe('turn-end regressions', () => {
  it('does not strand a turn whose generation settles before its gap elapses', () => {
    const h = harness();

    // Q1 fires and starts streaming.
    h.trigger.handleTranscript(event({ text: 'First question about your work' }));
    vi.advanceTimersByTime(GAP);
    expect(h.fired).toHaveLength(1);

    // Q2's final arrives while Q1 is still streaming, so its gap is armed and
    // the machine stays GENERATING.
    h.trigger.handleTranscript(event({ text: 'Second question about your work' }));

    // Q1's stream ends first. The machine used to drop to LISTENING here, and
    // the gap timer then fired into a state evaluateTurn refused.
    h.trigger.noteGenerationSettled('gen-1');
    expect(h.trigger.current).toBe('AWAITING_TURN_END');

    vi.advanceTimersByTime(GAP);
    expect(h.fired).toHaveLength(2);
    expect(h.fired[1]?.question).toBe('Second question about your work');
  });

  it('a settled generation with no turn pending still returns to LISTENING', () => {
    const h = harness();
    h.trigger.handleTranscript(event());
    vi.advanceTimersByTime(GAP);
    h.trigger.noteGenerationSettled('gen-1');
    expect(h.trigger.current).toBe('LISTENING');
  });

  it('the stranded turn is not merged into the question that follows it', () => {
    const h = harness();
    h.trigger.handleTranscript(event({ text: 'First question about your work' }));
    vi.advanceTimersByTime(GAP);
    h.trigger.handleTranscript(event({ text: 'Second question about your work' }));
    h.trigger.noteGenerationSettled('gen-1');
    vi.advanceTimersByTime(GAP);

    h.trigger.handleTranscript(event({ text: 'Third question about your work' }));
    h.trigger.noteGenerationSettled('gen-2');
    vi.advanceTimersByTime(GAP);

    expect(h.fired).toHaveLength(3);
    expect(h.fired[2]?.question).toBe('Third question about your work');
  });

  it('honors a native endpoint while a generation is still streaming', () => {
    const h = harness();
    h.trigger.handleTranscript(event({ text: 'First question about your work' }));
    vi.advanceTimersByTime(GAP);

    h.trigger.handleTranscript(event({ text: 'Second question about your work' }));
    // The provider has already observed the silence. Waiting out another full
    // local gap after that is the delay FR-050 exists to avoid.
    h.trigger.handleEndpoint();

    expect(h.fired).toHaveLength(2);
    expect(h.fired[0]?.signal.aborted).toBe(true);
  });

  it('holds an endpoint that arrives before the text it ends', () => {
    // OpenAI's server VAD emits speech_stopped before the completed item.
    const h = harness();
    h.trigger.handleEndpoint();
    expect(h.fired).toHaveLength(0);

    h.trigger.handleTranscript(event({ text: 'Tell me about a hard project' }));
    expect(h.fired).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a held endpoint is spent once, not on every later turn', () => {
    const h = harness();
    h.trigger.handleEndpoint();
    h.trigger.handleTranscript(event({ text: 'Tell me about a hard project' }));
    h.trigger.noteGenerationSettled('gen-1');

    h.trigger.handleTranscript(event({ text: 'And what did you learn from it' }));
    expect(h.fired).toHaveLength(1);
    vi.advanceTimersByTime(GAP);
    expect(h.fired).toHaveLength(2);
  });

  it('a held endpoint does not survive a pause', () => {
    const h = harness();
    h.trigger.handleEndpoint();
    h.trigger.togglePause();
    h.trigger.togglePause();

    h.trigger.handleTranscript(event({ text: 'Tell me about a hard project' }));
    expect(h.fired).toHaveLength(0);
    vi.advanceTimersByTime(GAP);
    expect(h.fired).toHaveLength(1);
  });

  /**
   * `whisper-1` emits one `isFinal` per 4000 ms batch and never an interim or
   * an endpoint. An 800 ms gap measured from each batch fires while the
   * interviewer is still speaking into the next one, cutting a long question
   * into a suggestion per fragment.
   */
  it('waits a whole batch window before calling a batch model silent', () => {
    const h = harness({ batchIntervalMs: 4000, supportsEndpointing: false });

    h.trigger.handleTranscript(event({ text: 'Tell me about a time when you had to' }));
    vi.advanceTimersByTime(GAP);
    expect(h.fired).toHaveLength(0);

    // The next batch lands, still the same question.
    vi.advanceTimersByTime(3000);
    h.trigger.handleTranscript(event({ text: 'make a difficult technical tradeoff' }));
    vi.advanceTimersByTime(GAP + 3999);
    expect(h.fired).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]?.question).toBe(
      'Tell me about a time when you had to make a difficult technical tradeoff',
    );
  });

  it('a streaming model still fires at exactly the configured gap', () => {
    // batchIntervalMs is 0 for every streaming model, so TC-159's "a hard-coded
    // 800 fails this test" is unaffected by the batch allowance.
    const h = harness({ turnEndGapMs: 1400 });
    h.trigger.handleTranscript(event());
    vi.advanceTimersByTime(1399);
    expect(h.fired).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(h.fired).toHaveLength(1);
  });
});

describe('session lifecycle', () => {
  it('start moves IDLE to LISTENING and stop aborts everything in flight', () => {
    const h = harness();
    h.trigger.handleTranscript(event());
    vi.advanceTimersByTime(GAP);
    const inFlight = h.fired[0];

    h.trigger.stop();
    expect(h.trigger.current).toBe('IDLE');
    expect(inFlight?.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.trigger.candidateContext).toBe('');
  });

  it('ignores transcripts while IDLE', () => {
    const fired: TurnFired[] = [];
    const idle = new TriggerMachine({ config: config(), onFire: (t) => fired.push(t) });
    idle.handleTranscript(event());
    vi.advanceTimersByTime(GAP * 3);
    expect(fired).toHaveLength(0);
  });

  it('exposes the id of the generation currently streaming', () => {
    const h = harness();
    expect(h.trigger.activeGenerationId).toBeNull();

    h.trigger.handleTranscript(event());
    vi.advanceTimersByTime(GAP);
    expect(h.trigger.activeGenerationId).toBe('gen-1');

    h.trigger.noteGenerationSettled('gen-1');
    expect(h.trigger.activeGenerationId).toBeNull();
  });

  it('dispose releases the timer and aborts in flight, and is safe to repeat', () => {
    const h = harness();
    h.trigger.handleTranscript(event());
    vi.advanceTimersByTime(GAP);
    const inFlight = h.fired[0];

    h.trigger.handleTranscript(event({ isFinal: false, text: 'more' }));
    h.trigger.dispose();
    h.trigger.dispose();

    expect(inFlight?.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a settings change applies to the next turn', () => {
    const h = harness();
    h.trigger.setConfig(config({ turnEndGapMs: 1500 }));
    h.trigger.handleTranscript(event());
    vi.advanceTimersByTime(1499);
    expect(h.fired).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(h.fired).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * TASK-060. The classifier the machine calls but does not own.
 * ------------------------------------------------------------------ */

/**
 * A turn neither lexicon resolves, so `evaluateTurn` has to ask the injected
 * classifier. No `?`, no lead word at the start, and not an exact match against
 * a non-actionable phrase (`TC-167`).
 */
const UNRESOLVED = 'I was reading your resume on the train last night';
const UNRESOLVED_TWO = 'My colleague mentioned the migration you led at Acme';

interface ClassifierHarness extends Harness {
  /** One entry per `classify` call, with the signal it was handed. */
  calls: { text: string; signal: AbortSignal }[];
  /** Settle the nth call, in the order they were made. */
  resolve: (index: number, verdict: 'actionable' | 'non-actionable') => void;
  reject: (index: number, reason: Error) => void;
}

function classifierHarness(over: Partial<TriggerConfig> = {}): ClassifierHarness {
  const calls: { text: string; signal: AbortSignal }[] = [];
  const settlers: {
    resolve: (v: 'actionable' | 'non-actionable') => void;
    reject: (e: Error) => void;
  }[] = [];
  const fired: TurnFired[] = [];
  const states: TriggerState[] = [];

  const h: ClassifierHarness = {
    calls,
    fired,
    states,
    idleCards: 0,
    resolve: (index, verdict) => settlers[index]?.resolve(verdict),
    reject: (index, reason) => settlers[index]?.reject(reason),
    trigger: new TriggerMachine({
      config: config(over),
      onFire: (turn) => fired.push(turn),
      onStateChange: (state) => states.push(state),
      onOverlayIdle: () => {
        h.idleCards += 1;
      },
      newGenerationId: () => `gen-${String(fired.length + calls.length + 1)}`,
      // Deliberately never settles on its own: every case below decides when,
      // and in what order, a classification comes back.
      classify: (text, signal) =>
        new Promise((resolve, reject) => {
          calls.push({ text, signal });
          settlers.push({ resolve, reject });
        }),
    }),
  };
  h.trigger.start();
  return h;
}

/**
 * TC-178. `abortInFlight` is "whichever async op is in flight", not "the
 * generation". Mirrors `TC-086`'s abort-during-`GENERATING` case, extended to
 * the state this milestone added.
 */
describe('TC-178 a new turn end during CLASSIFYING aborts the classification', () => {
  it('aborts the previous call before the new turn asks its own question', async () => {
    const h = classifierHarness();
    const callsAtAbort: number[] = [];

    h.trigger.handleTranscript(event({ text: UNRESOLVED }));
    await vi.advanceTimersByTimeAsync(GAP);

    expect(h.trigger.current).toBe('CLASSIFYING');
    expect(h.calls).toHaveLength(1);
    const first = h.calls[0]!;
    expect(first.signal.aborted).toBe(false);
    // The ordering claim: at the moment of the abort, the new turn has not run
    // its own guard chain yet, so no second classification exists.
    first.signal.addEventListener('abort', () => callsAtAbort.push(h.calls.length));

    h.trigger.handleTranscript(event({ text: UNRESOLVED_TWO }));
    await vi.advanceTimersByTimeAsync(GAP);

    expect(first.signal.aborted).toBe(true);
    expect(callsAtAbort).toEqual([1]);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]?.text).toBe(UNRESOLVED_TWO);
    expect(h.calls[1]?.signal.aborted).toBe(false);
    expect(h.trigger.current).toBe('CLASSIFYING');
    // Nothing fired: the first turn was superseded and the second is still out.
    expect(h.fired).toEqual([]);
  });

  it('aborts a classification when the session stops or pauses, too', async () => {
    const h = classifierHarness();
    h.trigger.handleTranscript(event({ text: UNRESOLVED }));
    await vi.advanceTimersByTimeAsync(GAP);
    h.trigger.pause();
    expect(h.calls[0]?.signal.aborted).toBe(true);

    const stopping = classifierHarness();
    stopping.trigger.handleTranscript(event({ text: UNRESOLVED }));
    await vi.advanceTimersByTimeAsync(GAP);
    stopping.trigger.stop();
    expect(stopping.calls[0]?.signal.aborted).toBe(true);
  });
});

/**
 * TC-183. An aborted classification settles whenever the promise underneath it
 * happens to settle, which is not the instant the signal fired. The machine
 * has already moved past that turn by then, so the late settlement is
 * discarded against the in-flight marker, exactly as a stale generation
 * settlement already is (`noteGenerationSettled`).
 */
describe('TC-183 an aborted classification settles into nothing', () => {
  it('produces no TurnFired when it resolves actionable after being superseded', async () => {
    const h = classifierHarness();

    h.trigger.handleTranscript(event({ text: UNRESOLVED }));
    await vi.advanceTimersByTimeAsync(GAP);
    h.trigger.handleTranscript(event({ text: UNRESOLVED_TWO }));
    await vi.advanceTimersByTimeAsync(GAP);
    expect(h.calls[0]?.signal.aborted).toBe(true);

    // The superseded call comes back long after the guard-pass that killed it.
    h.resolve(0, 'actionable');
    await Promise.resolve();
    await Promise.resolve();

    expect(h.fired).toEqual([]);
    expect(h.trigger.current).toBe('CLASSIFYING');

    // The turn that actually owns the machine is unaffected by it.
    h.resolve(1, 'actionable');
    await Promise.resolve();
    await Promise.resolve();
    expect(h.fired.map((t) => t.question)).toEqual([UNRESOLVED_TWO]);
    expect(h.trigger.current).toBe('GENERATING');
  });

  it('is not read as the superseded turn non-actionable verdict either', async () => {
    const h = classifierHarness();

    h.trigger.handleTranscript(event({ text: UNRESOLVED }));
    await vi.advanceTimersByTimeAsync(GAP);
    h.trigger.handleTranscript(event({ text: UNRESOLVED_TWO }));
    await vi.advanceTimersByTimeAsync(GAP);

    const statesBefore = h.states.length;
    h.resolve(0, 'non-actionable');
    await Promise.resolve();
    await Promise.resolve();

    // A `'non-actionable'` settle returns the machine to LISTENING. Applied to
    // a turn the machine has already moved past, it would drop the live
    // classification's own state on the floor.
    expect(h.states).toHaveLength(statesBefore);
    expect(h.trigger.current).toBe('CLASSIFYING');
  });

  /**
   * The rejection path is the one that reads most like a fresh failure: the
   * machine's own `.catch` turns any rejection into `'actionable'`, which is
   * the correct fallback for a **live** classification and exactly the wrong
   * thing for one a newer turn already replaced.
   */
  it('does not treat an aborted call rejection as this turn actionable fallback', async () => {
    const h = classifierHarness();

    h.trigger.handleTranscript(event({ text: UNRESOLVED }));
    await vi.advanceTimersByTimeAsync(GAP);
    h.trigger.handleTranscript(event({ text: UNRESOLVED_TWO }));
    await vi.advanceTimersByTimeAsync(GAP);

    h.reject(0, Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(h.fired).toEqual([]);
    expect(h.trigger.current).toBe('CLASSIFYING');
  });
});
