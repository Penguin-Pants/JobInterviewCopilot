/**
 * TASK-030 and TASK-032 wired together against fakes: the trigger, the STT
 * sessions it listens to, the audio supervisor beneath them and one LLM
 * generation above.
 *
 * TC-087 and TC-095 are integration cases because each asserts something about
 * two components at once: that pausing the trigger leaves the audio and STT
 * layers untouched, and that cancelling really aborts the request the adapter
 * sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../src/shared/defaults.js';
import type {
  AudioChunk,
  ProviderChoice,
  ProviderError,
  TranscriptEvent,
  TranscriptSource,
} from '../../src/shared/types.js';
import { AudioSupervisor, type AudioWorkerHandle } from '../../src/main/audio.js';
import { clearSttProviders, registerSttProvider, openSttSession } from '../../src/main/ai/stt.js';
import type { SttProvider, SttSession } from '../../src/main/ai/stt.js';
import { TriggerMachine, type TriggerConfig, type TurnFired } from '../../src/main/ai/trigger.js';
import { runGeneration, type GenerationRequest } from '../../src/main/ai/llm.js';
import { createAnthropicProvider } from '../../src/main/ai/llm/anthropic.js';
import { OverlayGate, type GatedMessage } from '../../src/main/overlay-gate.js';
import { anthropicScript, scriptedTransport } from '../fakes/llm.js';

const GAP = defaultSettings().trigger.turnEndGapMs;

function triggerConfig(): TriggerConfig {
  return { ...defaultSettings().trigger, supportsEndpointing: true };
}

/* ------------------------------------------------------------------ *
 * Fakes: an audio worker, and an STT session that stays open
 * ------------------------------------------------------------------ */

function fakeWorker(): AudioWorkerHandle & { stopped: number; destroyed: number } {
  let stopped = 0;
  let destroyed = 0;
  return {
    get stopped() {
      return stopped;
    },
    get destroyed() {
      return destroyed;
    },
    start: () => Promise.resolve(),
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
  pushed = 0;
  private readonly transcript: ((t: TranscriptEvent) => void)[] = [];

  constructor(
    readonly source: TranscriptSource,
    readonly choice: ProviderChoice,
  ) {}

  push(_chunk: AudioChunk): void {
    this.pushed += 1;
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
  }

  emit(text: string, isFinal: boolean): void {
    for (const h of this.transcript) {
      h({ source: this.source, text, isFinal, timestamp: Date.now(), providerId: 'fake' });
    }
  }
}

function fakeSttProvider(): { provider: SttProvider; opened: FakeSttSession[] } {
  const opened: FakeSttSession[] = [];
  return {
    opened,
    provider: {
      id: 'deepgram',
      open: (choice, source) => {
        const session = new FakeSttSession(source, choice);
        opened.push(session);
        return Promise.resolve(session);
      },
      validateKey: () => Promise.resolve({ ok: true }),
    },
  };
}

beforeEach(() => {
  clearSttProviders();
});

afterEach(() => {
  vi.useRealTimers();
  clearSttProviders();
});

/**
 * TC-087: pausing aborts the in-flight generation, pushes the overlay idle
 * state, and leaves both STT sessions open and both audio streams running.
 */
describe('TC-087 pause', () => {
  it('aborts the generation and touches neither audio nor STT', async () => {
    vi.useFakeTimers();

    const stt = fakeSttProvider();
    registerSttProvider(stt.provider);
    const worker = fakeWorker();
    const supervisor = new AudioSupervisor({ worker, onChunk: () => {} });

    const choice: ProviderChoice = { providerId: 'deepgram', modelId: 'nova-3' };
    const interviewer = (await openSttSession(choice, 'interviewer', 'k', {
      turnEndGapMs: GAP,
    })) as FakeSttSession;
    const candidate = (await openSttSession(choice, 'candidate', 'k', {
      turnEndGapMs: GAP,
    })) as FakeSttSession;

    supervisor.noteStreamState('interviewer', 'running');
    supervisor.noteStreamState('candidate', 'running');

    const overlayModes: { paused: boolean }[] = [];
    const fired: TurnFired[] = [];
    const trigger = new TriggerMachine({
      config: triggerConfig(),
      onFire: (turn) => fired.push(turn),
      onOverlayIdle: () => overlayModes.push({ paused: true }),
    });
    trigger.start();

    interviewer.on('transcript', (t) => trigger.handleTranscript(t));
    candidate.on('transcript', (t) => trigger.handleTranscript(t));

    // A real turn, so there is a generation to abort.
    interviewer.emit('Tell me about a time you shipped something hard', true);
    vi.advanceTimersByTime(GAP);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.signal.aborted).toBe(false);

    // Audio keeps arriving. Pausing the trigger must not change that.
    supervisor.handleChunk({
      source: 'interviewer',
      pcm: new ArrayBuffer(32000),
      timestamp: Date.now(),
      sequence: 1,
    });

    trigger.togglePause();

    expect(fired[0]?.signal.aborted).toBe(true);
    expect(overlayModes).toEqual([{ paused: true }]);
    expect(trigger.current).toBe('PAUSED');

    // The session and the streams are untouched: FR-053 pauses suggestions,
    // not capture.
    expect(interviewer.closed).toBe(0);
    expect(candidate.closed).toBe(0);
    expect(worker.stopped).toBe(0);
    expect(worker.destroyed).toBe(0);
    expect(supervisor.statusFor('interviewer').state).toBe('running');
    expect(supervisor.statusFor('candidate').state).toBe('running');

    // And audio still flows to the sessions while paused.
    interviewer.push({
      source: 'interviewer',
      pcm: new ArrayBuffer(32000),
      timestamp: Date.now(),
      sequence: 2,
    });
    expect(interviewer.pushed).toBe(1);
  });
});

