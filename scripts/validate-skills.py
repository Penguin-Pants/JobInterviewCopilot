import json
import re
import sys
from pathlib import Path

from shared_skills import registered, regular

ROOT = Path(__file__).resolve().parents[1]

def validate(root):
    errors = []
    try:
        names = registered(root)
        for name in names:
            path = regular(root, f".agents/skills/{name}/SKILL.md")
            copy = regular(root, f".claude/skills/{name}/SKILL.md")
            text = path.read_text(encoding="utf-8")
            match = re.match(r"\A---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n", text)
            if not match:
                errors.append(f"{name}: invalid metadata")
                continue
            declared, description = match.groups()
            if declared != name or len(name) > 64:
                errors.append(f"{name}: invalid name")
            try:
                description = json.loads(description) if description.startswith('"') else description
            except ValueError:
                errors.append(f"{name}: invalid description quoting")
                continue
            if not isinstance(description, str) or not description.strip() or len(description) > 1024:
                errors.append(f"{name}: invalid description length")
            if path.read_bytes() != copy.read_bytes():
                errors.append(f"{name}: generated copy differs")
            for ref in re.findall(r"`(\.\./[^ `]+/SKILL\.md)`", text):
                target = (path.parent / ref).resolve()
                if not target.is_file() or target not in {root.resolve() / ".agents/skills" / n / "SKILL.md" for n in names}:
                    errors.append(f"{name}: invalid managed reference {ref}")
        cases = json.loads(regular(root, ".agents/shared/skill-evaluations.json").read_text(encoding="utf-8"))
        expected = {"positive", "negative", "boundary", "normal", "failure"}
        ids = [c["id"] for c in cases]
        if len(ids) != len(set(ids)):
            errors.append("Duplicate evaluation IDs")
        if {c["skill"] for c in cases} != set(names):
            errors.append("Evaluation skill set differs")
        for name in names:
            rows = [c for c in cases if c["skill"] == name]
            if len(rows) != 5 or {c["kind"] for c in rows} != expected:
                errors.append(f"{name}: missing or duplicate evaluation cases")
            if any(not c.get("request") or not c.get("success_criteria") for c in rows):
                errors.append(f"{name}: incomplete evaluation case")
    except (OSError, ValueError, KeyError, TypeError) as exc:
        errors.append(str(exc))
    return errors

def main():
    errors = validate(ROOT)
    if errors:
        print("\n".join(errors))
        return 1
    print(f"Validated {len(registered(ROOT))} registered shared skills; local skills excluded; behavioral execution not implied.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
