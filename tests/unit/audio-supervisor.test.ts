import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AudioSupervisor,
  MAX_CHUNKS_IN_FLIGHT,
  MAX_STREAM_RESTARTS,
  type AudioWorkerHandle,
} from '../../src/main/audio.js';
import type { AudioChunk, TranscriptSource } from '../../src/shared/types.js';

/** A worker that records what it was asked to do, with no Electron involved. */
function fakeWorker(): AudioWorkerHandle & {
  starts: TranscriptSource[][];
  stopped: number;
  destroyed: number;
} {
  const starts: TranscriptSource[][] = [];
  let stopped = 0;
  let destroyed = 0;
  return {
    starts,
    get stopped() {
      return stopped;
    },
    get destroyed() {
      return destroyed;
    },
    start: async (streams) => {
      starts.push([...streams]);
    },
    stop: async () => {
      stopped += 1;
    },
    destroy: async () => {
      destroyed += 1;
    },
  };
}

function chunk(source: TranscriptSource, sequence: number): AudioChunk {
  return { source, pcm: new ArrayBuffer(32000), timestamp: Date.now(), sequence };
}

let worker: ReturnType<typeof fakeWorker>;

beforeEach(() => {
  worker = fakeWorker();
});

/** TC-041: the supervisor half of bounded retention (ADR-027). */
describe('TC-041 the supervisor retains no chunk', () => {
  it('holds nothing once a chunk has been handed on', () => {
    const supervisor = new AudioSupervisor({ worker, onChunk: () => {} });
    supervisor.handleChunk(chunk('interviewer', 1));
    expect(supervisor.chunksInFlight).toBe(0);
  });

  it('never exceeds the declared bound across a long run', () => {
    const supervisor = new AudioSupervisor({ worker, onChunk: () => {} });
    for (let i = 1; i <= 600; i += 1) {
      supervisor.handleChunk(chunk('interviewer', i));
      supervisor.handleChunk(chunk('candidate', i));
    }
    expect(supervisor.peakChunksInFlight).toBeLessThanOrEqual(MAX_CHUNKS_IN_FLIGHT);
    expect(supervisor.chunksInFlight).toBe(0);
  });

  it('releases the chunk even when the consumer throws', () => {
    // A consumer that throws must not leak a slot, or the count drifts upward
    // and the bound becomes meaningless exactly when something is going wrong.
    const supervisor = new AudioSupervisor({
      worker,
      onChunk: () => {
        throw new Error('consumer exploded');
      },
    });

    expect(() => supervisor.handleChunk(chunk('interviewer', 1))).toThrow('consumer exploded');
    expect(supervisor.chunksInFlight).toBe(0);
  });

  it('counts a chunk as in flight only while the consumer is running', () => {
    let observed = -1;
    const supervisor = new AudioSupervisor({
      worker,
      onChunk: () => {
        observed = supervisor.chunksInFlight;
      },
    });
    supervisor.handleChunk(chunk('candidate', 1));

    expect(observed).toBe(1);
    expect(supervisor.chunksInFlight).toBe(0);
  });
});

describe('chunk routing', () => {
  it('passes the chunk through unchanged, with its source tag', () => {
    const seen: AudioChunk[] = [];
    const supervisor = new AudioSupervisor({ worker, onChunk: (c) => seen.push(c) });

    supervisor.handleChunk(chunk('interviewer', 1));
    supervisor.handleChunk(chunk('candidate', 2));

    expect(seen.map((c) => c.source)).toEqual(['interviewer', 'candidate']);
    expect(seen[0]!.pcm.byteLength).toBe(32000);
  });

  it('marks a source running once its first chunk arrives', () => {
    const supervisor = new AudioSupervisor({ worker, onChunk: () => {} });
    expect(supervisor.statusFor('interviewer').state).toBe('idle');

    supervisor.handleChunk(chunk('interviewer', 1));

    expect(supervisor.statusFor('interviewer').state).toBe('running');
    expect(supervisor.statusFor('candidate').state).toBe('idle');
  });

  it('detects a dropped chunk from the sequence', () => {
    // A gap means audio was lost, which later reads as a transcript missing a
    // clause rather than as an obvious failure.
    const supervisor = new AudioSupervisor({ worker, onChunk: () => {} });
    supervisor.handleChunk(chunk('interviewer', 1));

    expect(supervisor.hasSequenceGap('interviewer', 2)).toBe(false);
    expect(supervisor.hasSequenceGap('interviewer', 4)).toBe(true);
  });

  it('reports no gap for the first chunk of a source', () => {
    const supervisor = new AudioSupervisor({ worker, onChunk: () => {} });
    expect(supervisor.hasSequenceGap('candidate', 7)).toBe(false);
  });
});

