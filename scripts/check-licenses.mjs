#!/usr/bin/env node
/**
 * License gate (NFR-015, NFR-016).
 *
 * Two checks, because one tool cannot see both kinds of dependency.
 *
 * 1. npm dependencies must carry a permissive license. A copyleft runtime
 *    dependency fails the build.
 * 2. Vendored code, Magic UI in particular, is copied into the repository
 *    rather than installed, so license-checker cannot see it at all. Every file
 *    under src/renderer/**\/vendor/ must be covered by an entry in VENDORED.md
 *    naming its source, version and license.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ALLOWED = [
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'CC0-1.0',
  'Unlicense',
  'BlueOak-1.0.0',
  'Python-2.0',
  'CC-BY-4.0',
];

const failures = [];

/* -------------------------------------------------------- *
 * 1. npm production dependencies
 * -------------------------------------------------------- */
function checkNpmLicenses() {
  let raw;
  try {
    raw = execFileSync(
      'npx',
      ['license-checker-rseidelsohn', '--production', '--json', '--excludePrivatePackages'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    failures.push(`license-checker could not run: ${err.message}`);
    return;
  }

  const packages = JSON.parse(raw);
  for (const [name, info] of Object.entries(packages)) {
    const licenses = Array.isArray(info.licenses) ? info.licenses : [info.licenses];
    const text = String(licenses.join(' OR '));
    // An OR expression passes when any branch is allowed.
    const branches = text.split(/\s+OR\s+/i).map((s) => s.replace(/[()*]/g, '').trim());
    const ok = branches.some((b) => ALLOWED.includes(b));
    if (!ok) failures.push(`${name}: disallowed license "${text}"`);
  }
}

/* -------------------------------------------------------- *
 * 2. Vendored components (NFR-016)
 * -------------------------------------------------------- */
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function findVendorDirs(root, out = []) {
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (!statSync(full).isDirectory()) continue;
    if (entry === 'vendor') out.push(full);
    else findVendorDirs(full, out);
  }
  return out;
}

function checkVendored() {
  const manifestPath = 'VENDORED.md';
  if (!existsSync(manifestPath)) {
    failures.push('VENDORED.md is missing (NFR-016).');
    return;
  }
  const manifest = readFileSync(manifestPath, 'utf8');

  const vendorDirs = findVendorDirs('src/renderer');
  const files = vendorDirs.flatMap((d) => walk(d));

  for (const file of files) {
    const rel = relative(process.cwd(), file).replace(/\\/g, '/');
    if (!manifest.includes(rel)) {
      failures.push(`Vendored file not declared in VENDORED.md: ${rel} (NFR-016)`);
    }
  }

  // Every declared entry must name a license from the allow list.
  const rows = manifest.split('\n').filter((l) => l.trim().startsWith('|') && l.includes('src/'));
  for (const row of rows) {
    const cells = row.split('|').map((c) => c.trim());
    const license = cells.find((c) => ALLOWED.includes(c));
    if (!license) failures.push(`VENDORED.md row has no allowed license: ${row.trim()}`);
  }
}

checkNpmLicenses();
checkVendored();

if (failures.length > 0) {
  console.error('License check failed:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('License check passed: npm dependencies and vendored components are permissive.');
