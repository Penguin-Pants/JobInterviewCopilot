import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INVOKE_CHANNEL_NAMES, type InvokeChannel } from '../../src/shared/ipc.js';

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
      'src/main/audio-host.ts',
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
 * FR-086 regression: `doc:retry` (CH-123) and `model:ensure` (CH-124) were
 * declared in the contract and handled in main, but never added to the
 * Dashboard preload's allowlist, so FR-079's retry and ADR-026's
 * "model not downloaded, retry" action did not exist end to end. Nothing
 * failed: the allowlist is a plain array, so an omission is invisible.
 */
describe('FR-086 the preload allowlists account for every invoke channel', () => {
  /** Channels that belong to a window other than the Dashboard, named on purpose. */
  const NOT_DASHBOARD: InvokeChannel[] = [
    'overlay:savePosition',
    'overlay:ready',
    'consent:dismiss',
  ];

  it('the Dashboard may invoke every channel not explicitly reserved to another window', () => {
    const source = readFileSync('src/preload/dashboard.ts', 'utf8');
    const list = source.slice(
      source.indexOf('const ALLOWED_INVOKE'),
      source.indexOf('const ALLOWED_PUSH'),
    );

    const missing = INVOKE_CHANNEL_NAMES.filter(
      (name) => !NOT_DASHBOARD.includes(name) && !list.includes(`'${name}'`),
    );
    expect(
      missing,
      `declared and handled but not exposed to the Dashboard: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every channel the Dashboard lists is a real channel', () => {
    const source = readFileSync('src/preload/dashboard.ts', 'utf8');
    const list = source.slice(
      source.indexOf('const ALLOWED_INVOKE'),
      source.indexOf('const ALLOWED_PUSH'),
    );
    const listed = [...list.matchAll(/'([a-z]+:[a-zA-Z]+)'/g)].map((m) => m[1]!);

    expect(listed.length).toBeGreaterThan(0);
    for (const name of listed) expect(INVOKE_CHANNEL_NAMES).toContain(name);
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
    const start = source.indexOf("router.handle('config:set'");
    expect(start).toBeGreaterThan(-1);
    // Bounded by the next handler rather than by a character count. A fixed
    // window failed the moment a comment was added inside this handler, which
    // says nothing about whether the theme change is applied.
    const next = source.indexOf('router.handle(', start + 1);
    expect(source.slice(start, next === -1 ? undefined : next)).toContain('applyThemeChange');
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

/**
 * ADR-028 regression: the two details the loopback spike found the hard way.
 *
 * Both are the kind of mistake that produces no error at all. A missing
 * callback leaves getDisplayMedia pending forever, and microphone processing
 * left on degrades the interviewer audio before the transcriber sees it, so the
 * symptom is bad suggestions rather than anything that looks like an audio bug.
 */
describe('ADR-028 loopback acquisition details', () => {
  it('the display-media handler disables the system picker', () => {
    const source = readFileSync('src/main/audio-host.ts', 'utf8');
    expect(source).toContain('useSystemPicker: false');
  });

  it('the handler calls its callback on every path, including failures', () => {
    const source = readFileSync('src/main/audio-host.ts', 'utf8');
    const handler = source.slice(
      source.indexOf('export function installLoopbackHandler'),
      source.indexOf('export function installPermissionHandler'),
    );
    // One for the no-source path, one for the error path, one for success.
    expect((handler.match(/callback\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(handler).toContain('callback({})');
  });

  it('both streams request microphone processing off', () => {
    const source = readFileSync('src/renderer/audio-worker/capture.ts', 'utf8');
    for (const setting of ['autoGainControl', 'echoCancellation', 'noiseSuppression']) {
      expect(source, `${setting} must be requested off`).toMatch(
        new RegExp(`${setting}:\\s*false`),
      );
    }
    // Applied to the loopback stream and the microphone alike.
    expect((source.match(/RAW_AUDIO_CONSTRAINTS/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('the video track is dropped immediately after acquisition', () => {
    // The video is only the vehicle Chromium requires for a display stream.
    // Holding a screen capture in this app would be indefensible.
    const source = readFileSync('src/renderer/audio-worker/capture.ts', 'utf8');
    expect(source).toContain('getVideoTracks()');
    expect(source).toContain('removeTrack(track)');
  });

  it('media permission is granted only to the audio worker', () => {
    const source = readFileSync('src/main/audio-host.ts', 'utf8');
    expect(source).toMatch(/permission === 'media' && isAudioWorker\(contents\)/);
  });

  it('electron-audio-loopback is not imported anywhere', () => {
    const files = execSync('git ls-files src spike', { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);
    const importers = files.filter((f) =>
      readFileSync(f, 'utf8').includes('electron-audio-loopback'),
    );
    // The spike harness may mention it in a comment; an import is the problem.
    const realImports = importers.filter((f) =>
      /(?:import|require)\s*\(?\s*['"]electron-audio-loopback/.test(readFileSync(f, 'utf8')),
    );
    expect(realImports).toEqual([]);
  });
});

/**
 * Regression: CI must never publish a release.
 *
 * electron-builder detects CI and triggers an implicit GitHub Release publish.
 * With no GH_TOKEN it fails, and the installer job goes red *after* building
 * the installer successfully, which reads as a packaging failure and is not
 * one. Its own warning asks for an explicit --publish, and v27 removes the
 * implicit behaviour, so stating it is right regardless.
 */
describe('packaging never publishes from CI', () => {
  it('the package script passes --publish never', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.package).toContain('--publish never');
  });

  it('declares an author, which electron-builder warns about and shows as publisher', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { author?: string };
    expect(pkg.author).toBeTruthy();
  });
});

/**
 * TC-151 and TC-056: the registry drives everything.
 *
 * The acceptance criterion is "a grep finds no branch on a provider id string
 * outside the adapter files and the registry itself". That is asserted here as
 * a grep rather than described in a comment, because a comment does not fail a
 * build when someone writes `if (providerId === 'deepgram')` in the trigger.
 */
describe('TC-151 no provider id outside the registry and its adapters', () => {
  const PROVIDER_IDS = ['deepgram', 'elevenlabs', 'anthropic'];

  /**
   * 'openai' is deliberately absent. It is a credential id and appears in the
   * vault's key map and the settings schema, which name credentials, not
   * providers. The three above are equally credential ids, so the allowlist
   * below carries the files that legitimately name a credential.
   */
  const ALLOWED = [
    'src/shared/registry/',
    'src/main/ai/stt/',
    // Credential plumbing: these name a vault key, not a provider to branch on.
    'src/shared/types.ts',
    'src/shared/ipc.ts',
    'src/shared/defaults.ts',
    'src/main/secrets.ts',
  ];

  for (const id of PROVIDER_IDS) {
    it(`does not name "${id}" outside the registry, the adapters and the vault`, () => {
      // --untracked matters: without it a brand new file passes this guard
      // locally and only fails in CI once committed, which is exactly how this
      // rule was first broken.
      const out = execSync(
        `git grep -l --untracked -F "'${id}'" -- 'src/*.ts' 'src/*.tsx' || true`,
        {
          encoding: 'utf8',
          cwd: process.cwd(),
        },
      );
      const files = out
        .split('\n')
        .filter(Boolean)
        .filter((f) => !ALLOWED.some((prefix) => f.startsWith(prefix)));
      expect(files).toEqual([]);
    });
  }
});

/**
 * TC-057: the non-streaming badge text comes from the registry entry. No
 * renderer names Whisper, so swapping the model or its warning text is a
 * registry edit rather than a UI edit (FR-037, ADR-022).
 */
describe('TC-057 no renderer names a model', () => {
  it('does not mention Whisper outside the registry and its adapter', () => {
    const out = execSync(`git grep -l -i --untracked -F "whisper" -- 'src/*' || true`, {
      encoding: 'utf8',
      cwd: process.cwd(),
    });
    const files = out
      .split('\n')
      .filter(Boolean)
      // `pricing.json` is data keyed by the registry, not code branching on a
      // model name, and TC-156 already proves its keys and the registry agree.
      .filter((f) => !f.endsWith('.json'))
      .filter((f) => !f.startsWith('src/shared/registry/') && !f.startsWith('src/main/ai/stt/'));
    expect(files).toEqual([]);
  });
});
