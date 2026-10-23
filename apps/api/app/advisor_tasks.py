"""Task-specific adviser contracts and frozen market evidence."""
from __future__ import annotations

from datetime import datetime, timedelta
import hashlib
from uuid import uuid4

from . import market, closing_review
from .advisor_contracts import ADVISOR_KINDS, STOCK_KINDS, AdvisorScope
from .db import json_dump, json_load, utc_now

HORIZONS = {"short": "短期（数日到数周）", "medium": "中期（1–6个月）", "long": "长期（6个月以上）"}
RISK_LABELS = {"unspecified": "未提供", "cautious": "谨慎", "balanced": "均衡", "growth": "进取"}
VERDICTS = {"review": "市场复盘", "support": "逻辑有依据", "conditional": "有条件支持", "watch": "继续观察", "insufficient": "证据不足", "against": "暂不支持"}


class AdvisorTaskError(ValueError):
    pass


def build_context(connection, kind, scope, cutoff):
    if kind not in ADVISOR_KINDS:
        return None
    advisor = scope.advisor or AdvisorScope()
    requested = advisor.trade_date or cutoff.date()
    if requested > cutoff.date():
        raise AdvisorTaskError("分析日期不能晚于研究截止时间")
    completed_date = cutoff.date() if cutoff.hour >= 15 else cutoff.date() - timedelta(days=1)
    data_cutoff = min(requested, completed_date).isoformat()
    stock = None
    if kind in STOCK_KINDS:
        stock = connection.execute("SELECT stock_code,name,market FROM security_catalog WHERE stock_code=?", (advisor.stock_code,)).fetchone()
        if stock is None or stock["market"] == "指数":
            raise AdvisorTaskError("请从股票目录选择一只有效A股，不能把指数作为诊股对象")
    targets = [(stock["stock_code"], stock["name"])] if stock else [
        ("000001.SH", "上证指数"), ("399001.SZ", "深证成指"), ("399006.SZ", "创业板指")]
    fingerprint = market.source_fingerprint()
    observations, gaps = [], []
    for code, name in targets:
        bars = market.get_bars(code, data_cutoff, 80 if stock else 2)
        valid = [bar for bar in bars if bar.get("quality_valid", True) and bar.get("close") is not None]
        if not valid:
            gaps.append(name + "在截止时间前没有可用日线，需读取其他可靠行情来源")
            continue
        latest, previous = valid[-1], valid[-2] if len(valid) > 1 else None
        close = float(latest["close"])
        percent = round((close / float(previous["close"]) - 1) * 100, 4) if previous and previous["close"] else None
        averages = {str(period): round(sum(float(bar["close"]) for bar in valid[-period:]) / period, 6)
                    for period in (5, 20, 60) if len(valid) >= period}
        observations.append({"stock_code": code, "name": name, "trade_date": latest["trade_date"],
            "close": close, "previous_close": previous["close"] if previous else None,
            "previous_trade_date": previous["trade_date"] if previous else None, "change_pct": percent,
            "volume": latest.get("volume"), "amount": latest.get("amount"), "moving_averages": averages,
            "bars": valid, "invalid_bars_skipped": len(bars) - len(valid)})
        if len(bars) != len(valid):
            gaps.append(name + "存在异常日线并已跳过，均线和涨跌幅的时间跨度需另行核对")
    if fingerprint != market.source_fingerprint():
        raise AdvisorTaskError("行情文件在读取期间变化，请重新提交以固定同一份行情")
    actual_date = max((item["trade_date"] for item in observations), default=None)
    not_closed = requested == cutoff.date() and cutoff.hour < 15
    session_status = "not_closed" if not_closed else "closed" if actual_date == requested.isoformat() and requested.weekday() < 5 else "data_missing"
    if not_closed:
        gaps.append("研究截止时A股尚未收盘；当日日线未作为已完成收盘数据读取")
    if actual_date and actual_date != requested.isoformat():
        gaps.append("所选日期与本地行情实际日期不同，不得把旧收盘价表述为所选日的价格")
    context = {"kind": kind, "stock": dict(stock) if stock else None, "advisor": advisor.model_dump(mode="json"),
        "market_price_basis": market.PRICE_BASIS,
        "requested_trade_date": requested.isoformat(), "research_cutoff": cutoff.isoformat(),
        "market_data_cutoff": data_cutoff, "actual_market_date": actual_date, "session_status": session_status,
        "observations": observations, "gaps": gaps, "market_source_ids": [],
        "input_note": "持仓成本、咨询问题和推荐背景为用户输入，未经来源核实，不能当作公司事实或支持推荐的证据。"}
    if kind == "closing":
        context["closing_policy"] = closing_review.policy_snapshot()
    return context


