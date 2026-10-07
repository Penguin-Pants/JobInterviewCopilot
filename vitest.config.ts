import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const MODULE_PATH = '?modulePath';
const MODULE_PATH_ID = '\0module-path:';

/**
 * electron-vite's `?modulePath` import, for tests (ADR-055).
 *
 * The app build bundles the imported entry as a file of its own and the import
 * is that file's path. The conversion worker is started that way. A worker
 * thread cannot run TypeScript, so here the entry is bundled the same way, to
 * CommonJS with its dependencies external, into a folder under `out/`. The tests then
 * run the real worker rather than a stand-in.
 */
function modulePathForTests(): Plugin {
  const built = new Map<string, Promise<string>>();
  return {
    name: 'test-module-path',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (!source.endsWith(MODULE_PATH)) return null;
      const entry = await this.resolve(source.slice(0, -MODULE_PATH.length), importer, {
        skipSelf: true,
      });
      return entry ? `${MODULE_PATH_ID}${entry.id}` : null;
    },
    async load(id) {
      if (!id.startsWith(MODULE_PATH_ID)) return null;
      const entry = id.slice(MODULE_PATH_ID.length);
      let output = built.get(entry);
      if (!output) {
        // Inside the project, so the bundle resolves `node_modules` the way the
        // app's own build output does. `out/` is ignored by git and by lint.
        // One folder per entry and process, removed when the process exits.
        const outDir = join(__dirname, 'out', 'test-workers', `${process.pid}-${built.size}`);
        mkdirSync(outDir, { recursive: true });
        process.once('exit', () => rmSync(outDir, { recursive: true, force: true }));
        output = build({
          configFile: false,
          logLevel: 'silent',
          build: {
            ssr: entry,
            outDir,
            emptyOutDir: true,
            rollupOptions: { output: { format: 'cjs', entryFileNames: 'worker.cjs' } },
          },
        }).then(() => join(outDir, 'worker.cjs'));
        built.set(entry, output);
      }
      return `export default ${JSON.stringify(await output)};`;
    },
  };
}

export default defineConfig({
  plugins: [modulePathForTests()],
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 20000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/main/**/*.ts', 'src/shared/**/*.ts'],
      // `src/main/ai/**` was excluded before it existed. The STT adapters are
      // driven through an injected socket factory and are measured. Only the
      // file that constructs a real `ws` is unreachable from a unit test.
      //
      // `src/main/rag/**` was excluded for the same reason and is measured now
      // that TASK-020 to TASK-025 exist: the engine takes an injected `Embedder`
      // and an injected watcher factory, so everything but the two functions
      // that construct the real dependencies is reachable from a test.
      exclude: ['src/main/index.ts', 'src/main/ai/stt/ws-factory.ts'],
      thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 },
    },
  },
});
