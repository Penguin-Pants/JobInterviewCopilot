import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptSource } from '../../src/shared/types.js';

/**
 * The hidden audio worker's start and stop paths (CMP-03b, NFR-002, FR-046).
 *
 * The worker runs in a sandboxed renderer, so these tests give it plain stubs
 * for the three things it touches: the preload bridge, `navigator.mediaDevices`
 * and the Web Audio graph. Every acquisition and every worklet load is a
 * promise the test resolves by hand, which is what lets a stop land in the
 * middle of a start.
 *
 * The property under test is a privacy one. After a stop, no stream the worker
 * acquired may still be live, whatever order the messages arrived in.
 */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeTrack {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
  addEventListener(): void {}
}

class FakeStream {
  readonly tracks = [new FakeTrack()];
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks;
  }
  getVideoTracks(): FakeTrack[] {
    return [];
  }
  removeTrack(): void {}
  get live(): boolean {
    return this.tracks.some((t) => !t.stopped);
  }
}

class FakeNode {
  readonly port = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    postMessage: (message: { type: string }) => {
      if (message.type !== 'flush') return;
      queueMicrotask(() =>
        this.port.onmessage?.({ data: { pcm: new ArrayBuffer(0), final: true } }),
      );
    },
  };
  disconnect(): void {}
  /** What the processor would post for one full chunk. */
  emit(): void {
    this.port.onmessage?.({ data: { pcm: new ArrayBuffer(8) } });
  }
}

let contexts: FakeContext[];
let nodes: FakeNode[];
let moduleLoads: Deferred<void>[];
let closeFails: boolean;

class FakeContext {
  closed = false;
  readonly audioWorklet = {
    addModule: (): Promise<void> => {
      const load = deferred<void>();
      moduleLoads.push(load);
      return load.promise;
    },
  };
  constructor() {
    contexts.push(this);
  }
  createMediaStreamSource(): { connect: () => void } {
    return { connect: () => undefined };
  }
  close(): Promise<void> {
    this.closed = true;
    return closeFails ? Promise.reject(new Error('context already closed')) : Promise.resolve();
  }
}

class FakeWorkletNode extends FakeNode {
  constructor() {
    super();
    nodes.push(this);
  }
}

let acquisitions: Array<{ source: TranscriptSource; request: Deferred<FakeStream> }>;
let streams: FakeStream[];
let states: Array<{ source: TranscriptSource; state: string; error?: string }>;
let chunks: Array<{ source: TranscriptSource; sequence: number }>;
let startListener: (payload: { streams: TranscriptSource[] }) => void;
let stopListener: () => void;

function acquire(source: TranscriptSource): Promise<FakeStream> {
  const request = deferred<FakeStream>();
  acquisitions.push({ source, request });
  return request.promise;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
}

/** Answer the oldest pending acquisition with a fresh stream. */
async function grantNextStream(): Promise<FakeStream> {
  await settle();
  const next = acquisitions.shift();
  if (!next) throw new Error('no acquisition is pending');
  const stream = new FakeStream();
  streams.push(stream);
  next.request.resolve(stream);
  await settle();
  return stream;
}

/** Finish the oldest pending worklet load. */
async function loadNextModule(): Promise<void> {
  await settle();
  const next = moduleLoads.shift();
  if (!next) throw new Error('no worklet load is pending');
  next.resolve();
  await settle();
}

function statesFor(source: TranscriptSource): string[] {
  return states.filter((s) => s.source === source).map((s) => s.state);
}

beforeEach(async () => {
  contexts = [];
  nodes = [];
  moduleLoads = [];
  closeFails = false;
  acquisitions = [];
  streams = [];
  states = [];
  chunks = [];

  vi.stubGlobal('window', {
    location: { href: 'file:///app/out/renderer/audio-worker/index.html' },
    audioWorker: {
      onStart: (listener: typeof startListener) => {
        startListener = listener;
      },
      onStop: (listener: typeof stopListener) => {
        stopListener = listener;
      },
      sendChunk: (meta: { source: TranscriptSource; sequence: number }) => {
        chunks.push({ source: meta.source, sequence: meta.sequence });
      },
      sendStreamState: (payload: { source: TranscriptSource; state: string; error?: string }) => {
        states.push(payload);
      },
    },
  });
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getDisplayMedia: () => acquire('interviewer'),
      getUserMedia: () => acquire('candidate'),
    },
  });
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);

  // The worker registers its listeners on import, so each test gets a fresh
  // module and therefore fresh graphs and counters.
  vi.resetModules();
  await import('../../src/renderer/audio-worker/index.js');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NFR-002 a stop during a start releases the capture', () => {
  it('releases a stream that arrives after the stop', async () => {
    startListener({ streams: ['candidate'] });
    await settle();
    stopListener();

    const stream = await grantNextStream();

    expect(stream.live).toBe(false);
    expect(statesFor('candidate')).not.toContain('running');
    expect(statesFor('candidate').at(-1)).toBe('idle');
  });

  it('releases the stream and the context when the stop lands during the worklet load', async () => {
    startListener({ streams: ['interviewer'] });
    const stream = await grantNextStream();
    stopListener();

    await loadNextModule();

    expect(stream.live).toBe(false);
    expect(contexts.every((c) => c.closed)).toBe(true);
    expect(statesFor('interviewer')).not.toContain('running');
    expect(statesFor('interviewer').at(-1)).toBe('idle');
  });

  it('sends no chunk after the stop, even from a graph that finished starting late', async () => {
    startListener({ streams: ['candidate'] });
    await grantNextStream();
    stopListener();
    await loadNextModule();

    for (const node of nodes) node.emit();

    expect(chunks).toEqual([]);
  });
});

describe('FR-045 overlapping starts leave one graph', () => {
  it('orphans no stream when a second start arrives during the first', async () => {
    startListener({ streams: ['candidate'] });
    await settle();
    startListener({ streams: ['candidate'] });

    // Answer every acquisition and worklet load, in whatever order they are
    // asked for, until the worker has nothing left pending.
    for (let i = 0; i < 4 && (acquisitions.length > 0 || moduleLoads.length > 0); i += 1) {
      if (acquisitions.length > 0) await grantNextStream();
      if (moduleLoads.length > 0) await loadNextModule();
      await settle();
    }

    expect(streams.filter((s) => s.live)).toHaveLength(1);
    expect(contexts.filter((c) => !c.closed)).toHaveLength(1);

    stopListener();
    await settle();

    expect(streams.filter((s) => s.live)).toEqual([]);
    expect(contexts.filter((c) => !c.closed)).toEqual([]);
  });
});

describe('FR-046 teardown always completes', () => {
  it('reports idle even when closing the context fails', async () => {
    startListener({ streams: ['candidate'] });
    const stream = await grantNextStream();
    await loadNextModule();
    expect(statesFor('candidate').at(-1)).toBe('running');

    closeFails = true;
    stopListener();
    await settle();

    expect(stream.live).toBe(false);
    expect(statesFor('candidate').at(-1)).toBe('idle');
  });

  it('starts the next session counting from one after a failed close', async () => {
    startListener({ streams: ['candidate'] });
    await grantNextStream();
    await loadNextModule();
    nodes.at(-1)!.emit();

    closeFails = true;
    stopListener();
    await settle();
    closeFails = false;

    startListener({ streams: ['candidate'] });
    await grantNextStream();
    await loadNextModule();
    nodes.at(-1)!.emit();

    expect(chunks.map((c) => c.sequence)).toEqual([1, 1]);
  });
});
