/**
 * The trigger state machine (`CMP-05`). Mirrors `docs/02-architecture.md`
 * section 5.3 (TASK-030).
 *
 * A pure module: no Electron import, no provider import, no network. Every
 * timer is injected, so the whole of `FR-050` to `FR-055` is driven with fake
 * timers and no real waiting (test strategy section 2).
 *
 * This component decides *when* a turn ended. It never calls a provider
 * (`CMP-05` must not), so firing means handing a `TurnFired` to its owner.
 */
import type { TranscriptEvent } from '../../shared/types.js';

/** The five states of `docs/02-architecture.md` section 5.3. */
export type TriggerState = 'IDLE' | 'LISTENING' | 'AWAITING_TURN_END' | 'GENERATING' | 'PAUSED';

/** The trigger subset of `Settings`, plus the capability read off the STT model. */
export interface TriggerConfig {
  /** `settings.trigger.turnEndGapMs`. Never hard-coded (FR-050, TC-159). */
  turnEndGapMs: number;
  minTurnWords: number;
  minTurnChars: number;
  candidateContextTurns: number;
  candidateContextChars: number;
  /**
   * `supportsEndpointing` from the **registry entry of the selected model**,
   * never from the provider id (FR-037, FR-050). False means a native signal is
   * ignored here and the local timer is the only turn-end source.
   */
  supportsEndpointing: boolean;
}

/** Injected so a test drives the gap without waiting for it. */
export interface TriggerTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_TIMERS: TriggerTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** What the owner receives when a turn passes the guard (FR-050, FR-051). */
export interface TurnFired {
  generationId: string;
  /** The accumulated interviewer text for the turn. */
  question: string;
  /** The candidate context ring, already capped (FR-052). */
  candidateContext: string;
  /** Aborted when a newer turn end arrives, or on pause or stop (FR-054, FR-075). */
  signal: AbortSignal;
}

/** How the owner wires itself to the machine (FR-050 to FR-055). */
export interface TriggerOptions {
  config: TriggerConfig;
  /**
   * A turn passed the guard. The owner starts a generation and calls
   * `noteGenerationSettled` when the stream ends, however it ends.
   */
  onFire: (turn: TurnFired) => void;
  onStateChange?: (state: TriggerState, previous: TriggerState) => void;
  /** Entering `PAUSED` pushes the overlay idle state (FR-053). */
  onOverlayIdle?: () => void;
  timers?: Partial<TriggerTimers>;
  /** Injected so a test can assert on a stable generation id. */
  newGenerationId?: () => string;
}

let generationCounter = 0;

function defaultGenerationId(): string {
  generationCounter += 1;
  return `gen-${String(Date.now())}-${String(generationCounter)}`;
}

/** Words as the guard counts them: whitespace-separated, empties dropped (FR-051). */
export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * `FR-051`: a turn shorter than `minTurnWords` **or** `minTurnChars` does not
 * fire. "Okay" fails on both counts, "Tell me about yourself" passes both
 * (TC-083).
 */
export function passesTurnGuard(text: string, config: TriggerConfig): boolean {
  const trimmed = text.trim();
  return countWords(trimmed) >= config.minTurnWords && trimmed.length >= config.minTurnChars;
}

/**
 * The candidate context ring (`FR-052`, ASM-009).
 *
 * The last `turns` candidate turns, capped at `chars` characters in total with
 * the **oldest content dropped first**, so the newest turn is always whole and
 * an over-long older turn loses its opening rather than the ring losing the
 * turn. Exported because TC-085 asserts the rule, not the class that holds it.
 */
export function renderContextRing(turns: string[], maxTurns: number, maxChars: number): string {
  if (maxTurns <= 0 || maxChars <= 0) return '';
  const kept = turns.slice(-maxTurns);

  // Walk newest to oldest, spending the budget. The separator costs a
  // character too, or two joined turns could exceed the cap by one each.
  const out: string[] = [];
  let budget = maxChars;
  for (let i = kept.length - 1; i >= 0; i -= 1) {
    if (budget <= 0) break;
    const separator = out.length > 0 ? 1 : 0;
    const room = budget - separator;
    if (room <= 0) break;
    const turn = kept[i] ?? '';
    // Dropping the oldest *content* first means slicing this turn's head.
    out.unshift(turn.length > room ? turn.slice(turn.length - room) : turn);
    budget -= (out[0]?.length ?? 0) + separator;
  }
  return out.join('\n');
}

