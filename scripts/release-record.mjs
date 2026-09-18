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
 * Checks whose evidence must carry measured numbers, and the budget each one is
 * measured against.
 *
 * A bare PASS on a number nobody wrote down is how a budget quietly stops being
 * measured, and TASK-051 names both of these explicitly. Recording the number
 * is not enough either: a record reading `p50 99 s` beside the word PASS is a
 * tester's slip, and a gate that reads the verdict rather than the measurement
 * would ship on it. The numbers are parsed and compared.
 */
export const LATENCY_BUDGETS = {
  'MW-06': { p50: 2.5, p95: 4.0, requirement: 'NFR-001' },
  'MW-11': { p50: 7.0, p95: 10.0, requirement: 'NFR-017' },
};

export const NEEDS_NUMBERS = new Set(Object.keys(LATENCY_BUDGETS));

/**
 * `p50 1.9 s` or `p95 3400 ms`. The unit is required.
 *
 * Without it, `p50 1900` is ambiguous between a comfortable pass in
 * milliseconds and a catastrophic one in seconds, and guessing which would be
 * worse than asking.
 */
function measured(evidence, label) {
  const match = new RegExp(
    `\\b${label}\\b[^0-9]{0,12}([0-9]+(?:\\.[0-9]+)?)\\s*(ms|s)\\b`,
    'i',
  ).exec(evidence ?? '');
  if (!match) return null;
  const value = Number(match[1]);
  return match[2].toLowerCase() === 'ms' ? value / 1000 : value;
}

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
    // `NFR-011` is Windows 10 **and** 11, and section 6 says run on both. A
    // record that names neither machine cannot be shown to have done so.
    windows10: field('Windows 10 machine'),
    windows11: field('Windows 11 machine'),
    rows,
  };
}

/**
 * Check a record against the checklist.
 *
 * @returns `{ blockers, warnings }`. A release proceeds only on no blockers.
 */
export function validateRecord(record, required, expectedTag, options = {}) {
  const blockers = [];
  const warnings = [];

  for (const name of ['tag', 'commit', 'tester', 'date', 'windows10', 'windows11']) {
    if (!record[name]) blockers.push(`The record has no **${FIELD_LABELS[name]}** field.`);
  }

  // A record for a different tag is not this release's evidence. It is the
  // easiest mistake to make when copying the previous one.
  if (expectedTag && record.tag && record.tag !== expectedTag) {
    blockers.push(`The record is for ${record.tag}, but the release is ${expectedTag}.`);
  }

  // A commit field reading `TBD` is not a record of what was tested, and a
  // release built from a commit the checklist never ran against is the failure
  // this whole file exists to prevent.
  if (record.commit && !/^[0-9a-f]{40}$/i.test(record.commit)) {
    blockers.push(
      `The commit "${record.commit}" is not a full 40-character sha. ` +
        'Record the commit the installer was built from.',
    );
  }
  if (
    options.expectedCommit &&
    record.commit &&
    !sameCommit(record.commit, options.expectedCommit)
  ) {
    blockers.push(
      `The checklist was run against ${record.commit}, but ${options.expectedCommit} is being ` +
        'released. Re-run the checklist against the commit being tagged.',
    );
  }

  // Section 6 says one Windows 10 machine on build 19041 or later. Below that,
  // capture exclusion is a black rectangle rather than invisibility (NFR-012),
  // so MW-01 on such a machine is testing something else.
  if (record.windows10) {
    const build = /\b(\d{5,})\b/.exec(record.windows10);
    if (!build) {
      blockers.push(
        `The Windows 10 machine "${record.windows10}" names no build number. ` +
          'Section 6 requires build 19041 or later.',
      );
    } else if (Number(build[1]) < MIN_WINDOWS_10_BUILD) {
      blockers.push(
        `The Windows 10 machine is build ${build[1]}, below ${MIN_WINDOWS_10_BUILD}. ` +
          'Capture exclusion degrades below it (NFR-012), so MW-01 would test something else.',
      );
    }
  }

  const seen = new Map();
  for (const row of record.rows) {
    if (seen.has(row.id)) {
      blockers.push(`${row.id} appears more than once. Which run is the record is ambiguous.`);
      continue;
    }
    seen.set(row.id, row);
  }

  // The full checklist is required of the release being prepared. A sweep over
  // records already merged checks only what each one claims: a checklist that
  // grows a row must not retroactively invalidate every release before it and
  // fail every pull request until someone invents evidence for old binaries.
  const ids = options.requireAll === false ? [...seen.keys()] : required;

  for (const id of ids) {
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
      blockers.push(...latencyBlockers(id, row.evidence));
    }
  }

  for (const id of seen.keys()) {
    if (!required.includes(id)) {
      warnings.push(`${id} is recorded but is not a checklist id. Harmless; check for a typo.`);
    }
  }

  return { blockers, warnings };
}

/** Human names for the header fields, for the message above. */
const FIELD_LABELS = {
  tag: 'Tag',
  commit: 'Commit',
  tester: 'Tester',
  date: 'Date',
  windows10: 'Windows 10 machine',
  windows11: 'Windows 11 machine',
};

/** Section 6's floor, which is `NFR-012`'s capture-exclusion build. */
export const MIN_WINDOWS_10_BUILD = 19041;

/** A record may abbreviate a sha; the release passes a full one. */
function sameCommit(recorded, expected) {
  const a = recorded.toLowerCase();
  const b = expected.toLowerCase();
  return a.startsWith(b) || b.startsWith(a);
}

/** Every way a latency row can fail to hold its budget. */
function latencyBlockers(id, evidence) {
  const budget = LATENCY_BUDGETS[id];
  const out = [];
  for (const label of ['p50', 'p95']) {
    const seconds = measured(evidence, label);
    if (seconds === null) {
      out.push(
        `${id} must record a measured ${label} with a unit, such as "${label} 1.9 s" or ` +
          `"${label} 1900 ms" (TASK-051, ${budget.requirement}). Got: ${evidence || 'nothing'}`,
      );
      continue;
    }
    if (seconds >= budget[label]) {
      out.push(
        `${id} records ${label} ${seconds} s against a ${budget[label]} s budget ` +
          `(${budget.requirement}). A PASS beside a number over budget is not a pass.`,
      );
    }
  }
  return out;
}
