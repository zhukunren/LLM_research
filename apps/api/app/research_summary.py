"""Optional, turn-bound reading briefs; full research answers remain authoritative."""
from __future__ import annotations

from datetime import date
import logging
import re
from typing import Annotated, Literal

from pydantic import Field, StringConstraints, ValidationError

from .models import StrictModel
from . import research_workspace

logger = logging.getLogger(__name__)
ShortText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=240)]


class SummaryPoint(StrictModel):
    kind: Literal["fact", "inference", "unknown"]
    text: ShortText


class ResearchSummary(StrictModel):
    version: Literal[1]
    turn_id: str = Field(min_length=1, max_length=100)
    conclusion: ShortText
    key_points: list[SummaryPoint] = Field(max_length=3)
    risks: list[ShortText] = Field(max_length=3)
    next_steps: list[ShortText] = Field(max_length=3)
    data_as_of: date | None
    data_note: ShortText | None


def filename(turn_id: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", turn_id):
        raise ValueError("研究回合标识无效")
    return f".research-summary-{turn_id}.json"


def contract(turn_id: str) -> dict:
    return {
        "path_relative_to_workspace": filename(turn_id),
        "turn_id": turn_id,
        "schema": ResearchSummary.model_json_schema(),
        "instructions": (
            "For a completed research answer (including a brief explanation), write one UTF-8 JSON object matching this schema "
            "to the exact workspace-relative path before the final answer. This is internal reading metadata; "
            "do not link it as a deliverable. Use the user's language, with one short conclusion and up to "
            "three key points, risks and next steps. Summarize only findings supported in the full answer; "
            "distinguish source-backed facts, inferences and unknowns. Keep citations and original source "
            "locators in the full answer. data_as_of is an actual common evidence cutoff, never the generation "
            "date or an assumed market watermark; use null for mixed or unconfirmed dates and explain actual "
            "report periods/dates in data_note. Use empty lists or null where there is no supported content. "
            "For clarification-only replies or requests for code or files without research findings, omit this file. "
            "The full answer must also remain complete when read without this brief."
        ),
    }


def clear(conversation_id: str, turn_id: str) -> None:
    """A retry must not publish a brief left over from a previous execution."""
    path = research_workspace.directory(conversation_id) / filename(turn_id)
    path.unlink(missing_ok=True)


def read(conversation_id: str, turn_id: str) -> dict | None:
    root = research_workspace.directory(conversation_id).resolve()
    path = root / filename(turn_id)
    try:
        if path.is_symlink() or not path.resolve().is_relative_to(root) or not path.is_file():
            return None
        # Bound the read as well as the validated fields, including a file growing during the read.
        with path.open("rb") as stream:
            raw = stream.read(16385)
        if len(raw) > 16384:
            return None
        brief = ResearchSummary.model_validate_json(raw)
        if brief.turn_id != turn_id:
            return None
        return brief.model_dump(mode="json")
    except (OSError, ValueError, ValidationError):
        logger.warning("Ignoring unavailable or invalid research brief for turn %s", turn_id)
        return None
