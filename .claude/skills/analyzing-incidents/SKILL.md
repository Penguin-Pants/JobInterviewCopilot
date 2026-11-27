---
name: analyzing-incidents
description: "Produces a factual software incident or outage postmortem focused on timeline, impact, technical root cause, contributing conditions, detection, recovery, and evidence-backed prevention work. Use after a production failure, data incident, severe regression, or operational outage. Use for postmortems of past incidents, not live bug remediation or performance optimization."
---

# Analyze a software incident

Follow AGENTS.md authorization modes and decision checkpoints. Use for postmortems of past incidents, not live bug remediation or performance optimization.

Create an evidence-based postmortem for this incident:

Resolve the requested incident from the user request and repository context; ask only if essential information is missing.

Use repository history, logs, monitoring, deployment records and other supplied evidence. Separate confirmed facts from assumptions and unknowns.

Document:

- user and system impact
- timeline with confirmed timestamps where available
- detection and initial signals
- technical root cause
- contributing conditions that increased likelihood or impact
- why existing tests, monitoring or controls did not prevent or detect it earlier
- mitigation and recovery actions
- remaining risk

Do not assign personal blame. Do not turn every contributing condition into mandatory work.

For prevention items, distinguish:

- root-cause fixes
- detection or recovery improvements
- optional resilience improvements

Tie each action to incident evidence, assign a measurable completion condition and identify the affected system or document when known.

Run `TWO-PASS REVIEW` on the postmortem before finalizing it.
