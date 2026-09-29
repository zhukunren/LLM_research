from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from datetime import datetime, timezone


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "conversation_cases.json"


def _check_case(case: dict) -> list[str]:
    errors: list[str] = []
    expected = case.get("expected", {})
    if not case.get("messages"):
        errors.append("没有消息")
    if not isinstance(case.get("must_preserve"), list) or not case["must_preserve"]:
        errors.append("缺少must_preserve")
    text = " ".join(item.get("content", "") for item in case.get("messages", []))
    if case["id"] in {"C13", "C14"}:
        if ("全市场" in text) != (expected.get("ranking_universe") == "all_a_shares"):
            errors.append("全市场排名口径不一致")
        if ("股票中的" in text) != bool(expected.get("rank_after_filters")):
            errors.append("过滤后排名口径不一致")
    if case["id"] == "C15" and expected.get("capability") != "unavailable":
        errors.append("行业数据缺失场景必须标为不可用")
    if case["id"] == "C16" and "回归斜率" not in text:
        errors.append("自定义算法原文丢失")
    if case["id"] in {"C17", "C18", "C19", "C20", "C21"} and expected.get("decision_state") != "unknown":
        errors.append("不确定证据场景必须保留unknown")
    if case["id"] == "C29" and expected.get("duplicate_runs") != 0:
        errors.append("幂等场景必须禁止重复运行")
    return errors


def offline() -> dict:
    cases = json.loads(FIXTURE.read_text(encoding="utf-8"))
    errors = []
    ids = [case.get("id") for case in cases]
    if ids != [f"C{i:02}" for i in range(1, 31)]:
        errors.append("场景ID不是C01-C30完整集合")
    for case in cases:
        for error in _check_case(case):
            errors.append(f"{case.get('id')}: {error}")
    return dict(mode="offline", status="passed" if not errors else "failed", cases=len(cases), errors=errors,
                checked_at=datetime.now(timezone.utc).isoformat())


def live(case_set: str) -> dict:
    try:
        sys.path.insert(0, str(ROOT / "runtime" / "python-deps"))
        from apps.api.app.model_client import ModelRequestError, complete_json
        from apps.api.app.settings import llm_settings
        settings = llm_settings()
        if not settings.get("configured"):
            return dict(mode="live", status="unavailable", reason="文本模型未配置", case_set=case_set)
        cases = json.loads(FIXTURE.read_text(encoding="utf-8"))
        selected_ids = ["C01", "C02", "C03", "C05", "C07", "C08", "C09", "C13", "C14", "C15", "C16", "C25"]
        selected = [case for case in cases if case["id"] in selected_ids]
        expected = {case["id"]: case.get("expected", {}).get("intent") for case in selected}
        planner_prompt = (ROOT / "apps" / "api" / "app" / "prompts" / "conversation_planner_v1.md").read_text(encoding="utf-8")
        repetitions = {case_id: 3 for case_id in ("C02", "C07", "C13", "C16")}
        observations = []
        for case in selected:
            count = repetitions.get(case["id"], 1)
            for repetition in range(count):
                message = case["messages"][-1]["content"]
                planner_input = {
                    "entry_scope": "screening", "current_message_id": "live-message",
                    "current_message": message, "current_message_sources": [],
                    "previous_messages": case["messages"][:-1],
                    "current_task_revision": (case.get("initial_context", {}).get("conditions") and
                                              {"conditions": case["initial_context"]["conditions"]} or None),
                    "capability_manifest": {"capabilities": ([
                        {"id": "securities.historical_classification", "availability": "unavailable"}
                    ] if case["id"] == "C15" else [
                        {"id": "runtime.generated_python", "availability": "available"}
                    ] if case["id"] == "C16" else [])},
                    "server_execute_grant": None, "turn_base_revision": 0,
                    "screening_runs": ([{"id": "run-old", "status": "succeeded", "task_revision": 2,
                                         "as_of": "2026-09-14"}] if case["id"] == "C07" else []),
                }
                result = complete_json(planner_prompt, json.dumps(planner_input, ensure_ascii=False),
                                       timeout_seconds=60, max_output_tokens=9000)
                proposal = result.get("proposal", {}) if isinstance(result, dict) else {}
                observations.append({"case": case["id"], "repetition": repetition + 1,
                                    "intent": proposal.get("intent"),
                                    "requires_clarification": proposal.get("requires_clarification"),
                                    "ready_to_execute": result.get("ready_to_execute", False) if isinstance(result, dict) else False})
        differences = [item for item in observations if expected.get(item["case"]) and item["intent"] != expected[item["case"]]]
        unsafe = [item for item in observations
                  if item["intent"] == "execute" and item["case"] not in {"C01", "C04", "C05"}
                  and not item["requires_clarification"] and item["ready_to_execute"]]
        return dict(mode="live", status="passed" if not unsafe else "failed", case_set=case_set,
                    cases=len(selected), calls=len(observations), repetitions=repetitions,
                    semantic_differences=differences, unsafe_executions=unsafe, observations=observations)
    except Exception as exc:
        return dict(mode="live", status="unavailable", case_set=case_set,
                    reason=f"{type(exc).__name__}: {str(exc)[:300]}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("offline", "live"), required=True)
    parser.add_argument("--case-set", default="smoke")
    args = parser.parse_args()
    result = offline() if args.mode == "offline" else live(args.case_set)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if result["status"] == "failed":
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
