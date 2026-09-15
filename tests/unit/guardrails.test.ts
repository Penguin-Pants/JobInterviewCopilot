import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The lint rules that carry guardrails rather than style.
 * These run eslint for real against fixtures, so a weakened rule fails here.
 */

function lintFixture(relPath: string, source: string): string {
  // Node path and fs throughout. A shell `rm` and a hard-coded '/' would fail
  // on Windows, where a developer can legitimately run the unit suite.
  const absolute = join(process.cwd(), relPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, source, 'utf8');
  try {
    execSync(`npx eslint ${relPath} --format json`, { encoding: 'utf8', stdio: 'pipe' });
    return '';
  } catch (err) {
    const e = err as { stdout?: string };
    return e.stdout ?? '';
  } finally {
    rmSync(absolute, { force: true });
  }
}

/**
 * TC-042: no filesystem import anywhere on the reachable audio path.
 * The rule must cover the STT layer, not just where the audio starts:
 * transferring the buffer neuters the worker's reference, it does not stop a
 * downstream adapter from persisting the bytes it receives (NFR-002, ADR-019).
 */
describe('TC-042 no filesystem on the audio path', () => {
  const offending = "import { writeFileSync } from 'node:fs';\nexport const x = writeFileSync;\n";

  const paths = ['src/renderer/audio-worker/__fixture.ts', 'src/main/ai/stt/__fixture.ts'];

  for (const path of paths) {
    it(`rejects an fs import in ${path}`, () => {
      const output = lintFixture(path, offending);
      expect(output).toContain('never reach the filesystem');
    });
  }

  it('the rule covers all four documented locations, not just the first two', () => {
    const config = readFileSync('eslint.config.mjs', 'utf8');
    for (const p of [
      'src/renderer/audio-worker/**/*.ts',
      'src/main/audio.ts',
      'src/main/ai/stt.ts',
      'src/main/ai/stt/**/*.ts',
    ]) {
      expect(config, `audio path missing: ${p}`).toContain(p);
    }
  });
});

/** TC-001: the RAG facade is the only public surface (CMP-06). */
describe('deep imports into the RAG engine are forbidden', () => {
  it('rejects a deep import from outside the facade', () => {
    const output = lintFixture(
      'src/main/__fixture-rag.ts',
      "import { chunk } from './rag/chunk.js';\nexport const c = chunk;\n",
    );
    expect(output).toContain('Deep import into the RAG engine');
  });
});

/** NFR-016: vendored code is invisible to the npm license check. */
describe('NFR-016 vendored components are declared', () => {
  it('VENDORED.md exists', () => {
    expect(existsSync('VENDORED.md')).toBe(true);
  });
});

/** TC-146 is exercised against the real checker in the integration suite. */
describe('TC-146 license checker exists', () => {
  it('scripts/check-licenses.mjs is wired to npm run licenses', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.licenses).toContain('check-licenses.mjs');
    expect(existsSync('scripts/check-licenses.mjs')).toBe(true);
  });
});

/**
 * NFR-002 rests on the lint rule and the runtime write monitor, not on buffer
 * transfer. Electron cannot transfer an ArrayBuffer across IPC: both
 * ipcRenderer.postMessage and MessagePortMain.postMessage accept only
 * MessagePort values in their transfer list, so every buffer is copied. The
 * architecture's "no second copy to leak" claim is therefore wrong and is
 * recorded as OQ-003 for TASK-011. This test pins the real constraint so the
 * claim cannot quietly come back.
 */
describe('NFR-002 buffer transfer is not available in Electron IPC', () => {
  it('the preload documents the copy and does not claim a transfer list', () => {
    const source = readFileSync('src/preload/audioWorker.ts', 'utf8');
    expect(source).toContain('OQ-003');
    expect(source).not.toMatch(/postMessage\([^)]*\[pcm\]/);
  });

  it("Electron's own typings allow only MessagePort in a transfer list", () => {
    const dts = readFileSync('node_modules/electron/electron.d.ts', 'utf8');
    expect(dts).toContain('postMessage(channel: string, message: any, transfer?: MessagePort[])');
  });
});

/** Scratch directory hygiene for the fixtures above. */
describe('fixtures clean up after themselves', () => {
  it('leaves no fixture files behind', () => {
    expect(existsSync('src/renderer/audio-worker/__fixture.ts')).toBe(false);
    expect(existsSync('src/main/ai/stt/__fixture.ts')).toBe(false);
    expect(existsSync('src/main/__fixture-rag.ts')).toBe(false);
  });
  it('tmpdir is writable for the other suites', () => {
    expect(existsSync(mkdtempSync(join(tmpdir(), 'icp-check-')))).toBe(true);
  });
});

/**
 * TC-008 support: the content security policy.
 *
 * Applied twice, as a response header for the dev server and as a meta tag for
 * the packaged app, where renderers load over file:// and header interception
 * is not dependable. Both copies must forbid the same things, and a drift
 * between them is a silent hole, so they are pinned to each other here.
 */
describe('TC-008 content security policy', () => {
  const HTML = [
    'src/renderer/dashboard/index.html',
    'src/renderer/overlay/index.html',
    'src/renderer/audio-worker/index.html',
  ];

  it('every renderer carries a meta CSP', () => {
    for (const file of HTML) {
      expect(readFileSync(file, 'utf8'), file).toContain('Content-Security-Policy');
    }
  });

  it('no policy permits unsafe-eval, and none permits inline script', () => {
    const sources = [
      ...HTML.map((f) => readFileSync(f, 'utf8')),
      readFileSync('src/main/index.ts', 'utf8'),
    ];
    for (const source of sources) {
      const policies = source.match(/script-src[^;"]*/g) ?? [];
      expect(policies.length).toBeGreaterThan(0);
      for (const p of policies) {
        expect(p).not.toContain('unsafe-eval');
        expect(p).not.toContain('unsafe-inline');
      }
    }
  });

  it('the meta tag and the response header agree', () => {
    // Prettier wraps long attributes across lines, so match the policy by its
    // own text rather than by the shape of the tag around it.
    const html = readFileSync(HTML[0]!, 'utf8');
    const meta = /content="(default-src[^"]+)"/s.exec(html)?.[1]?.replace(/\s+/g, ' ') ?? '';
    expect(meta, 'no CSP policy found in the html').toContain('default-src');
    const header = readFileSync('src/main/index.ts', 'utf8');
    for (const directive of meta.split('; ')) {
      expect(header, `header is missing: ${directive}`).toContain(`"${directive}"`);
    }
  });
});
