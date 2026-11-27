---
name: checking-release-readiness
description: "Checks whether the actual release candidate is ready to deploy by verifying required behavior, tests, build, migrations, configuration, security, documentation, rollout, rollback, and smoke checks at the project tier. Use immediately before a release or deployment, not for early design review. Use for an actual release candidate, not early plan risk or general project status. Never publish or deploy as part of checking."
---

# Release readiness check

Follow AGENTS.md authorization modes and decision checkpoints. Use for an actual release candidate, not early plan risk or general project status. Never publish or deploy as part of checking.

Assess the current release candidate or branch for deployment readiness. This is a verification task. Do not add scope or implement optional improvements.

Scale the check to project tier and risk; confirm an unassigned tier only when it materially changes release requirements. Do not claim readiness while material requirements remain unknown.

Verify applicable evidence for:

1. required features, acceptance criteria and known release scope
2. test, lint, type-check and build status
3. migrations, schema changes, data backups and backward compatibility
4. environment variables, configuration, secrets and deployment prerequisites
5. security and privacy requirements required by the project tier
6. user-facing documentation, release notes or upgrade instructions when required
7. rollout, rollback and recovery steps
8. post-deploy smoke checks and observability for failures

Inspect the actual branch, configuration and deployment artifacts. Do not treat a planning checklist as proof that a check passed.

Classify each applicable check as `PASS`, `FAIL`, `NOT VERIFIED` or `NOT APPLICABLE` and cite the evidence used.

Run `TWO-PASS REVIEW` on the readiness assessment.

Deliver:

- release scope checked
- blocking failures
- unverified items
- passed checks
- skipped checks with the project-tier reason
- exact verification or remediation needed for each blocker

Do not declare the release ready while required checks are `FAIL` or `NOT VERIFIED`.
