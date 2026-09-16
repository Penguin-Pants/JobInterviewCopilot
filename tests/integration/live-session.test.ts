/**
 * TASK-044. The live session loop, end to end.
 *
 * Everything below the loop is real: a real `SessionManager` writing to a real
 * temporary `userData`, a real `CostMeter`, a real `TriggerMachine`, a real
 * `OverlayGate`, a real `ProviderHealthRegistry` and the real `openSttSession`
 * facade resolving a provider out of the registry. Only the three things that
 * would reach the outside world are fakes: the audio worker, the STT transport
 * and the LLM transport (`tests/fakes/llm.ts`).
 *
 * That is deliberate. The defects this loop can produce are ordering defects
 * between components, and a test that mocked the components could not see one.
 *
 * Covers `TC-164`, the integration halves of `TC-080`, `TC-086`, `TC-087` and
 * `TC-088`, and `TC-071`'s "`session:start` still succeeds during the model
 * download" half.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../src/shared/defaults.js';
import type {
  AudioChunk,
  ProviderChoice,
  ProviderError,
  Session,
  Settings,
  TranscriptEvent,
  TranscriptSource,
} from '../../src/shared/types.js';
import { AudioSupervisor, type AudioWorkerHandle } from '../../src/main/audio.js';
import { ProviderHealthRegistry } from '../../src/main/ai/health.js';
import { createAnthropicProvider } from '../../src/main/ai/llm/anthropic.js';
import {
  clearSttProviders,
  registerSttProvider,
  type SttProvider,
  type SttSession,
} from '../../src/main/ai/stt.js';
import { TriggerMachine, type TriggerConfig } from '../../src/main/ai/trigger.js';
import { CostMeter, type PriceTable } from '../../src/main/cost.js';
import { LiveSessionLoop, chunkSeconds } from '../../src/main/live.js';
import { OverlayGate, type GatedMessage } from '../../src/main/overlay-gate.js';
import { RagEngine } from '../../src/main/rag.js';
import { XenovaEmbedder } from '../../src/main/rag/embed.js';
import type { RetrievedChunk } from '../../src/main/rag.js';
import { SessionManager, readSession } from '../../src/main/session.js';
import { anthropicScript, scriptedTransport } from '../fakes/llm.js';

const PROFILE = { id: 'p1', name: 'Acme' };
const GAP = defaultSettings().trigger.turnEndGapMs;

/** One second of 16 kHz, 16-bit mono PCM (`FR-041`, `FR-042`). */
const ONE_SECOND_BYTES = 16000 * 2;

const PRICING: PriceTable = {
  version: '2026-09-15',
  llm: { 'anthropic:claude-haiku-4-5-20251001': { inputPerMTok: 1.0, outputPerMTok: 5.0 } },
  stt: { 'deepgram:nova-3': { perAudioMinute: 0.6 } },
};

/* ------------------------------------------------------------------ *
 * Fakes: the audio worker and an STT session that stays open
 * ------------------------------------------------------------------ */

function fakeWorker(): AudioWorkerHandle & { started: number; stopped: number; destroyed: number } {
  let started = 0;
  let stopped = 0;
  let destroyed = 0;
  return {
    get started() {
      return started;
    },
    get stopped() {
      return stopped;
    },
    get destroyed() {
      return destroyed;
    },
    start: () => {
      started += 1;
      return Promise.resolve();
    },
    stop: () => {
      stopped += 1;
      return Promise.resolve();
    },
    destroy: () => {
      destroyed += 1;
      return Promise.resolve();
    },
  };
}

class FakeSttSession implements SttSession {
  closed = 0;
  pushedBytes = 0;

  private readonly transcript: ((t: TranscriptEvent) => void)[] = [];
  private readonly endpoints: (() => void)[] = [];
  private readonly errors: ((e: ProviderError) => void)[] = [];

  constructor(
    readonly source: TranscriptSource,
    readonly choice: ProviderChoice,
    readonly turnEndGapMs: number,
  ) {}

  push(chunk: AudioChunk): void {
    this.pushedBytes += chunk.pcm.byteLength;
  }

