# Project tiers (proposed)

Confirm tier with owner only when it materially affects validation, security or release requirements. Continue evidence gathering when unassigned; apply risk-based safeguards. Do not infer from size alone. Escalate for sensitive data, irreversible changes or production exposure.

| Tier | Scope | Minimum validation and documents |
|---|---|---|
| T1 | Small utility or experiment | README, instructions, brief requirements, relevant behavior checks |
| T2 | Standalone application | Requirements, repeatable build and tests, CI, basic security and release checks |
| T3 | Complex app or integrations | Architecture, build plan, decision log, integration tests, full risk review |
| T4 | Complex or high-risk product | T3 plus traceability, release evidence, critical E2E, security and recovery tests |

Planning-only work validates documents and decisions rather than pretending code tests exist. Risk overrides tier.
