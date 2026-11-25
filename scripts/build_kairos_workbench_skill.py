"""Build the Kairos Skill ZIP for the hosted research workbench."""

import argparse
from pathlib import Path
from tempfile import NamedTemporaryFile
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parents[1]
NAME = "llm-research-workbench"
SOURCE = ROOT / "skills" / "kairos" / NAME
FILES = (
    "SKILL.md",
    "references/setup.md",
    "references/project-review.md",
    "references/screening.md",
    "references/client-service.md",
    "assets/mcp-remote.json",
)


def build(output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=output.parent, suffix=".zip.tmp", delete=False) as temporary:
        pending = Path(temporary.name)
    try:
        with ZipFile(pending, "w", ZIP_DEFLATED) as archive:
            for name in FILES:
                archive.write(SOURCE / name, f"{NAME}/{name}")
        pending.replace(output)
    finally:
        pending.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts" / "kairos-workbench" / f"{NAME}.zip")
    args = parser.parse_args()
    build(args.output)
    print(args.output.resolve())


if __name__ == "__main__":
    main()