  close(): Promise<void> {
    this.closed += 1;
    return Promise.resolve();
  }

  on(e: 'transcript', h: (t: TranscriptEvent) => void): void;
  on(e: 'endpoint', h: () => void): void;
  on(e: 'error', h: (err: ProviderError) => void): void;
  on(e: 'transcript' | 'endpoint' | 'error', h: (...args: never[]) => void): void {
    if (e === 'transcript') this.transcript.push(h as (t: TranscriptEvent) => void);
    if (e === 'endpoint') this.endpoints.push(h as () => void);
    if (e === 'error') this.errors.push(h as (err: ProviderError) => void);
  }

  /** How many endpoint listeners were wired. Zero on the candidate (`FR-055`). */
  get endpointListeners(): number {
    return this.endpoints.length;
  }

  emit(text: string, isFinal: boolean): void {
    for (const h of this.transcript) {
      h({ source: this.source, text, isFinal, timestamp: Date.now(), providerId: 'fake' });
    }
  }

  emitEndpoint(): void {
    for (const h of this.endpoints) h();
  }
}

function fakeSttProvider(opts: { failFirstOpens?: number } = {}): {
  provider: SttProvider;
  opened: FakeSttSession[];
} {
  const opened: FakeSttSession[] = [];
  let remainingFailures = opts.failFirstOpens ?? 0;
  return {
    opened,
    provider: {
      // The registry decides which adapter answers, so the fake takes a real
      // provider id and a real model. That is the path production uses.
      id: 'deepgram',
      open: (choice, source, _key, options) => {
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          const err = new Error('the socket refused') as ProviderError;
          err.class = 'network';
          err.providerId = 'deepgram';
          err.retryable = true;
          return Promise.reject(err);
        }
        const session = new FakeSttSession(source, choice, options.turnEndGapMs);
        opened.push(session);
        return Promise.resolve(session);
      },
      validateKey: () => Promise.resolve({ ok: true }),
    },
  };
}

/** One retrieved note, shaped as `RagEngine.query` really returns it. */
function retrieved(text = 'Shipped the billing migration in six weeks'): RetrievedChunk {
  return {
    chunk: {
      id: 'c1',
      docId: 'd1',
      profileId: PROFILE.id,
      index: 0,
      text,
      headerPath: ['Experience', 'Acme'],
      docType: 'resume',
      sourceFile: 'resume.md',
      tokenCount: 12,
    },
    score: 0.91,
  };
}

/* ------------------------------------------------------------------ *
 * The harness: bootstrap's wiring, in miniature
 * ------------------------------------------------------------------ */

interface HarnessOptions {
  /** SSE frames the LLM transport yields. */
  llmChunks?: string[];
  /** Awaited before each LLM frame, so a test can interleave a second turn. */
  beforeChunk?: (index: number) => Promise<void> | void;
  retrieve?: (profileId: string, question: string, k: number) => Promise<RetrievedChunk[]>;
  failFirstSttOpens?: number;
  settings?: Partial<Settings>;
}

