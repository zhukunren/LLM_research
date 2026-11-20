"""Conservative checks on the user's words before granting a screening run."""
from __future__ import annotations

import re
from unicodedata import normalize


WORKBENCH_MARKER = "\n\n[选股工作台指令]\n"
_QUESTION = re.compile(r'如何|怎么|怎样|为何|为什么|是否|能否|能不能|可否|可不可以|会不会|要不要|[?？]|什么意思|区别|\b(?:how|why|whether)\b', re.IGNORECASE)
_POLITE_REQUEST = re.compile(r'^(?:请问[，,]?\s*)?(?:能否|能不能|可否|可以|可不可以|能)\s*(?:请)?(?:帮我|替我|为我|给我)\s*')
_STOCK_SELECTION = re.compile(
    r'(?:^|[，,。；;\n：:]\s*|(?:股票池|观察池|自选(?:股|分组)?|全部\s*A\s*股|全\s*A\s*股|全市场)(?:里|中|内|范围内)?\s*|(?:股票|个股|标的)(?:里|中|内)\s*)'
    r'(?:请|帮我|替我|为我|给我|麻烦|直接|先|现在|开始|继续|再|重新|\s)*'
    r'(?:选股(?=$|[，,。；;\n：:]|[，, ]*按)|筛(?:一下|一遍|一次|出|选(?!方案|条件|逻辑|流程|结果|记录|历史))|筛(?=截至|最近|近|收盘|股票|全|涨|跌|放量|缩量|成交|\d))'
)
_STOCK_CONTEXT = re.compile(r'选股|股票|个股|A\s*股|全市场|观察池|自选|股价|均线|收盘价|成交[量额]|涨幅|跌幅|放量|缩量|股息|股本|市值|换手率|分钟线|\b(?:RSI|MACD|PE|PB)\b', re.IGNORECASE)
_FIND_STOCKS = re.compile(
    r'(?:^|[，,。；;\n：:]\s*)(?:请|帮我|替我|为我|给我|麻烦|直接|先|\s)*'
    r'(?:找出?|挑出|挑几只|选出)[^。；;\n]*(?:的股票(?!代码|名称|行情)|的个股|的公司(?!名称|代码|名单)|只股票|符合条件的标的)'
)
_PREVIEW_SELECTION = re.compile(
    r'^(?:请|帮我|替我|先|只|仅|\s)*(?:生成|整理|给我|给出|列出?|看看?|核对)(?:一下)?(?:这[个套次])?(?:选股|筛选)(?:方案|口径|条件)'
)
_WORKBENCH_RUN = (
    '请整理筛选方案；条件完整后请开始筛选并直接返回结果',
    '用户提交了方案修改。更新条件后请开始筛选并直接返回新结果',
)
_RESULT_QUESTION = re.compile(
    r'^(?:请(?:帮我)?|帮我)?\s*(?:为什么|为何|怎么会|解释(?:一下)?|说明(?:一下)?|告诉我|列出|给我)[^。！？\n]*'
    r'(?:入选|中选|选中|落选|没选上|命中依据|第[一二三四五六七八九十\d]+只|这批|筛选结果)|'
    r'^(?:这批|上次|上一批|本次|第[一二三四五六七八九十\d]+只)[^。！？\n]*(?:原因|理由|依据|怎么|为什么|实际值|门槛|多少|几只)'
)
_TREND_REQUEST = re.compile(
    r'(?:请)?(?:帮我|替我|给我)?(?:在?(?:全部A股|全A股|全市场)(?:中|里|内|范围内)?)?'
    r'(?:筛一下|筛一次|筛选|选股)?[:：]?收盘价(?:高于|大于|>)(?P<ma_window>\d{1,3})日(?:简单移动)?均线'
    r'(?:[,，、]|且|并且|同时)+(?:最近|近)(?P<return_window>\d{1,3})(?:个)?交易日涨幅'
    r'(?:超过|大于|高于|>)(?P<threshold>[+-]?\d{1,4}(?:\.\d{1,4})?)%(?:的(?:A股|股票|个股))?'
    r'(?:(?:[,，])?(?:筛一下|筛一次|直接筛选))?'
)
_THRESHOLD_CHANGE = re.compile(
    r'(?:请)?(?:把|将)?(?:(?:最近|近)(?P<window>\d{1,3})(?:个)?交易日)?涨幅(?:门槛|阈值)'
    r'(?:从(?P<previous>[+-]?\d{1,4}(?:\.\d{1,4})?)%)?改(?:成|为|到)(?:超过|大于|高于|>)?'
    r'(?P<threshold>[+-]?\d{1,4}(?:\.\d{1,4})?)%(?:[,，](?:其他|其余)(?:条件|股票范围|范围|日期|截止日|和|、|及)+(?:均|都)?(?:沿用|不变))?'
    r'[,，]?(?:再筛一次|再筛一下|重新筛选|重筛一次)'
)


def _screening_request_text(content: str) -> str:
    return re.sub(r'\s+', '', normalize('NFKC', content.partition(WORKBENCH_MARKER)[0])).rstrip('。!')


def match_trend_request(content: str) -> dict[str, int | float] | None:
    match = _TREND_REQUEST.fullmatch(_screening_request_text(content))
    if match:
        return {"ma_window": int(match["ma_window"]), "return_window": int(match["return_window"]),
                "threshold": float(match["threshold"])}
    return None


def match_threshold_change(content: str, parameters: dict) -> float | None:
    match = _THRESHOLD_CHANGE.fullmatch(_screening_request_text(content))
    if (match and (match["window"] is None or int(match["window"]) == parameters["return_window"])
            and (match["previous"] is None or float(match["previous"]) == parameters["threshold"])):
        return float(match["threshold"])
    return None


