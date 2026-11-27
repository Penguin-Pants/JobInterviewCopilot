---
name: debugging-code
description: "Diagnoses and fixes observed software failures by reproducing the problem, tracing evidence to a root cause, adding regression coverage, and validating the smallest correct fix. Use for bugs, errors, broken behavior, failing workflows, flaky features, or unexplained regressions. Use for observed functional failures, not performance-only investigation or planned changes. Analyze by default unless a fix is authorized."
---

# Diagnose and fix a bug

Follow AGENTS.md authorization modes and decision checkpoints. Use for observed functional failures, not performance-only investigation or planned changes. Analyze by default unless a fix is authorized.

Investigate this observed problem:

Resolve the requested problem from the user request and repository context; ask only if essential information is missing.

Investigate before editing.

1. Establish the expected behavior from repository evidence, requirements or tests.
2. Reproduce the failure when practical. If reproduction is not possible, identify the strongest observable evidence available.
3. Trace the failure from symptom to root cause across the relevant code path, state, data and external boundaries.
4. Test competing hypotheses rather than patching the first plausible cause.

Before implementing a fix, state concisely:

- confirmed root cause or current best-supported cause
- evidence
- affected code or component
- confidence
- regression risk

If the root cause is not sufficiently supported, continue diagnosis instead of guessing.

If a fix is authorized, implement the smallest root-cause fix. Add or update a regression test that fails for the original defect and passes with the fix where practical; document why and provide alternative evidence if not. Otherwise report diagnosis and proposed fix without edits.

For implementation, run relevant validation before `TWO-PASS REVIEW` on the complete diff. For diagnosis only, use analysis review. Handle findings under `AGENTS.md`.

Finish with the root cause, fix, regression coverage, validation evidence and any remaining unverified risk.
