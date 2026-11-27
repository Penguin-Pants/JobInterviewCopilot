---
name: reviewing-pull-requests
description: "Reviews pull requests for correctness, reviewer feedback, or maintainability and can apply approved fixes. Use for general PR review, validating automated reviewer comments, fixing confirmed PR issues, or assessing long-term maintenance cost. Use for an existing PR or reviewer feedback, not general repository audits. Analyze by default; apply fixes and update the PR only within authorized scope."
---

# Review a pull request

Follow AGENTS.md authorization modes and decision checkpoints. Use for an existing PR or reviewer feedback, not general repository audits. Analyze by default; apply fixes and update the PR only within authorized scope.

Review the current PR using the mode that matches the request:

Resolve the requested mode from the user request and repository context; ask only if essential information is missing.

Default to `general`.

Always inspect the full diff plus affected code, tests and contracts. Run `TWO-PASS REVIEW` before finalizing findings.

## General

Classify remaining findings under the shared finding classification in `AGENTS.md`.

When fixes are requested, use `DECISION CHECKPOINT` to confirm scope, apply the selected fixes, run required validation and update the PR.

## Reviewer comments

Review every supplied or available reviewer comment against the current diff and affected code before changing anything.

For each comment, determine whether it is a confirmed error, possible risk, idea, obsolete comment or incorrect comment. Handle confirmed errors under the shared finding classification. Do not implement optional ideas without approval.

Finish with a compact table showing each comment, status, evidence and what changed or why no change was made.

## Maintainability

Do not modify code unless explicitly requested.

Rate these dimensions from 1 to 10 and state the direction with each score:

- readability, where 10 is best
- complexity, where 10 is most complex
- dependency risk, where 10 is highest risk
- change isolation, where 10 is best

Support scores with diff evidence. Identify up to three highest-impact maintainability concerns with `path:line`, impact and the simplest reduction in maintenance cost. Do not invent concerns to fill the list.

Finish with confirmed issues fixed when applicable, proposed out-of-scope fixes not selected and remaining possible risks.
