---
name: assessing-productization
description: "Assesses what must change to turn a one-off or personal application into a reusable product for external users, open source, self-hosting, or future SaaS. Use for productization gap analysis, onboarding and configuration design, distribution planning, and staged readiness roadmaps. Use for external-user readiness of an existing personal app, not a new product PRD or actual release candidate verification."
---

# Productization readiness assessment

Follow AGENTS.md authorization modes and decision checkpoints. Use for external-user readiness of an existing personal app, not a new product PRD or actual release candidate verification.

Assess the current repository for the work required to turn a one-off personal solution into a reusable product that other people can install, configure and use without the original developer.

Possible future models are self-hosted open source, hosted SaaS or both. Do not assume the current architecture or UX must be preserved.

This is an analysis and planning task. Do not implement changes.

## Review process

Inspect the repository first. Ask only questions whose answers materially change the recommendations and that the repository cannot answer.

Evaluate these areas:

1. **Current state:** architecture, workflows, configuration, integrations, authentication, storage, deployment, jobs, infrastructure assumptions and manual steps.
2. **One-user coupling:** hardcoded paths, IDs, accounts, prompts, schemas, defaults, secrets, undocumented conventions and other assumptions tied to the original user or environment.
3. **Configuration and onboarding:** what should become a default, settings UI, environment variable, configuration file, setup step or admin/user preference. Include installation, first run, upgrades, backup and restore.
4. **Product UX:** terminology, navigation, onboarding, empty and error states, settings, status feedback and any workflow that assumes implementation knowledge.
5. **Multi-user and SaaS readiness:** identity, authorization, workspaces, tenant isolation, secrets, quotas, usage, audit logs, rate limits, privacy and data lifecycle. Separate what is required now from what should only be designed for later.
6. **Reliability and distribution:** validation, retries, migrations, observability, tests, security, dependency management, documentation, supportability and the smallest practical distribution model.

Use repository evidence for recommendations. Prefer product or UX fixes over documentation when they remove the need for explanation. Avoid designing for hypothetical scale that the first reusable release does not need.

Run `TWO-PASS REVIEW` before finalizing the assessment.

## Deliverables

Provide:

1. **Executive summary**
2. **Up to 10 material productization gaps**
3. **Current-state architecture**
4. **Productization gap table** with `Area | Current state | Problem for external users | Recommended state | Priority`
5. **Target user experience** from discovery through installation, setup, first successful result and regular use
6. **Prioritized roadmap**:
   - `P0`: blocks external users
   - `P1`: minimum reusable release
   - `P2`: product-quality improvements
   - `P3`: deferred improvements, including SaaS-only readiness when relevant
7. **Architecture and product decisions** that require the user

For each major roadmap item include the problem, recommended change, reason, likely affected components, dependencies and complexity (`Small`, `Medium` or `Large`).

For each required decision include the options, trade-offs, recommended default and whether it is needed now or can wait.
