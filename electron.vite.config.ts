import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

/**
 * electron-vite build graph (TASK-001, FR-001).
 *
 * Three renderer entry points are required by the acceptance criteria:
 * dashboard (CMP-13), overlay (CMP-14) and the hidden audio worker (CMP-03b).
 * The audio worker has no UI but is a real renderer, because neither WASAPI
 * loopback nor getUserMedia is reachable from the main process (ADR-005).
 */
export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rollupOptions: { input: resolve(__dirname, 'src/main/index.ts') },
    },
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          dashboard: resolve(__dirname, 'src/preload/dashboard.ts'),
          overlay: resolve(__dirname, 'src/preload/overlay.ts'),
          audioWorker: resolve(__dirname, 'src/preload/audioWorker.ts'),
        },
      },
    },
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  },
  renderer: {
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          dashboard: resolve(__dirname, 'src/renderer/dashboard/index.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay/index.html'),
          audioWorker: resolve(__dirname, 'src/renderer/audio-worker/index.html'),
        },
      },
    },
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  },
});
