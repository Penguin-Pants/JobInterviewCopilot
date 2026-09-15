import { defineConfig } from '@playwright/test';

/**
 * Electron end-to-end tests (ADR-004).
 *
 * These drive real windows, real IPC and the real preload bridge, so they only
 * mean anything on the target platform. CI runs them on a Windows runner; they
 * are skipped elsewhere rather than passing vacuously.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: { trace: 'retain-on-failure' },
});
