"""Resolve companies mentioned in news for chart display, without changing evidence links."""
from functools import lru_cache
import re

from . import security_catalog


def _company_name_mention(text: str, start: int, end: int, name: str) -> bool:
    before, after = text[:start], text[end:]
    # Names embedded in longer phrases (e.g. 中国新能源 -> 国新能源) are not mentions.
    if before and re.search(r"[\u4e00-\u9fff]\Z", before) and not re.search(
        r"(?:与|和|及|由|向|为|对|据|称|的|等|或|于|有|是|将|以|给|同|到|如|含|包括|以及|公司|子公司|集团|例如|消息|持有|出售|收购|来自|股票|上市公司|证券)\Z", before
    ):
        return False
    if re.match(r"(?:行业|产业|市场|领域)", after):
        return False
    # This listed company's short name is also an ordinary industry noun.
    if name == "机器人":
        return bool(re.search(r"(?:上市公司|证券简称|股票简称)[：:\s\"“]*$", before)
                    or (not before.strip() and re.match(r"[：:]", after)))
    return True


@lru_cache(maxsize=4)
def _name_matcher(catalog: tuple[tuple[str, str], ...]):
    aliases: dict[str, set[str]] = {}
    for code, name in catalog:
        variants = {name}
        plain = re.sub(r"^(?:S\*ST|\*ST|SST|ST|XD|XR|DR|[NC])(?=[\u4e00-\u9fff])", "", name)
        plain = re.sub(r"-(?:U|W|UW|V|UV)$", "", plain)
        variants.add(plain)
        for alias in variants:
            if len(alias) >= 3:
                aliases.setdefault(alias, set()).add(code)
    # Ambiguous short names must not invent a security association.
    unique = {name: next(iter(codes)) for name, codes in aliases.items() if len(codes) == 1}
    pattern = re.compile(r"(?<![A-Za-z0-9])(?:" + "|".join(re.escape(name) for name in sorted(unique, key=lambda name: (-len(name), name))) + r")(?![A-Za-z0-9])") if unique else None
    return pattern, unique


def chart_companies(record: dict) -> list[dict]:
    catalog = {code: name for code, name in security_catalog.names().items() if re.fullmatch(r"\d{6}\.(SH|SZ|BJ)", code)}
    text = record["title"] + "\n" + record["body"]
    mentions: list[tuple[int, str]] = []
    matcher, aliases = _name_matcher(tuple(sorted(catalog.items())))
    if matcher:
        mentions.extend((match.start(), aliases[match.group()]) for match in matcher.finditer(text)
                        if _company_name_mention(text, match.start(), match.end(), match.group()))
    for match in re.finditer(r"(?<![A-Za-z0-9])(\d{6})\s*[.．]\s*(SH|SZ|BJ)(?![A-Za-z0-9])", text, re.I):
        mentions.append((match.start(), match.group(1) + "." + match.group(2).upper()))
    by_digits: dict[str, list[str]] = {}
    for code in catalog:
        by_digits.setdefault(code[:6], []).append(code)
    for match in re.finditer(r"(?:[（(]\s*(\d{6})\s*[）)]|(?:证券|股票)(?:代码)?(?:为)?\s*[:：]?\s*(\d{6})(?!\d))", text):
        codes = by_digits.get(match.group(1) or match.group(2), [])
        if len(codes) == 1:
            mentions.append((match.start(), codes[0]))
    # Keep explicit existing associations as a fallback for abbreviated announcements.
    mentions.extend((len(text) + index, code) for index, code in enumerate(record.get("stock_codes", [])))
    result, seen = [], set()
    for _, code in sorted(mentions):
        if code not in seen:
            seen.add(code)
            result.append({"stock_code": code, "name": catalog.get(code, code)})
    return result