function harness(userData: string, options: HarnessOptions = {}) {
  const stt = fakeSttProvider({ failFirstOpens: options.failFirstSttOpens });
  registerSttProvider(stt.provider);

  const settings: Settings = { ...defaultSettings(), ...options.settings };

  const sessions = new SessionManager({ userDataDir: userData, newSessionId: () => 's1' });

  let clock = 1_000_000;
  let tickBody: (() => void) | null = null;
  const cost = new CostMeter({
    thresholds: { costUsd: 0, timeMinutes: 0 },
    pricing: PRICING,
    now: () => clock,
    setIntervalFn: (fn) => {
      tickBody = fn;
      return 'handle';
    },
    clearIntervalFn: () => {
      tickBody = null;
    },
    onUsage: (snapshot) => {
      const { elapsedSeconds, ...record } = snapshot;
      void elapsedSeconds;
      sessions.noteUsage(record);
    },
    onWarning: () => {},
  });

  const worker = fakeWorker();
  const audio = new AudioSupervisor({ worker, onChunk: (chunk) => live.handleChunk(chunk) });

  const health = new ProviderHealthRegistry(
    () => {},
    () => () => Promise.resolve(true),
    { sleep: () => Promise.resolve(), random: () => 0.5 },
  );
  health.bind({ capability: 'stt', primary: 'deepgram', backup: null });
  health.bind({ capability: 'llm', primary: 'anthropic', backup: null });

  const triggerConfigs: TriggerConfig[] = [];
  const trigger = new TriggerMachine({
    config: { ...settings.trigger, supportsEndpointing: true, batchIntervalMs: 0 },
    onFire: (turn) => live.onFire(turn),
  });

  const sent: GatedMessage[] = [];
  const gate = new OverlayGate((m) => sent.push(m));

  const transcripts: TranscriptEvent[] = [];
  const errors: { message: string; detail?: unknown }[] = [];

  const transport = scriptedTransport({
    chunks: options.llmChunks ?? anthropicScript(['first cue\n', 'second cue\n']),
    beforeChunk: options.beforeChunk,
  });
  const llmProvider = createAnthropicProvider({ keyFor: () => 'k', post: transport.post });

  const retrievals: { profileId: string; question: string; k: number }[] = [];

  const live: LiveSessionLoop = new LiveSessionLoop({
    audio,
    trigger,
    sessions,
    cost,
    health,
    settings: () => settings,
    retrieve: (profileId, question, k) => {
      retrievals.push({ profileId, question, k });
      return options.retrieve?.(profileId, question, k) ?? Promise.resolve([]);
    },
    keyFor: () => 'k',
    onTranscript: (event) => transcripts.push(event),
    onSuggestion: (message) => gate.send(message),
    onSttChoice: (choice) => {
      const next: TriggerConfig = {
        ...settings.trigger,
        supportsEndpointing: choice !== null,
        batchIntervalMs: 0,
      };
      triggerConfigs.push(next);
      trigger.setConfig(next);
    },
    onError: (message, detail) => errors.push({ message, detail }),
    generate: undefined,
    resolveLlmProvider: () => llmProvider,
  });

  return {
    audio,
    cost,
    errors,
    gate,
    health,
    live,
    llmTransport: transport,
    retrievals,
    sent,
    sessions,
    settings,
    stt,
    transcripts,
    trigger,
    triggerConfigs,
    worker,
    tick: (seconds: number) => {
      for (let i = 0; i < seconds; i += 1) {
        clock += 1000;
        tickBody?.();
      }
    },
    /** The chunk the Audio Worker would have sent (`CH-303`). */
    sendChunk: (source: TranscriptSource, sequence = 1) => {
      audio.handleChunk({
        source,
        pcm: new ArrayBuffer(ONE_SECOND_BYTES),
        timestamp: Date.now(),
        sequence,
      });
    },
  };
}

type Harness = ReturnType<typeof harness>;

/** `session:start`, as `index.ts` sequences it. */
async function startSession(h: Harness): Promise<void> {
  await h.sessions.start({ profile: PROFILE, sttKeyPresent: true, llmKeyPresent: true });
  h.cost.start();
  await h.live.start(PROFILE.id);
}

/** `session:stop`, in the same order `index.ts` uses. */
async function stopSession(h: Harness): Promise<Session | null> {
  await h.live.stop();
  h.sessions.noteUsage(h.cost.record());
  const session = await h.sessions.stop();
  h.cost.stop();
  return session;
}

function speak(h: Harness, text: string): void {
  h.stt.opened.find((s) => s.source === 'interviewer')?.emit(text, true);
}

let userData: string;

beforeEach(() => {
  clearSttProviders();
  userData = mkdtempSync(join(tmpdir(), 'icp-live-'));
});