def persist_context(connection, run_id, context):
    if context is None:
        return
    if context["observations"]:
        source_id = str(uuid4())
        title = "已冻结的行情证据" + (" · " + context["stock"]["name"] if context["stock"] else " · 指数收盘")
        lines = [title, "研究截止：" + context["research_cutoff"], "请求日期：" + context["requested_trade_date"],
                 "行情实际日期：" + context["actual_market_date"],
                 "行情价格口径：" + context["market_price_basis"], ""]
        for observation in context["observations"]:
            lines += [observation["name"] + " " + observation["stock_code"],
                "交易日期：" + observation["trade_date"], "收盘价：" + str(observation["close"]),
                "上一有效交易日收盘价：" + str(observation["previous_close"]),
                "上一有效数据日期：" + str(observation["previous_trade_date"]),
                "相邻有效交易日收盘涨跌幅（%）：" + str(observation["change_pct"]),
                "成交量（原文件单位待核实）：" + str(observation["volume"]),
                "成交额（原文件单位待核实）：" + str(observation["amount"]),
                "均线（原始价格口径）：" + json_dump(observation["moving_averages"]), ""]
        lines += ["数据限制：" + "；".join(context["gaps"])]
        text = "\n".join(lines)
        connection.execute("""INSERT INTO intelligence_sources(id,run_id,url,title,text,sha256,retrieved_at,publisher_date)
            VALUES(?,?,?,?,?,?,?,?)""", (source_id, run_id, "/api/v1/intelligence/runs/" + run_id + "/evidence/" + source_id,
                title, text, hashlib.sha256(text.encode("utf-8")).hexdigest(), utc_now(), context["actual_market_date"]))
        context["market_source_ids"] = [source_id]
        context["market_evidence_text"] = text
    connection.execute("INSERT INTO intelligence_advisor_context(run_id,context_json,created_at) VALUES(?,?,?)",
                       (run_id, json_dump(context), utc_now()))


def read_context(connection, run_id):
    record = connection.execute("SELECT context_json FROM intelligence_advisor_context WHERE run_id=?", (run_id,)).fetchone()
    return json_load(record[0]) if record else None


