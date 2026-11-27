---
name: evaluating-agent-skills
description: "Designs and runs focused evaluations for reusable agent skills, including trigger accuracy, non-trigger cases, instruction following, output quality, coexistence with related skills, and regression checks. Use before adopting or changing a skill and when a skill triggers incorrectly or produces inconsistent results. Use for skill behavior and trigger evaluations, not application testing."
---

# Evaluate an agent skill

Follow AGENTS.md authorization modes and decision checkpoints. Use for skill behavior and trigger evaluations, not application testing.

Evaluate this skill or skill source:

Resolve the requested skill from the user request and repository context; ask only if essential information is missing.

Do not judge quality from the wording alone. Create representative evaluations that test actual behavior.

At minimum include:

1. a clear request that should trigger the skill
2. a clear request that should not trigger the skill
3. a boundary case where a related skill could also apply
4. a normal successful workflow case
5. a difficult, incomplete or failure-path case when relevant

For each case define the expected trigger behavior and observable success criteria. Avoid criteria that depend on hidden reasoning.

When execution is available, run the cases in a clean context and record actual behavior. Test related skills together when trigger overlap is possible.

Evaluate:

- trigger precision and recall
- instruction following
- unnecessary questions or approval gates
- scope control
- evidence and verification quality
- final output usefulness
- conflicts with `AGENTS.md` or related skills

Run `TWO-PASS REVIEW` on the findings.

Recommend the smallest skill change that fixes observed failures. Do not add instructions for hypothetical failures that the evaluations do not expose.

After changes, rerun the failed cases plus at least one previously passing regression case.
