---
name: discovering-requirements
description: "Turns an incomplete product or feature idea into a precise, decision-complete set of requirements. Use when the user wants rigorous clarification before planning or implementation, especially when product behavior, scope, workflows, edge cases, or priorities are ambiguous. Use for decision-complete discovery without implementation or a formal PRD deliverable; supports creating-prds and delivering-features as a subtask."
---

# Requirements discovery

Follow AGENTS.md authorization modes and decision checkpoints. Use for decision-complete discovery without implementation or a formal PRD deliverable; supports creating-prds and delivering-features as a subtask.

Turn this initial idea into a precise set of requirements without implementing it.

Resolve the requested input from the user request and repository context; ask only if essential information is missing.

Inspect the repository or supplied context first when it can answer questions about current behavior, constraints or existing patterns.

Run a focused discovery loop under the question rules in `AGENTS.md`. Ask only questions whose answers materially change the product, scope or implementation. Ask in small groups and follow up when an answer introduces a contradiction, hidden assumption or unresolved behavior.

For each stated solution, determine whether it is a hard requirement, preference, example or one possible implementation. Do not convert preferences into requirements silently.

Resolve only applicable areas such as:

- problem, users, outcome and non-goals
- current and desired behavior
- primary workflows, entry points and UX states
- defaults, settings and configuration
- data, persistence, permissions and integrations
- validation, errors, recovery and edge cases
- compatibility, migration and rollout
- security, privacy, accessibility and performance when material

Challenge unnecessary complexity and solution-first assumptions when a smaller behavior can satisfy the underlying need.

Stop discovery when another competent coding agent could proceed without making a material product decision for the user.

Deliver:

- problem and desired outcome
- confirmed requirements
- preferences and examples that must not be treated as requirements
- non-goals
- edge cases and failure behavior
- confirmed constraints
- deferred ideas
- open questions

`Open questions` must be empty before the requirements are described as decision-complete.
