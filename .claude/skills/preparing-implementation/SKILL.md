---
name: preparing-implementation
description: "Reconciles project requirements, design, tasks, acceptance criteria, dependencies, and test strategy so implementation can begin without material ambiguity. Use when a project has planning documents but may contain gaps or contradictions and no application code should be changed yet. Use to reconcile existing planning artifacts, not initial discovery or application implementation. Edit planning documents only if authorized."
---

# Implementation preparation

Follow AGENTS.md authorization modes and decision checkpoints. Use to reconcile existing planning artifacts, not initial discovery or application implementation. Edit planning documents only if authorized.

Prepare `the project identified from context` for implementation. Do not implement application code.

Inspect and reconcile the project documents so they define:

- requirements and scope
- technical design and key dependencies
- implementation tasks mapped to requirements
- testable acceptance criteria
- test strategy

If planning edits are authorized, fix the largest ambiguity, contradiction or missing dependency that could cause two competent engineers to build materially different systems. Keep traceability between requirements, design decisions, tasks and acceptance criteria.

Otherwise report the required planning corrections without edits.

Ask only when a product decision cannot be resolved from repository evidence. Make normal engineering decisions under `AGENTS.md`.

Run `TWO-PASS REVIEW` on the final planning artifacts.

Stop when no material contradiction remains, every planned task is testable and no unresolved product decision blocks implementation. Otherwise report the blocker.
