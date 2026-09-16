/**
 * The Cost Meter (`CMP-09`). Mirrors `docs/02-architecture.md` section 7
 * (TASK-041, FR-103, FR-109, ASM-011).
 *
 * Three jobs and no others: count what was actually consumed, turn that into a
 * dollar estimate from the shipped price table, and warn once per threshold per
 * session. It holds usage in memory and hands it to the Session Manager, which
 * is the only writer of a session file (ADR-018). Nothing here stops a session:
 * a cost ceiling that ends an interview mid-answer is worse than the overspend
 * it prevents (`FR-103`).
 *
 * Pure apart from the injected clock and timer, so every rule below is testable
 * without Electron, without a provider and without waiting a real minute.
 */
import type { ProviderChoice, TranscriptSource, UsageRecord } from '../shared/types.js';
import type { TokenUsage } from './ai/llm.js';
import priceTable from './pricing.json';

/** `CH-204` cadence. `FR-103` wants the timer and the estimate live at all times. */
export const USAGE_TICK_MS = 1000;

/**
 * Dollars are rounded to this many decimals before being reported *or*
 * compared against the threshold.
 *
 * Both, not one: an unrounded comparison against a rounded display can warn at
 * a number the Dashboard is not showing yet. Six decimals is far below a cent
 * and far above the float noise that summing per-model costs produces.
 */
const USD_DECIMALS = 6;

/** One language model's price, per million tokens (ASM-011). */
export interface LlmPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

/** One transcription model's price, per minute of audio (ASM-011). */
export interface SttPrice {
  perAudioMinute: number;
}

/**
 * The shipped price table. Keyed `providerId:modelId` in both blocks, so a new
 * registry entry needs a price row and nothing else, and two providers shipping
 * a model of the same name stay distinct (TC-156).
 */
export interface PriceTable {
  version: string;
  llm: Record<string, LlmPrice>;
  stt: Record<string, SttPrice>;
}

/** The table bundled with the app. Never fetched at runtime (ASM-011). */
export const PRICE_TABLE: PriceTable = priceTable as PriceTable;

/** The price-table key for a choice. A join, not a branch on a provider id (ADR-022). */
export function priceKey(choice: ProviderChoice): string {
  return `${choice.providerId}:${choice.modelId}`;
}

/** The two thresholds the user sets in the Dashboard (`FR-031`). */
export interface Thresholds {
  costUsd: number;
  timeMinutes: number;
}

/** `CH-205`. One per kind per session, upward only (`FR-109`). */
export interface UsageWarning {
  kind: 'cost' | 'time';
  /** The value that crossed: dollars for `cost`, minutes for `time`. */
  value: number;
  threshold: number;
}

/** `CH-204`'s payload: the record plus the running timer (`FR-103`). */
export interface UsageSnapshot extends UsageRecord {
  elapsedSeconds: number;
}

/** The meter's wiring. Everything time-related is injected (`FR-103`). */
export interface CostMeterOptions {
  thresholds: Thresholds;
  /** `CH-204`, and the hand-over to the Session Manager (ADR-018). */
  onUsage: (snapshot: UsageSnapshot) => void;
  /** `CH-205`. Called at most once per kind per session. */
  onWarning: (warning: UsageWarning) => void;
  pricing?: PriceTable;
  /**
   * Injected so a whole session's timer can pass in a millisecond. The default
   * is monotonic, not wall clock: a clock adjustment mid-interview must not
   * move the session timer, which would fire the time warning early and can
   * never be taken back (`FR-109`).
   */
  now?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  tickMs?: number;
}

/**
 * Accounting for one session.
 *
 * Audio seconds and tokens are accumulated **per model**, not as one total,
 * because a failover mid-session moves the stream to a model at a different
 * price and a total recomputed at the end would bill every second of the
 * session at the last model's rate.
 */
