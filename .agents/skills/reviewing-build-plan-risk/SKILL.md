---
name: reviewing-build-plan-risk
description: "Reviews an implementation or deployment plan for production safety, data integrity, compatibility, rollback, failure modes, observability, and blast radius before code is changed. Use when a planned change could affect production reliability or real data. Use before implementation for production risks in a plan, not actual release candidate verification."
---

# Build plan production-risk review

Follow AGENTS.md authorization modes and decision checkpoints. Use before implementation for production risks in a plan, not actual release candidate verification.

Review the build plan at `the plan identified from the request or repository context` before implementation. This is an analysis task. Do not modify application code.

Use repository evidence to evaluate the plan across these dimensions:

1. **Production safety and data integrity:** destructive operations, migrations, state changes, corruption or loss risks.
2. **Backward compatibility and deployment sequencing:** APIs, services, clients, schemas and rolling-deployment compatibility.
3. **Rollback and recovery:** how to return to a known-good state after partial or failed deployment.
4. **Edge cases and failure modes:** concurrency, retries, timeouts, external failures, rate limits and partial completion.
5. **Observability and blast radius:** logs, metrics, alerts, feature flags, canaries and ways to limit impact.

Run `TWO-PASS REVIEW` before finalizing findings.

Output:

- **Executive summary:** overall severity using the shared severity scale and why
- **Confirmed gaps:** grouped by the five dimensions with repository or plan evidence
- **Possible risks:** unproven concerns and how to verify them
- **Plan amendments:** exact changes recommended for the build plan
- **Deployment checklist:** concrete checks that must pass before rollout

Surface any unresolved product decision separately. Do not edit the plan unless the user asks.
