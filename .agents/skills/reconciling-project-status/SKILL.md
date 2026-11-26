---
name: reconciling-project-status
description: "Determines the real implementation status of a project by comparing plans, requirements, code, tests, documentation, and git state. Use when the user asks what is finished, what remains, whether a build plan is complete, or whether documentation matches the actual repository. Use to assess actual progress against plans, not to execute the next phase or certify release readiness."
---

# Reconcile project status

Follow AGENTS.md authorization modes and decision checkpoints. Use to assess actual progress against plans, not to execute the next phase or certify release readiness.

Determine the project's actual status from repository evidence. Do not implement changes unless explicitly asked.

Inspect applicable planning documents, requirements, implementation, tests, documentation and current git state.

For each planned requirement, task, phase or acceptance criterion, classify it as:

- `COMPLETE` — implementation evidence and required verification support completion
- `PARTIAL` — some required behavior or verification is missing
- `NOT STARTED` — no meaningful implementation evidence
- `OBSOLETE` — repository evidence shows the item no longer applies
- `NOT VERIFIED` — implementation may exist but available evidence is insufficient

Do not mark work complete because a plan or checklist says it is complete. Prefer working implementation, tests and direct verification over status labels in documentation.

Identify contradictions between planning documents and the repository. Distinguish missing implementation from stale documentation.

Run `TWO-PASS REVIEW` on the status assessment.

Deliver:

- overall project status
- status table for planned work
- confirmed remaining work in dependency order
- stale or contradictory documentation
- blockers and unverified items
- the smallest next action that moves the project toward completion

Do not create new scope while reconciling status.