export class CostMeter {
  private readonly pricing: PriceTable;
  private readonly now: () => number;
  private readonly setIntervalFn: (fn: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private readonly tickMs: number;
  private readonly onUsage: (snapshot: UsageSnapshot) => void;
  private readonly onWarning: (warning: UsageWarning) => void;

  private thresholds: Thresholds;

  private startedAtMs: number | null = null;
  private stoppedAtMs: number | null = null;
  private timer: unknown = null;

  /** Audio seconds by price key, and the per-stream totals the record reports. */
  private readonly sttSeconds = new Map<string, number>();
  private streamSeconds = { interviewer: 0, candidate: 0 };

  /**
   * Tokens by **generation id**, not by model.
   *
   * Keyed that way because one generation can report usage more than once: a
   * provider that sends an interim usage frame and then a terminal one, and a
   * generation that is cancelled after an interim frame and whose outcome
   * carries the smaller figure the provider actually settled on. Summed by id,
   * the second report would be added to the first and the session would bill
   * the same tokens twice; replaced by id, a cancellation lowers the estimate,
   * which is the case `FR-109` exists for.
   */
  private readonly llmTokens = new Map<string, { key: string; input: number; output: number }>();

  /** Which thresholds have fired. Append-only for the life of the session. */
  private readonly warned: ('cost' | 'time')[] = [];

  constructor(options: CostMeterOptions) {
    this.pricing = options.pricing ?? PRICE_TABLE;
    this.now = options.now ?? (() => performance.now());
    this.setIntervalFn = options.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn = options.clearIntervalFn ?? ((h) => clearInterval(h as NodeJS.Timeout));
    this.tickMs = options.tickMs ?? USAGE_TICK_MS;
    this.onUsage = options.onUsage;
    this.onWarning = options.onWarning;
    this.thresholds = { ...options.thresholds };
  }

  /** True between `start` and `stop`. */
  get isRunning(): boolean {
    return this.startedAtMs !== null && this.stoppedAtMs === null;
  }

  /** The version the Dashboard shows next to the estimate (ASM-011). */
  get priceTableVersion(): string {
    return this.pricing.version;
  }

  /**
   * Begin accounting for a new session.
   *
   * Every accumulator and every warning resets here, so "once per session"
   * means this session and not since launch. Starting an already-running meter
   * is a bug in the caller, not a silent restart that would throw away the
   * running session's spend.
   */
  start(): void {
    if (this.isRunning) throw new Error('the cost meter is already running');
    this.startedAtMs = this.now();
    this.stoppedAtMs = null;
    this.sttSeconds.clear();
    this.llmTokens.clear();
    this.streamSeconds = { interviewer: 0, candidate: 0 };
    this.warned.length = 0;
    this.timer = this.setIntervalFn(() => this.tick(), this.tickMs);
    // Pushed immediately as well as on the interval, so the Dashboard shows a
    // zeroed timer at 0 s rather than an empty panel for the first second.
    this.emit();
  }

  /**
   * End accounting and return the final record for the Session Manager.
   *
   * Returns the record rather than writing it: this component holds no file
   * handle and knows no path (ADR-018).
   */
  stop(): UsageRecord {
    if (this.timer !== null) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
    const wasRunning = this.isRunning;
    if (wasRunning) this.stoppedAtMs = this.now();
    // One last push, so the final figures the Dashboard shows are the figures
    // that went into the transcript. Without it the panel froze on the previous
    // tick and disagreed with the saved session by up to a second of spend.
    if (wasRunning) this.emit();
    return this.record();
  }

  /**
   * Replace the thresholds mid-session, when the user edits them in Settings.
   *
   * A threshold that has already warned stays warned even if it is raised above
   * the current estimate: `FR-109` says a fired threshold never re-arms for the
   * session, and re-arming would let a user produce a second warning by nudging
   * the number up and back.
   */
  setThresholds(thresholds: Thresholds): void {
    this.thresholds = { ...thresholds };
    this.check();
  }

  /**
   * Audio consumed by one STT stream, priced at the model that transcribed it.
   *
   * Seconds come from the audio actually sent to a provider, not from wall
   * clock: a stream that is down bills nothing while the session timer runs on.
   */
  noteAudio(source: TranscriptSource, choice: ProviderChoice, seconds: number): void {
    if (!(seconds > 0)) return;
    const key = priceKey(choice);
    this.sttSeconds.set(key, (this.sttSeconds.get(key) ?? 0) + seconds);
    this.streamSeconds[source] += seconds;
    this.check();
  }

  /**
   * What one generation cost, taken from the provider's own usage record.
   *
   * There is no local estimate here and no token counter of our own. A provider
   * that reports usage is the authority on what it charged for; a count we
   * invented would disagree with the invoice and be believed anyway (ASM-011).
   * The consequence is that a generation cancelled before the provider reported
   * anything accounts zero tokens, which understates spend. That is the honest
   * answer: the alternative is a guessed number the Dashboard would present as
   * a measurement.
   *
   * Calling this twice for one `generationId` **replaces** rather than adds, so
   * a settled figure lower than an interim one lowers the estimate instead of
   * being billed on top of it.
   */
  noteGeneration(generationId: string, choice: ProviderChoice, usage: TokenUsage): void {
    this.llmTokens.set(generationId, {
      key: priceKey(choice),
      input: Math.max(usage.inputTokens, 0),
      output: Math.max(usage.outputTokens, 0),
    });
    this.check();
  }

  /** Whole seconds since `start`, frozen at `stop`. Zero before starting. */
  get elapsedSeconds(): number {
    if (this.startedAtMs === null) return 0;
    const end = this.stoppedAtMs ?? this.now();
    return Math.max(Math.floor((end - this.startedAtMs) / 1000), 0);
  }

  /** The record the Session Manager persists (`FR-106`). */
  record(): UsageRecord {
    const { usd, incomplete } = this.estimate();
    return {
      sttAudioSeconds: { ...this.streamSeconds },
      llmInputTokens: sum(this.llmTokens, 'input'),
      llmOutputTokens: sum(this.llmTokens, 'output'),
      estimatedUsd: usd,
      priceTableVersion: this.pricing.version,
      estimateIncomplete: incomplete,
      warningsIssued: [...this.warned],
    };
  }

  /** The record plus the timer. `CH-204`'s payload (`FR-103`). */
  snapshot(): UsageSnapshot {
    return { ...this.record(), elapsedSeconds: this.elapsedSeconds };
  }

  /**
   * `estimatedUsd`, and whether a price row was missing.
   *
   * A model with no row contributes zero dollars and sets the flag, rather than
   * contributing a guessed rate: a number that silently understates spend is
   * worse than a number labelled incomplete. `TC-156` fails the build on a
   * registry model with no row, so this path should be unreachable in a shipped
   * build; it exists because "should be unreachable" is not "is".
   */
  private estimate(): { usd: number; incomplete: boolean } {
    let usd = 0;
    let incomplete = false;

    for (const [key, seconds] of this.sttSeconds) {
      const row = this.pricing.stt[key];
      if (!row) {
        incomplete = true;
        continue;
      }
      usd += (seconds / 60) * row.perAudioMinute;
    }

    for (const tokens of this.llmTokens.values()) {
      const row = this.pricing.llm[tokens.key];
      if (!row) {
        incomplete = true;
        continue;
      }
      usd += (tokens.input / 1_000_000) * row.inputPerMTok;
      usd += (tokens.output / 1_000_000) * row.outputPerMTok;
    }

    return { usd: round(usd, USD_DECIMALS), incomplete };
  }

  /** The interval body: push `CH-204` and re-check the time threshold. */
  private tick(): void {
    if (!this.isRunning) return;
    this.check();
    this.emit();
  }

  private emit(): void {
    this.onUsage(this.snapshot());
  }

  /**
   * Edge-triggered, upward, once (`FR-109`).
   *
   * The guard is membership in `warned`, never a comparison against the
   * previous value. A cancelled generation can lower the estimate, and a
   * re-arming meter would warn again the moment it climbed back over a
   * threshold it had already reported. A threshold of zero or less is "not
   * set": it would otherwise fire on the first tick of every session.
   */
  private check(): void {
    if (!this.isRunning) return;

    const { usd } = this.estimate();
    if (
      !this.warned.includes('cost') &&
      this.thresholds.costUsd > 0 &&
      usd >= this.thresholds.costUsd
    ) {
      this.warned.push('cost');
      this.onWarning({ kind: 'cost', value: usd, threshold: this.thresholds.costUsd });
    }

    const minutes = this.elapsedSeconds / 60;
    if (
      !this.warned.includes('time') &&
      this.thresholds.timeMinutes > 0 &&
      minutes >= this.thresholds.timeMinutes
    ) {
      this.warned.push('time');
      this.onWarning({ kind: 'time', value: minutes, threshold: this.thresholds.timeMinutes });
    }
  }
}

function sum(
  tokens: Map<string, { input: number; output: number }>,
  field: 'input' | 'output',
): number {
  let total = 0;
  for (const entry of tokens.values()) total += entry[field];
  return total;
}

/** Kills the float noise of summing per-model costs, without losing sub-cent detail. */
function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
