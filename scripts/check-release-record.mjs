#!/usr/bin/env node
/**
 * Gate a release on its recorded checklist (TASK-051, NFR-013).
 *
 * Usage:
 *   node scripts/check-release-record.mjs v0.1.0
 *   node scripts/check-release-record.mjs            # checks every record present
 *   node scripts/check-release-record.mjs v0.1.0 --dir=<path>   # for the test fixtures
 *   node scripts/check-release-record.mjs v0.1.0 --commit=<sha> # bind to the tagged source
 *
 * Exit 0 when the record is complete and passing, 1 otherwise, naming every
 * reason rather than the first.
 *
 * A note on what this can and cannot enforce. A tag-triggered workflow runs
 * *after* a tag exists, so nothing in CI can stop `git tag` being typed. What it
 * can do, and does, is refuse to build or publish anything for a tag whose
 * record is missing, incomplete or failing, and fail the pull request that
 * introduces a bad record. The tag without a release is inert.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRecord, requiredIds, validateRecord } from './release-record.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const strategy = join(root, 'docs/04-test-strategy.md');
const dirFlag = process.argv.find((a) => a.startsWith('--dir='));
const recordsDir = dirFlag ? resolve(dirFlag.slice('--dir='.length)) : join(root, 'releases');

const required = requiredIds(readFileSync(strategy, 'utf8'));

const tag = process.argv.slice(2).find((a) => !a.startsWith('--'));
const commitFlag = process.argv.find((a) => a.startsWith('--commit='));
const expectedCommit = commitFlag ? commitFlag.slice('--commit='.length).trim() : undefined;
const targets = tag ? [`${tag}.md`] : recordsFound();

function recordsFound() {
  if (!existsSync(recordsDir)) return [];
  return readdirSync(recordsDir)
    .filter((name) => name.endsWith('.md') && name !== 'TEMPLATE.md')
    .sort();
}

if (targets.length === 0) {
  console.log(
    'No release records to check. A release needs releases/<tag>.md; see docs/07-release-checklist.md.',
  );
  process.exit(0);
}

let failed = false;

for (const name of targets) {
  const path = join(recordsDir, name);
  const expectedTag = name.replace(/\.md$/, '');

  if (!existsSync(path)) {
    console.error(
      `\nBLOCKED ${expectedTag}\n` +
        `  No record at releases/${name}.\n` +
        `  Copy releases/TEMPLATE.md, run the checklist in docs/04-test-strategy.md\n` +
        `  section 6 on real Windows hardware, and record every result.`,
    );
    failed = true;
    continue;
  }

  const record = parseRecord(readFileSync(path, 'utf8'));
  // A named tag is the release being prepared, so the whole checklist is
  // required of it. The no-tag sweep runs on every pull request over records
  // already merged, and only checks what each one claims: a checklist that
  // grows a row must not retroactively invalidate every release before it.
  const { blockers, warnings } = validateRecord(record, required, expectedTag, {
    requireAll: Boolean(tag),
    ...(expectedCommit ? { expectedCommit } : {}),
  });

  for (const warning of warnings) console.warn(`  note  ${expectedTag}: ${warning}`);

  if (blockers.length > 0) {
    console.error(`\nBLOCKED ${expectedTag} (${blockers.length}):`);
    for (const blocker of blockers) console.error(`  - ${blocker}`);
    failed = true;
  } else {
    const counted = tag ? required.length : record.rows.length;
    console.log(`OK ${expectedTag}: ${counted} checks recorded, none blocking.`);
  }
}

process.exit(failed ? 1 : 0);