def prompt(kind, scope, context):
    if kind not in ADVISOR_KINDS:
        return ""
    advisor = scope.advisor or AdvisorScope()
    identity = (context["stock"]["name"] + "（" + advisor.stock_code + "）") if context["stock"] else "中国内地A股市场"
    contract = {
        "closing": """收评是投顾每日股评写作任务：
核对指定交易日的指数、成交与板块表现、主要驱动、分歧和次日观察。不能只有资讯列表。
必须提交 advisor_report，verdict=review，并注明 effective_date 和 session_status。
未收盘时使用 not_closed，产出明确标注的盘中草稿；无当日行情时使用 data_missing。
周末或无法确认交易状态时不虚构当日收盘。client_copy 为可编辑的简短股评，full_copy 为完整每日股评。
条目 analysis_dimension=market/catalyst/risk，事实引用行情快照或实际读取的来源。
不要把旧指数价、期货价或未经核实的成交额当作所选日收盘数据。""",
        "stock-analysis": """个股分析是投顾诊股任务：
直接回答客户关注的“是否可以买入/持仓怎么办”，按业务、财务质量、估值、量价走势、催化和风险核对。
每项使用 analysis_dimension，不能用几条利好新闻替代诊股。
advisor_report.stock_code 必须与选定股票一致。effective_date 为研究截止日期。
给出有依据的结论与分情形行动条件，区分尚未持有和已经持有，不以一句笼统风险提示代替分析。
基本面和估值资料允许早于近期资讯窗口，但必须在截止日前公开，并注明报告期与口径。
不能凭涨幅或技术信号直接认定公司低估、业绩增长；缺少财报或估值资料时明确缺口并降级结论。
client_copy 为给客户解释的简明诊股稿，full_copy 为完整诊股报告。""",
        "stock-rationale": """个股推荐理由是投顾为已选股票准备依据与沟通稿的任务：
用户可能已经推荐股票。把这个背景当作待检验的业务意图，先独立核对，不预设推荐一定正确。
advisor_report.stock_code 必须与选定股票一致。effective_date 为研究截止日期。
支持理由通过 supporting_points 关联本轮有证据的条目，反方事实通过 contrary_points 关联，列明风险与失效条件。
verdict 可为 support/conditional/insufficient/against/watch。证据不支持时，照样交付可用的调整建议或暂缓推荐说明稿。
support 至少两条独立有据理由；中长期推荐不能只靠技术走势。不要编造订单、盈利、估值、催化、目标价或收益承诺。
client_copy 为客户沟通短稿，full_copy 为可编辑的完整推荐理由；两者须与实际结论一致并保留重大风险。
允许以历史财报等背景资料支持逻辑，但须区分已经发生的事实、未来假设和未确认信息。""",
    }[kind]
    if kind == "closing" and context.get("closing_policy"):
        contract += "\n\n" + closing_review.PROMPT
    scenario = ("\n观察期限：本交易日复盘及下一交易日，稿件只作公开市场资讯交流。" if kind == "closing" else
        "\n分析期限：" + HORIZONS[advisor.horizon] + \
        "\n持仓状态：" + ("已经持有" if advisor.position == "holding" else "尚未持有/观察") + \
        "\n用户填写成本：" + str(advisor.holding_cost) + "\n风险偏好：" + RISK_LABELS[advisor.risk_preference] +
        "\n推荐背景（未经核验）：" + (advisor.recommendation_background or "未提供"))
    return "\n\n投顾业务交付契约：\n" + contract + "\n研究对象：" + identity + scenario + \
        "\n客户咨询：" + (advisor.question or ("形成盘面回顾、热点板块与明日观察" if kind == "closing" else "请给出当前证据支持的判断与可验证的行动条件")) + \
        "\n使用场景：" + ("客户沟通稿" if advisor.audience == "client" else "内部研究记录") + \
        "\n先调用 read_advisor_context 读取已冻结的输入、行情与数据缺口。该工具的 market_source_ids 可以作为本轮行情证据。" + \
        "\n所有支持/反方要点的 evidence_keys 必须指向本轮 items.event_key；每个主题须带真实引文。缺少信息可在 limitations 中说明，不凑出有利理由。" + \
        "\n客户短稿和完整稿使用自然段纯文本，不放Markdown表格、原始JSON或内部字段名，便于投顾复制后编辑。" + \
        "\n先取得一份可读原文确认来源链路，再扩展检索；稿件写给投顾使用，不出现工具名、内部编号或系统报错。"


