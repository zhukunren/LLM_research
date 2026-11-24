"""Formatting for customer-facing card copy."""
import re


_URL_CHAR = r"""[^\s<>{}\[\]()"'（）【】《》“”‘’，。；：、！？]"""
_HOST = r"(?<![a-z0-9@_.-])(?:[a-z0-9-]+\.)+(?:com|cn|net|org|gov|edu|hk|io|pro|info)(?![a-z0-9-]|\.[a-z0-9])"
_URL_TAIL = rf"{_URL_CHAR}*(?:\({_URL_CHAR}*\){_URL_CHAR}*)*"
_WEB_ADDRESS = rf"(?:(?:https?://|www\.){_URL_CHAR}{_URL_TAIL}|{_HOST}(?:[/?#]{_URL_TAIL})?)"
_MARKDOWN_LINK = re.compile(
    rf"""!?\[([^\]\r\n]*)\]\([ \t]*<?{_WEB_ADDRESS}>?(?:[ \t]+"[^"\r\n]*")?[ \t]*\)""",
    re.IGNORECASE,
)
_WEB_LINK = re.compile(
    rf"<{_WEB_ADDRESS}>|（{_WEB_ADDRESS}）|\({_WEB_ADDRESS}\)|{_WEB_ADDRESS}", re.IGNORECASE,
)


def without_web_links(text: str) -> str:
    """Keep visible link labels and sentence punctuation in forwarded text."""
    cleaned = _MARKDOWN_LINK.sub(r"\1", text)

    def trailing_punctuation(match: re.Match) -> str:
        address = match[0]
        return address[len(address.rstrip(".,;:!?")):]

    cleaned = _WEB_LINK.sub(trailing_punctuation, cleaned)
    return re.sub(r"[ \t]+(?=[，。；：、！？.,;:!?])", "", cleaned).strip() if cleaned != text else text


def card_copy_content(content: dict) -> dict:
    fields = ("brand", "headline", "conclusion", "action", "focus", "service")
    return {**content, **{field: without_web_links(content[field]) for field in fields if field in content}}


def contains_return_promise(text: str) -> bool:
    body = re.sub(r"(?:不|不得|不能|禁止)(?:直接)?(?:承诺收益|保证收益|保证获利|承诺保本|保本保收益)", "", text)
    return bool(re.search(r"稳赚(?:不赔)?|包赚|承诺收益|保证(?:收益|获利|盈利)|承诺保本|保本保收益|必涨|必赚", body))
