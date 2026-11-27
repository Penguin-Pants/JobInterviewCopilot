---
name: auditing-error-messages
description: "Inventories, improves, implements, and verifies user-visible error messages across a repository or named scope. Use when error copy is unclear, exposes internal details, lacks recovery guidance, or needs systematic browser and test verification. Use for systematic user-facing error copy review, not functional bug diagnosis or general design audit. Analyze by default; edit only when authorized."
---

# User-visible error-message audit

Follow AGENTS.md authorization modes and decision checkpoints. Use for systematic user-facing error copy review, not functional bug diagnosis or general design audit. Analyze by default; edit only when authorized.

Audit every user-visible error message within the scope resolved from the request. If no scope is supplied, use the user-facing surfaces in the current repository and state any exclusions.

Prepare a CSV (return it without repository edits in Analyze mode; create or update it when authorized) with one row per error state and these fields:

- location
- trigger
- current message
- severity using the shared severity scale
- proposed message
- implementation status
- verification result

Inspect source strings, surfaced API or client errors and reachable browser states. Propose messages in plain language; replace them only when authorized that explains the problem and gives a useful recovery action when one exists. Do not expose provider names, stack traces, internal identifiers or implementation details.

For each changed state, verify the relevant automated checks and exercise the real user-facing state on the applicable platform when practical. Do not mark an unreachable state as verified. Search again after changes for raw or internal error text that can still reach users.

Run analysis `TWO-PASS REVIEW` on the audit; for authorized changes run relevant tests before implementation review on the final diff.

For analysis, report proposed fixes and unverified states. For implementation, stop when each in-scope row is `VERIFIED` or explicitly `BLOCKED`. Finish with the CSV path, changed files, verification evidence and blocked rows.
