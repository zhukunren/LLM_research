"""Frozen defaults and mechanical review of client-facing closing commentary."""
from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
from decimal import Decimal
import re
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import Field, model_validator

from .models import StrictModel

BEIJING = timezone(timedelta(hours=8))
MARKET_SCOPES = {"SH_SZ": "沪深两市", "SH_SZ_BJ": "沪深京三市"}
SESSION_LABELS = {"before_open": "盘前", "during_session": "盘中", "midday_break": "午间休市",
                  "after_close": "收盘后", "non_trading_day": "周末非交易日", "time_unconfirmed": "时间待确认"}
PLAIN_WORDS = {"个股宽度": "上涨股票数量", "市场宽度": "上涨股票占比", "宽度背离": "指数与多数股票表现不一致",
               "结构性修复": "部分板块回暖", "分母端": "估值所受的利率影响", "分子端": "公司盈利",
               "右侧确认": "上涨走势进一步得到验证", "催化兑现": "事件公布后的实际表现"}


def policy_snapshot():
    return {"revision": "closing-client-v1", "preferred_turnover_scope": "SH_SZ", "fallback_turnover_scope": "SH_SZ_BJ",
            "event_timezone": "Asia/Shanghai", "client_sections": ["盘面回顾", "热点板块", "明日观察"],
            "client_max_characters": 1000, "plain_language": dict(PLAIN_WORDS)}


PROMPT = """收评默认复核规则（不能用补充要求代替这些默认检查）：
1. 行情口径：成交额优先采用沪深两市（SH_SZ），只与同一范围的前一交易日比较。
   若只能确认沪深京三市，可显式改用SH_SZ_BJ；不能将"全市场"自动等同于沪深两市，无法确认范围就省略金额。
   closing_review.turnover 记录 amount_yi（人民币亿元）、market_scope、evidence_keys。
   有较前日变化时填写 comparison={market_scope,change_yi,evidence_keys}；增加为正、减少为负，前后范围必须相同。
   对应证据主题注明所选交易日，引用须支持范围与金额；精确值和终端差异留在证据主题与 scope_notes。
   客户稿把金额适当取整，明确写"沪深两市"或"沪深京三市"。上涨家数使用有据的"超过/约/接近"约数，
   不把不同终端的精确家数拼接；行业与概念分开，默认不列单一终端的精确行业涨跌幅。
2. 事件时间：每个用于明日观察的会议、演讲、发布会等事件填入 closing_review.events。
   有已确认时刻时记录 local_start（ISO日期时间及UTC偏移）、source_timezone（IANA区域名，例如Europe/Berlin）、
   title、evidence_keys、client_copy_excerpt（客户稿中提到该事件的连续原文）。不得猜时刻或时区。
   服务端按事件当天的夏令时规则换算 beijing_start 和 session_relation；这两个字段可以省略，由服务端计算。
   客户稿中的该段须明确写"北京时间M月D日HH:mm"和"盘前/盘中/午间/收盘后/周末非交易日"。
   特别注意跨日：海外当地的明天不一定是北京时间明天。盘后事件不能写成当日盘中已经兑现的利好。
   另行核对事件当日是否休市；常规交易时段分类不代替交易日历，遇休市须在稿件中说明。
   若只有日期或时间未确认，local_start留空；提到事件时明确写"时间待确认"，或从客户稿省略，仅在完整稿说明。
   只放内部记录、没有在客户稿出现的事件，client_copy_excerpt留空。所有事件仍须关联已引用的证据主题。
3. 客户表达建议：client_copy 默认约350—650字，建议不超过1000字符，按"盘面回顾—热点板块—明日观察"三段自然段写。
   休市前可用"下一交易日观察"。用"上涨股票数量""部分板块回暖"等易懂表达，避免个股宽度、宽度背离、
   结构性修复、分母端、分子端、右侧确认、催化兑现等术语。不要在客户稿中解释终端技术细节、校验过程和工具错误。
   明日观察给可核对的条件，不保证涨跌，不把产业事件等同于个股盈利改善，不附无依据的目标价或仓位指令。
   客户稿保留简短风险提示；来源、精确统计、口径差异和缺口放完整稿、scope_notes及证据主题。
   术语、篇幅、段落和家数约数属于非阻塞建议，不必为表达建议反复重试发布。
4. 必须提交 advisor_report.closing_review，即使无可用成交额或事件也提交 {turnover:null,events:[],scope_notes:"实际缺口"}。
   校验失败仅修正指出的口径、时刻或稿件字段，不删除已经核对的可靠证据。"""


