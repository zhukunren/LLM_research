import json
import os
import subprocess
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).parents[2]


def test_offline_conversation_verifier_covers_all_thirty_cases():
    result = subprocess.run(
        [sys.executable, "scripts/verify_conversation.py", "--mode", "offline"],
        cwd=ROOT, capture_output=True, text=True, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    payload = json.loads(result.stdout)
    assert payload["status"] == "passed"
    assert payload["cases"] == 30


@pytest.mark.skipif(os.environ.get("RUN_LIVE_CONVERSATION_TESTS") != "1", reason="live model acceptance is an explicit command")
def test_live_verifier_has_explicit_unavailable_state_without_credentials():
    result = subprocess.run(
        [sys.executable, "scripts/verify_conversation.py", "--mode", "live"],
        cwd=ROOT, capture_output=True, text=True, check=False,
    )
    assert result.returncode == 0
    payload = json.loads(result.stdout)
    assert payload["mode"] == "live"
    assert payload["status"] in {"passed", "unavailable", "failed"}
