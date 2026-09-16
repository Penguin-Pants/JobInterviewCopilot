/**
 * TASK-041. The Cost Meter joined to the Session Manager.
 *
 * `CMP-09` holds usage in memory and `CMP-08` writes it (ADR-018). The unit
 * tests prove the arithmetic; this proves the hand-over, which is the part that
 * has a file on the other end of it. Covers TC-108's persistence half and
 * TC-109's "never stopped by the meter" half.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '../../src/shared/types.js';
import {
  CostMeter,
  type PriceTable,
  type UsageSnapshot,
  type UsageWarning,
} from '../../src/main/cost.js';
import { SessionManager, readSession } from '../../src/main/session.js';

const PROFILE = { id: 'p1', name: 'Acme' };
const HAIKU = { providerId: 'anthropic', modelId: 'claude-haiku-4-5-20251001' };
const NOVA = { providerId: 'deepgram', modelId: 'nova-3' };

const PRICING: PriceTable = {
  version: '2026-09-15',
  llm: { 'anthropic:claude-haiku-4-5-20251001': { inputPerMTok: 1.0, outputPerMTok: 5.0 } },
  stt: { 'deepgram:nova-3': { perAudioMinute: 0.0043 } },
};

let userData: string;

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'icp-cost-'));
});

afterEach(() => {
  rmSync(userData, { recursive: true, force: true });
});

/**
 * The bootstrap wiring, in miniature: one callback both hands usage to the
 * manager and pushes `CH-204`, so the number on screen and the number in the
 * transcript cannot diverge.
 */
function harness() {
  const sessions = new SessionManager({ userDataDir: userData, newSessionId: () => 's1' });
  const pushes: UsageSnapshot[] = [];
  const warnings: UsageWarning[] = [];
  let clock = 1_000_000;
  let body: (() => void) | null = null;

  const cost = new CostMeter({
    thresholds: { costUsd: 1, timeMinutes: 30 },
    pricing: PRICING,
    now: () => clock,
    setIntervalFn: (fn) => {
      body = fn;
      return 'handle';
    },
    clearIntervalFn: () => {
      body = null;
    },
    onUsage: (snapshot) => {
      const { elapsedSeconds, ...record } = snapshot;
      sessions.noteUsage(record);
      pushes.push({ ...record, elapsedSeconds });
    },
    onWarning: (warning) => warnings.push(warning),
  });

  return {
    sessions,
    cost,
    pushes,
    warnings,
    tick: (seconds: number) => {
      for (let i = 0; i < seconds; i += 1) {
        clock += 1000;
        body?.();
      }
    },
  };
}

async function read(): Promise<Session | null> {
  return readSession(userData, PROFILE.id, 's1');
}

describe('TC-108 usage reaches the transcript', () => {
  it('writes the record the meter accounted, with the price table version', async () => {
    const { sessions, cost, tick } = harness();
    await sessions.start({ profile: PROFILE, sttKeyPresent: true, llmKeyPresent: true });
    cost.start();

    cost.noteAudio('interviewer', NOVA, 600);
    cost.noteAudio('candidate', NOVA, 120);
    cost.noteGeneration('gen-1', HAIKU, { inputTokens: 1_000_000, outputTokens: 200_000 });
    tick(5);

    sessions.noteUsage(cost.stop());
    await sessions.stop();

    const session = await read();
    expect(session?.usage).toEqual({
      sttAudioSeconds: { interviewer: 600, candidate: 120 },
      llmInputTokens: 1_000_000,
      llmOutputTokens: 200_000,
      estimatedUsd: 2.0516,
      priceTableVersion: '2026-09-15',
      estimateIncomplete: false,
      warningsIssued: ['cost'],
    });
  });

  it('pushes CH-204 at least once per second while the session runs', async () => {
    const { sessions, cost, pushes, tick } = harness();
    await sessions.start({ profile: PROFILE, sttKeyPresent: true, llmKeyPresent: true });
    cost.start();
    tick(10);

    // One at start, then one per second.
    expect(pushes).toHaveLength(11);
    expect(pushes.at(-1)?.elapsedSeconds).toBe(10);

    sessions.noteUsage(cost.stop());
    await sessions.stop();
  });

  it('the pushed snapshot and the persisted record carry the same numbers', async () => {
    const { sessions, cost, pushes, tick } = harness();
    await sessions.start({ profile: PROFILE, sttKeyPresent: true, llmKeyPresent: true });
    cost.start();
    cost.noteGeneration('gen-1', HAIKU, { inputTokens: 250_000, outputTokens: 10_000 });
    tick(3);

    const last = pushes.at(-1);
    sessions.noteUsage(cost.stop());
    await sessions.stop();

    const session = await read();
    const { elapsedSeconds, ...record } = last ?? ({} as UsageSnapshot);
    expect(elapsedSeconds).toBe(3);
    expect(session?.usage).toEqual(record);
  });

  it('a session that ran with no usage still writes a zeroed record', async () => {
    const { sessions, cost } = harness();
    await sessions.start({ profile: PROFILE, sttKeyPresent: true, llmKeyPresent: true });
    cost.start();
    sessions.noteUsage(cost.stop());
    await sessions.stop();

    const session = await read();
    expect(session?.usage.estimatedUsd).toBe(0);
    expect(session?.usage.priceTableVersion).toBe('2026-09-15');
    expect(session?.usage.warningsIssued).toEqual([]);
  });
});

describe('TC-109 warnings never stop the session', () => {
  it('crosses both thresholds and leaves the session running', async () => {
    const { sessions, cost, warnings, tick } = harness();
    const active = await sessions.start({
      profile: PROFILE,
      sttKeyPresent: true,
      llmKeyPresent: true,
    });
    cost.start();

    cost.noteGeneration('gen-1', HAIKU, { inputTokens: 5_000_000, outputTokens: 0 });
    tick(1800);

    expect(warnings.map((w) => w.kind)).toEqual(['cost', 'time']);
    // Still live, still writable, still the same session.
    expect(sessions.isActive).toBe(true);
    expect(sessions.current?.id).toBe(active.id);
    await sessions.appendTurn('interviewer', 'still going');

    sessions.noteUsage(cost.stop());
    await sessions.stop();

    const session = await read();
    expect(session?.endReason).toBe('user');
    expect(session?.entries).toHaveLength(1);
    expect(session?.usage.warningsIssued).toEqual(['cost', 'time']);
  });

  it('warns once per threshold however long the session runs past it', async () => {
    const { sessions, cost, warnings, tick } = harness();
    await sessions.start({ profile: PROFILE, sttKeyPresent: true, llmKeyPresent: true });
    cost.start();
    tick(3600);

    expect(warnings.filter((w) => w.kind === 'time')).toHaveLength(1);
    sessions.noteUsage(cost.stop());
    await sessions.stop();
  });
});
