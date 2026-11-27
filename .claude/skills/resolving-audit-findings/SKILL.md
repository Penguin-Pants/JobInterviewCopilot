---
name: resolving-audit-findings
description: Resolves an existing audit's confirmed findings in an approved scope through dependency-ordered implementation and validated pull requests. Use for batch audit remediation or planning its PR sequence; not for discovering new findings, ordinary bug fixes or general feature execution.
---

# Resolve audit findings

Resolve the audit source and requested mode from the user request and repository context. Ask only if essential information remains missing.

Modes:
- plan-only (default unless edits are authorized): verify findings, order fixes and propose PRs without repository edits.
- selected: implement explicitly selected findings.
- all-approved: implement all confirmed findings in an explicitly approved audit scope.

Follow AGENTS.md authorization modes and DECISION CHECKPOINT. Initial batch approval covers individual in-scope fixes. Stop only affected work for unresolved material product or security decisions, scope expansion or genuine blockers. Continue independent authorized work.

## Verify and sequence

Recheck each finding against current code, tests and contracts. Record evidence, severity and F1–F4 disposition independently. Identify dependencies, shared components, migrations, rollback risk and test dependencies. Group related changes; isolate unrelated or risky fixes. Do not invent new scope.

Create a proposed dependency-ordered PR sequence. Stack branches only where changes depend on previous PRs. Identify base branches and exact merge order. Avoid unnecessary PRs.

## Implement authorized scope

For each group:
1. Inspect branch and preserve unrelated changes.
2. Implement smallest root-cause fixes and add risk-based regression coverage.
3. Run relevant validation and implementation TWO-PASS REVIEW; fix F1/F2 findings within scope and rerun checks. Record F3 proposals and F4 reasons.
4. Commit, push and create/update PR only when authorized. Do not merge without authorization. Do not bypass checks or rewrite history without explicit approval.
5. Continue independent work; record blockers and dependent work that cannot proceed.

## Final verification

Verify the combined stacked result where practical, run broad relevant checks and map every original finding to a PR or documented disposition. Confirm base branches and merge sequence. Report exact verification gaps; do not claim integration passed unless tested.

Deliver merge order, PR links or proposed groups, finding-to-PR traceability, test evidence, blockers and final status. For plan-only use analysis TWO-PASS REVIEW.