/** TC-044: an unexpected stream end retries 3 times, then reports. */
describe('TC-044 stream restart', () => {
  it('restarts exactly MAX_STREAM_RESTARTS times before giving up', async () => {
    const supervisor = new AudioSupervisor({ worker, onChunk: () => {} });
    await supervisor.start();
    worker.starts.length = 0;

    for (let i = 0; i < MAX_STREAM_RESTARTS; i += 1) {
      expect(await supervisor.handleStreamEnded('interviewer', 'device lost')).toBe(true);
    }
    expect(await supervisor.handleStreamEnded('interviewer', 'device lost')).toBe(false);

    expect(worker.starts).toHaveLength(MAX_STREAM_RESTARTS);
    const status = supervisor.statusFor('interviewer');
    expect(status.state).toBe('error');
    expect(status.error).toContain('gave up');
  });

  it('restarts only the stream that died', async () => {
    const supervisor = new AudioSupervisor({ worker, onChunk: () => {} });
    await supervisor.start();
    worker.starts.length = 0;

    await supervisor.handleStreamEnded('candidate', 'mic unplugged');

    expect(worker.starts).toEqual([['candidate']]);
    expect(supervisor.statusFor('interviewer').state).toBe('starting');
  });

  it('does not restart anything after stop', async () => {
    const supervisor = new AudioSupervisor({ worker, onChunk: () => {} });
    await supervisor.start();
    await supervisor.stop();
    worker.starts.length = 0;

    expect(await supervisor.handleStreamEnded('interviewer', 'late event')).toBe(false);
    expect(worker.starts).toHaveLength(0);
  });
});

/** TC-043: a dead interviewer stream must block session start (FR-044). */
describe('TC-043 the interviewer stream gates a session', () => {
  it('refuses to start a session when system audio failed', () => {
    const supervisor = new AudioSupervisor({ worker, onChunk: () => {} });
    supervisor.markUnavailable('interviewer', 'No system audio device was found.');

    const verdict = supervisor.canStartSession();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('No system audio device');
  });

  it('allows a session when only the candidate stream failed', () => {
    // Losing the microphone costs context, not the product. Losing system audio
    // means there is nothing to react to at all.
    const supervisor = new AudioSupervisor({ worker, onChunk: () => {} });
    supervisor.markUnavailable('candidate', 'No microphone was found.');

    expect(supervisor.canStartSession().ok).toBe(true);
    expect(supervisor.statusFor('candidate').state).toBe('error');
  });

  it('allows a session when both streams are healthy', () => {
    const supervisor = new AudioSupervisor({ worker, onChunk: () => {} });
    expect(supervisor.canStartSession().ok).toBe(true);
  });
});

/** TC-045: teardown releases everything (FR-046). */
describe('TC-045 teardown', () => {
  it('stops and destroys the worker, and resets every stream', async () => {
    const supervisor = new AudioSupervisor({ worker, onChunk: () => {} });
    await supervisor.start();
    supervisor.handleChunk(chunk('interviewer', 1));

    await supervisor.stop();

    expect(worker.stopped).toBe(1);
    expect(worker.destroyed).toBe(1);
    expect(supervisor.statusFor('interviewer')).toMatchObject({
      state: 'idle',
      restarts: 0,
      received: 0,
    });
    expect(supervisor.chunksInFlight).toBe(0);
  });

  it('is safe to call twice', async () => {
    const supervisor = new AudioSupervisor({ worker, onChunk: () => {} });
    await supervisor.start();
    await supervisor.stop();
    await supervisor.stop();

    expect(worker.stopped).toBe(1);
  });

  it('clears the sequence history, so a restart is not a gap', async () => {
    const supervisor = new AudioSupervisor({ worker, onChunk: () => {} });
    await supervisor.start();
    supervisor.handleChunk(chunk('interviewer', 99));
    await supervisor.stop();

    expect(supervisor.hasSequenceGap('interviewer', 1)).toBe(false);
  });
});

describe('lifecycle guards', () => {
  it('refuses to start twice', async () => {
    const supervisor = new AudioSupervisor({ worker, onChunk: () => {} });
    await supervisor.start();
    await expect(supervisor.start()).rejects.toThrow(/already running/i);
  });

  it('starts both sources', async () => {
    const supervisor = new AudioSupervisor({ worker, onChunk: () => {} });
    await supervisor.start();
    expect(worker.starts[0]).toEqual(['interviewer', 'candidate']);
  });

  it('reports state changes to the Dashboard callback', async () => {
    const seen: string[] = [];
    const supervisor = new AudioSupervisor({
      worker,
      onChunk: () => {},
      onStreamState: (source, status) => seen.push(`${source}:${status.state}`),
    });

    await supervisor.start();
    supervisor.handleChunk(chunk('interviewer', 1));

    expect(seen).toContain('interviewer:starting');
    expect(seen).toContain('interviewer:running');
  });

  it('throws on an unknown source rather than guessing', () => {
    const supervisor = new AudioSupervisor({ worker, onChunk: vi.fn() });
    expect(() => supervisor.statusFor('nope' as TranscriptSource)).toThrow(/unknown audio source/i);
  });
});
