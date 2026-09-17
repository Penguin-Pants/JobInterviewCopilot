/**
 * TASK-051, TC-165 and TC-166. The two gates the release pipeline is made of.
 *
 * Both are checked the way `tests/integration/licenses.test.ts` checks the
 * license gate: by running the real script against fixtures, including
 * fixtures that must fail. A gate nobody has watched reject anything is a gate
 * nobody knows is closed.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const CHECK_PACKAGED = join(ROOT, 'scripts/check-packaged.mjs');
const CHECK_RECORD = join(ROOT, 'scripts/check-release-record.mjs');

const VERSION = (
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
).version;

const dirs: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/**
 * Run a gate. Returns its exit code and **both** streams.
 *
 * `spawnSync` rather than `execFileSync`, which returns stdout alone: the
 * non-blocking MW-12 note is a warning on a run that succeeds, so a helper that
 * dropped stderr on the success path could not see it.
 */
function run(script: string, args: string[]): { code: number; output: string } {
  const result = spawnSync('node', [script, ...args], { encoding: 'utf8' });
  return { code: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/* ------------------------------------------------------------------ *
 * The packaged app (NFR-011, the open TASK-025 follow-up)
 * ------------------------------------------------------------------ */

interface PackageShape {
  /** Modules to unpack, each with the files it should contain. */
  unpacked?: Record<string, string[]>;
  installerBytes?: number;
  installerName?: string;
  omitAsar?: boolean;
  omitUnpackedDir?: boolean;
}

/** A `release/` tree shaped like electron-builder's, built to order. */
function fakeRelease(shape: PackageShape = {}): string {
  const release = tmp('icp-release-');
  const resources = join(release, 'win-unpacked', 'resources');
  mkdirSync(resources, { recursive: true });

  if (!shape.omitAsar) writeFileSync(join(resources, 'app.asar'), 'x'.repeat(64));

  const unpacked = shape.unpacked ?? {
    'onnxruntime-node': ['bin/onnxruntime_binding.node'],
    chokidar: ['esm/index.js'],
    readdirp: ['esm/index.js'],
  };

  if (!shape.omitUnpackedDir) {
    for (const [module, files] of Object.entries(unpacked)) {
      const moduleDir = join(resources, 'app.asar.unpacked', 'node_modules', module);
      mkdirSync(moduleDir, { recursive: true });
      for (const file of files) {
        const path = join(moduleDir, file);
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, 'x');
      }
    }
  }

  const name = shape.installerName ?? `Interview CoPilot-${VERSION}-x64.exe`;
  writeFileSync(join(release, name), 'x'.repeat(shape.installerBytes ?? 2_000_000));
  return release;
}

describe('TC-165 the packaged app is checked, not assumed', () => {
  it('passes on a package whose unpacked modules are real files', () => {
    const { code, output } = run(CHECK_PACKAGED, [fakeRelease()]);
    expect(output).toContain('onnxruntime-node');
    expect(code).toBe(0);
  });

  it('fails when a native addon was left inside the archive', () => {
    // The exact failure `asarUnpack` exists to prevent. `process.dlopen` cannot
    // open a file inside an asar, and nothing before this caught it: the
    // installer still builds, and the app only breaks when it tries to embed.
    const { code, output } = run(CHECK_PACKAGED, [
      fakeRelease({ unpacked: { chokidar: ['esm/index.js'], readdirp: ['esm/index.js'] } }),
    ]);
    expect(code).toBe(1);
    expect(output).toContain('onnxruntime-node was not unpacked');
  });

  it('fails when a module is unpacked but carries no binary', () => {
    // A glob that matched the package directory but none of its contents.
    const { code, output } = run(CHECK_PACKAGED, [
      fakeRelease({
        unpacked: {
          'onnxruntime-node': ['package.json'],
          chokidar: ['esm/index.js'],
          readdirp: ['esm/index.js'],
        },
      }),
    ]);
    expect(code).toBe(1);
    expect(output).toContain('contains no .node file');
  });

  it('fails when every unpack glob matched nothing', () => {
    const { code, output } = run(CHECK_PACKAGED, [fakeRelease({ omitUnpackedDir: true })]);
    expect(code).toBe(1);
    expect(output).toContain('matched');
  });

  it('fails when the ESM-only watcher was left inside the archive', () => {
    const { code, output } = run(CHECK_PACKAGED, [
      fakeRelease({
        unpacked: {
          'onnxruntime-node': ['bin/onnxruntime_binding.node'],
          readdirp: ['esm/index.js'],
        },
      }),
    ]);
    expect(code).toBe(1);
    expect(output).toContain('chokidar was not unpacked');
  });

  it('fails on a truncated installer, which a build that died late produces', () => {
    const { code, output } = run(CHECK_PACKAGED, [fakeRelease({ installerBytes: 12 })]);
    expect(code).toBe(1);
    expect(output).toContain('That is not an installer');
  });

  it('fails when no installer carries the package version and x64', () => {
    // NFR-011 is x64 only, and a release record cites the installer by name.
    const { code, output } = run(CHECK_PACKAGED, [
      fakeRelease({ installerName: 'Interview CoPilot-ia32.exe' }),
    ]);
    expect(code).toBe(1);
    expect(output).toContain('No installer matching');
  });

  it('fails when the app was never packaged into an archive', () => {
    const { code, output } = run(CHECK_PACKAGED, [fakeRelease({ omitAsar: true })]);
    expect(code).toBe(1);
    expect(output).toContain('app.asar');
  });
});

/* ------------------------------------------------------------------ *
 * The release record (TASK-051 acceptance criterion 4)
 * ------------------------------------------------------------------ */

/** Every id the real checklist requires, read the way the gate reads it. */
function requiredIds(): string[] {
  const strategy = readFileSync(join(ROOT, 'docs/04-test-strategy.md'), 'utf8');
  const start = strategy.indexOf('## 6.');
  const rest = strategy.slice(start + 1);
  const end = rest.indexOf('\n## ');
  const section = end === -1 ? rest : rest.slice(0, end);
  const ids = [...section.matchAll(/^\|\s*(MW-\d+)\s*\|/gm)].map((m) => m[1]!);
  return ['TC-001', ...[...new Set(ids)].sort()];
}

interface RecordShape {
  tag?: string;
  omitField?: string;
  results?: Record<string, string>;
  evidence?: Record<string, string>;
  omitRows?: string[];
  extraRows?: string[];
}

/** A passing record, with the named parts bent out of shape. */
function fakeRecord(tag: string, shape: RecordShape = {}): string {
  const dir = tmp('icp-records-');
  const lines: string[] = ['# Release record', ''];
  for (const [name, value] of [
    ['Tag', shape.tag ?? tag],
    ['Commit', 'a'.repeat(40)],
    ['Tester', 'A Person'],
    ['Date', '2026-09-17'],
  ]) {
    if (shape.omitField === name) continue;
    lines.push(`**${name}** ${value}`);
  }
  lines.push('', '| ID | Result | Evidence |', '|---|---|---|');

  for (const id of requiredIds()) {
    if (shape.omitRows?.includes(id)) continue;
    const result = shape.results?.[id] ?? (id === 'MW-12' ? 'NOTED' : 'PASS');
    const fallback =
      id === 'MW-06'
        ? 'p50 1.9 s, p95 3.4 s over 20 turns'
        : id === 'MW-11'
          ? 'p50 5.8 s, p95 8.9 s over 20 turns'
          : 'checked on both machines';
    lines.push(`| ${id} | ${result} | ${shape.evidence?.[id] ?? fallback} |`);
  }
  for (const extra of shape.extraRows ?? []) lines.push(extra);

  writeFileSync(join(dir, `${tag}.md`), `${lines.join('\n')}\n`);
  return dir;
}

describe('TC-166 a release is gated on its recorded checklist', () => {
  it('passes a complete record with every check accounted for', () => {
    const { code, output } = run(CHECK_RECORD, ['v1.0.0', `--dir=${fakeRecord('v1.0.0')}`]);
    expect(output).toContain('none blocking');
    expect(code).toBe(0);
  });

  it('blocks when the record is missing entirely', () => {
    const { code, output } = run(CHECK_RECORD, ['v9.9.9', `--dir=${tmp('icp-records-')}`]);
    expect(code).toBe(1);
    expect(output).toContain('No record at');
  });

  it('blocks on any failed check', () => {
    const dir = fakeRecord('v1.0.0', {
      results: { 'MW-01': 'FAIL' },
      evidence: { 'MW-01': 'the overlay appeared in the Teams share' },
    });
    const { code, output } = run(CHECK_RECORD, ['v1.0.0', `--dir=${dir}`]);
    expect(code).toBe(1);
    expect(output).toContain('MW-01 failed');
  });

  it('does not block on MW-12, which confirms a documented limitation', () => {
    // TASK-051 says so explicitly: MW-12 records what ADR-021 predicts, so its
    // finding is information rather than a defect.
    const dir = fakeRecord('v1.0.0', {
      results: { 'MW-12': 'FAIL' },
      evidence: { 'MW-12': 'music and a notification both transcribed, as predicted' },
    });
    const { code, output } = run(CHECK_RECORD, ['v1.0.0', `--dir=${dir}`]);
    expect(output).toContain('does not block');
    expect(code).toBe(0);
  });

  it('blocks when a check has no row at all', () => {
    const dir = fakeRecord('v1.0.0', { omitRows: ['MW-07'] });
    const { code, output } = run(CHECK_RECORD, ['v1.0.0', `--dir=${dir}`]);
    expect(code).toBe(1);
    expect(output).toContain('MW-07 has no row');
  });

  it('blocks when a blocking check is marked NOTED', () => {
    // Otherwise NOTED becomes the way to wave a failure through.
    const dir = fakeRecord('v1.0.0', { results: { 'MW-04': 'NOTED' } });
    const { code, output } = run(CHECK_RECORD, ['v1.0.0', `--dir=${dir}`]);
    expect(code).toBe(1);
    expect(output).toContain('MW-04 is NOTED');
  });

  it('blocks when MW-06 records a verdict but no latency numbers', () => {
    const dir = fakeRecord('v1.0.0', { evidence: { 'MW-06': 'felt fast enough' } });
    const { code, output } = run(CHECK_RECORD, ['v1.0.0', `--dir=${dir}`]);
    expect(code).toBe(1);
    expect(output).toContain('MW-06 must record measured p50 and p95');
  });

  it('blocks when MW-11 records only a p50', () => {
    const dir = fakeRecord('v1.0.0', { evidence: { 'MW-11': 'p50 5.8 s over 20 turns' } });
    const { code, output } = run(CHECK_RECORD, ['v1.0.0', `--dir=${dir}`]);
    expect(code).toBe(1);
    expect(output).toContain('MW-11 must record measured p50 and p95');
  });

  it('blocks a record copied from the previous release', () => {
    const dir = fakeRecord('v1.0.0', { tag: 'v0.9.0' });
    const { code, output } = run(CHECK_RECORD, ['v1.0.0', `--dir=${dir}`]);
    expect(code).toBe(1);
    expect(output).toContain('is for v0.9.0, but the release is v1.0.0');
  });

  it('blocks a row with a result and no evidence', () => {
    const dir = fakeRecord('v1.0.0', { evidence: { 'MW-03': '' } });
    const { code, output } = run(CHECK_RECORD, ['v1.0.0', `--dir=${dir}`]);
    expect(code).toBe(1);
    expect(output).toContain('MW-03 has no evidence');
  });

  it('blocks a record with no tester, so a record has an author', () => {
    const dir = fakeRecord('v1.0.0', { omitField: 'Tester' });
    const { code, output } = run(CHECK_RECORD, ['v1.0.0', `--dir=${dir}`]);
    expect(code).toBe(1);
    expect(output).toContain('no **tester** field');
  });

  it('blocks a check recorded twice, which leaves the outcome ambiguous', () => {
    const dir = fakeRecord('v1.0.0', { extraRows: ['| MW-02 | FAIL | a second run, later |'] });
    const { code, output } = run(CHECK_RECORD, ['v1.0.0', `--dir=${dir}`]);
    expect(code).toBe(1);
    expect(output).toContain('MW-02 appears more than once');
  });

  it('keeps evidence written across an unescaped pipe, rather than truncating it', () => {
    // An unescaped pipe inside a cell is malformed markdown, so "what did the
    // tester mean" has no single answer. Keeping the whole line is the safe
    // reading: truncating at the first pipe would drop the p95 below and then
    // block the release for not having recorded a number that is right there.
    const dir = fakeRecord('v1.0.0', {
      evidence: { 'MW-06': 'p50 1.9 s | p95 3.4 s over 20 turns' },
    });
    const { code, output } = run(CHECK_RECORD, ['v1.0.0', `--dir=${dir}`]);
    expect(output).not.toContain('MW-06 must record');
    expect(code).toBe(0);
  });

  it('is not fooled by the table separator row', () => {
    // `|---|---|---|` is a row shaped like the others. Reading it as a check
    // would put an id no checklist defines into every record.
    const dir = fakeRecord('v1.0.0');
    const { code, output } = run(CHECK_RECORD, ['v1.0.0', `--dir=${dir}`]);
    expect(output).not.toContain('is recorded but is not a checklist id');
    expect(code).toBe(0);
  });

  it('requires every MW id the checklist defines, read from the checklist itself', () => {
    // The gate derives its list from 04-test-strategy.md, so a checklist that
    // grows a row does not leave the gate behind still requiring the old set.
    const ids = requiredIds();
    expect(ids).toContain('TC-001');
    expect(ids).toContain('MW-01');
    expect(ids).toContain('MW-14');
    expect(ids.length).toBeGreaterThanOrEqual(15);
  });
});

/* ------------------------------------------------------------------ *
 * The shipped template
 * ------------------------------------------------------------------ */

describe('TC-166 the template matches the checklist', () => {
  it('carries a row for every required check', () => {
    const template = readFileSync(join(ROOT, 'releases/TEMPLATE.md'), 'utf8');
    for (const id of requiredIds()) {
      expect(template, `releases/TEMPLATE.md has no ${id} row`).toContain(`| ${id} |`);
    }
  });

  it('is not itself mistaken for a release record', () => {
    // It has no results, so it would block every release if the gate read it.
    const { code } = run(CHECK_RECORD, [`--dir=${join(ROOT, 'releases')}`]);
    expect(code).toBe(0);
  });
});