def validate_report(kind, scope, report, items, context, cutoff, validation_level="basic"):
    """
    Validate advisor report with configurable strictness.

    Args:
        validation_level: "off" (no validation), "basic" (default, minimal checks), "strict" (all checks)

    Returns:
        dict with validation_result: {errors: [], warnings: [], suggestions: []}
    """
    validation_result = {"errors": [], "warnings": [], "suggestions": []}

    if validation_level == "off":
        return validation_result

    if kind not in ADVISOR_KINDS:
        if report is not None:
            msg = "普通情报任务不应提交投顾报告"
            if validation_level == "strict":
                raise AdvisorTaskError(msg)
            validation_result["warnings"].append(msg)
        return validation_result

    if report is None:
        msg = "请提交 advisor_report，包含结论、证据要点、行动条件与沟通稿"
        if validation_level == "strict":
            raise AdvisorTaskError(msg)
        validation_result["warnings"].append(msg)
        return validation_result

    if context is None:
        msg = "本次投顾输入快照不存在，请重新创建任务"
        if validation_level == "strict":
            raise AdvisorTaskError(msg)
        validation_result["errors"].append(msg)
        return validation_result

    if report.effective_date > cutoff.date():
        msg = "报告日期晚于研究截止时间"
        if validation_level == "strict":
            raise AdvisorTaskError(msg)
        validation_result["warnings"].append(msg)

    by_key = {item["event_key"]: item for item in items}
    for point in [*report.supporting_points, *report.contrary_points]:
        if any(key not in by_key for key in point.evidence_keys):
            msg = "支持或反方判断引用了不属于本次成果的主题"
            if validation_level == "strict":
                raise AdvisorTaskError(msg)
            validation_result["warnings"].append(msg)
            break

    if kind == "closing":
        if validation_level == "strict":
            if report.verdict != "review" or report.session_status is None:
                raise AdvisorTaskError("收评须使用市场复盘结论并注明收盘状态")
        elif report.verdict != "review":
            validation_result["warnings"].append("建议收评使用市场复盘结论")

        if report.effective_date.isoformat() != context["requested_trade_date"]:
            msg = "收评日期必须与用户选择的日期一致"
            if validation_level == "strict":
                raise AdvisorTaskError(msg)
            validation_result["warnings"].append(msg)

        if validation_level == "strict" and report.session_status == "closed":
            if report.effective_date.weekday() >= 5 or context["session_status"] == "not_closed":
                raise AdvisorTaskError("所选市场尚未收盘或日期为周末，不能交付已收盘结论")
            if context["actual_market_date"] != context["requested_trade_date"]:
                market_items = [item for item in items if item.get("analysis_dimension") == "market"]
                if not any(any((citation.get("published_at") or "").startswith(context["requested_trade_date"]) for citation in item["evidence"]) for item in market_items):
                    raise AdvisorTaskError("缺少所选日行情或当日可靠行情来源，收评应标记为行情待补齐")

        result = closing_review.validate(report, items, context.get("closing_policy"), context["advisor"]["audience"], level=validation_level)
        validation_result["errors"].extend(result.errors)
        validation_result["warnings"].extend(result.warnings)
        validation_result["suggestions"].extend(result.suggestions)

        if validation_level == "strict" and result.errors:
            raise AdvisorTaskError("\n".join(result.errors))

    else:  # Stock analysis or rationale
        if report.stock_code != scope.advisor.stock_code:
            msg = "诊股或推荐理由的股票与已选对象不一致"
            if validation_level == "strict":
                raise AdvisorTaskError(msg)
            validation_result["warnings"].append(msg)

        if report.effective_date != cutoff.date():
            msg = "个股报告须使用冻结的研究截止日期"
            if validation_level == "strict":
                raise AdvisorTaskError(msg)
            validation_result["warnings"].append(msg)

        if validation_level == "strict":
            if report.verdict == "review":
                raise AdvisorTaskError("个股任务需要明确的研判结论")
        elif report.verdict == "review":
            validation_result["suggestions"].append("建议明确研判结论")

        if validation_level == "strict" and report.verdict == "support":
            keys = {key for point in report.supporting_points for key in point.evidence_keys}
            if len(keys) < 2:
                raise AdvisorTaskError("支持推荐须有至少两个独立的证据主题")
            if scope.advisor.horizon != "short" and not any(by_key[key].get("analysis_dimension") in {"business", "financial", "valuation", "catalyst"} for key in keys):
                raise AdvisorTaskError("中长期推荐不能仅由技术走势支持，请补充经营、财务、估值或催化依据")

    if validation_level == "strict" and any(not item.get("analysis_dimension") for item in items):
        raise AdvisorTaskError("投顾报告的每个证据主题需要注明 analysis_dimension")
    elif any(not item.get("analysis_dimension") for item in items):
        validation_result["suggestions"].append("建议为每个证据主题注明分析维度")

    return validation_result


def report_text(report, name, cutoff, short=False):
    content = report["client_copy"] if short else report["full_copy"]
    return name + " · 待投顾确认\n研究截止：" + cutoff + "\n研判：" + VERDICTS[report["verdict"]] + "\n\n" + content
