---
name: upgrading-dependencies-and-apis
description: "Plans and performs dependency, SDK, framework, model, browser API, or external API upgrades using authoritative migration evidence and focused regression validation. Use when changing versions or replacing deprecated interfaces where breaking changes may affect behavior. Assess a proposed upgrade without edits unless migration is authorized; prefer debugging-code for a failure not caused by a version migration."
---

# Upgrade a dependency or API

Follow AGENTS.md authorization modes and decision checkpoints. Assess a proposed upgrade without edits unless migration is authorized; prefer debugging-code for a failure not caused by a version migration.

Upgrade this dependency, SDK, framework or API:

Resolve the requested target from the user request and repository context; ask only if essential information is missing.

Establish before editing:

- currently used version or interface
- requested target version or interface
- all repository call sites and configuration that depend on it
- authoritative changelog, migration guide or API documentation when available
- breaking changes, deprecations and compatibility constraints that apply to this repository

Do not assume a newer interface is backward compatible.

Create the smallest migration plan that preserves existing product behavior unless the request explicitly changes behavior. Keep unrelated dependency upgrades out of scope unless they are required together.

If migration is authorized, implement it; otherwise stop with the migration plan and risk assessment. Update configuration, lockfiles, tests and documentation only where required.

Run the relevant tests and direct behavior checks for affected integrations. Search again for obsolete APIs, deprecated configuration and old version assumptions after the change.

Run `TWO-PASS REVIEW` on the complete diff.

Finish with:

- old and new versions or interfaces
- applicable breaking changes
- changed call sites and configuration
- validation performed
- remaining deprecations or compatibility risks
- any required follow-up that could not be completed
