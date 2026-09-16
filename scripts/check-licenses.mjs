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
  'Zlib',
];

/**
 * Declarations license-checker cannot resolve to an SPDX id, and how to read
 * them. Each is resolved by reading the package's own license text rather than
 * by trusting the string, because the string is exactly what is ambiguous.
 *
 * - `Custom: <file>` and `SEE LICENSE IN <file>` mean the id is in that file.
 * - A bare family name such as `BSD` names a family, not a license. BSD-2-Clause
 *   and BSD-3-Clause are both permissive, but `BSD-4-Clause` carries the
 *   advertising clause and is not on the allow list, so the text decides.
 *
 * A declaration this function cannot resolve stays unresolved and fails. The
 * gate never widens on a guess.
 */
const UNRESOLVED = /^(custom:|see license in\b|bsd$|bsd\b.*\*$)/i;

/**
 * The BSD advertising clause, which makes a license BSD-4-Clause.
 *
 * Checked before anything else, because a BSD-4-Clause text contains the whole
 * BSD-3-Clause text including its non-endorsement sentence. Matching on that
 * sentence alone identified a four-clause license as three-clause and let the
 * gate pass a dependency the allow list does not permit.
 */
const ADVERTISING_CLAUSE = /All advertising materials mentioning features or use of this software/i;

/** Distinguishing sentences from the license texts the allow list accepts. */
const TEXT_SIGNATURES = [
  ['Apache-2.0', /Apache License\s+Version 2\.0/],
  ['MIT', /Permission is hereby granted, free of charge, to any person obtaining a copy/],
  ['ISC', /Permission to use, copy, modify, and\/or distribute this software/],
  [
    'BSD-3-Clause',
    /Neither the name of .{0,120}? nor the names of its\s+contributors may be used to endorse/is,
  ],
  ['BSD-2-Clause', /Redistribution and use in source and binary forms/],
];

/**
 * Identify a license from the text shipped in the package.
 *
 * BSD-3-Clause is tested before BSD-2-Clause because the 3-clause text contains
 * the whole 2-clause text; testing in the other order would label every
 * 3-clause package as 2-clause.
 *
 * @returns the SPDX id, or null when no signature matches.
 */
function identifyFromText(packageDir) {
  if (!existsSync(packageDir)) return null;
  const candidates = readdirSync(packageDir).filter((n) => /^(licen[cs]e|copying)/i.test(n));
  for (const name of candidates) {
    const full = join(packageDir, name);
    if (!statSync(full).isFile()) continue;
    const text = readFileSync(full, 'utf8');
    // BSD-4-Clause first, and as a rejection rather than an identification: it
    // is not on the allow list, and every signature below would otherwise claim
    // it. Returning its real id lets the caller fail it by name.
    if (ADVERTISING_CLAUSE.test(text)) return 'BSD-4-Clause';
    for (const [id, signature] of TEXT_SIGNATURES) {
      if (signature.test(text)) return id;
    }
  }
  return null;
}

/**
 * Evaluate an SPDX-ish expression against the allow list.
 *
 * `AND` requires every branch, `OR` requires one. license-checker emits both:
 * `pako` declares `(MIT AND Zlib)`, which is permissive only because both
 * halves are. Splitting on OR alone passed nothing and failed the build.
 */
function expressionIsAllowed(text) {
  const clean = (s) => s.replace(/[()*]/g, '').trim();
  return text.split(/\s+OR\s+/i).some((branch) =>
    branch
      .split(/\s+AND\s+/i)
      .map(clean)
      .every((id) => ALLOWED.includes(id)),
  );
}

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
    let text = String(licenses.join(' OR '));

    // A declaration that names a file or a family rather than a license is
    // resolved from the package's own license text. `info.path` is where
    // license-checker found the package, so it is the copy actually installed.
    if (UNRESOLVED.test(text.trim())) {
      const identified = identifyFromText(info.path ?? '');
      if (!identified) {
        failures.push(
          `${name}: license "${text}" could not be resolved from its license text (NFR-015)`,
        );
        continue;
      }
      text = identified;
    }

    if (!expressionIsAllowed(text)) failures.push(`${name}: disallowed license "${text}"`);
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
