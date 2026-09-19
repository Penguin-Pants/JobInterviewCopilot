/**
 * TASK-060 and TASK-061. The guard chain a turn end runs, whichever way the
 * turn ended.
 *
 * `TC-170` drives the confidence gate from a fake STT provider in both
 * directions, the registry-driven pattern `TC-151` established: one registry
 * entry and one adapter, with `supportsConfidence` the only difference between
 * the two models. `TC-187` proves the native-endpoint path is the same path,
 * not an older one that predates `FR-111`/`FR-113`.
 *
 * Real components throughout: the real registry lookup, the real
 * `openSttSession` facade and the real `TriggerMachine`. Only the socket and
 * the classifier are fakes, because they are the two things that would reach
 * the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../src/shared/defaults.js';
import type {
  AudioChunk,
  ProviderChoice,
  ProviderDescriptor,
  ProviderError,
  SttModelDescriptor,
  TranscriptEvent,
  TranscriptSource,
} from '../../src/shared/types.js';
import { findSttModel } from '../../src/shared/registry/stt.js';
import {
  clearSttProviders,
  openSttSession,
  registerSttProvider,
  type SttProvider,
  type SttSession,
} from '../../src/main/ai/stt.js';
import type { ActionabilityVerdict } from '../../src/main/ai/actionability.js';
import {
  CONFIDENCE_THRESHOLD,
  TriggerMachine,
  type TriggerConfig,
} from '../../src/main/ai/trigger.js';

const GAP = defaultSettings().trigger.turnEndGapMs;

/**
 * A turn neither lexicon resolves, so reaching the classifier is what a turn
 * that passes the confidence gate does, and never reaching it is what a turn
 * the gate suppresses does (`TC-167`).
 */
const UNRESOLVED = 'I was reading your resume on the train last night';
const UNRESOLVED_TWO = 'My colleague mentioned the migration you led at Acme';

/**
 * Two models that differ in exactly one field. Nothing else in the app is
 * edited to add them, which is the registry claim `TC-056`/`TC-151` make.
 */
const FAKE_REGISTRY: ProviderDescriptor<SttModelDescriptor>[] = [
  {
    id: 'acme-speech',
    displayName: 'Acme Speech',
    credentialId: 'deepgram',
    models: [
      {
        id: 'acme-confident',
        displayName: 'Acme Confident',
        streaming: true,
        supportsInterim: true,
        supportsEndpointing: true,
        supportsConfidence: true,
        audio: { encoding: 'linear16', sampleRate: 16000, channels: 1 },
        pricePerAudioMinuteUsd: 0.005,
      },
      {
        id: 'acme-blind',
        displayName: 'Acme Blind',
        streaming: true,
        supportsInterim: true,
        supportsEndpointing: true,
        supportsConfidence: false,
        audio: { encoding: 'linear16', sampleRate: 16000, channels: 1 },
        pricePerAudioMinuteUsd: 0.005,
      },
    ],
  },
];

/** The session the fake adapter hands back, driven by hand from each case. */
class ScriptedSttSession implements SttSession {
  private readonly transcript: ((t: TranscriptEvent) => void)[] = [];
  private readonly endpoints: (() => void)[] = [];

  constructor(
    readonly source: TranscriptSource,
    readonly choice: ProviderChoice,
    /** Whatever the selected model's registry entry declares. */
    readonly supportsConfidence: boolean,
  ) {}

  push(_chunk: AudioChunk): void {}
  close(): Promise<void> {
    return Promise.resolve();
  }

  on(e: 'transcript', h: (t: TranscriptEvent) => void): void;
  on(e: 'endpoint', h: () => void): void;
  on(e: 'error', h: (err: ProviderError) => void): void;
  on(e: 'transcript' | 'endpoint' | 'error', h: (...args: never[]) => void): void {
    if (e === 'transcript') this.transcript.push(h as (t: TranscriptEvent) => void);
    if (e === 'endpoint') this.endpoints.push(h as () => void);
  }

