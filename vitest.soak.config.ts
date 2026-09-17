import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { soakMinutes } from './tests/soak/duration.js';

/**
 * TC-131 only. Its own config rather than a third project in `vitest.config.ts`,
 * because `vitest run --coverage` runs every project and a pull request must not
 * wait an hour for the soak (`04-test-strategy.md` section 5).
 *
 * Run it with `npm run test:soak`. `SOAK_MINUTES` shortens it for a local smoke
 * check; the nightly job leaves it unset and gets the full hour.
 */
const minutes = soakMinutes();

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    name: 'soak',
    include: ['tests/soak/**/*.test.ts'],
    environment: 'node',
    // The run itself, plus enough slack for start-up, the final stop and the
    // compaction of an hour-long transcript.
    testTimeout: minutes * 60_000 + 120_000,
    hookTimeout: 60_000,
    teardownTimeout: 60_000,
  },
});
