import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
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
