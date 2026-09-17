#!/usr/bin/env node
/**
 * Assert the packaged app is actually loadable (TASK-051, NFR-011).
 *
 * The `package` job built the installer and checked the `.exe` existed. That
 * passes with or without a correct `asarUnpack` path, because nothing looks
 * inside the package: the failure is at runtime, in the installed app, on a
 * machine nobody in CI is watching. `docs/03-tasks.md` carries it as an open
 * TASK-025 follow-up for exactly that reason.
 *
 * Two kinds of module cannot be loaded from inside an asar archive, and this
 * app ships both:
 *
 *   - a native addon, because `process.dlopen` cannot open a file inside an
 *     archive: `onnxruntime-node`, which `@xenova/transformers` loads; and
 *   - an ESM-only package reached through `import()`, because Electron's asar
 *     integration patches CommonJS `require` and not Node's ESM loader:
 *     `chokidar` 5 and its `readdirp` dependency.
 *
 * So this checks what the globs in `electron-builder.yml` were written to
 * achieve, rather than that they were written: every unpacked module is a real
 * directory on disk with real files in it, next to an `app.asar` that is not
 * where those modules are being loaded from.
 *
 * Run: node scripts/check-packaged.mjs [releaseDir]   (after npm run package)
 *
 * `releaseDir` defaults to `release/`. It is a parameter so the integration
 * test can point this at a fixture tree and prove the check fails on a wrong
 * `asarUnpack` path, rather than trusting that it would.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const release = process.argv[2] ? resolve(process.argv[2]) : join(root, 'release');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/**
 * What must be unpacked, and what proves it.
 *
 * `mustContain` is an extension rather than a filename: the exact binary name
 * varies by platform and by version, and asserting the wrong one would fail a
 * correct package. What matters is that a file of that kind is on disk.
 */
const UNPACKED = [
  {
    module: 'onnxruntime-node',
    mustContain: '.node',
    why: 'a native addon cannot be dlopened from inside an asar',
  },
  {
    module: 'chokidar',
    mustContain: '.js',
    why: "Electron's asar shim does not cover Node's ESM loader",
  },
  {
    module: 'readdirp',
    mustContain: '.js',
    why: "chokidar's ESM-only dependency, reached the same way",
  },
];

const failures = [];

function fail(message) {
  failures.push(message);
}

/** Every file under `dir`, recursively. Empty when the directory is absent. */
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

if (!existsSync(release)) {
  console.error(`No release/ directory at ${release}. Run "npm run package" first.`);
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * The installer
 * ------------------------------------------------------------------ */

// `artifactName: ${productName}-${version}-x64.${ext}` in electron-builder.yml.
const installers = readdirSync(release).filter((n) => n.endsWith('.exe'));
if (installers.length === 0) {
  fail('No .exe installer in release/. electron-builder produced no NSIS package.');
} else {
  const expected = `-${pkg.version}-x64.exe`;
  if (!installers.some((n) => n.endsWith(expected))) {
    fail(
      `No installer matching *${expected} in release/. Found: ${installers.join(', ')}. ` +
        'NFR-011 is x64 only, and the name carries the version a release record cites.',
    );
  }
  for (const name of installers) {
    const size = statSync(join(release, name)).size;
    // A truncated or empty artifact is a build that failed after creating the
    // file. The real installer is tens of megabytes.
    if (size < 1_000_000) fail(`release/${name} is only ${size} bytes. That is not an installer.`);
  }
}

/* ------------------------------------------------------------------ *
 * The unpacked modules
 * ------------------------------------------------------------------ */

const unpackedDirs = readdirSync(release, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.endsWith('unpacked'))
  .map((e) => join(release, e.name));

if (unpackedDirs.length === 0) {
  fail(
    'No *-unpacked directory in release/. electron-builder always writes one beside ' +
      'the installer, and it is the only place the unpacked modules can be checked.',
  );
}

for (const dir of unpackedDirs) {
  const resources = join(dir, 'resources');
  const asar = join(resources, 'app.asar');
  const unpacked = join(resources, 'app.asar.unpacked');

  if (!existsSync(asar)) {
    fail(`${asar} is missing. The app was not packaged into an archive at all.`);
  }

  if (!existsSync(unpacked)) {
    fail(
      `${unpacked} is missing, so every asarUnpack glob in electron-builder.yml matched ` +
        'nothing. The packaged app cannot load its native addon or its ESM-only watcher.',
    );
    continue;
  }

  for (const { module, mustContain, why } of UNPACKED) {
    const moduleDir = join(unpacked, 'node_modules', module);
    if (!existsSync(moduleDir)) {
      fail(`${module} was not unpacked (${why}). Expected ${moduleDir}.`);
      continue;
    }
    const files = filesUnder(moduleDir);
    if (files.length === 0) {
      fail(`${module} was unpacked as an empty directory. Expected files under ${moduleDir}.`);
      continue;
    }
    if (!files.some((f) => f.endsWith(mustContain))) {
      fail(
        `${module} was unpacked but contains no ${mustContain} file (${why}). ` +
          `Found ${files.length} file(s), none of them a ${mustContain}.`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`The packaged app would not load (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  `Packaged app checked: installer present, and ${UNPACKED.map((u) => u.module).join(', ')} ` +
    'are unpacked with real files on disk.',
);