class ClosingComparison(StrictModel):
    market_scope: Literal["SH_SZ", "SH_SZ_BJ"]
    change_yi: float = Field(allow_inf_nan=False, description="Change from the preceding session, in CNY 100 million; positive for an increase.")
    evidence_keys: list[str] = Field(min_length=1, max_length=5)


class ClosingTurnover(StrictModel):
    market_scope: Literal["SH_SZ", "SH_SZ_BJ"]
    amount_yi: float = Field(gt=0, allow_inf_nan=False)
    evidence_keys: list[str] = Field(min_length=1, max_length=5)
    comparison: ClosingComparison | None = None

    @model_validator(mode="after")
    def same_universe(self):
        if self.comparison and self.comparison.market_scope != self.market_scope:
            raise ValueError("成交额与前日变化必须使用同一行情统计口径，不能混用沪深与沪深京")
        return self


def _session(value):
    clock = value.time()
    if value.weekday() >= 5:
        return "non_trading_day"
    if clock < time(9, 30):
        return "before_open"
    if clock < time(11, 30) or time(13) <= clock < time(15):
        return "during_session"
    if clock < time(13):
        return "midday_break"
    return "after_close"


class ClosingEvent(StrictModel):
    title: str = Field(min_length=3, max_length=120)
    evidence_keys: list[str] = Field(min_length=1, max_length=5)
    local_start: datetime | None = Field(default=None, description="Confirmed local date/time WITH UTC offset; null when only a date is known. Never infer a time.")
    source_timezone: str | None = Field(default=None, max_length=100, description="IANA area such as Europe/Berlin or America/New_York, not ambiguous abbreviations such as CST.")
    beijing_start: datetime | None = Field(default=None, description="Server-calculated Beijing date/time; omit rather than guessing.")
    session_relation: Literal["before_open", "during_session", "midday_break", "after_close", "non_trading_day", "time_unconfirmed"] | None = None
    client_copy_excerpt: str = Field(default="", max_length=500, description="Continuous passage of client_copy containing this event's Beijing date/time and relation to the A-share session. Empty if omitted from client_copy.")

    @model_validator(mode="after")
    def to_beijing(self):
        if self.local_start is None:
            if self.beijing_start is not None or self.session_relation not in {None, "time_unconfirmed"}:
                raise ValueError("事件时刻未确认，不能填写已确认的北京时间或交易时段")
            self.session_relation = "time_unconfirmed"
            return self
        if self.local_start.utcoffset() is None or not self.source_timezone:
            raise ValueError("事件必须提供带UTC偏移的当地日期时间和IANA时区；不明确时将local_start留空")
        if "/" not in self.source_timezone and self.source_timezone != "UTC":
            raise ValueError("事件时区不能使用CST等缩写，请核对原始日程并使用IANA区域名")
        try:
            zone = ZoneInfo(self.source_timezone)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError("事件时区无效，请使用Europe/Berlin等IANA区域名并核对原始日程") from exc
        actual_local = self.local_start.astimezone(zone)
        if actual_local.replace(tzinfo=None) != self.local_start.replace(tzinfo=None) or actual_local.utcoffset() != self.local_start.utcoffset():
            raise ValueError("事件UTC偏移与当地日期的夏令时规则不符，请核对日期、时区和原文")
        expected = self.local_start.astimezone(BEIJING)
        if self.beijing_start is not None and (self.beijing_start.utcoffset() != timedelta(hours=8) or self.beijing_start != expected):
            raise ValueError("事件北京时间换算不一致，请省略beijing_start由服务端计算")
        slot = _session(expected)
        if self.session_relation is not None and self.session_relation != slot:
            raise ValueError("事件盘前、盘中或收盘后关系与北京时间不一致")
        self.beijing_start, self.session_relation = expected, slot
        return self


class ClosingReview(StrictModel):
    turnover: ClosingTurnover | None = None
    events: list[ClosingEvent] = Field(default_factory=list, max_length=6)
    scope_notes: str = Field(default="", max_length=1400, description="Provider/universe differences, breadth and sector conventions, omitted data and unresolved timing. Kept outside the client copy.")


def _rounded_match(number, unit, actual):
    value = Decimal(number.replace(",", ""))
    multiplier = Decimal(10000 if unit == "万亿" else 1)
    rounding_step = Decimal(10) ** value.as_tuple().exponent * multiplier
    return abs(Decimal(str(actual)) - value * multiplier) <= rounding_step / 2 + Decimal("0.000001")


