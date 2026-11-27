import json
import re

PATTERN = re.compile(r"\.agents/skills/([a-z0-9]+(?:-[a-z0-9]+)*)/SKILL\.md")

def registered(root):
    manifest = json.loads((root / ".agents/ownership.json").read_text(encoding="utf-8"))
    paths = manifest["managed"]
    if not isinstance(paths, list) or len(paths) != len(set(paths)):
        raise ValueError("Invalid ownership list")
    names = sorted(m.group(1) for p in paths if (m := PATTERN.fullmatch(p)))
    expected = {f".claude/skills/{name}/SKILL.md" for name in names}
    actual = {p for p in paths if re.fullmatch(r"\.claude/skills/[^/]+/SKILL\.md", p)}
    if not names or actual != expected:
        raise ValueError("Managed skill pairs differ")
    return names

def regular(root, relative):
    path = root / relative
    if not path.is_file() or path.is_symlink() or path.resolve() != root.resolve() / relative:
        raise ValueError("Missing or nonregular shared file: " + relative)
    return path
