---
name: implementing-bounded-changes
description: "Implements a small, well-bounded code change without creating unnecessary feature specifications or build plans. Use for focused changes such as adding a setting, adjusting behavior, renaming a field, removing an obsolete option, or making another limited modification. Use for an authorized, clearly specified small change, not a bug diagnosis, substantial feature or existing build-plan phase."
---

# Implement a bounded change

Follow AGENTS.md authorization modes and decision checkpoints. Use for an authorized, clearly specified small change, not a bug diagnosis, substantial feature or existing build-plan phase.

Implement this change:

Resolve the requested change from the user request and repository context; ask only if essential information is missing.

Inspect the relevant implementation before editing. Determine whether the requested behavior is sufficiently defined for direct implementation.

If a material product decision remains, use `DECISION CHECKPOINT`. Otherwise proceed without creating a feature specification or build plan.

Make the smallest complete change that satisfies the request. Reuse existing patterns and keep unrelated cleanup out of scope.

After implementation:

1. Run the relevant validation required by `AGENTS.md`.
2. Run `TWO-PASS REVIEW` on the complete diff.
3. Handle findings under the shared finding classification.
4. Verify the requested behavior directly when practical.
5. Update affected documentation or configuration examples only when the change requires it.

Do not expand a bounded change into a redesign, broad refactor or unrelated improvement.
