"""Fixed customer disclosure, shared with the web editor and all export paths."""
import json
from pathlib import Path


FIXED_DISCLOSURE = json.loads(
    (Path(__file__).parent / 'assets/client-service/disclosure.json').read_text(encoding='utf-8')
)


def with_fixed_disclosure(content: dict) -> dict:
    # Also upgrades saved templates/cards without touching their editable copy or revision.
    return {**content, **FIXED_DISCLOSURE}


def disclosure_lines() -> list[str]:
    return [f'{label}：{FIXED_DISCLOSURE[key]}' for key, label in (
        ('risk', '风险提示'), ('adviser', '投资顾问'),
        ('license', '投顾执业编码'), ('institution', '执业机构'),
    )]