/**
 * The turn-end machine.
 *
 * Candidate finals only append to the ring. They cause no transition and can
 * never fire, which is the mechanical guarantee behind `FR-003` and `FR-055`
 * (TC-084).
 */
export class TriggerMachine {
  private state: TriggerState = 'IDLE';
  private config: TriggerConfig;

  private readonly timers: TriggerTimers;
  private readonly fire: (turn: TurnFired) => void;
  private readonly onStateChange?: (state: TriggerState, previous: TriggerState) => void;
  private readonly onOverlayIdle?: () => void;
  private readonly newGenerationId: () => string;

  private gapHandle: unknown = null;
  /** The interviewer text accumulated for the turn being assembled. */
  private turnText = '';
  private candidateTurns: string[] = [];

  private inFlight: { generationId: string; controller: AbortController } | null = null;

  constructor(options: TriggerOptions) {
    this.config = options.config;
    this.fire = options.onFire;
    this.onStateChange = options.onStateChange;
    this.onOverlayIdle = options.onOverlayIdle;
    this.newGenerationId = options.newGenerationId ?? defaultGenerationId;
    this.timers = { ...REAL_TIMERS, ...options.timers };
  }

  get current(): TriggerState {
    return this.state;
  }

  get isPaused(): boolean {
    return this.state === 'PAUSED';
  }

  /** The ring as the prompt builder will render it (FR-052, FR-072). */
  get candidateContext(): string {
    return renderContextRing(
      this.candidateTurns,
      this.config.candidateContextTurns,
      this.config.candidateContextChars,
    );
  }

  /** The generation currently streaming, or null. */
  get activeGenerationId(): string | null {
    return this.inFlight?.generationId ?? null;
  }

  /**
   * A settings change lands immediately. The gap is read when a timer is armed,
   * so a change mid-turn applies to the next turn rather than rewriting one in
   * progress, which would move a deadline the user is already waiting on.
   */
  setConfig(config: TriggerConfig): void {
    this.config = config;
  }

  /** `session:start` (TASK-040). IDLE to LISTENING. */
  start(): void {
    if (this.state !== 'IDLE') return;
    this.turnText = '';
    this.candidateTurns = [];
    this.transition('LISTENING');
  }

  /** `session:stop`. Any state to IDLE, aborting anything in flight. */
  stop(): void {
    this.clearGap();
    this.abortInFlight();
    this.turnText = '';
    this.candidateTurns = [];
    this.transition('IDLE');
  }

  /**
   * One normalized STT event (`CH-206`).
   *
   * The source decides everything: a candidate event reaches the ring and
   * returns, before any state is read. That ordering is the guarantee, not a
   * check further down that a later edit could reorder (FR-003, FR-055).
   */
  handleTranscript(event: TranscriptEvent): void {
    if (event.source === 'candidate') {
      // Kept fed while paused: the ring is context, not a trigger, and a resume
      // with a stale context would describe an interview that moved on.
      if (event.isFinal && event.text.trim() !== '') this.candidateTurns.push(event.text.trim());
      return;
    }
    if (this.state === 'IDLE' || this.state === 'PAUSED') return;

    if (event.isFinal) {
      this.turnText =
        this.turnText === '' ? event.text.trim() : `${this.turnText} ${event.text.trim()}`;
    }

    // Any new interviewer interim or final restarts the gap (FR-050, TC-081).
    // An interim before the first final does not arm it: FR-050 says a turn end
    // is a *final* followed by silence.
    if (this.turnText === '') return;
    this.armGap();
    if (this.state === 'LISTENING') this.transition('AWAITING_TURN_END');
  }