  /**
   * One final segment. `confidence` is set only when the active model declares
   * `supportsConfidence`, which is the contract every real adapter follows: a
   * model that cannot measure it emits no field rather than a substituted one.
   */
  emitFinal(text: string, confidence: number): void {
    for (const h of this.transcript) {
      h({
        source: this.source,
        text,
        isFinal: true,
        timestamp: Date.now(),
        providerId: this.choice.providerId,
        ...(this.supportsConfidence ? { confidence } : {}),
      });
    }
  }

  emitEndpoint(): void {
    for (const h of this.endpoints) h();
  }
}

function fakeProvider(supportsConfidenceFor: (modelId: string) => boolean): SttProvider {
  return {
    id: 'acme-speech',
    open: (choice, source) =>
      Promise.resolve(
        new ScriptedSttSession(source, choice, supportsConfidenceFor(choice.modelId)),
      ),
    validateKey: () => Promise.resolve({ ok: true }),
  };
}

interface Wiring {
  session: ScriptedSttSession;
  trigger: TriggerMachine;
  classified: string[];
  fired: string[];
  log: string[];
}

/** The wiring `bootstrap` builds, for one model of the fake registry. */
async function wire(modelId: string): Promise<Wiring> {
  const choice = { providerId: 'acme-speech', modelId };
  const model = findSttModel(choice, FAKE_REGISTRY);
  expect(model, `${modelId} is missing from the fake registry`).not.toBeNull();

  const session = (await openSttSession(
    choice,
    'interviewer',
    'key',
    { turnEndGapMs: GAP },
    FAKE_REGISTRY,
  )) as unknown as ScriptedSttSession;

  const classified: string[] = [];
  const fired: string[] = [];
  const log: string[] = [];

  // Exactly `triggerConfigFrom`'s rule in `index.ts`: every capability flag
  // comes off the registry entry of the model that is actually serving.
  const config: TriggerConfig = {
    ...defaultSettings().trigger,
    supportsEndpointing: model?.supportsEndpointing ?? false,
    supportsConfidence: model?.supportsConfidence ?? false,
    batchIntervalMs: 0,
  };

  const trigger = new TriggerMachine({
    config,
    newGenerationId: () => `gen-${String(fired.length + 1)}`,
    onFire: (turn) => {
      fired.push(turn.generationId);
      log.push(`fire:${turn.generationId}`);
      turn.signal.addEventListener('abort', () => log.push(`abort:${turn.generationId}`));
    },
    onStateChange: (state) => log.push(`state:${state}`),
    classify: (text): Promise<ActionabilityVerdict> => {
      classified.push(text);
      log.push(`classify:${text}`);
      return Promise.resolve('actionable');
    },
  });

  session.on('transcript', (event) => trigger.handleTranscript(event));
  session.on('endpoint', () => trigger.handleEndpoint());
  trigger.start();

  return { session, trigger, classified, fired, log };
}

beforeEach(() => {
  clearSttProviders();
  registerSttProvider(
    fakeProvider((modelId) => modelId === 'acme-confident'),
    'streaming',
  );
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  clearSttProviders();
});

/**
 * TC-170. The gate is free and the classifier is not, so the gate runs first:
 * a turn the confidence gate suppresses must never also pay for a
 * classification call.
 */
describe('TC-170 the confidence capability drives the gate', () => {
  const LOW = CONFIDENCE_THRESHOLD - 0.1;

  it('suppresses a low-confidence turn, and never calls the classifier for it', async () => {
    const w = await wire('acme-confident');

    w.session.emitFinal(UNRESOLVED, LOW);
    await vi.advanceTimersByTimeAsync(GAP);

    expect(w.fired).toEqual([]);
    expect(w.classified).toEqual([]);
    // Back to LISTENING with no card and no transcript entry: the same path a
    // `FR-051` guard failure already takes, not a new one.
    expect(w.trigger.current).toBe('LISTENING');
    w.trigger.dispose();
  });

  it('fires normally on the identical value when the model cannot measure it', async () => {
    const w = await wire('acme-blind');

    w.session.emitFinal(UNRESOLVED, LOW);
    await vi.advanceTimersByTimeAsync(GAP);

    // The gate is not evaluated at all here, rather than evaluated and passing,
    // so the turn goes on to the classifier and fires.
    expect(w.classified).toEqual([UNRESOLVED]);
    expect(w.fired).toEqual(['gen-1']);
    expect(w.trigger.current).toBe('GENERATING');
    w.trigger.dispose();
  });

  it('lets a confident turn through on the same model that suppressed one', async () => {
    const w = await wire('acme-confident');

    w.session.emitFinal(UNRESOLVED, CONFIDENCE_THRESHOLD);
    await vi.advanceTimersByTimeAsync(GAP);

    expect(w.classified).toEqual([UNRESOLVED]);
    expect(w.fired).toEqual(['gen-1']);
    w.trigger.dispose();
  });
});

