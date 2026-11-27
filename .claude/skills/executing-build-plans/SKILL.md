---
name: executing-build-plans
description: "Executes an existing build plan one phase or all remaining phases, keeping implementation, validation, planning status, commits, and CI aligned. Use when a repository already has a phased implementation plan with requirements and acceptance criteria. Use only when an existing phased plan is explicitly selected for execution, not status reconciliation or initial feature discovery."
---

# Execute a build plan

Follow AGENTS.md authorization modes and decision checkpoints. Use only when an existing phased plan is explicitly selected for execution, not status reconciliation or initial feature discovery.

Execute the existing build plan with this scope:

Resolve the requested scope from the user request and repository context; ask only if essential information is missing.

Default to `next` when scope is not supplied.

For each phase in scope:

1. Read the phase requirements, dependencies and acceptance criteria before editing.
2. Inspect the affected implementation and tests.
3. Implement only the work required for that phase.
4. Run relevant tests and verify phase acceptance criteria.
5. Run implementation `TWO-PASS REVIEW`; fix authorized findings and rerun validation.
6. Update planning documents with evidence, remaining work, blockers and phase status. Review the final diff and validate any subsequent changes.
7. Commit, push and create or update a PR only when authorized and validation passes. Use the approved work branch; merge only when separately authorized. Do not claim completion if required checks fail or remain unverified.

If a prerequisite, contradiction or missing product decision blocks a phase, stop that part and report the blocker instead of inventing a solution.

For `scope = next`, stop after the next incomplete phase is completed or blocked.

For `scope = all`, re-read the build plan after each completed phase and continue until every planned phase is complete or a genuine blocker prevents further valid work. Do not invent new phases or pull follow-up ideas into implementation unless the existing plan requires them.

When all phases are complete, verify the overall implementation against the full plan, run the broadest practical project-level validation and reconcile final planning status with the implementation.

Report phases completed, blockers, proposed follow-up work, validation results, planning status and branch or push status.
