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
  return { ...defaultSettings().trigger, supportsEndpointing: true, ...over };
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
      vi.advanceTimersByTime(GAP);
    }

    expect(h.fired).toHaveLength(0);
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

/** TC-085: the context ring (FR-052, ASM-009). */
describe('TC-085 context ring', () => {
  it('keeps the last 2 of 5 candidate turns', () => {
    const h = harness();
    for (const n of [1, 2, 3, 4, 5]) {
      h.trigger.handleTranscript(event({ source: 'candidate', text: `turn ${String(n)}` }));
    }
    expect(h.trigger.candidateContext).toBe('turn 4\nturn 5');
  });

  it('caps the pair at 400 characters, dropping the oldest content first', () => {
    const h = harness();
    const older = `OLDSTART${'o'.repeat(300)}`;
    const newer = 'n'.repeat(200);
    h.trigger.handleTranscript(event({ source: 'candidate', text: older }));
    h.trigger.handleTranscript(event({ source: 'candidate', text: newer }));

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
