# Shared skills

Canonical skills live in .agents/skills/<name>/SKILL.md. The .claude/skills copies are generated for Claude Code. Edit the canonical source only, then run `python scripts/sync-skills.py` and `python scripts/validate-skills.py` from the repository root. Commit both trees together.

Choose the most specific skill matching the requested outcome. See AGENTS.md for authorization and review procedures. A skill does not grant permissions. Explicit invocation does not authorize unrelated actions.

Behavioral test cases live in .agents/shared/skill-evaluations.json. Run them in clean Claude Code and Codex contexts with representative repositories and record actual outcomes separately. Static checks do not demonstrate trigger accuracy.

Only registered shared paths in `.agents/ownership.json` are generated and validated; custom project skills are not modified or evaluated by this check.
