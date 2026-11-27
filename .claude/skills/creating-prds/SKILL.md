---
name: creating-prds
description: "Creates an implementation-ready product requirements document through evidence-based discovery. Use when the user wants a PRD with explicit goals, workflows, functional requirements, acceptance criteria, constraints, edge cases, and deferred items but does not want code implemented yet. Use for an explicit formal PRD deliverable without code implementation, not discovery-only or end-to-end feature delivery."
---

# Product requirements document discovery

Follow AGENTS.md authorization modes and decision checkpoints. Use for an explicit formal PRD deliverable without code implementation, not discovery-only or end-to-end feature delivery.

Create an implementation-ready product requirements document from this input:

Resolve the requested product_idea from the user request and repository context; ask only if essential information is missing.

Inspect the repository or supplied product context first when it can answer questions about existing behavior or constraints.

Follow the canonical discovery procedure in `../discovering-requirements/SKILL.md`. Resolve material product questions before writing the PRD.

Then write the PRD with:

- problem and context
- users and use cases
- goals and non-goals
- current behavior when relevant
- required workflows and UX states
- functional requirements with stable IDs such as `FR-01`
- data, permissions and integration requirements
- edge cases and failure behavior
- applicable non-functional requirements
- acceptance criteria with stable IDs such as `AC-01`
- dependencies, constraints and rollout considerations
- deferred ideas
- open questions

Requirements and acceptance criteria must be observable and testable. Do not invent technical constraints.

Run `TWO-PASS REVIEW` on the PRD and correct confirmed issues. `Open questions` must be empty before the PRD is considered implementation-ready.

Do not implement code.