def _request_words(text: str) -> str:
    text = _unquoted(text)
    if _POLITE_REQUEST.match(text):
        return re.sub(r'[?？]', '。', _POLITE_REQUEST.sub('请', text, count=1)).rstrip('。吗 ')
    return text


def _preview_only(words: str) -> bool:
    return bool(_PREVIEW_SELECTION.search(words) and not re.search(
        r'(?:并|再|然后)(?:帮我|请|直接|开始|继续|重新|再|\s)*(?:执行|运行|筛(?:选|一下|一次|一遍)|跑)', words
    ))


def starts_screening(text: str) -> bool:
    user_text = text.partition(WORKBENCH_MARKER)[0]
    words = _request_words(user_text)
    return not _QUESTION.search(words) and bool(
        match_trend_request(user_text) or _FIND_STOCKS.search(words) or _PREVIEW_SELECTION.search(words)
        or _STOCK_SELECTION.search(words) and _STOCK_CONTEXT.search(user_text)
    )


def asks_about_screening_result(text: str) -> bool:
    return bool(_RESULT_QUESTION.search(text.partition(WORKBENCH_MARKER)[0].strip()))


def asks_question(text: str) -> bool:
    return bool(_QUESTION.search(_request_words(text.partition(WORKBENCH_MARKER)[0])))


def requests_plan_save(text: str) -> bool:
    """Persisting a reusable asset requires a save request in this turn."""
    text = _request_words(text.partition(WORKBENCH_MARKER)[0])
    if re.search(r'(?:不要|不用|不必|无需|不需要|先不|暂不|别|禁止|不)[^，,。；;\n]{0,16}(?:保存|收藏|存入|存下|存为|留存)|\b(?:do\s+not|don\x27t|never)\s+(?:save|bookmark)\b', text, re.IGNORECASE):
        return False
    if _QUESTION.search(text):
        return False
    # Reading an existing saved plan is not a new save request.
    text = re.sub(r'已保存|保存的|已收藏|收藏的', '', text)
    return bool(re.search(r'保存|收藏|存入(?:方案|条件|策略)库|(?:方案|条件|策略).{0,8}(?:存下|存为|存起来|留存)|\b(?:save|bookmark)\b', text, re.IGNORECASE))


def _unquoted(text: str) -> str:
    # Mentioning a command is not issuing it. Leave the surrounding request intact.
    return re.sub(r'“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|\'[^\'\n]*\'|`[^`]*`', '', text).strip()


def denies_execution(text: str) -> bool:
    if _preview_only(_request_words(text.partition(WORKBENCH_MARKER)[0])):
        return True
    text = _unquoted(text)
    return bool(re.search(
        r'(?:不要|不用|不必|无需|不需要|禁止|取消)[^，,。；;\n]{0,24}(?:执行|运行|筛选)|'
        r'(?:不要|不用|不必|不需要|暂不|先不|别|禁止|停止|取消|不)(?:再|立即|马上|直接|自动|继续|进行|开始|帮我|为我|\s)*'
        r'(?:执行|运行|筛选|筛一下|筛|跑)|'
        r'(?:只|仅)(?:需|要)?(?:先)?(?:保存|讨论|解释|分析|修改|调整|核对)|'
        r'(?:只|仅)(?:需|要)?(?:先)?(?:生成|查看|整理|改|更新)(?:一下)?(?:选股|筛选)?方案|'
        r'(?:先|只|仅)(?:给我(?:看看?|看下|看一下)?|列出?|看看?|看下|核对)(?:一下)?(?:选股|筛选|比较|计算)?口径|'
        r'^(?:取消|停止|先不|暂不|先不要|暂时不要)[。！!\s]*$|'
        r'\b(?:do\s+not|don\x27t|never|cancel|stop)\s+(?:run|execute|screen)\b',
        text, re.IGNORECASE,
    ))


def requests_execution(text: str) -> bool:
    if denies_execution(text) or asks_about_screening_result(text):
        return False
    user_text, _, workbench = text.partition(WORKBENCH_MARKER)
    text = _request_words(user_text)
    if _QUESTION.search(text):
        return False
    if match_trend_request(user_text) or _STOCK_SELECTION.search(text) or _FIND_STOCKS.search(text) or re.search(
        r'按(?:这个|这套(?:方案|规则)?|刚才的(?:方案|规则)?)筛|再筛(?:一次|一遍|一下|$)|筛(?:一下|一遍|一次)|'
        r'(?:^|[，,。；;\n：:]|请|帮我|替我|给我|麻烦|并|然后)(?:现在|马上|立即|直接|继续|重新|再|开始|请|\s)*'
        r'(?:筛选(?!方案|条件|逻辑|流程|结果)|(?:执行|运行)(?!的|失败|结果|逻辑|流程|时间)|跑(?:一下|一次|一遍))|'
        r'(?:^|[.;\n])\s*(?:please\s+)?(?:run|execute|screen)\b',
        text, re.IGNORECASE,
    ):
        return True
    return not requests_plan_save(user_text) and any(line.startswith(_WORKBENCH_RUN) for line in workbench.splitlines())


def message_requests_execution(message: dict) -> bool:
    """Bind execution to the current request or its frozen plan-button action."""
    content = message.get("content", "")
    if denies_execution(content) or asks_about_screening_result(content):
        return False
    return requests_execution(content) or any(
        item.get("kind") in {"saved_screening_task", "screening_strategy"}
        and item.get("execution_requested") is True
        for item in message.get("source_refs", [])
    )