  /**
   * A provider-native turn end (`FR-050`).
   *
   * Honored only when the selected model's registry entry declares
   * `supportsEndpointing`. A model that cannot be told the user's gap has its
   * native signal ignored here and falls back to the local timer, so a native
   * signal can never preempt the chosen value (TC-159).
   */
  handleEndpoint(): void {
    if (!this.config.supportsEndpointing) return;
    if (this.state !== 'AWAITING_TURN_END') return;
    this.clearGap();
    this.evaluateTurn();
  }

  /** `Ctrl+Shift+P` (FR-053, ASM-002). */
  togglePause(): void {
    if (this.state === 'PAUSED') this.resume();
    else this.pause();
  }

  /**
   * Pausing aborts the in-flight generation and shows the idle card. Audio
   * capture and the STT sockets stay open, which is why nothing here touches
   * them (FR-053, TC-087).
   *
   * `IDLE` is deliberately not pausable. Section 5.3 writes the transition as
   * `any -> PAUSED`, but `IDLE` means no session; resuming out of it would put
   * the machine in `LISTENING` with nothing listening. Recorded as ADR-031.
   */
  pause(): void {
    if (this.state === 'PAUSED' || this.state === 'IDLE') return;
    this.clearGap();
    this.abortInFlight();
    this.turnText = '';
    this.transition('PAUSED');
    this.onOverlayIdle?.();
  }

  /**
   * PAUSED to LISTENING (FR-053, TC-088).
   *
   * Always to `LISTENING`, never back to whatever state the pause interrupted:
   * the generation was aborted and the half-assembled turn discarded, so there
   * is nothing for `AWAITING_TURN_END` or `GENERATING` to resume into.
   */
  resume(): void {
    if (this.state !== 'PAUSED') return;
    this.turnText = '';
    this.transition('LISTENING');
  }

  /**
   * The owner reports that a generation finished, was cancelled or failed.
   *
   * Stale ids are ignored: a cancelled generation's stream ends *after* its
   * replacement started, and letting that late report move the machine would
   * drop the state back to `LISTENING` under a live generation (FR-054).
   */
  noteGenerationSettled(generationId: string): void {
    if (this.inFlight?.generationId !== generationId) return;
    this.inFlight = null;
    if (this.state === 'GENERATING') this.transition('LISTENING');
  }

  /** Release timers and abort anything in flight. Safe to call twice. */
  dispose(): void {
    this.clearGap();
    this.abortInFlight();
  }

  private armGap(): void {
    this.clearGap();
    this.gapHandle = this.timers.setTimeout(() => {
      this.gapHandle = null;
      this.evaluateTurn();
    }, this.config.turnEndGapMs);
  }

  private clearGap(): void {
    if (this.gapHandle === null) return;
    this.timers.clearTimeout(this.gapHandle);
    this.gapHandle = null;
  }

  /** The gap elapsed, or the provider said the turn ended. Guard, then fire. */
  private evaluateTurn(): void {
    if (this.state !== 'AWAITING_TURN_END' && this.state !== 'GENERATING') return;

    const question = this.turnText.trim();
    this.turnText = '';

    if (!passesTurnGuard(question, this.config)) {
      // A short turn is not an error and never reaches the overlay. Back to
      // LISTENING without firing (FR-051, TC-083).
      //
      // Unless a generation is still streaming: a short interjection during one
      // must not cancel it and must not report `LISTENING` while the overlay is
      // still filling, or the stream's own end would arrive against a state
      // that had already moved on.
      if (this.inFlight === null) this.transition('LISTENING');
      return;
    }

    // A new turn end while a generation streams cancels it *before* the new one
    // starts, so the two never overlap on the overlay (FR-054, ASM-004, TC-086).
    this.abortInFlight();

    const controller = new AbortController();
    const generationId = this.newGenerationId();
    this.inFlight = { generationId, controller };
    this.transition('GENERATING');

    this.fire({
      generationId,
      question,
      candidateContext: this.candidateContext,
      signal: controller.signal,
    });
  }

  private abortInFlight(): void {
    if (!this.inFlight) return;
    const { controller } = this.inFlight;
    this.inFlight = null;
    controller.abort();
  }

  private transition(next: TriggerState): void {
    if (this.state === next) return;
    const previous = this.state;
    this.state = next;
    this.onStateChange?.(next, previous);
  }
}
