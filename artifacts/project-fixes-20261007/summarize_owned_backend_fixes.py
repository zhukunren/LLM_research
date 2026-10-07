"""Compare only this agent's edits with the user's pre-fix working files."""
from pathlib import Path
import difflib
import json
import xml.etree.ElementTree as ET

AUDIT = Path(__file__).resolve().parent
ROOT = AUDIT.parents[1]
BASELINE = AUDIT / "backend-tests-before"
FILES = [
    "apps/api/app/research_pdf_service.py", "apps/api/app/research_projects.py",
    "apps/api/app/research_observations.py", "tests/integration/test_research_pdf_jobs.py",
    "tests/integration/test_research_observations.py", "tests/integration/test_screening_tool_api.py",
    "tests/integration/test_workflow_tools.py", "tests/integration/test_market_data.py",
]
chunks = []
for relative in FILES:
    before = (BASELINE / relative).read_text(encoding="utf-8").splitlines(keepends=True)
    after = (ROOT / relative).read_text(encoding="utf-8").splitlines(keepends=True)
    chunks.extend(difflib.unified_diff(before, after, fromfile="before/" + relative, tofile="after/" + relative))
(AUDIT / "backend-owned-fixes.diff").write_text("".join(chunks), encoding="utf-8")
suite = ET.parse(AUDIT / "backend-owned-tests.xml").getroot().find("testsuite")
summary = {
    "files": FILES, "tests": suite.attrib,
    "changes": [
        "Normalize cache owner metadata and stable sort keys for project PDF file lists",
        "Retain previous PDF while its replacement queues, fails, or retries",
        "Require a successful research turn with matching published text for observation candidates",
        "Allow missing historical client binding only with one matching recorded completion and timestamp",
        "Supply isolated real Parquet fixtures for tool capability checks; missing real data explicitly skips",
    ],
    "isolation": "Empty LLMR_DATA_ROOT; temporary DB and local Parquet; no model or business DB calls",
    "baseline": str(BASELINE), "patch": str(AUDIT / "backend-owned-fixes.diff"),
}
(AUDIT / "backend-owned-fixes.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(suite.attrib, ensure_ascii=False))
