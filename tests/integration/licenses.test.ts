import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * TC-146: the license gate fails on a vendored file with no VENDORED.md entry
 * (NFR-016), and passes on the real dependency tree (NFR-015).
 */

const FIXTURE_DIR = 'src/renderer/overlay/vendor';
const FIXTURE = `${FIXTURE_DIR}/__fixture-card.tsx`;

function runChecker(): { code: number; output: string } {
  try {
    const output = execSync('node scripts/check-licenses.mjs', { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

afterEach(() => {
  if (existsSync(FIXTURE_DIR)) rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe('TC-146 license gate', () => {
  it('passes on the current dependency tree', () => {
    const result = runChecker();
    expect(result.output).toContain('License check passed');
    expect(result.code).toBe(0);
  });

  it('fails when a vendored file has no VENDORED.md entry', () => {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(FIXTURE, 'export const Card = () => null;\n', 'utf8');

    const result = runChecker();

    expect(result.code).toBe(1);
    expect(result.output).toContain('not declared in VENDORED.md');
    expect(result.output).toContain('__fixture-card.tsx');
  });

  it('VENDORED.md documents why it exists and what a row must carry', () => {
    const manifest = readFileSync('VENDORED.md', 'utf8');
    expect(manifest).toContain('NFR-016');
    expect(manifest).toContain('license');
  });
});