def _compact(text):
    return re.sub(r"\s+", "", text)


def _clocks_in_text(quotes):
    clocks = {(int(h), int(m)) for h, m in re.findall(r"(?<!\d)(\d{1,2}):(\d{2})(?!\d)", quotes)}
    for hour, minute, ampm in re.findall(r"(?<!\d)(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)(?!\w)", quotes, re.I):
        clocks.add((int(hour) % 12 + (12 if ampm.lower().startswith("p") else 0), int(minute or 0)))
    for period, hour, minute in re.findall(r"(上午|下午|晚上|中午|凌晨)?(\d{1,2})[点时](?:(\d{1,2})分?)?", quotes):
        number = int(hour)
        if period in {"下午", "晚上"} and number < 12:
            number += 12
        clocks.add((number, int(minute or 0)))
    return clocks


def _clock_in_quotes(value, quotes):
    return (value.hour, value.minute) in _clocks_in_text(quotes)


def _zone_in_quotes(event, quotes):
    local = event.local_start.astimezone(ZoneInfo(event.source_timezone))
    abbreviation = local.tzname()
    labels = [event.source_timezone]
    if abbreviation not in {"CST", "IST", "BST", "AST"}:
        labels.append(abbreviation)
    if event.source_timezone == "Asia/Shanghai":
        labels += ["北京时间", "Beijing time", "China Standard Time"]
    if any(re.search(r"(?<![A-Za-z])" + re.escape(label) + r"(?![A-Za-z])", quotes, re.I) for label in labels if label):
        return True
    for sign, hour, minute in re.findall(r"(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?", quotes, re.I):
        minutes = (int(hour) * 60 + int(minute or 0)) * (-1 if sign == "-" else 1)
        if local.utcoffset() == timedelta(minutes=minutes):
            return True
    return False


class ValidationResult:
    """Three-level validation result for advisor reports."""
    def __init__(self):
        self.errors = []      # Must fix, will block submission
        self.warnings = []    # Should fix, but can proceed
        self.suggestions = []  # Nice to have, optional improvements


