"""Run a public research question through the real app in an isolated database.

This records answers and tool activity for source-by-source human review. It does
not label an answer correct merely because a tool succeeded or a number appeared.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from uuid import uuid4


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prompt", type=Path, required=True, help="UTF-8 public research question")
    parser.add_argument("--as-of", required=True, help="Information cutoff, YYYY-MM-DD")
    parser.add_argument("--depth", choices=("standard", "deep", "both"), default="both")
    parser.add_argument("--output-root", type=Path, default=PROJECT_ROOT / "runtime" / "verification" / "research-quality")
    args = parser.parse_args()
    from datetime import date

    date.fromisoformat(args.as_of)
    prompt = args.prompt.resolve().read_text(encoding="utf-8").strip()
    if not prompt:
        parser.error("The question is empty")

    # Set isolation before importing modules that freeze database/data locations.
    output = args.output_root.resolve() / uuid4().hex
    output.mkdir(parents=True)
    os.environ["LLMR_DB_PATH"] = str(output / "app.db")
    os.environ["LLMR_DATA_ROOT"] = str(output / "empty-data")
    sys.path.insert(0, str(PROJECT_ROOT))
    from apps.api.app import codex_runtime, conversation_store, db
    from apps.api.app.screening_contracts import ResearchScope

    db.init_db()
    (output / "prompt.txt").write_text(prompt, encoding="utf-8")
    results = []
    depths = ("standard", "deep") if args.depth == "both" else (args.depth,)
    for depth in depths:
        # Separate threads prevent one depth from reusing the other's evidence.
        conversation = conversation_store.create_conversation("screening", workflow_type="research")
        cid = conversation["id"]
        conversation_store.update_workflow(cid, "research", depth)
        conversation_store.update_research_scope(cid, 0, ResearchScope(as_of=args.as_of))
        message = conversation_store.add_user_message(cid, "quality-" + depth, 0, prompt)
        tid = message["turn_id"]
        conversation_store.start_turn(cid, tid)
        print(json.dumps({"started": depth, "output": str(output)}, ensure_ascii=False), flush=True)
        started = time.monotonic()
        turn = codex_runtime.process_conversation_turn(cid, tid)
        with db.connect() as connection:
            events = [json.loads(row[0]).get("item", {}) for row in connection.execute(
                "SELECT payload_json FROM codex_turn_events WHERE app_turn_id=? AND method='item/completed' ORDER BY sequence", (tid,)
            )]
            calls = [dict(row) for row in connection.execute(
                "SELECT tool_name,state,result_json FROM tool_calls WHERE turn_id=? ORDER BY created_at", (tid,)
            )]
        record = {
            "depth": depth, "state": turn["state"], "seconds": round(time.monotonic() - started, 1),
            "as_of": args.as_of, "conversation_id": cid, "turn_id": tid,
            "result": turn["result"], "response": turn["response_text"],
            "web_actions": [event for event in events if event.get("type") == "webSearch"],
            "image_views": [event for event in events if event.get("type") == "imageView"],
            "tool_calls": calls,
        }
        results.append(record)
        (output / (depth + ".txt")).write_text(turn["response_text"], encoding="utf-8")
        (output / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"finished": depth, "state": record["state"], "seconds": record["seconds"],
                          "model": record["result"].get("model"), "effort": record["result"].get("reasoning_effort")}, ensure_ascii=False), flush=True)
    print(json.dumps({"output": str(output / "results.json"), "human_review_required": True}), flush=True)
    return 0 if all(result["state"] == "succeeded" for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
