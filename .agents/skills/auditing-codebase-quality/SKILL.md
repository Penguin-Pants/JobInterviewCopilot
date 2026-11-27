---
name: auditing-codebase-quality
description: "Performs an evidence-based codebase quality audit covering correctness, maintainability, performance, resilience, and applicable usability concerns. Use when the user wants a prioritized improvement plan without assuming the working application should be rewritten or expanded. Use for broad quality assessment, not specialized security, design, error-copy or PR review."
---

# Comprehensive codebase improvement review

Follow AGENTS.md authorization modes and decision checkpoints. Use for broad quality assessment, not specialized security, design, error-copy or PR review.

Review the codebase for evidence-backed improvements. This is an analysis task. Do not modify code.

Scale the audit to project tier and risk. Confirm an unassigned tier only if material to the assessment. Evaluate applicable areas:

- **Correctness and consistency:** logic errors, edge cases, type or contract mismatches and inconsistent behavior.
- **Maintainability:** harmful duplication, dead code, unclear responsibilities, unnecessary indirection and inconsistent patterns.
- **Performance and resources:** leaks, unbounded work or data, unnecessary queries or renders, blocking I/O and missing backpressure or timeouts where needed.
- **Error handling and resilience:** swallowed failures, missing trust-boundary validation and weak handling of external failures.
- **Usability:** responsive behavior, accessibility and UX problems when required by the project tier and product surface.

Do not use arbitrary thresholds such as function length alone as evidence of a problem.

Run `TWO-PASS REVIEW` before finalizing findings.

For each confirmed issue, report:

- `path:line`
- severity using the shared severity scale
- category
- issue
- evidence and user or engineering impact
- root-cause fix

Use the shared finding classification. Report possible risks separately. Group changes that should be solved together and end with a prioritized improvement plan. Skip categories with no meaningful findings.
