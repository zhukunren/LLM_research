"""Publish a verified directory without treating transient Windows sharing locks as corruption."""
from pathlib import Path
import time


def publish_directory(temporary: Path, destination: Path) -> None:
    if temporary.is_symlink() or temporary.is_junction():
        raise ValueError("Temporary backup/restore directory cannot be a link")
    source, target = temporary.resolve(), destination.resolve()
    if source.parent != target.parent or source.name != target.name + ".tmp":
        raise ValueError("Temporary directory must be the destination's sibling staging directory")
    for attempt in range(6):
        if destination.exists():
            raise FileExistsError("The destination already exists; it will not be overwritten")
        try:
            temporary.rename(destination)
            return
        except PermissionError as exc:
            if getattr(exc, "winerror", None) not in {5, 32, 33} or attempt == 5:
                raise
            time.sleep(0.05 * 2 ** attempt)