def validate(report, items, policy, audience, level="basic"):
    """Return factual errors separately from review warnings and editorial hints.

    Every mode checks amounts, evidence and stated event times. Strict mode
    additionally requires explicit scope/time provenance in the client draft.
    Legacy off suppresses editorial hints, not factual validation.
    """
    if level not in {"off", "basic", "strict"}:
        raise ValueError("未知的投顾验证级别")
    result = ValidationResult()
    if not policy:  # Older frozen runs retain their original publication contract.
        return result
    review = report.closing_review
    if review is None:
        result.errors.append("收评需提交closing_review，记录统一的行情口径和事件北京时间核对结果")
        return result

    by_key = {item["event_key"]: item for item in items}

    def bound(keys, market=False):
        if any(key not in by_key for key in keys):
            result.errors.append("收评复核引用了不属于本次成果的证据主题")
            return []
        selected = [by_key[key] for key in keys]
        if market and any(item.get("analysis_dimension") != "market" or item["event_date"] != report.effective_date.isoformat() for item in selected):
            result.errors.append("成交额口径须关联所选交易日的市场表现证据主题")
            return []
        return selected

    def money_evidence(keys, scope, amount, comparison=False):
        selected = bound(keys, market=True)
        if not selected:
            return
        quotes = [c["quote"] for item in selected for c in item["evidence"]]
        scope_pattern = r"沪深两市|沪深市场|沪深成交|两市" if scope == "SH_SZ" else r"沪深京|三市"
        scoped = [quote for quote in quotes if re.search(scope_pattern, re.sub(r"沪深京", "三市", quote) if scope == "SH_SZ" else quote)]
        if not scoped:
            result.errors.append("成交额引文未明确所选统计范围，请补充同口径来源；不能把全市场自动写成沪深两市")
            return
        unchanged = comparison and amount == 0 and any(re.search(r"持平|不变", quote) for quote in scoped)
        quoted_values = []
        for quote in scoped:
            for match in re.finditer(r"([0-9][0-9,]*(?:\.[0-9]+)?)\s*(万亿|亿)(?:元)?", quote):
                if re.search(r"(?:超过|不足|高于|低于|少于|逾|超)\s*$", quote[max(0, match.start() - 8):match.start()]):
                    continue  # A threshold is not an observed total.
                quoted_values.append(Decimal(match[1].replace(",", "")) * (10000 if match[2] == "万亿" else 1))
        if not unchanged and not any(abs(Decimal(str(abs(amount))) - value) < Decimal("0.000001") for value in quoted_values):
            available = "、".join(dict.fromkeys(f"{value:g}亿元" for value in quoted_values))
            result.errors.append("同口径引文未支持所记录的成交金额或变化值，请登记来源直接披露的总额及精度，分项计算另放完整稿说明" + (f"；该口径引文出现的金额为{available[:160]}，请按总额/前日值/变化值的原文含义选择，不自动互换" if available else ""))
        if comparison and not unchanged:
            changes = [(Decimal(number.replace(",", "")) * (10000 if unit == "万亿" else 1) * (-1 if verb in {"减少", "缩量", "下降", "少", "-"} else 1))
                       for quote in scoped for verb, number, unit in re.findall(r"(放量|缩量|增加|减少|增长|下降|多|少|[+-])\s*(?:了\s*)?(?:约|为)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(万亿|亿)(?:元)?", quote)]
            if not any(abs(Decimal(str(amount)) - value) < Decimal("0.000001") for value in changes):
                result.errors.append("同口径引文未支持所记录的成交变化方向，请核对放量、缩量和正负号")

    if review.turnover:
        money_evidence(review.turnover.evidence_keys, review.turnover.market_scope, review.turnover.amount_yi)
        if review.turnover.comparison:
            comparison = review.turnover.comparison
            money_evidence(comparison.evidence_keys, comparison.market_scope, comparison.change_yi, comparison=True)

    for event in review.events:
        selected = bound(event.evidence_keys)
        if not selected:
            continue
        if event.local_start:
            quotes = "\n".join(c["quote"] for item in selected for c in item["evidence"])
            if not _clock_in_quotes(event.local_start, quotes) or not _zone_in_quotes(event, quotes):
                result.errors.append("事件引文须支持原始日程时刻与时区；只有日期时不可编造具体时刻，请补读官方日程或标记时间待确认")
        excerpt = _compact(event.client_copy_excerpt)
        if not excerpt:
            if event.title in report.client_copy:
                message = f"客户稿提到的事件「{event.title}」需补充对应摘录，以核对北京时间"
                (result.errors if level == "strict" else result.warnings).append(message)
            continue
        if excerpt not in _compact(report.client_copy):
            result.errors.append("事件client_copy_excerpt不是客户稿中的连续原文")
            continue
        clocks = _clocks_in_text(excerpt)
        if event.beijing_start is None:
            if clocks:
                result.errors.append(f"未确认时刻的事件「{event.title}」不能在客户稿写入具体时刻")
            elif not re.search(r"(?:时间|时刻)(?:尚)?(?:待确认|未确认|不确定)", excerpt):
                result.warnings.append(f"未确认时刻的事件「{event.title}」建议在客户稿写明时间待确认")
            continue
        start = event.beijing_start
        dates = re.findall(r"(?:\d{4}年)?(\d{1,2})月(\d{1,2})日|\d{4}-(\d{2})-(\d{2})", excerpt)
        dated = [(int(month or iso_month), int(day or iso_day)) for month, day, iso_month, iso_day in dates]
        years = re.findall(r"(\d{4})(?:年\d{1,2}月\d{1,2}日|-\d{2}-\d{2})", excerpt)
        if (dated and (start.month, start.day) not in dated) or (years and str(start.year) not in years) or (clocks and (start.hour, start.minute) not in clocks):
            result.errors.append(f"事件「{event.title}」客户稿北京时间与记录的日期或时刻不一致")
        labels = {"before_open": ("盘前", "开盘前"), "during_session": ("盘中",), "midday_break": ("午间", "午休"),
                  "after_close": ("收盘后", "盘后"), "non_trading_day": ("非交易日", "周末")}
        stated = {slot for slot, names in labels.items() if any(name in excerpt for name in names)}
        if stated and event.session_relation not in stated:
            result.errors.append(f"事件「{event.title}」客户稿盘前、盘中或盘后关系与北京时间不一致")
        if "北京时间" not in excerpt or not dated or not clocks or not stated:
            message = f"事件「{event.title}」请在客户稿明确注明北京时间、日期、时刻及交易时段"
            (result.errors if level == "strict" else result.warnings).append(message)

    if audience != "client":
        return result

    copy = report.client_copy
    if level != "off":
        if len(copy) > policy["client_max_characters"]:
            result.suggestions.append(f"客户收评共 {len(copy)} 字符，建议精简至 {policy['client_max_characters']} 字符以内")
        if "盘面回顾" not in copy or "热点板块" not in copy or not any(label in copy for label in ("明日观察", "下一交易日观察")):
            result.suggestions.append("建议客户收评包含盘面回顾、热点板块和明日观察三段")
        for term, replacement in policy["plain_language"].items():
            if term in copy:
                result.suggestions.append(f"建议将「{term}」改为「{replacement}」等易懂表达")
        for match in re.finditer(r"(?:上涨|下跌)(?:的)?(?:股票|个股)?(?:数量|家数)?(?:为|有|达到)?\s*([1-9]\d*)\s*只", copy):
            if int(match[1]) % 100:
                result.suggestions.append('建议上涨、下跌家数使用约数（如“超过 XX00 只”）')
                break
    if not re.search(r"(?:市场|股市)有风险|投资[需须应].{0,12}(?:谨慎|审慎)|(?:市场|股价|行情).{0,12}(?:波动|回撤|风险)|风险提示|不构成.{0,30}(?:建议|推荐)|仅供.{0,15}参考", copy):
        result.warnings.append("建议保留一句简短风险提示，交付前由投顾核对")

    amount_pattern = r"(?:成交额|成交金额|成交)\s*(?:约为|为|约|达到|合计)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(万亿|亿)(?:元)?"
    amounts = list(re.finditer(amount_pattern, copy))
    if amounts and review.turnover is None:
        result.errors.append("客户稿写有成交金额，须补充closing_review.turnover及所选统计范围，或省略未确认数字")
    if review.turnover:
        turnover = review.turnover
        label = MARKET_SCOPES[turnover.market_scope]
        if amounts and label not in copy:
            message = f"客户稿成交额请明确标注「{label}」"
            (result.errors if level == "strict" else result.warnings).append(message)
        scope_aliases = {"沪深两市": "SH_SZ", "两市": "SH_SZ", "沪深京三市": "SH_SZ_BJ", "沪深京": "SH_SZ_BJ", "三市": "SH_SZ_BJ", "全市场": "unknown"}
        for match in re.finditer(r"(沪深京三市|沪深两市|沪深京|全市场|两市|三市)(?:全天|当日|今日)?成交", _compact(copy)):
            if scope_aliases[match[1]] != turnover.market_scope:
                result.errors.append(f"客户稿成交额统计范围与记录不一致，应标注{label}")
                break
        if any(not _rounded_match(match[1], match[2], turnover.amount_yi) for match in amounts):
            result.errors.append("客户稿成交额与所记录的同口径金额不一致，亿元与万亿元换算及取整须一致")
        for sentence in re.split(r"[。；;\n]", copy):
            if not re.search(r"成交|放量|缩量", sentence):
                continue
            for match in re.finditer(r"(放量|缩量|增加|减少)(?:了)?\s*(?:约)?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(万亿|亿)(?:元)?", sentence):
                if turnover.comparison is None:
                    result.errors.append("客户稿含前日成交变化，须提供同一统计口径的comparison或省略未确认数字")
                else:
                    sign = -1 if match[1] in {"减少", "缩量"} else 1
                    if not _rounded_match(match[2], match[3], turnover.comparison.change_yi * sign):
                        result.errors.append("客户稿放量或缩量金额与记录的前日比较不一致")

    return result


def review_lines(review):
    """Human-readable provenance for exports, kept outside the client draft."""
    lines = []
    if review.get("turnover"):
        turnover = review["turnover"]
        lines.append(f"成交额口径：{MARKET_SCOPES[turnover['market_scope']]}，{turnover['amount_yi']:g}亿元。")
        if turnover.get("comparison"):
            delta = turnover["comparison"]["change_yi"]
            lines.append(f"与前一交易日使用同口径比较：{'增加' if delta >= 0 else '减少'}{abs(delta):g}亿元。")
    for event in review.get("events", []):
        if event.get("beijing_start"):
            start = datetime.fromisoformat(event["beijing_start"])
            lines.append(f"{event['title']}：北京时间{start:%Y-%m-%d %H:%M}，{SESSION_LABELS[event['session_relation']]}（相对常规交易时段）；原时区{event['source_timezone']}。")
        else:
            lines.append(event["title"] + "：时间待确认。")
    if review.get("scope_notes"):
        lines.append(review["scope_notes"])
    return lines