/** TC-095: cancellation aborts the underlying request, not merely the read. */
describe('TC-095 real abort', () => {
  function request(): GenerationRequest {
    return {
      generationId: 'gen-1',
      question: 'Tell me about a performance win',
      candidateContext: '',
      chunks: [],
      choice: { providerId: 'anthropic', modelId: 'claude-haiku-4-5-20251001' },
    };
  }

  it('the provider records signal.aborted === true on the request it sent', async () => {
    const controller = new AbortController();
    const transport = scriptedTransport({
      chunks: anthropicScript(['first bullet\n', 'second bullet\n', 'third bullet\n']),
      beforeChunk: (index) => {
        // Abort part-way through, as a newer turn would (FR-054).
        if (index === 2) controller.abort();
      },
    });

    const provider = createAnthropicProvider({ keyFor: () => 'k', post: transport.post });
    const lines: string[] = [];
    const ends: { status: string }[] = [];

    const outcome = await runGeneration(provider, request(), controller.signal, {
      onBegin: () => {},
      onLine: (l) => lines.push(l.line),
      onEnd: (e) => ends.push(e),
    });

    // The signal the adapter handed to the transport is the aborted one. That
    // is the difference between aborting the request and stopping the read.
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.signal.aborted).toBe(true);
    expect(outcome.status).toBe('cancelled');
    expect(ends).toEqual([{ generationId: 'gen-1', status: 'cancelled' }]);
    expect(outcome.error).toBeNull();
  });

  it('a generation aborted before it starts sends no line and ends cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = scriptedTransport({ chunks: anthropicScript(['bullet\n']) });
    const provider = createAnthropicProvider({ keyFor: () => 'k', post: transport.post });

    const lines: string[] = [];
    const outcome = await runGeneration(provider, request(), controller.signal, {
      onBegin: () => {},
      onLine: (l) => lines.push(l.line),
      onEnd: () => {},
    });

    expect(lines).toEqual([]);
    expect(outcome.status).toBe('cancelled');
  });

  it('a cancelled generation flushes no partial bullet to the overlay', async () => {
    const controller = new AbortController();
    const transport = scriptedTransport({
      chunks: anthropicScript(['whole bullet\n', 'partial with no newline']),
      beforeChunk: (index) => {
        if (index === 3) controller.abort();
      },
    });
    const provider = createAnthropicProvider({ keyFor: () => 'k', post: transport.post });

    const lines: string[] = [];
    await runGeneration(provider, request(), controller.signal, {
      onBegin: () => {},
      onLine: (l) => lines.push(l.line),
      onEnd: () => {},
    });

    // FR-054 removes the cancelled generation's output from the overlay, so
    // completing its last bullet on the way out would add a line to a card that
    // is about to be replaced.
    expect(lines).toEqual(['whole bullet']);
  });
});

/** The gate in front of the overlay, driven by a real generation. */
describe('a generation reaching an overlay that is not ready yet', () => {
  it('holds every message and delivers them once overlay:ready arrives', async () => {
    const sent: GatedMessage[] = [];
    const gate = new OverlayGate((m) => sent.push(m));
    const transport = scriptedTransport({ chunks: anthropicScript(['one\ntwo\n']) });
    const provider = createAnthropicProvider({ keyFor: () => 'k', post: transport.post });

    await runGeneration(
      provider,
      {
        generationId: 'gen-1',
        question: 'q',
        candidateContext: '',
        chunks: [],
        choice: { providerId: 'anthropic', modelId: 'claude-haiku-4-5-20251001' },
      },
      new AbortController().signal,
      {
        onBegin: (payload) => gate.send({ channel: 'suggestion:begin', payload }),
        onLine: (payload) => gate.send({ channel: 'suggestion:line', payload }),
        onEnd: (payload) => gate.send({ channel: 'suggestion:end', payload }),
      },
    );

    expect(sent).toHaveLength(0);
    gate.noteReady();
    expect(sent.map((m) => m.channel)).toEqual([
      'suggestion:begin',
      'suggestion:line',
      'suggestion:line',
      'suggestion:end',
    ]);
  });
});
