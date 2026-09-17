/**
 * The release record: what it must contain, and what blocks a release.
 *
 * TASK-051's fourth acceptance criterion says the manual checklist in
 * `docs/04-test-strategy.md` section 6 is executed and recorded before a tag is
 * cut, that any single failure blocks the tag, and that `MW-12` confirms a
 * documented limitation and cannot fail the release.
 *
 * "Recorded" is the part software can hold up. A checklist that lives only in
 * someone's memory of having run it is not a gate, so each release carries a
 * file under `releases/` naming every check and its outcome, and this decides
 * whether that file is complete and passing.
 *
 * The required ids are read out of `04-test-strategy.md` rather than listed
 * here, for the same reason `scripts/traceability.py` derives its tables: a
 * checklist that grows a row must not leave this file behind, silently no
 * longer requiring the new check.
 *
 * Exported as a module so `tests/integration/release-record.test.ts` can drive
 * it against fixtures. The CLI is `scripts/check-release-record.mjs`.
 */

/** Outcomes a row may carry. */
export const RESULTS = ['PASS', 'FAIL', 'NOTED'];

/**
 * The one check that cannot fail a release.
 *
 * `MW-12` plays music and fires a notification during a session and confirms
 * both are transcribed onto the interviewer stream, which is what `ADR-021`
 * predicts and what the session-prep note warns about. It documents a known
 * limitation, so its finding is information rather than a defect.
 */
export const NON_BLOCKING = new Set(['MW-12']);

/**
 * Checks whose evidence must carry measured numbers, not just a verdict.
 *
 * `MW-06` and `MW-11` are the latency budgets (`NFR-001`, `NFR-017`). A bare
 * PASS on a number nobody wrote down is how a budget quietly stops being
 * measured, and TASK-051 names both explicitly.
 */
export const NEEDS_NUMBERS = new Set(['MW-06', 'MW-11']);

/** `p50 1.9 s` and `p95 3.4 s`, in either order, units optional. */
const P50 = /\bp50\b[^0-9]{0,12}[0-9]+(?:\.[0-9]+)?/i;
const P95 = /\bp95\b[^0-9]{0,12}[0-9]+(?:\.[0-9]+)?/i;

/**
 * Every check id the release record must account for.
 *
 * `MW-*` ids come from section 6's table. `TC-001` is added because TASK-051
 * lists it under `Verified by`: it is the clean build and package, which is the
 * one automated check a release cannot be cut without.
 */
export function requiredIds(testStrategyMarkdown) {
  const section = sectionSix(testStrategyMarkdown);
  const ids = [...section.matchAll(/^\|\s*(MW-\d+)\s*\|/gm)].map((m) => m[1]);
  const unique = [...new Set(ids)].sort();
  if (unique.length === 0) {
    throw new Error(
      'No MW- rows found in section 6 of docs/04-test-strategy.md. ' +
        'The release record cannot be checked against a checklist that could not be read.',
    );
  }
  return ['TC-001', ...unique];
}

/** Section 6 only, so a MW id mentioned in prose elsewhere is not mistaken for a row. */
function sectionSix(markdown) {
  const start = markdown.indexOf('## 6.');
  if (start === -1) throw new Error('docs/04-test-strategy.md has no section 6.');
  const rest = markdown.slice(start + 1);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Parse a release record into its header fields and its rows.
 *
 * Tolerant of formatting, strict about content: the checker below is what
 * decides whether a record is acceptable, and it is easier to read one error
 * about a missing row than a parse failure that names a line number.
 */
export function parseRecord(markdown) {
  const field = (name) => {
    const match = markdown.match(new RegExp(`^\\*\\*${name}\\*\\*\\s+(.+?)\\s*$`, 'mi'));
    return match ? match[1].trim() : null;
  };

  const rows = [];
  for (const line of markdown.split('\n')) {
    // Evidence runs to the **last** pipe on the line, not the first. An
    // unescaped pipe inside a cell is malformed markdown, and a tester who
    // writes `| MW-06 | PASS | p50 1.9 s | p95 3.4 s |` has recorded both
    // numbers. Stopping at the first pipe would drop the p95 and then block
    // the release for not having recorded it, which is the wrong strictness.
    const match = line.match(/^\|\s*((?:MW|TC)-\d+)\s*\|\s*([^|]*?)\s*\|\s*(.*?)\s*\|\s*$/);
    if (match) rows.push({ id: match[1], result: match[2].toUpperCase(), evidence: match[3] });
  }

  return {
    tag: field('Tag'),
    commit: field('Commit'),
    tester: field('Tester'),
    date: field('Date'),
    rows,
  };
}

/**
 * Check a record against the checklist.
 *
 * @returns `{ blockers, warnings }`. A release proceeds only on no blockers.
 */
export function validateRecord(record, required, expectedTag) {
  const blockers = [];
  const warnings = [];

  for (const name of ['tag', 'commit', 'tester', 'date']) {
    if (!record[name]) blockers.push(`The record has no **${name}** field.`);
  }

  // A record for a different tag is not this release's evidence. It is the
  // easiest mistake to make when copying the previous one.
  if (expectedTag && record.tag && record.tag !== expectedTag) {
    blockers.push(`The record is for ${record.tag}, but the release is ${expectedTag}.`);
  }

  const seen = new Map();
  for (const row of record.rows) {
    if (seen.has(row.id)) {
      blockers.push(`${row.id} appears more than once. Which run is the record is ambiguous.`);
      continue;
    }
    seen.set(row.id, row);
  }

  for (const id of required) {
    const row = seen.get(id);
    if (!row) {
      blockers.push(`${id} has no row. Every check is recorded, including the ones that passed.`);
      continue;
    }

    if (!RESULTS.includes(row.result)) {
      blockers.push(`${id} has result "${row.result}". Use one of ${RESULTS.join(', ')}.`);
      continue;
    }

    // NOTED exists for MW-12 alone. Allowing it anywhere would turn every
    // blocking check into one a tired release manager could wave through.
    if (row.result === 'NOTED' && !NON_BLOCKING.has(id)) {
      blockers.push(
        `${id} is NOTED, which only ${[...NON_BLOCKING].join(', ')} may be. Record PASS or FAIL.`,
      );
      continue;
    }

    if (!row.evidence) {
      blockers.push(`${id} has no evidence. A result with nothing behind it is not a record.`);
    }

    if (row.result === 'FAIL') {
      if (NON_BLOCKING.has(id)) {
        warnings.push(`${id} failed, which does not block: it confirms a documented limitation.`);
      } else {
        blockers.push(`${id} failed: ${row.evidence || 'no evidence given'}`);
      }
    }

    if (NEEDS_NUMBERS.has(id) && row.result === 'PASS') {
      if (!P50.test(row.evidence ?? '') || !P95.test(row.evidence ?? '')) {
        blockers.push(
          `${id} must record measured p50 and p95 numbers, not just a verdict ` +
            `(TASK-051, NFR-001, NFR-017). Got: ${row.evidence || 'nothing'}`,
        );
      }
    }
  }

  for (const id of seen.keys()) {
    if (!required.includes(id)) {
      warnings.push(`${id} is recorded but is not a checklist id. Harmless; check for a typo.`);
    }
  }

  return { blockers, warnings };
}
