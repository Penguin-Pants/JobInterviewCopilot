/**
 * `bootstrap`'s wiring, in miniature, shared by every test that needs a live
 * session (TASK-044, TASK-050).
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
 */
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
  registerSttProvider,
  type SttProvider,
  type SttTransportClass,
} from '../../src/main/ai/stt.js';
import type { SttSession } from '../../src/main/ai/stt.js';
import { TriggerMachine, type TriggerConfig } from '../../src/main/ai/trigger.js';
import { CostMeter, type PriceTable } from '../../src/main/cost.js';
import { LiveSessionLoop } from '../../src/main/live.js';
import { OverlayGate, type GatedMessage } from '../../src/main/overlay-gate.js';
import type { RetrievedChunk } from '../../src/main/rag.js';
import { SessionManager } from '../../src/main/session.js';
import { anthropicScript, scriptedTransport } from './llm.js';

export const PROFILE = { id: 'p1', name: 'Acme' };
export const GAP = defaultSettings().trigger.turnEndGapMs;

/** One second of 16 kHz, 16-bit mono PCM (`FR-041`, `FR-042`). */
export const ONE_SECOND_BYTES = 16000 * 2;

export const PRICING: PriceTable = {
  version: '2026-09-15',
  llm: { 'anthropic:claude-haiku-4-5-20251001': { inputPerMTok: 1.0, outputPerMTok: 5.0 } },
  stt: { 'deepgram:nova-3': { perAudioMinute: 0.6 }, 'openai:whisper-1': { perAudioMinute: 0.36 } },
};

/* ------------------------------------------------------------------ *
 * Fakes: the audio worker and an STT session that stays open
 * ------------------------------------------------------------------ */

export function fakeWorker(): AudioWorkerHandle & {
  started: number;
  stopped: number;
  destroyed: number;
} {
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

export class FakeSttSession implements SttSession {
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

export function fakeSttProvider(opts: { failFirstOpens?: number } = {}): {
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
export function retrieved(text = 'Shipped the billing migration in six weeks'): RetrievedChunk {
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
 * The harness
 * ------------------------------------------------------------------ */

export interface HarnessOptions {
  /** SSE frames the LLM transport yields. */
  llmChunks?: string[];
  /** Awaited before each LLM frame, so a test can interleave a second turn. */
  beforeChunk?: (index: number) => Promise<void> | void;
  retrieve?: (profileId: string, question: string, k: number) => Promise<RetrievedChunk[]>;
  failFirstSttOpens?: number;
  settings?: Partial<Settings>;
  /**
   * An adapter to register instead of the streaming fake, so a test can drive
   * the real Whisper adapter over an injected transport (`TC-137`).
   */
  sttAdapter?: { provider: SttProvider; transport?: SttTransportClass };
  /**
   * Register no adapter at all, which is how a session with no usable model
   * reaches `openTranscription`'s warning path (`TC-132`).
   */
  registerStt?: boolean;
  /**
   * The vault lookup. `undefined` for a provider is the "no key saved" branch
   * that leaves the session with no usable model (`TC-132`).
   */
  keyFor?: (providerId: string) => string | undefined;
}

export function harness(userData: string, options: HarnessOptions = {}) {
  const stt = fakeSttProvider({ failFirstOpens: options.failFirstSttOpens });
  if (options.registerStt !== false) {
    if (options.sttAdapter) {
      registerSttProvider(options.sttAdapter.provider, options.sttAdapter.transport ?? 'streaming');
    } else {
      registerSttProvider(stt.provider);
    }
  }

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
  /** Wall-clock arrival of each gated message, in the same order (`TC-133`). */
  const sentAt: number[] = [];
  const gate = new OverlayGate((m) => {
    sent.push(m);
    sentAt.push(Date.now());
  });

  const transcripts: TranscriptEvent[] = [];
  const errors: { message: string; detail?: unknown }[] = [];
  const infos: { message: string; detail?: unknown }[] = [];

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
    keyFor: options.keyFor ?? (() => 'k'),
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
    onInfo: (message, detail) => infos.push({ message, detail }),
    generate: undefined,
    resolveLlmProvider: () => llmProvider,
  });

  return {
    audio,
    cost,
    errors,
    gate,
    health,
    infos,
    live,
    llmTransport: transport,
    retrievals,
    sent,
    sentAt,
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
    /**
     * The chunk the Audio Worker would have sent (`CH-303`). `fill` stamps every
     * byte, so a write monitor can recognize these exact bytes on disk
     * (`TC-137`).
     */
    sendChunk: (source: TranscriptSource, sequence = 1, fill?: number) => {
      const pcm = new ArrayBuffer(ONE_SECOND_BYTES);
      if (fill !== undefined) new Uint8Array(pcm).fill(fill);
      audio.handleChunk({ source, pcm, timestamp: Date.now(), sequence });
    },
  };
}

export type Harness = ReturnType<typeof harness>;

/** `session:start`, as `index.ts` sequences it. */
export async function startSession(h: Harness): Promise<void> {
  await h.sessions.start({ profile: PROFILE, sttKeyPresent: true, llmKeyPresent: true });
  h.cost.start();
  await h.live.start(PROFILE.id);
}

/** `session:stop`, in the same order `index.ts` uses. */
export async function stopSession(h: Harness): Promise<Session | null> {
  await h.live.stop();
  h.sessions.noteUsage(h.cost.record());
  const session = await h.sessions.stop();
  h.cost.stop();
  return session;
}

/** One final interviewer transcript, from whichever stream is open. */
export function speak(h: Harness, text: string): void {
  h.stt.opened.find((s) => s.source === 'interviewer')?.emit(text, true);
}
