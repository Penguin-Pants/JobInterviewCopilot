import shutil
from pathlib import Path

from shared_skills import registered, regular

ROOT = Path(__file__).resolve().parents[1]

def sync(root):
    for name in registered(root):
        source = regular(root, f".agents/skills/{name}/SKILL.md")
        relative = f".claude/skills/{name}/SKILL.md"
        destination = root / relative
        if destination.resolve() != root.resolve() / relative or destination.is_symlink():
            raise ValueError("Nonregular shared destination: " + relative)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)

if __name__ == "__main__":
    sync(ROOT)
