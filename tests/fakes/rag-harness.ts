import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RagEngine, type RagEngineOptions } from '../../src/main/rag.js';
import type { DocumentState, Profile } from '../../src/shared/types.js';
import { FakeEmbedder } from './embedder.js';
import type { FileWatcher } from '../../src/main/rag/watch.js';

/**
 * A `RagEngine` on a throwaway `userData`, with a deterministic embedder.
 *
 * Every RAG integration test needs the same four things: a temp directory, a
 * fake embedder it can count calls on, a profile, and a way to put a file in
 * `kb/`. Collected here so a test reads as its scenario rather than as setup.
 */

/** A watcher a test drives by hand, in place of chokidar. */
export class ManualWatcher implements FileWatcher {
  private readonly handlers = new Map<string, ((value: never) => void)[]>();
  closed = false;

  on(event: string, handler: (value: never) => void): FileWatcher {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  emit(event: 'add' | 'change' | 'unlink' | 'error', value: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(value as never);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export interface Harness {
  dir: string;
  engine: RagEngine;
  embedder: FakeEmbedder;
  /** The watchers the engine opened, keyed by the directory they watch. */
  watchers: Map<string, ManualWatcher>;
  /** Every `CH-213` progress event the engine emitted. */
  progress: { docId: string; state: DocumentState; percent: number }[];
  /** Every `CH-214` model state the engine emitted. */
  modelStates: unknown[];
  /** Write a file straight into a profile's `kb/`, as Explorer would. */
  writeKbFile(profileId: string, name: string, contents: string | Buffer): string;
  /** A source file outside `kb/`, for `doc:import`. */
  writeSourceFile(name: string, contents: string | Buffer): string;
}

export function makeHarness(
  overrides: Partial<RagEngineOptions> = {},
  embedder: FakeEmbedder = new FakeEmbedder(),
): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'icp-rag-'));
  const sources = join(dir, 'sources');
  mkdirSync(sources, { recursive: true });

  const watchers = new Map<string, ManualWatcher>();
  const progress: Harness['progress'] = [];
  const modelStates: unknown[] = [];

  const engine = new RagEngine({
    userDataDir: dir,
    embedder,
    // A real chokidar watcher would put file system timing inside every
    // assertion. The queue's own debounce is unit-tested with fake timers.
    watcherFactory: (directory) => {
      const watcher = new ManualWatcher();
      watchers.set(directory, watcher);
      return watcher;
    },
    debounceMs: 1,
    onDocumentProgress: (docId, state, percent) => progress.push({ docId, state, percent }),
    onModelState: (state) => modelStates.push(state),
    ...overrides,
  });

  return {
    dir,
    engine,
    embedder,
    watchers,
    progress,
    modelStates,
    writeKbFile(profileId, name, contents) {
      const kb = engine.store.kbDir(profileId);
      mkdirSync(kb, { recursive: true });
      const path = join(kb, name);
      writeFileSync(path, contents);
      return path;
    },
    writeSourceFile(name, contents) {
      const path = join(sources, name);
      writeFileSync(path, contents);
      return path;
    },
  };
}

/** Create a profile and return it, for the many tests that need exactly one. */
export async function withProfile(harness: Harness, name = 'Acme'): Promise<Profile> {
  return harness.engine.createProfile(name);
}

export const RESUME_MD = [
  '# Professional Summary',
  'Ten years of experience building distributed systems.',
  '',
  '## Experience',
  'Acme Corp, Senior Engineer. Shipped the billing pipeline.',
  '',
  '## Education',
  'B.S. Computer Science.',
].join('\n');

export const NOTES_MD = [
  '# Company',
  'Founded in 2015 and headquartered in Berlin.',
  '',
  '## Competitors',
  'Two direct competitors, both Series B.',
].join('\n');