/**
 * TC-187. `FR-050` gives a provider that reports its own turn end priority over
 * the local gap timer, and nothing else about the turn changes with it. The
 * ordering claim is the point: `firedAt` is stamped, then whatever is in flight
 * is aborted, then the confidence gate, then the classifier.
 */
describe('TC-187 a native endpoint runs the identical guard chain', () => {
  const LOW = CONFIDENCE_THRESHOLD - 0.1;

  /**
   * The same three turns, ended two ways: by the local gap, and by the
   * provider's own endpoint signal arriving before that gap could elapse.
   */
  async function script(endTurn: (w: Wiring) => Promise<void>): Promise<Wiring> {
    const w = await wire('acme-confident');

    // 1. A turn that needs the classifier, and fires.
    w.session.emitFinal(UNRESOLVED, 0.95);
    await endTurn(w);

    // 2. A second turn while the first is still live: it aborts the first
    //    before running its own guard chain.
    w.session.emitFinal(UNRESOLVED_TWO, 0.95);
    await endTurn(w);

    // 3. A low-confidence turn, which the gate suppresses before the
    //    classifier is ever asked.
    w.session.emitFinal(UNRESOLVED, LOW);
    await endTurn(w);

    return w;
  }

  it('observes the identical calls, in the identical order, as a gap-ended turn', async () => {
    const byGap = await script(async (w) => {
      void w;
      await vi.advanceTimersByTimeAsync(GAP);
    });
    byGap.trigger.dispose();

    const byEndpoint = await script(async (w) => {
      // Fired well before `turnEndGapMs` would elapse, so the local timer
      // cannot be what ended these turns.
      w.session.emitEndpoint();
      await Promise.resolve();
      await Promise.resolve();
    });
    byEndpoint.trigger.dispose();

    expect(byEndpoint.log).toEqual(byGap.log);
    expect(byEndpoint.classified).toEqual(byGap.classified);
    expect(byEndpoint.fired).toEqual(byGap.fired);

    // And the sequence really is the documented one, rather than two paths
    // agreeing on the same wrong thing.
    expect(byEndpoint.log).toEqual([
      'state:LISTENING',
      'state:AWAITING_TURN_END',
      'state:CLASSIFYING',
      `classify:${UNRESOLVED}`,
      'state:GENERATING',
      'fire:gen-1',
      // The in-flight turn is aborted before the replacement's own guard chain
      // runs: no `classify` for the second turn has happened yet.
      'abort:gen-1',
      'state:CLASSIFYING',
      `classify:${UNRESOLVED_TWO}`,
      'state:GENERATING',
      'fire:gen-2',
      // The third turn aborts what is in flight first, exactly as the second
      // did, and only then meets the confidence gate -- which stops it before
      // the classifier is ever asked.
      'abort:gen-2',
      'state:LISTENING',
    ]);
  });

  it('ends the turn before the local gap could have elapsed', async () => {
    const w = await wire('acme-confident');

    w.session.emitFinal(UNRESOLVED, 0.95);
    await vi.advanceTimersByTimeAsync(GAP - 1);
    expect(w.fired).toEqual([]);

    w.session.emitEndpoint();
    await Promise.resolve();
    await Promise.resolve();
    expect(w.fired).toEqual(['gen-1']);

    // And the gap timer it cancelled does not fire a second turn behind it.
    await vi.advanceTimersByTimeAsync(GAP);
    expect(w.fired).toEqual(['gen-1']);
    w.trigger.dispose();
  });
});
