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
      exclude: ['src/main/index.ts', 'src/main/ai/stt/ws-factory.ts', 'src/main/rag/**'],
      thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 },
    },
  },
});
