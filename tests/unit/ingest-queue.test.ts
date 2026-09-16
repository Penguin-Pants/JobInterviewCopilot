import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IngestQueue,
  KnowledgeBaseWatcher,
  STABILITY_DEBOUNCE_MS,
  type FileWatcher,
} from '../../src/main/rag/watch.js';

/**
 * TASK-025. The coalescing half of TC-079, driven with fake timers so the
 * "exactly one re-embed" assertion does not depend on a real debounce elapsing.
 */

/** A watcher whose events a test emits by hand. */
class FakeWatcher implements FileWatcher {
  readonly handlers = new Map<string, ((value: never) => void)[]>();
  closed = false;

  on(event: string, handler: (value: never) => void): FileWatcher {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  emit(event: string, value: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(value as never);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

describe('TC-079 ingest queue coalescing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('collapses five rapid writes to one run', async () => {
    const process = vi.fn(async () => {});
    const queue = new IngestQueue({ process, remove: async () => {} });

    for (let i = 0; i < 5; i += 1) {
      queue.enqueue('p1', '/kb/a.md', 'change');
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(STABILITY_DEBOUNCE_MS);

    expect(process).toHaveBeenCalledTimes(1);
    expect(process).toHaveBeenCalledWith('p1', '/kb/a.md');
  });

  it('runs once more when a write lands while the first run is still going', async () => {
    let release = (): void => {};
    const process = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const queue = new IngestQueue({ process, remove: async () => {} });

    queue.enqueue('p1', '/kb/a.md', 'change');
    await vi.advanceTimersByTimeAsync(STABILITY_DEBOUNCE_MS);
    expect(process).toHaveBeenCalledTimes(1);

    // Three more saves during the embed collapse into one follow-up run.
    for (let i = 0; i < 3; i += 1) queue.enqueue('p1', '/kb/a.md', 'change');
    await vi.advanceTimersByTimeAsync(STABILITY_DEBOUNCE_MS);
    expect(process).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(process).toHaveBeenCalledTimes(2);
    release();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('lets an unlink arriving mid-run win over the change that preceded it', async () => {
    let release = (): void => {};
    const process = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const remove = vi.fn(async () => {});
    const queue = new IngestQueue({ process, remove });

    queue.enqueue('p1', '/kb/a.md', 'change');
    await vi.advanceTimersByTimeAsync(STABILITY_DEBOUNCE_MS);

    queue.enqueue('p1', '/kb/a.md', 'unlink');
    await vi.advanceTimersByTimeAsync(STABILITY_DEBOUNCE_MS);
    release();
    await vi.advanceTimersByTimeAsync(0);

    expect(remove).toHaveBeenCalledTimes(1);
    expect(process).toHaveBeenCalledTimes(1);
  });

  it('processes two different files independently', async () => {
    const process = vi.fn(async (_profileId: string, _path: string) => {});
    const queue = new IngestQueue({ process, remove: async () => {} });

    queue.enqueue('p1', '/kb/a.md', 'change');
    queue.enqueue('p1', '/kb/b.md', 'add');
    await vi.advanceTimersByTimeAsync(STABILITY_DEBOUNCE_MS);

    expect(process.mock.calls.map((c) => c[1]).sort()).toEqual(['/kb/a.md', '/kb/b.md']);
  });

  it('reports a processing failure without wedging the queue', async () => {
    const onError = vi.fn();
    const process = vi
      .fn<(profileId: string, path: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const queue = new IngestQueue({ process, remove: async () => {}, onError });

    queue.enqueue('p1', '/kb/a.md', 'change');
    await vi.advanceTimersByTimeAsync(STABILITY_DEBOUNCE_MS);
    expect(onError).toHaveBeenCalledTimes(1);

    queue.enqueue('p1', '/kb/a.md', 'change');
    await vi.advanceTimersByTimeAsync(STABILITY_DEBOUNCE_MS);
    expect(process).toHaveBeenCalledTimes(2);
  });

  it('drops pending work on dispose', async () => {
    const process = vi.fn(async () => {});
    const queue = new IngestQueue({ process, remove: async () => {} });

    queue.enqueue('p1', '/kb/a.md', 'change');
    expect(queue.busy).toBe(true);
    queue.dispose();
    await vi.advanceTimersByTimeAsync(STABILITY_DEBOUNCE_MS * 4);

    expect(process).not.toHaveBeenCalled();
    expect(queue.busy).toBe(false);
  });

  it('dispose releases a caller already waiting on drain', async () => {
    const queue = new IngestQueue({ process: async () => {}, remove: async () => {} });
    queue.enqueue('p1', '/kb/a.md', 'change');

    const drained = vi.fn();
    void queue.drain().then(drained);
    queue.dispose();
    await vi.advanceTimersByTimeAsync(0);

    // Without this, a shutdown that disposed the queue left anyone awaiting
    // drain hanging forever: the only place the promise settles is the end of a
    // run that dispose has just guaranteed will never start.
    expect(drained).toHaveBeenCalled();
  });

  it('drain resolves once nothing is queued or running', async () => {
    const process = vi.fn(async () => {});
    const queue = new IngestQueue({ process, remove: async () => {} });

    queue.enqueue('p1', '/kb/a.md', 'change');
    const drained = vi.fn();
    void queue.drain().then(drained);

    await vi.advanceTimersByTimeAsync(STABILITY_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toHaveBeenCalled();
  });
});

describe('TASK-025 watcher wiring', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('routes add, change and unlink to the queue with the right profile', async () => {
    const process = vi.fn(async (_profileId: string, _path: string) => {});
    const remove = vi.fn(async (_profileId: string, _path: string) => {});
    const queue = new IngestQueue({ process, remove });
    const fake = new FakeWatcher();

    const watcher = new KnowledgeBaseWatcher({ queue, factory: () => fake });
    await watcher.watch('p1', '/kb');

    fake.emit('add', '/kb/a.md');
    fake.emit('change', '/kb/b.md');
    fake.emit('unlink', '/kb/c.md');
    await vi.advanceTimersByTimeAsync(STABILITY_DEBOUNCE_MS);

    expect(process.mock.calls.map((c) => c[0])).toEqual(['p1', 'p1']);
    expect(remove).toHaveBeenCalledWith('p1', '/kb/c.md');
  });

  it('watching one profile twice creates one watcher', async () => {
    const queue = new IngestQueue({ process: async () => {}, remove: async () => {} });
    const factory = vi.fn(() => new FakeWatcher());
    const watcher = new KnowledgeBaseWatcher({ queue, factory });

    await watcher.watch('p1', '/kb');
    await watcher.watch('p1', '/kb');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('closes the watcher on unwatch and on closeAll', async () => {
    const queue = new IngestQueue({ process: async () => {}, remove: async () => {} });
    const watchers: FakeWatcher[] = [];
    const watcher = new KnowledgeBaseWatcher({
      queue,
      factory: () => {
        const fake = new FakeWatcher();
        watchers.push(fake);
        return fake;
      },
    });

    await watcher.watch('p1', '/kb/1');
    await watcher.watch('p2', '/kb/2');
    await watcher.unwatch('p1');
    expect(watchers[0]!.closed).toBe(true);
    expect(watchers[1]!.closed).toBe(false);

    await watcher.closeAll();
    expect(watchers[1]!.closed).toBe(true);
  });

  it('forwards a watcher error rather than throwing out of the handler', async () => {
    const onError = vi.fn();
    const queue = new IngestQueue({ process: async () => {}, remove: async () => {} });
    const fake = new FakeWatcher();
    const watcher = new KnowledgeBaseWatcher({ queue, factory: () => fake, onError });

    await watcher.watch('p1', '/kb');
    fake.emit('error', new Error('EACCES'));
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'p1');
  });

  it('a factory that rejects once does not disable watching for that profile', async () => {
    const queue = new IngestQueue({ process: async () => {}, remove: async () => {} });
    const healthy = new FakeWatcher();
    let attempt = 0;
    const watcher = new KnowledgeBaseWatcher({
      queue,
      factory: () => {
        attempt += 1;
        if (attempt === 1) return Promise.reject(new Error('chokidar import failed'));
        return healthy;
      },
    });

    const failing = watcher.watch('p1', '/kb');
    await watcher.unwatch('p1');
    await expect(failing).rejects.toThrow('chokidar import failed');

    // `stopped` was only cleared on the success path, so it kept the id forever:
    // the next watch opened a real watcher, closed it immediately and resolved
    // successfully, leaving kb/ unwatched with nothing reported.
    await watcher.watch('p1', '/kb');
    healthy.emit('add', '/kb/a.md');
    await vi.advanceTimersByTimeAsync(STABILITY_DEBOUNCE_MS);

    expect(healthy.closed).toBe(false);
  });

  it('closeAll also closes a watcher whose start is still in flight', async () => {
    const queue = new IngestQueue({ process: async () => {}, remove: async () => {} });
    const fake = new FakeWatcher();
    let resolveFactory: (value: FileWatcher) => void = () => {};
    const watcher = new KnowledgeBaseWatcher({
      queue,
      factory: () => new Promise<FileWatcher>((resolve) => (resolveFactory = resolve)),
    });

    const started = watcher.watch('p1', '/kb');
    // closeAll iterated `watchers` only, so a profile still starting was missed
    // and its watcher was registered after the close: stop() returned with a
    // live chokidar instance and its file handles still open.
    await watcher.closeAll();
    resolveFactory(fake);
    await started;

    expect(fake.closed).toBe(true);
  });

  it('closes a watcher whose start was still in flight when unwatch arrived', async () => {
    const queue = new IngestQueue({ process: async () => {}, remove: async () => {} });
    const fake = new FakeWatcher();
    let resolveFactory: (value: FileWatcher) => void = () => {};
    const watcher = new KnowledgeBaseWatcher({
      queue,
      factory: () => new Promise<FileWatcher>((resolve) => (resolveFactory = resolve)),
    });

    const started = watcher.watch('p1', '/kb');
    await watcher.unwatch('p1');
    resolveFactory(fake);
    await started;

    expect(fake.closed).toBe(true);
  });
});
