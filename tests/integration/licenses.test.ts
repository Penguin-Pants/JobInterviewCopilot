import { execSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/**
 * Load the gate's own `identifyFromText` without running the whole script.
 *
 * The function is not exported, so the block that defines it is extracted and
 * evaluated. Reaching into the real source rather than copying the regexes is
 * the point: a copy would drift and this test would stop testing the gate.
 */
function loadIdentifier(): (dir: string) => string | null {
  const source = readFileSync('scripts/check-licenses.mjs', 'utf8');
  const body = source.slice(
    source.indexOf('const ADVERTISING_CLAUSE'),
    source.indexOf('function expressionIsAllowed'),
  );
  const factory = new Function(
    'existsSync',
    'readFileSync',
    'readdirSync',
    'statSync',
    'join',
    `${body}; return identifyFromText;`,
  ) as (...deps: unknown[]) => (dir: string) => string | null;
  return factory(existsSync, readFileSync, readdirSync, statSync, join);
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

  it('identifies BSD-4-Clause rather than reading it as BSD-3-Clause', () => {
    // A BSD-4-Clause text contains the whole BSD-3-Clause text, including the
    // non-endorsement sentence the gate used to identify three-clause by. A
    // dependency declaring the ambiguous bare `BSD` was therefore resolved to an
    // allowed license and passed, even though four-clause is not on the list.
    const dir = mkdtempSync(join(tmpdir(), 'icp-bsd4-'));
    writeFileSync(
      join(dir, 'LICENSE'),
      [
        'Redistribution and use in source and binary forms are permitted',
        'provided that the following conditions are met:',
        '',
        '3. All advertising materials mentioning features or use of this software',
        '   must display the following acknowledgement.',
        '4. Neither the name of the Organization nor the names of its',
        '   contributors may be used to endorse or promote products derived from',
        '   this software without specific prior written permission.',
      ].join('\n'),
      'utf8',
    );

    const identify = loadIdentifier();
    expect(identify(dir)).toBe('BSD-4-Clause');

    // And a genuine three-clause text is still identified as three-clause.
    const three = mkdtempSync(join(tmpdir(), 'icp-bsd3-'));
    writeFileSync(
      join(three, 'LICENSE'),
      [
        'Redistribution and use in source and binary forms, with or without',
        'modification, are permitted provided that the following conditions are met:',
        '',
        '3. Neither the name of the Organization nor the names of its',
        '   contributors may be used to endorse or promote products derived from',
        '   this software without specific prior written permission.',
      ].join('\n'),
      'utf8',
    );
    expect(identify(three)).toBe('BSD-3-Clause');
  });

  it('does not allow BSD-4-Clause', () => {
    const source = readFileSync('scripts/check-licenses.mjs', 'utf8');
    const allowed = source.slice(source.indexOf('const ALLOWED = ['), source.indexOf('];'));
    expect(allowed).not.toContain('BSD-4-Clause');
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
