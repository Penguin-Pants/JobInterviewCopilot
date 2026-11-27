---
name: auditing-design-systems
description: "Audits UI implementation against a repository design specification, reports evidence-backed violations, confirms fix scope, and applies approved changes. Use when checking design tokens, typography, spacing, components, states, accessibility, or other explicit design-system rules. Use for compliance with an existing design specification, not creating a design or general code quality review. Analyze by default."
---

# UX design-system compliance review

Follow AGENTS.md authorization modes and decision checkpoints. Use for compliance with an existing design specification, not creating a design or general code quality review. Analyze by default.

Resolve UI paths and design specification from the request, AGENTS.md, docs/project-context.md and repository inspection. Conventional paths are search hints only. If no authoritative specification exists, report the blocker rather than invent rules.

Read the design spec first. Treat its YAML front matter as authoritative when present. Treat only rules actually defined by the design system as requirements.

Check applicable areas such as:

- hardcoded or off-system colors and token misuse
- spacing, borders, radius and shadows
- typography roles and text treatments
- focus states and accessibility requirements
- icon or affordance rules
- any other explicit component or semantic rules in the design spec

For each finding, report:

`path:line | category | current behavior | required behavior | design-spec reference`

Run `TWO-PASS REVIEW` on the audit. End the audit report with the five highest-impact fixes, or fewer when fewer are material.

Only when fixes are requested, confirm any unresolved scope through `DECISION CHECKPOINT`. Apply selected authorized fixes. Create or update a draft PR with a test-plan checklist only when PR operations are authorized.

After implementation, run relevant validation, then run `TWO-PASS REVIEW` on the full diff, handle findings under `AGENTS.md` and update the PR.
