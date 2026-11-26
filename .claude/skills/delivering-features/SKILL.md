---
name: delivering-features
description: "Takes a feature from incomplete idea through requirements discovery, specification, scope approval, implementation, acceptance-criteria verification, and pull request update. Use for substantial features that require product decisions before coding. Use for substantial features explicitly requested through implementation, not discovery-only, PRD-only or bounded changes."
---

# Feature discovery, specification and implementation

Follow AGENTS.md authorization modes and decision checkpoints. Use for substantial features explicitly requested through implementation, not discovery-only, PRD-only or bounded changes.

Turn this feature idea into an implementation-ready specification, then implement it after scope approval.

Resolve the requested feature_idea from the user request and repository context; ask only if essential information is missing.

Do not implement until discovery, specification review and the scope checkpoint are complete.

## 1. Discover requirements

Follow the canonical discovery procedure in `../discovering-requirements/SKILL.md`. Resolve all material product questions before specification and scope approval.

## 2. Write the feature specification

Create or update a specification with:

- Problem
- Goals and non-goals
- Users and use cases
- Current behavior
- Required behavior and key workflows
- UX requirements and states
- Functional requirements with stable IDs such as `FR-01`
- Edge cases and failure modes
- Confirmed technical constraints
- Acceptance criteria with stable IDs such as `AC-01`
- Testing and documentation requirements
- Deferred ideas
- Open questions

Requirements and acceptance criteria must be observable and testable. Do not invent technical constraints. `Open questions` must be empty before implementation.

## 3. Review and confirm scope

Run `TWO-PASS REVIEW` on the specification. Correct confirmed specification issues. Keep useful out-of-scope ideas under `Deferred ideas`.

Use `DECISION CHECKPOINT` to confirm the feature scope before implementation.

## 4. Plan and implement

After scope approval:

1. Inspect the affected code and produce the smallest implementation plan that satisfies the specification. Map planned work to the relevant `FR-*` and `AC-*` items.
2. Run `TWO-PASS REVIEW` on the plan when architecture, sequencing or migration risk is material. Resolve engineering issues directly. Ask only when a product decision is required.
3. Implement the approved scope under `AGENTS.md`.
4. Update the specification or plan only when implementation evidence requires it. Do not silently change product requirements.

## 5. Verify and create the PR

Run `TWO-PASS REVIEW` on the complete implementation.

Verify every acceptance criterion individually as `PASS`, `FAIL` or `NOT VERIFIED`. Explain any item that is not `PASS`. Do not describe the feature as complete unless all required acceptance criteria pass.

When PR operations are authorized, create or update the PR with (otherwise prepare this information for the owner):

- problem and solution
- major changes
- testing and validation performed
- acceptance criteria status
- important technical decisions
- known limitations
- deferred or proposed out-of-scope work

Split work into multiple PRs only when the changes are independently reviewable and the split reduces risk or coupling.
