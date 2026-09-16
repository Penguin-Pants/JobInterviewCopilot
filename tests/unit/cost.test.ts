/**
 * TASK-041. The Cost Meter (`CMP-09`) as a pure unit.
 *
 * Clock and interval are injected, so a sixty-minute session and a threshold
 * crossing both happen inside one synchronous test. Covers TC-108's accounting
 * half, TC-109's "never stopped" half and all of TC-145.
 */
import { describe, expect, it } from 'vitest';
import {
  CostMeter,
  PRICE_TABLE,
  USAGE_TICK_MS,
  priceKey,
  type PriceTable,
  type UsageSnapshot,
  type UsageWarning,
} from '../../src/main/cost.js';
import { pushChannels } from '../../src/shared/ipc.js';

const HAIKU = { providerId: 'anthropic', modelId: 'claude-haiku-4-5-20251001' };
const GPT = { providerId: 'openai', modelId: 'gpt-4o-mini' };
const NOVA = { providerId: 'deepgram', modelId: 'nova-3' };
const SCRIBE = { providerId: 'elevenlabs', modelId: 'scribe-v2-realtime' };

const PRICING: PriceTable = {
  version: 'test-1',
  llm: {
    'anthropic:claude-haiku-4-5-20251001': { inputPerMTok: 1.0, outputPerMTok: 5.0 },
    'openai:gpt-4o-mini': { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  },
  stt: {
    'deepgram:nova-3': { perAudioMinute: 0.0043 },
    'elevenlabs:scribe-v2-realtime': { perAudioMinute: 0.0067 },
  },
};

/**
 * A meter with a hand-driven clock and a hand-driven interval.
 *
 * `advance` moves the clock and then runs the interval body as many times as
 * the elapsed milliseconds allow, which is what a real interval would have
 * done, so the tick count in a test is the count the Dashboard would see.
 */
function meter(over: Partial<ConstructorParameters<typeof CostMeter>[0]> = {}): {
  cost: CostMeter;
  advance: (ms: number) => void;
  usages: UsageSnapshot[];
  warnings: UsageWarning[];
  cleared: () => number;
} {
  let clock = 1_000_000;
  let body: (() => void) | null = null;
  let tick = USAGE_TICK_MS;
  let clears = 0;
  const usages: UsageSnapshot[] = [];
  const warnings: UsageWarning[] = [];

  const cost = new CostMeter({
    thresholds: { costUsd: 0, timeMinutes: 0 },
    pricing: PRICING,
    onUsage: (u) => usages.push(u),
    onWarning: (w) => warnings.push(w),
    now: () => clock,
    setIntervalFn: (fn, ms) => {
      body = fn;
      tick = ms;
      return 'handle';
    },
    clearIntervalFn: () => {
      clears += 1;
      body = null;
    },
    ...over,
  });

  return {
    cost,
    usages,
    warnings,
    cleared: () => clears,
    advance: (ms: number) => {
      const ticks = Math.floor(ms / tick);
      for (let i = 0; i < ticks; i += 1) {
        clock += tick;
        body?.();
      }
      const remainder = ms - ticks * tick;
      if (remainder > 0) clock += remainder;
    },
  };
}

describe('CH-204 carries the whole record', () => {
  it('survives the push schema, incomplete flag and all', () => {
    const spec = pushChannels['state:usage'];
    const { cost } = meter();
    cost.start();
    cost.noteGeneration(
      'gen-1',
      { providerId: 'openai', modelId: 'unpriced' },
      {
        inputTokens: 10,
        outputTokens: 1,
      },
    );

    const parsed = spec.payload.safeParse(cost.snapshot());
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(cost.snapshot());
  });
});

describe('the shipped price table', () => {
  it('is bundled, not fetched, and carries a version (ASM-011)', () => {
    expect(PRICE_TABLE.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(PRICE_TABLE.llm).length).toBeGreaterThan(0);
    expect(Object.keys(PRICE_TABLE.stt).length).toBeGreaterThan(0);
  });

  it('keys both blocks by providerId:modelId, so two providers can ship one name', () => {
    for (const key of [...Object.keys(PRICE_TABLE.llm), ...Object.keys(PRICE_TABLE.stt)]) {
      expect(key).toMatch(/^[a-z0-9-]+:.+$/);
    }
    expect(priceKey(HAIKU)).toBe('anthropic:claude-haiku-4-5-20251001');
  });
});

describe('accounting (TC-108)', () => {
  it('reports the price table version it priced with', () => {
    const { cost } = meter();
    expect(cost.priceTableVersion).toBe('test-1');
    cost.start();
    expect(cost.record().priceTableVersion).toBe('test-1');
  });

  it('takes token counts from the provider usage fields, never from an estimate', () => {
    const { cost } = meter();
    cost.start();
    cost.noteGeneration('g1', HAIKU, { inputTokens: 1200, outputTokens: 180 });
    cost.noteGeneration('g2', HAIKU, { inputTokens: 900, outputTokens: 150 });

    const record = cost.record();
    expect(record.llmInputTokens).toBe(2100);
    expect(record.llmOutputTokens).toBe(330);
  });

  it('matches a hand-computed estimate across both meters', () => {
    const { cost } = meter();
    cost.start();
    // 1_000_000 input at $1.00/MTok = $1.00; 200_000 output at $5.00/MTok = $1.00
    cost.noteGeneration('g3', HAIKU, { inputTokens: 1_000_000, outputTokens: 200_000 });
    // 600 s = 10 min at $0.0043/min = $0.043
    cost.noteAudio('interviewer', NOVA, 600);
    // 120 s = 2 min at $0.0043/min = $0.0086
    cost.noteAudio('candidate', NOVA, 120);

    expect(cost.record().estimatedUsd).toBe(2.0516);
  });

  it('accumulates audio seconds per stream', () => {
    const { cost } = meter();
    cost.start();
    cost.noteAudio('interviewer', NOVA, 30);
    cost.noteAudio('interviewer', NOVA, 15.5);
    cost.noteAudio('candidate', NOVA, 4);

    expect(cost.record().sttAudioSeconds).toEqual({ interviewer: 45.5, candidate: 4 });
  });

  it('prices each model at its own rate when the session fails over', () => {
    const { cost } = meter();
    cost.start();
    // 60 s on Nova, then 60 s on Scribe. A total recomputed at the end would
    // bill all 120 s at whichever model happened to be last.
    cost.noteAudio('interviewer', NOVA, 60);
    cost.noteAudio('interviewer', SCRIBE, 60);

    expect(cost.record().estimatedUsd).toBe(0.011);
    expect(cost.record().sttAudioSeconds.interviewer).toBe(120);
  });

  it('prices two language models separately in one session', () => {
    const { cost } = meter();
    cost.start();
    cost.noteGeneration('g4', HAIKU, { inputTokens: 1_000_000, outputTokens: 0 });
    cost.noteGeneration('g5', GPT, { inputTokens: 1_000_000, outputTokens: 0 });

    expect(cost.record().estimatedUsd).toBe(1.15);
    expect(cost.record().llmInputTokens).toBe(2_000_000);
  });

  it('ignores a zero or negative audio duration rather than crediting it back', () => {
    const { cost } = meter();
    cost.start();
    cost.noteAudio('interviewer', NOVA, 60);
    cost.noteAudio('interviewer', NOVA, 0);
    cost.noteAudio('interviewer', NOVA, -600);

    expect(cost.record().sttAudioSeconds.interviewer).toBe(60);
    expect(cost.record().estimatedUsd).toBe(0.0043);
  });

  it('counts a model with no price row and labels the estimate incomplete', () => {
    const { cost } = meter();
    cost.start();
    cost.noteGeneration(
      'g6',
      { providerId: 'openai', modelId: 'unpriced' },
      {
        inputTokens: 5000,
        outputTokens: 500,
      },
    );
    cost.noteAudio('interviewer', NOVA, 60);

    const record = cost.record();
    // The tokens are still counted, and the dollars it contributes are zero
    // rather than guessed.
    expect(record.llmInputTokens).toBe(5000);
    expect(record.estimatedUsd).toBe(0.0043);
    expect(record.estimateIncomplete).toBe(true);
  });

  it('refuses a non-finite token count instead of poisoning the estimate', () => {
    // An adapter casts provider JSON onto TokenUsage without validating it, so
    // a value like 1e400 arrives as Infinity. Kept, it makes estimatedUsd
    // non-finite, which CH-204's schema rejects and which JSON.stringify writes
    // into the session file as null, and that file then fails sessionSchema on
    // read: one bad frame would cost the user the whole interview.
    for (const bad of [Infinity, -Infinity, NaN]) {
      const { cost } = meter();
      cost.start();
      cost.noteGeneration('gen-1', HAIKU, { inputTokens: 1000, outputTokens: 50 });
      cost.noteGeneration('gen-2', HAIKU, { inputTokens: bad, outputTokens: 10 });

      const record = cost.record();
      expect(Number.isFinite(record.estimatedUsd)).toBe(true);
      expect(Number.isFinite(record.llmInputTokens)).toBe(true);
      expect(Number.isFinite(record.llmOutputTokens)).toBe(true);
      // The good generation is still accounted, and the refusal is visible.
      expect(record.llmInputTokens).toBe(1000);
      expect(record.estimateIncomplete).toBe(true);
    }
  });

  it('refuses a non-finite audio duration the same way', () => {
    const { cost } = meter();
    cost.start();
    cost.noteAudio('interviewer', NOVA, 60);
    cost.noteAudio('interviewer', NOVA, Infinity);
    cost.noteAudio('candidate', NOVA, NaN);

    const record = cost.record();
    expect(record.sttAudioSeconds).toEqual({ interviewer: 60, candidate: 0 });
    expect(Number.isFinite(record.estimatedUsd)).toBe(true);
    expect(record.estimateIncomplete).toBe(true);
  });

  it('a refused report never reaches the CH-204 schema as a non-finite number', () => {
    const { cost } = meter();
    cost.start();
    cost.noteGeneration('gen-1', HAIKU, { inputTokens: Infinity, outputTokens: NaN });
    expect(pushChannels['state:usage'].payload.safeParse(cost.snapshot()).success).toBe(true);
  });

  it('is complete when every model consumed has a row', () => {
    const { cost } = meter();
    cost.start();
    cost.noteAudio('interviewer', NOVA, 60);
    cost.noteGeneration('g7', GPT, { inputTokens: 100, outputTokens: 10 });
    expect(cost.record().estimateIncomplete).toBe(false);
  });
});

describe('the running timer and CH-204 (FR-103)', () => {
  it('pushes a zeroed snapshot at start rather than an empty panel', () => {
    const { cost, usages } = meter();
    cost.start();
    expect(usages).toHaveLength(1);
    expect(usages[0]?.elapsedSeconds).toBe(0);
    expect(usages[0]?.estimatedUsd).toBe(0);
  });

  it('updates at least once per second', () => {
    const { cost, usages, advance } = meter();
    cost.start();
    advance(10_000);
    // One at start, then one per second.
    expect(usages).toHaveLength(11);
    expect(usages.at(-1)?.elapsedSeconds).toBe(10);
  });

  it('freezes the timer at stop and clears the interval', () => {
    const { cost, usages, advance, cleared } = meter();
    cost.start();
    advance(5000);
    const final = cost.stop();
    const after = usages.length;

    advance(60_000);
    expect(cost.elapsedSeconds).toBe(5);
    expect(usages).toHaveLength(after);
    expect(cleared()).toBe(1);
    expect(final.estimatedUsd).toBe(0);
  });

  it('pushes one last snapshot at stop, matching the record it returns', () => {
    const { cost, usages, advance } = meter();
    cost.start();
    cost.noteGeneration('gen-1', HAIKU, { inputTokens: 1_000_000, outputTokens: 0 });
    advance(3000);
    const beforeStop = usages.length;

    const final = cost.stop();
    expect(usages).toHaveLength(beforeStop + 1);
    const { elapsedSeconds, ...pushed } = usages.at(-1) as UsageSnapshot;
    expect(pushed).toEqual(final);
    expect(elapsedSeconds).toBe(3);
  });

  it('pushes nothing when a meter that never ran is stopped', () => {
    const { cost, usages } = meter();
    cost.stop();
    expect(usages).toHaveLength(0);
  });

  it('reads zero before a session starts', () => {
    const { cost } = meter();
    expect(cost.elapsedSeconds).toBe(0);
    expect(cost.isRunning).toBe(false);
  });

  it('refuses to restart over a running session instead of discarding its spend', () => {
    const { cost } = meter();
    cost.start();
    cost.noteGeneration('g8', HAIKU, { inputTokens: 1000, outputTokens: 100 });
    expect(() => cost.start()).toThrow(/already running/);
    expect(cost.record().llmInputTokens).toBe(1000);
  });

  it('clears every accumulator and every warning for the next session', () => {
    const { cost, warnings } = meter({ thresholds: { costUsd: 1, timeMinutes: 0 } });
    cost.start();
    cost.noteGeneration('g9', HAIKU, { inputTokens: 2_000_000, outputTokens: 0 });
    expect(warnings).toHaveLength(1);
    cost.stop();

    cost.start();
    const record = cost.record();
    expect(record.llmInputTokens).toBe(0);
    expect(record.sttAudioSeconds).toEqual({ interviewer: 0, candidate: 0 });
    expect(record.warningsIssued).toEqual([]);

    // "Once per session" means this session, not since launch.
    cost.noteGeneration('g10', HAIKU, { inputTokens: 2_000_000, outputTokens: 0 });
    expect(warnings).toHaveLength(2);
  });
});

describe('threshold warnings (TC-109, TC-145)', () => {
  it('warns exactly once when the cost threshold is crossed', () => {
    const { cost, warnings } = meter({ thresholds: { costUsd: 1, timeMinutes: 0 } });
    cost.start();
    cost.noteGeneration('g11', HAIKU, { inputTokens: 1_100_000, outputTokens: 0 });
    cost.noteGeneration('g12', HAIKU, { inputTokens: 1_100_000, outputTokens: 0 });

    expect(warnings).toEqual([{ kind: 'cost', value: 1.1, threshold: 1 }]);
    expect(cost.record().warningsIssued).toEqual(['cost']);
  });

  it('warns exactly once when the time threshold is crossed', () => {
    const { cost, warnings, advance } = meter({ thresholds: { costUsd: 0, timeMinutes: 1 } });
    cost.start();
    advance(59_000);
    expect(warnings).toHaveLength(0);
    advance(1000);
    expect(warnings).toEqual([{ kind: 'time', value: 1, threshold: 1 }]);
    advance(600_000);
    expect(warnings).toHaveLength(1);
  });

  it("replaces a generation's usage rather than adding to it", () => {
    const { cost } = meter();
    cost.start();
    // An interim usage frame, then the terminal one for the same generation.
    cost.noteGeneration('gen-1', HAIKU, { inputTokens: 1000, outputTokens: 40 });
    cost.noteGeneration('gen-1', HAIKU, { inputTokens: 1000, outputTokens: 180 });

    const record = cost.record();
    expect(record.llmInputTokens).toBe(1000);
    expect(record.llmOutputTokens).toBe(180);
  });

  it('does not re-warn when a cancelled generation lowers the estimate (FR-109, TC-145)', () => {
    const { cost, warnings } = meter({ thresholds: { costUsd: 1, timeMinutes: 0 } });
    cost.start();

    // An interim usage frame takes the session over the threshold, and it warns.
    cost.noteGeneration('gen-1', HAIKU, { inputTokens: 1_200_000, outputTokens: 0 });
    expect(warnings).toHaveLength(1);
    expect(cost.record().estimatedUsd).toBe(1.2);

    // The generation is cancelled. What the provider actually settled on is
    // lower, so the estimate falls back under the threshold.
    cost.noteGeneration('gen-1', HAIKU, { inputTokens: 400_000, outputTokens: 0 });
    expect(cost.record().estimatedUsd).toBe(0.4);

    // The replacement generation takes it back over. The threshold does not
    // re-arm, so this is silent.
    cost.noteGeneration('gen-2', HAIKU, { inputTokens: 2_000_000, outputTokens: 0 });
    expect(cost.record().estimatedUsd).toBe(2.4);
    expect(warnings).toHaveLength(1);
    expect(cost.record().warningsIssued).toEqual(['cost']);
  });

  it('keeps a fired threshold fired when the user raises it and it is crossed again', () => {
    const { cost, warnings } = meter({ thresholds: { costUsd: 1, timeMinutes: 0 } });
    cost.start();
    cost.noteGeneration('g13', HAIKU, { inputTokens: 1_500_000, outputTokens: 0 });
    expect(warnings).toHaveLength(1);

    // Raise it above the estimate, then cross it again.
    cost.setThresholds({ costUsd: 5, timeMinutes: 0 });
    cost.noteGeneration('g14', HAIKU, { inputTokens: 5_000_000, outputTokens: 0 });
    expect(warnings).toHaveLength(1);
    expect(cost.record().warningsIssued).toEqual(['cost']);
  });

  it('warns on each threshold independently', () => {
    const { cost, warnings, advance } = meter({ thresholds: { costUsd: 1, timeMinutes: 1 } });
    cost.start();
    cost.noteGeneration('g15', HAIKU, { inputTokens: 1_000_000, outputTokens: 0 });
    advance(60_000);

    expect(warnings.map((w) => w.kind)).toEqual(['cost', 'time']);
    expect(cost.record().warningsIssued).toEqual(['cost', 'time']);
  });

  it('catches a crossing that stop reaches before the next tick does', () => {
    // The interval callback can be delayed. Without a check at stop, a session
    // ended just past its threshold crosses with no tick left to notice, and
    // the crossing is missing from CH-205 and from the saved record alike.
    const { cost, warnings, advance } = meter({ thresholds: { costUsd: 0, timeMinutes: 1 } });
    cost.start();
    advance(59_000);
    expect(warnings).toHaveLength(0);

    // 1.5 s of wall clock with no interval callback at all.
    advance(500);
    advance(500);
    advance(500);
    const final = cost.stop();

    expect(warnings).toEqual([{ kind: 'time', value: 1, threshold: 1 }]);
    expect(final.warningsIssued).toEqual(['time']);
  });

  it('warns when the user lowers a threshold below what is already spent', () => {
    // FR-109's upward edge is the estimate's. A limit set below current spend
    // that never warns is a limit that is silently dead for the session.
    const { cost, warnings } = meter({ thresholds: { costUsd: 10, timeMinutes: 0 } });
    cost.start();
    cost.noteGeneration('gen-1', HAIKU, { inputTokens: 5_000_000, outputTokens: 0 });
    expect(warnings).toHaveLength(0);

    cost.setThresholds({ costUsd: 3, timeMinutes: 0 });
    expect(warnings).toEqual([{ kind: 'cost', value: 5, threshold: 3 }]);

    // Still exactly once: lowering it again says nothing more.
    cost.setThresholds({ costUsd: 1, timeMinutes: 0 });
    expect(warnings).toHaveLength(1);
  });

  it('treats a threshold of zero or less as not set', () => {
    const { cost, warnings, advance } = meter({ thresholds: { costUsd: 0, timeMinutes: -1 } });
    cost.start();
    cost.noteGeneration('g16', HAIKU, { inputTokens: 50_000_000, outputTokens: 0 });
    advance(3_600_000);
    expect(warnings).toHaveLength(0);
  });

  it('warns at the threshold, not only past it', () => {
    const { cost, warnings } = meter({ thresholds: { costUsd: 1, timeMinutes: 0 } });
    cost.start();
    cost.noteGeneration('g17', HAIKU, { inputTokens: 1_000_000, outputTokens: 0 });
    expect(warnings).toEqual([{ kind: 'cost', value: 1, threshold: 1 }]);
  });

  it('warns on the value it is about to display, not on an unrounded one', () => {
    const { cost, warnings, usages, advance } = meter({
      thresholds: { costUsd: 1, timeMinutes: 0 },
    });
    cost.start();
    cost.noteGeneration('g18', HAIKU, { inputTokens: 1_000_000, outputTokens: 0 });
    advance(USAGE_TICK_MS);
    expect(warnings[0]?.value).toBe(usages.at(-1)?.estimatedUsd ?? -1);
  });

  it('does not warn before the session starts or after it stops', () => {
    const { cost, warnings, advance } = meter({ thresholds: { costUsd: 1, timeMinutes: 1 } });
    cost.setThresholds({ costUsd: 0.000001, timeMinutes: 0.0001 });
    expect(warnings).toHaveLength(0);

    cost.start();
    cost.stop();
    advance(600_000);
    cost.noteGeneration('g19', HAIKU, { inputTokens: 50_000_000, outputTokens: 0 });
    expect(warnings).toHaveLength(0);
  });

  it('never stops the session: a crossed threshold leaves the meter running', () => {
    const { cost, advance, usages } = meter({ thresholds: { costUsd: 0.01, timeMinutes: 1 } });
    cost.start();
    cost.noteGeneration('g20', HAIKU, { inputTokens: 10_000_000, outputTokens: 10_000_000 });
    advance(600_000);

    expect(cost.isRunning).toBe(true);
    expect(usages.at(-1)?.elapsedSeconds).toBe(600);
  });
});