afterEach(() => {
  vi.useRealTimers();
  clearSttProviders();
  rmSync(userData, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * TC-164
 * ------------------------------------------------------------------ */

describe('TC-164 the live session loop, end to end', () => {
  it('runs a question from audio in to bullets, transcript and spend out', async () => {
    vi.useFakeTimers();
    const h = harness(userData, { retrieve: () => Promise.resolve([retrieved()]) });
    h.gate.noteReady();

    await startSession(h);

    // One session per stream, on the model the registry resolved, and capture
    // started (FR-047).
    expect(h.live.openStreamCount).toBe(2);
    expect(h.stt.opened.map((s) => s.source)).toEqual(['interviewer', 'candidate']);
    expect(h.worker.started).toBe(1);
    // The user's gap reached the provider, rather than a constant in an adapter.
    expect(h.stt.opened[0]?.turnEndGapMs).toBe(GAP);

    // Audio actually sent to a provider is what the meter counts (FR-103).
    h.sendChunk('interviewer', 1);
    h.sendChunk('candidate', 1);
    expect(h.stt.opened[0]?.pushedBytes).toBe(ONE_SECOND_BYTES);
    expect(h.cost.record().sttAudioSeconds).toEqual({ interviewer: 1, candidate: 1 });

    // A turn: final, then silence.
    speak(h, 'Tell me about a time you shipped something hard');
    await vi.advanceTimersByTimeAsync(GAP);
    await h.live.whenSettled();

    // Retrieval ran for the bound profile with the FR-072 top-3.
    expect(h.retrievals).toEqual([
      { profileId: PROFILE.id, question: 'Tell me about a time you shipped something hard', k: 3 },
    ]);

    // The overlay saw one card, through the gate, with one line per bullet.
    expect(h.sent.map((m) => m.channel)).toEqual([
      'suggestion:begin',
      'suggestion:line',
      'suggestion:line',
      'suggestion:end',
    ]);

    // And the model was sent the retrieved note, not an empty prompt.
    const body = h.llmTransport.requests[0]?.body as { messages: { content: string }[] };
    expect(body.messages[0]?.content).toContain('Shipped the billing migration');

    const session = await stopSession(h);
    expect(h.worker.stopped).toBe(1);
    expect(h.stt.opened.every((s) => s.closed === 1)).toBe(true);

    // The transcript carries the question and the suggestion, in that order.
    const saved = session ?? (await readSession(userData, PROFILE.id, 's1'));
    expect(saved?.entries.map((e) => e.kind)).toEqual(['turn', 'suggestion']);
    expect(saved?.entries[0]).toMatchObject({
      kind: 'turn',
      source: 'interviewer',
      text: 'Tell me about a time you shipped something hard',
    });
    expect(saved?.entries[1]).toMatchObject({
      kind: 'suggestion',
      status: 'complete',
      bullets: ['first cue', 'second cue'],
      providerId: 'anthropic',
    });

    // And the usage the provider reported reached the meter and the file.
    expect(saved?.usage.llmInputTokens).toBe(412);
    expect(saved?.usage.llmOutputTokens).toBe(57);
    expect(saved?.usage.sttAudioSeconds).toEqual({ interviewer: 1, candidate: 1 });
    expect(saved?.usage.estimatedUsd).toBeGreaterThan(0);
    expect(saved?.usage.estimateIncomplete).toBe(false);
    expect(h.errors).toEqual([]);
  });

  it('holds the whole card until overlay:ready, dropping nothing', async () => {
    vi.useFakeTimers();
    const h = harness(userData);
    await startSession(h);

    speak(h, 'Tell me about a hard decision you made');
    await vi.advanceTimersByTimeAsync(GAP);
    await h.live.whenSettled();

    // FR-008: nothing reached the window while the consent card was unpainted.
    expect(h.sent).toEqual([]);
    h.gate.noteReady();
    expect(h.sent.map((m) => m.channel)).toEqual([
      'suggestion:begin',
      'suggestion:line',
      'suggestion:line',
      'suggestion:end',
    ]);

    await stopSession(h);
  });

  it('pushes CH-206 for interims and appends only finals', async () => {
    vi.useFakeTimers();
    const h = harness(userData);
    await startSession(h);

    const interviewer = h.stt.opened.find((s) => s.source === 'interviewer');
    const candidate = h.stt.opened.find((s) => s.source === 'candidate');
    interviewer?.emit('Tell me about', false);
    interviewer?.emit('Tell me about your proudest project', true);
    candidate?.emit('I rebuilt the billing pipeline end to end', true);

    // Every event reaches the Dashboard; only the finals reach the writer.
    expect(h.transcripts.map((e) => e.isFinal)).toEqual([false, true, true]);

    await vi.advanceTimersByTimeAsync(GAP);
    await h.live.whenSettled();
    const session = await stopSession(h);

    const turns = session?.entries.filter((e) => e.kind === 'turn') ?? [];
    expect(turns.map((t) => (t.kind === 'turn' ? t.source : ''))).toEqual([
      'interviewer',
      'candidate',
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * FR-106: the cancelled entry is appended before its replacement's
 * ------------------------------------------------------------------ */

describe('FR-106 a turn during GENERATING', () => {
  it('appends the cancelled generation before the replacement, with its bullets', async () => {
    vi.useFakeTimers();

    // The **first** generation is held part-way through its stream and nothing
    // else is. Without that asymmetry the replacement would be held too, and
    // the ordering this test exists for would hold by coincidence rather than
    // by the await that produces it.
    // Not `(() => void) | null`: assigning inside the executor narrows that to
    // `null` for the rest of the function and makes the call uncallable.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstHeld = false;

    const h = harness(userData, {
      llmChunks: anthropicScript(['first cue\n', 'second cue\n', 'third cue\n']),
      beforeChunk: (index) => {
        if (index !== 3 || firstHeld) return undefined;
        firstHeld = true;
        return held;
      },
    });
    h.gate.noteReady();
    await startSession(h);

    speak(h, 'Tell me about a time you shipped something hard');
    await vi.advanceTimersByTimeAsync(GAP);

    // The first generation is mid-stream and has flushed at least one bullet.
    expect(h.trigger.current).toBe('GENERATING');

    speak(h, 'And what did you learn from doing that');
    await vi.advanceTimersByTimeAsync(GAP);
    release();
    await h.live.whenSettled();

    const session = await stopSession(h);
    const entries = session?.entries ?? [];

    // Every `seq` is assigned at append time and strictly increases.
    expect(entries.map((e) => e.seq)).toEqual([0, 1, 2, 3]);

    const suggestions = entries.filter((e) => e.kind === 'suggestion');
    expect(suggestions).toHaveLength(2);

    // The cancelled generation is first, carrying what it had already flushed.
    expect(suggestions[0]).toMatchObject({
      kind: 'suggestion',
      status: 'cancelled',
      forQuestion: 'Tell me about a time you shipped something hard',
    });
    expect(suggestions[0]?.kind === 'suggestion' && suggestions[0].bullets.length).toBeGreaterThan(
      0,
    );

    // Its replacement follows it, never the other way round.
    expect(suggestions[1]).toMatchObject({
      kind: 'suggestion',
      forQuestion: 'And what did you learn from doing that',
    });
    expect((suggestions[0]?.seq ?? 0) < (suggestions[1]?.seq ?? 0)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * The trigger cases, through the loop rather than against a stub
 * ------------------------------------------------------------------ */

describe('TC-080 one turn end fires exactly one generation', () => {
  it('fires once for one final followed by the gap', async () => {
    vi.useFakeTimers();
    const h = harness(userData);
    h.gate.noteReady();
    await startSession(h);

    speak(h, 'Walk me through your most recent project');
    await vi.advanceTimersByTimeAsync(GAP);
    await h.live.whenSettled();

    expect(h.sent.filter((m) => m.channel === 'suggestion:begin')).toHaveLength(1);
    expect(h.llmTransport.requests).toHaveLength(1);
    await stopSession(h);
  });
});

describe('TC-086 a new turn end during GENERATING', () => {
  it('aborts the request the adapter sent before the replacement starts', async () => {
    vi.useFakeTimers();
    // Not `(() => void) | null`: assigning inside the executor narrows that to
    // `null` for the rest of the function and makes the call uncallable.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const h = harness(userData, {
      llmChunks: anthropicScript(['first cue\n', 'second cue\n']),
      beforeChunk: (index) => (index === 2 ? held : undefined),
    });
    h.gate.noteReady();
    await startSession(h);

    speak(h, 'Tell me about a time you shipped something hard');
    await vi.advanceTimersByTimeAsync(GAP);

    speak(h, 'And what did you learn from doing that');
    await vi.advanceTimersByTimeAsync(GAP);

    // The first request is aborted at the transport, not merely unsubscribed.
    expect(h.llmTransport.requests[0]?.signal.aborted).toBe(true);
    release();
    await h.live.whenSettled();
    await stopSession(h);
  });
});

describe('TC-087 and TC-088 pause and resume, through the loop', () => {
  it('pausing leaves both streams open and capture running; resuming answers again', async () => {
    vi.useFakeTimers();
    // Not `(() => void) | null`: assigning inside the executor narrows that to
    // `null` for the rest of the function and makes the call uncallable.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const h = harness(userData, {
      llmChunks: anthropicScript(['first cue\n', 'second cue\n']),
      beforeChunk: (index) => (index === 2 ? held : undefined),
    });
    h.gate.noteReady();
    await startSession(h);

    speak(h, 'Tell me about a time you shipped something hard');
    await vi.advanceTimersByTimeAsync(GAP);
    expect(h.trigger.current).toBe('GENERATING');

    h.trigger.togglePause();

    // FR-053: suggestions stop, the session does not.
    expect(h.llmTransport.requests[0]?.signal.aborted).toBe(true);
    expect(h.live.openStreamCount).toBe(2);
    expect(h.stt.opened.every((s) => s.closed === 0)).toBe(true);
    expect(h.worker.stopped).toBe(0);

    // And audio still flows to the provider while paused.
    h.sendChunk('interviewer', 2);
    expect(h.stt.opened[0]?.pushedBytes).toBe(ONE_SECOND_BYTES);

    release();
    await h.live.whenSettled();

    // TC-088: resuming returns to LISTENING and the next turn fires normally.
    h.trigger.togglePause();
    expect(h.trigger.current).toBe('LISTENING');

    speak(h, 'What would you do differently next time');
    await vi.advanceTimersByTimeAsync(GAP);
    await h.live.whenSettled();

    expect(h.llmTransport.requests).toHaveLength(2);
    await stopSession(h);
  });
});

/* ------------------------------------------------------------------ *
 * FR-055: the candidate stream can never fire
 * ------------------------------------------------------------------ */

describe('FR-055 the candidate stream is context, never a trigger', () => {
  it('wires no endpoint listener on the candidate session', async () => {
    vi.useFakeTimers();
    const h = harness(userData);
    await startSession(h);

    const interviewer = h.stt.opened.find((s) => s.source === 'interviewer');
    const candidate = h.stt.opened.find((s) => s.source === 'candidate');

    expect(interviewer?.endpointListeners).toBe(1);
    // A candidate endpoint reaching the machine would evaluate the interviewer's
    // pending turn and fire it early, which is the firing FR-055 forbids.
    expect(candidate?.endpointListeners).toBe(0);

    interviewer?.emit('Tell me about a time you shipped something hard', true);
    candidate?.emitEndpoint();

    // Still waiting out the local gap: nothing fired.
    expect(h.trigger.current).toBe('AWAITING_TURN_END');
    expect(h.llmTransport.requests).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(GAP);
    await h.live.whenSettled();
    await stopSession(h);
  });
});

/* ------------------------------------------------------------------ *
 * Failure paths: loud, and never a plausible value (ADR-032)
 * ------------------------------------------------------------------ */

describe('ADR-032 a failure stops rather than inventing a suggestion', () => {
  it('abandons the turn when retrieval fails, and says so', async () => {
    vi.useFakeTimers();
    const h = harness(userData, {
      retrieve: () => Promise.reject(new Error('vectors.bin is unreadable')),
    });
    h.gate.noteReady();
    await startSession(h);

    speak(h, 'Tell me about a time you shipped something hard');
    await vi.advanceTimersByTimeAsync(GAP);
    await h.live.whenSettled();

    // No generation ran, so no ungrounded suggestion reached the overlay or the
    // transcript, and the failure is in the log rather than swallowed.
    expect(h.llmTransport.requests).toHaveLength(0);
    expect(h.sent).toEqual([]);
    expect(h.errors.map((e) => e.message)).toContain(
      'retrieval failed, so this turn is not answered',
    );

    // The machine is free for the next question rather than stuck in GENERATING.
    expect(h.trigger.current).toBe('LISTENING');

    const session = await stopSession(h);
    expect(session?.entries.filter((e) => e.kind === 'suggestion')).toEqual([]);
  });

  it('starts the session with no transcription when the streams cannot open', async () => {
    vi.useFakeTimers();
    // Four failures exhausts the retry ladder, so the open really gives up.
    const h = harness(userData, { failFirstSttOpens: 8 });
    await startSession(h);

    expect(h.live.openStreamCount).toBe(0);
    expect(h.errors.map((e) => e.message)).toContain(
      'the speech-to-text provider could not be reached',
    );

    // A chunk with nowhere to go is dropped, and bills nothing.
    h.sendChunk('interviewer', 1);
    expect(h.cost.record().sttAudioSeconds).toEqual({ interviewer: 0, candidate: 0 });

    // The session itself is live and stops cleanly.
    const session = await stopSession(h);
    expect(session?.endReason).toBe('user');
  });

  it('ignores a provider that emits after its stream was closed', async () => {
    vi.useFakeTimers();
    const h = harness(userData);
    await startSession(h);

    const interviewer = h.stt.opened.find((s) => s.source === 'interviewer');
    interviewer?.emit('Tell me about your proudest project', true);
    await vi.advanceTimersByTimeAsync(GAP);
    await h.live.whenSettled();

    const session = await stopSession(h);
    expect(session).not.toBeNull();
    const pushesAtStop = h.transcripts.length;

    // A closed socket can still emit. Nothing it says may reach the Dashboard,
    // and nothing may be offered to a writer that has compacted and closed:
    // the ordering is this loop's to hold rather than the writer's to refuse.
    interviewer?.emit('a late segment nobody asked for', true);
    await Promise.resolve();
    await Promise.resolve();

    expect(h.transcripts).toHaveLength(pushesAtStop);
    expect(h.errors).toEqual([]);
    const saved = await readSession(userData, PROFILE.id, 's1');
    expect(saved?.entries.some((e) => e.kind === 'turn' && e.text.includes('late segment'))).toBe(
      false,
    );
  });
});

/* ------------------------------------------------------------------ *
 * TC-071, remaining half
 * ------------------------------------------------------------------ */

describe('TC-071 session:start still succeeds during the model download', () => {
  it('starts a live session, with both streams open, while the model downloads', async () => {
    const modelsRoot = join(userData, 'models');
    const engine = new RagEngine({
      userDataDir: userData,
      embedder: new XenovaEmbedder({ modelsRoot, allowDownload: false }),
      watcherFactory: () => ({ on: () => ({}) as never, close: async () => {} }),
    });

    const h = harness(userData, { retrieve: (p, q, k) => engine.query(p, q, k) });

    // Deliberately not awaited: the session must start while this is in flight.
    const download = engine.ensureModelReady({ userInitiated: true });
    expect(engine.getModelState().kind).toBe('downloading');

    await startSession(h);

    expect(h.sessions.current?.id).toBe('s1');
    expect(h.live.openStreamCount).toBe(2);
    expect(engine.getModelState().kind).not.toBe('ready');

    await download;
    await stopSession(h);
    await engine.stop();
  });
});

/* ------------------------------------------------------------------ *
 * Audio accounting arithmetic
 * ------------------------------------------------------------------ */

describe('chunkSeconds', () => {
  it('reads the duration off the bytes and the model sample rate', () => {
    expect(chunkSeconds(ONE_SECOND_BYTES, 16000)).toBe(1);
    // A short final chunk costs what it is, not a rounded-up second.
    expect(chunkSeconds(ONE_SECOND_BYTES / 4, 16000)).toBe(0.25);
    // A nonsense rate contributes nothing rather than Infinity, which would
    // reach the transcript as `null` and fail the session schema (ADR-032).
    expect(chunkSeconds(ONE_SECOND_BYTES, 0)).toBe(0);
  });
});
