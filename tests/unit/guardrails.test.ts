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

/**
 * FR-086 regression: the overlay preload forwarded every invoke channel.
 *
 * Push had a per-window allowlist but invoke did not, so a compromised overlay
 * renderer could write settings, rebind hotkeys or replace credentials. Both
 * directions are now allowlisted, and the overlay's list is deliberately tiny.
 */
describe('FR-086 preload invoke allowlists', () => {
  it('the overlay may invoke only the three channels its UI needs', () => {
    const source = readFileSync('src/preload/overlay.ts', 'utf8');
    const block = /ALLOWED_INVOKE[^=]*=\s*\[([^\]]*)\]/s.exec(source)?.[1] ?? '';
    const channels = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();

    expect(channels).toEqual(['consent:dismiss', 'overlay:ready', 'overlay:savePosition']);
    for (const forbidden of ['secrets:set', 'config:set', 'hotkey:rebind', 'session:start']) {
      expect(block, `overlay must not reach ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('both preloads gate invoke, not just push', () => {
    for (const file of ['src/preload/overlay.ts', 'src/preload/dashboard.ts']) {
      const source = readFileSync(file, 'utf8');
      expect(source, `${file} has no invoke allowlist`).toContain('allowedInvoke');
      expect(source).toMatch(/if \(!allowedInvoke\.has\(channel\)\)/);
    }
  });

  it('no preload exposes a bare ipcRenderer.invoke forwarder', () => {
    for (const file of ['src/preload/overlay.ts', 'src/preload/dashboard.ts']) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/invoke:\s*\(channel,\s*payload\)\s*=>\s*ipcRenderer\.invoke/);
    }
  });
});

/**
 * ADR-016 regression: the overlay reported readiness on mount, while the
 * consent text was still null, because the text only arrived in reply to that
 * very message. The gate opened before the reminder existed.
 */
describe('ADR-016 consent renders before readiness is reported', () => {
  it('the renderer waits for the consent text before reporting ready', () => {
    const source = readFileSync('src/renderer/overlay/Overlay.tsx', 'utf8');
    expect(source).toMatch(/if \(consent === null[^)]*\) return;/);
    expect(source).toContain("invoke('overlay:ready')");
  });

  it('main pushes the consent text on load rather than in reply to ready', () => {
    const source = readFileSync('src/main/index.ts', 'utf8');
    const onLoad = source.slice(source.indexOf('did-finish-load'), source.indexOf("on('moved'"));
    expect(onLoad).toContain("'overlay:consent'");

    const readyHandler = source.slice(source.indexOf("router.handle('overlay:ready'"));
    expect(readyHandler.slice(0, 400)).not.toContain("'overlay:consent'");
  });
});

/**
 * FR-082 / FR-084 regression: a frameless window is not movable just because it
 * accepts mouse events. Without a drag region the interaction toggle made the
 * overlay clickable but immovable, and the `moved` persistence handler could
 * never be reached through the UI.
 */
describe('FR-082 overlay is actually draggable in interactive mode', () => {
  it('declares a drag region and opts controls back out', () => {
    const html = readFileSync('src/renderer/overlay/index.html', 'utf8');
    expect(html).toContain('-webkit-app-region: drag');
    expect(html).toContain('-webkit-app-region: no-drag');
  });

  it('applies the drag region only in interactive mode', () => {
    const source = readFileSync('src/renderer/overlay/Overlay.tsx', 'utf8');
    expect(source).toMatch(/interactive \? \{ 'data-drag-region'/);
  });
});

/**
 * FR-085 / ADR-015 regression: config:set persisted a theme change but never
 * applied it, and the recreation helper was exported and tested yet never
 * called, so the running overlay kept its old appearance until restart.
 */
describe('FR-085 theme changes reach the running overlay', () => {
  it('config:set applies the change rather than only persisting it', () => {
    const source = readFileSync('src/main/index.ts', 'utf8');
    const handler = source.slice(source.indexOf("router.handle('config:set'"));
    expect(handler.slice(0, 300)).toContain('applyThemeChange');
  });

  it('a translucency mode change recreates the overlay', () => {
    const source = readFileSync('src/main/index.ts', 'utf8');
    expect(source).toContain('translucencyChangeNeedsRecreate(');
    const apply = source.slice(source.indexOf('async function applyThemeChange'));
    expect(apply.slice(0, 900)).toContain('createOverlayWindow(after)');
  });
});

/**
 * Regression: closing the Dashboard left the overlay holding the process open,
 * so a second launch lost the single-instance lock and returned early. The user
 * had no Dashboard and no way to open one short of killing the process.
 */
describe('a second launch restores a closed Dashboard', () => {
  it('second-instance recreates rather than returning early', () => {
    const source = readFileSync('src/main/index.ts', 'utf8');
    const handler = source.slice(source.indexOf("app.on('second-instance'"));
    expect(handler.slice(0, 500)).toContain('focusOrRecreateDashboard');
    expect(source).toMatch(/if \(!dashboardWindow \|\| dashboardWindow\.isDestroyed\(\)\)/);
  });
});

/**
 * Regression: electron must never be reachable as a production dependency.
 *
 * `electron-audio-loopback` declares electron as a peer dependency. npm
 * auto-installs peers, so adding that package silently made electron a
 * production dependency, and electron-builder hard-errors on electron outside
 * devDependencies. The only symptom was the Windows installer job failing at
 * `npm run package`, with nothing in the diff obviously about packaging.
 *
 * This is cheap to assert and expensive to rediscover.
 */
describe('electron stays out of production dependencies', () => {
  it('is declared only as a devDependency', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.devDependencies?.electron, 'electron must be a devDependency').toBeDefined();
    expect(pkg.dependencies?.electron, 'electron must not be a dependency').toBeUndefined();
  });

  it('no production dependency pulls electron in as a peer', () => {
    // `npm ls electron --omit=dev` prints the production tree only. A package
    // whose peer dependency is electron shows up here even though nothing
    // declared electron directly.
    //
    // npm exits non-zero when the package is absent, which is the state we
    // want, so the throw carries the answer and has to be read rather than
    // propagated.
    let output: string;
    try {
      output = execSync('npm ls electron --omit=dev --json', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      output = (err as { stdout?: string }).stdout ?? '{}';
    }

    const tree = JSON.parse(output) as { dependencies?: Record<string, unknown> };
    const production = Object.keys(tree.dependencies ?? {});

    expect(
      production,
      `these production dependencies pull electron into the packaged app: ${production.join(', ')}`,
    ).toEqual([]);
  });
});
