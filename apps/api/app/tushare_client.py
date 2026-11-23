"""Server-side access to a Tushare Pro-compatible JSON endpoint."""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from functools import partial
import hashlib
import json
import time
from typing import Any
from urllib.parse import quote

import requests


API_URL = "https://api.tushare.pro"
NULLABLE_JSON_APIS = frozenset({
    "daily_basic", "report_rc", "cyq_perf", "sw_daily", "limit_list_d",
    "stk_holdertrade", "disclosure_date", "etf_share_size", "fund_daily",
    "fina_indicator", "stk_surv",
})


def _parse_constant(value: str, *, api_name: str) -> None:
    # Some compatible providers emit bare NaN for missing table cells.
    if api_name in NULLABLE_JSON_APIS and value == "NaN":
        return None
    raise ValueError("nonfinite")


class TushareError(RuntimeError):
    """A Tushare failure that can be reported without revealing credentials."""

    def __init__(self, message: str, *, kind: str = "unknown", provider_code: int | None = None):
        super().__init__(message)
        self.kind = kind
        self.provider_code = provider_code


def classify_provider_error(message: str) -> str:
    lowered = message.lower()
    if any(word in lowered for word in ("每分钟", "每小时", "每天", "每日", "频次", "频率", "访问次数", "限流", "rate limit")):
        return "rate_limited"
    if any(word in lowered for word in ("权限", "积分", "未开通", "没有访问", "permission", "token", "令牌")):
        return "denied"
    if any(word in lowered for word in ("超时", "暂不可用", "维护", "timeout", "temporarily")):
        return "transient_error"
    return "unknown"


@dataclass(frozen=True)
class TushareSnapshot:
    body: bytes
    payload: dict[str, Any]


class TushareClient:
    def __init__(self, token: str, *, api_url: str = API_URL, timeout: float = 30, retries: int = 3, limiter=None):
        self._token = token.strip()
        if not self._token:
            raise TushareError("未配置 Tushare token，请设置 [tushare].token 或 token_env 指定的环境变量（默认 TUSHARE_TOKEN）", kind="not_configured")
        self._api_url = api_url.rstrip("/")
        self._timeout = timeout
        self._retries = retries
        self._limiter = limiter

    @property
    def credential_id(self) -> str:
        return hashlib.sha256(("tushare:" + self._token).encode()).hexdigest()

    @property
    def dataset_id(self) -> str:
        return hashlib.sha256((self._api_url + "\0" + self.credential_id).encode()).hexdigest()

    def raw_query(self, api_name: str, *, fields: str = "", **params: Any) -> dict[str, Any]:
        return json.loads(self.query_snapshot(api_name, fields=fields, **params).body,
                          parse_constant=partial(_parse_constant, api_name=api_name))

    def query_snapshot(self, api_name: str, *, fields: str = "", **params: Any) -> TushareSnapshot:
        body = {"api_name": api_name, "token": self._token, "params": params, "fields": fields}
        url = self._api_url
        if url != API_URL:
            # Compatible relays use the SDK's per-interface route.
            url = f"{url}/{quote(api_name, safe='')}"
        for attempt in range(self._retries + 1):
            if self._limiter is not None:
                self._limiter.acquire(self.credential_id, api_name)
            try:
                with requests.post(url, json=body, timeout=self._timeout, allow_redirects=False) as response:
                    if response.status_code == 429 or 500 <= response.status_code < 600:
                        if attempt == self._retries:
                            raise TushareError(f"Tushare 服务暂不可用（HTTP {response.status_code}）",
                                               kind="rate_limited" if response.status_code == 429 else "transient_error")
                    elif response.status_code != 200:
                        raise TushareError(f"Tushare 请求失败（HTTP {response.status_code}）",
                                           kind="denied" if response.status_code in {401, 403} else "unknown")
                    else:
                        try:
                            raw = response.content
                            if len(raw) > 16 * 1024 * 1024:
                                raise TushareError("Tushare 响应超过 16 MiB，请缩小范围", kind="invalid_response")
                            payload = json.loads(raw, parse_float=Decimal,
                                                 parse_constant=partial(_parse_constant, api_name=api_name))
                        except ValueError:
                            raise TushareError("Tushare 返回了无效的 JSON", kind="invalid_response") from None
                        if not isinstance(payload, dict) or type(payload.get("code")) is not int:
                            raise TushareError("Tushare 返回了无效的响应格式", kind="invalid_response")
                        if payload["code"] != 0:
                            message = " ".join(str(payload.get("msg") or "请求被拒绝").replace(self._token, "[redacted]").split())[:240]
                            raise TushareError(f"Tushare 接口错误（{payload['code']}）：{message}",
                                               kind=classify_provider_error(message), provider_code=payload["code"])
                        data = payload.get("data")
                        if not isinstance(data, dict) or not isinstance(data.get("fields"), list) or not isinstance(data.get("items"), list):
                            raise TushareError("Tushare 返回了无效的数据格式", kind="invalid_response")
                        # Successful raw snapshots must never persist an echoed credential.
                        if self._token.encode() in raw:
                            raise TushareError("Tushare 响应包含凭据回显，已拒绝保存", kind="invalid_response")
                        return TushareSnapshot(raw, payload)
            except (requests.Timeout, requests.ConnectionError):
                if attempt == self._retries:
                    raise TushareError("Tushare 接口连接失败或超时", kind="transient_error") from None
            except requests.RequestException:
                raise TushareError("Tushare 接口请求失败", kind="transient_error") from None
            time.sleep(0.6 * (2 ** attempt))
        raise TushareError("Tushare 请求失败")  # Defensive: all attempts must return or raise.
