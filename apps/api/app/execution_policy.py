"""Conservative checks on the user's words before granting a screening run."""
from __future__ import annotations

import re


def requests_plan_save(text: str) -> bool:
    """Persisting a reusable asset requires a save request in this turn."""
    text = _unquoted(text)
    if re.search(r'(?:不要|不用|不必|无需|不需要|先不|暂不|别|禁止|不)[^，,。；;\n]{0,16}(?:保存|收藏|存入|存下|存为|留存)|\b(?:do\s+not|don\x27t|never)\s+(?:save|bookmark)\b', text, re.IGNORECASE):
        return False
    if re.search(r'如何|怎么|怎样|是否|能否|要不要|[?？]|\b(?:how|whether)\b', text, re.IGNORECASE):
        return False
    # Reading an existing saved plan is not a new save request.
    text = re.sub(r'已保存|保存的|已收藏|收藏的', '', text)
    return bool(re.search(r'保存|收藏|存入(?:方案|条件|策略)库|(?:方案|条件|策略).{0,8}(?:存下|存为|存起来|留存)|\b(?:save|bookmark)\b', text, re.IGNORECASE))


def _unquoted(text: str) -> str:
    # Mentioning a command is not issuing it. Leave the surrounding request intact.
    return re.sub(r'“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|\'[^\'\n]*\'|`[^`]*`', '', text).strip()


def denies_execution(text: str) -> bool:
    text = _unquoted(text)
    return bool(re.search(
        r'(?:不要|不用|不必|无需|不需要|禁止|取消)[^，,。；;\n]{0,24}(?:执行|运行|筛选)|'
        r'(?:不要|不用|不必|不需要|暂不|先不|别|禁止|停止|取消|不)(?:再|立即|马上|直接|自动|继续|进行|开始|帮我|为我|\s)*'
        r'(?:执行|运行|筛选|筛一下|筛|跑)|'
        r'(?:只|仅)(?:需|要)?(?:先)?(?:保存|讨论|解释|分析|修改|调整|核对)|'
        r'^(?:取消|停止|先不|暂不|先不要|暂时不要)[。！!\s]*$|'
        r'\b(?:do\s+not|don\x27t|never|cancel|stop)\s+(?:run|execute|screen)\b',
        text, re.IGNORECASE,
    ))


def requests_execution(text: str) -> bool:
    text = _unquoted(text)
    if denies_execution(text):
        return False
    # Ambiguous questions remain discussions; the explicit UI action is available.
    if re.search(r'如何|怎么|怎样|为何|为什么|是否|能否|会不会|要不要|[?？]|什么意思|区别|\b(?:how|why|whether)\b', text, re.IGNORECASE):
        return False
    return bool(re.search(
        r'按这个筛|开始筛|再筛(?:一次|一遍|一下|$)|筛(?:一下|一遍|一次)|'
        r'(?:^|[，,。；;\n：:]|请|帮我|替我|给我|麻烦|并|然后)(?:现在|马上|立即|直接|继续|重新|再|开始|请|\s)*'
        r'(?:筛选(?!方案|条件|逻辑|流程|结果)|(?:执行|运行)(?!的|失败|结果|逻辑|流程|时间)|跑(?:一下|一次|一遍))|'
        r'(?:^|[.;\n])\s*(?:please\s+)?(?:run|execute|screen)\b',
        text, re.IGNORECASE,
    ))
