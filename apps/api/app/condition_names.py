"""Condition names identify current assets; historical revisions keep their names."""
from __future__ import annotations

import unicodedata


class ConditionNameError(ValueError):
    def __init__(self, message: str, status: int = 409):
        super().__init__(message)
        self.status = status
        self.code = "condition_name_conflict" if status == 409 else "invalid_condition_name"


def normalized_condition_name(name: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", name).split()).casefold()


def check_condition_name(connection, name: str, *, condition_id: str | None = None) -> str:
    cleaned = name.strip()
    if not cleaned:
        raise ConditionNameError("条件名称不能为空", 422)
    normalized = normalized_condition_name(cleaned)
    latest = connection.execute("""SELECT f.id,f.name FROM filters f
        JOIN (SELECT id,MAX(version) AS version FROM filters GROUP BY id) current
          ON current.id=f.id AND current.version=f.version""").fetchall()
    # Editing a pre-existing asset keeps its identity, including legacy assets
    # that already share a name. No new duplicate identity is created.
    if any(row["id"] == condition_id and normalized_condition_name(row["name"]) == normalized for row in latest):
        return cleaned
    if any(row["id"] != condition_id and normalized_condition_name(row["name"]) == normalized for row in latest):
        raise ConditionNameError("已有同名条件")
    return cleaned
