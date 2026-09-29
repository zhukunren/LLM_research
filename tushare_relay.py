"""Tushare Pro-style client for GET-based relay services.

The relay used by this project expects requests in this form::

    GET {base_url}/{api_name}?ts_code=000001.SZ
    X-API-Key: <relay API key>

``RelayDataApi`` exposes the familiar Tushare Pro calling convention while
translating it to that relay protocol.
"""

from __future__ import annotations

import time
from functools import partial
from typing import Any, Mapping
from urllib.parse import quote


DEFAULT_BASE_URL = "https://tl.kaixin8.top/tushare/pro"
DEFAULT_API_KEY = "tsr_sw9sb7Rb8uJukShVj_jW7AVVIHRxOU40vHB57NKzAag"
RETRYABLE_STATUS_CODES = frozenset({429, 500, 502, 503, 504})
_default_api_key: str | None = None


class RelayAPIError(RuntimeError):
    """Raised when the relay returns an API-level error response."""


def set_token(token: str) -> None:
    """Set the default relay API key.

    The function is named for compatibility with ``tushare.set_token``. Here,
    ``token`` is the relay's API key, not a Tushare-issued token.
    """

    if not isinstance(token, str) or not token.strip():
        raise ValueError("The relay API key must be a non-empty string.")

    global _default_api_key
    _default_api_key = token.strip()


def get_token() -> str | None:
    """Return the configured default relay API key, if one exists."""

    return _default_api_key


class RelayDataApi:
    """Expose Tushare Pro methods over a GET-based relay service.

    Example::

        pro = RelayDataApi(api_key="...", base_url="https://relay/tushare/pro")
        daily = pro.daily(ts_code="000001.SZ", start_date="20260701")
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30,
        verify: bool | str = True,
        retries: int = 2,
        retry_backoff: float = 0.5,
        session: Any | None = None,
    ) -> None:
        if not isinstance(api_key, str) or not api_key.strip():
            raise ValueError("The relay API key must be a non-empty string.")
        if not isinstance(base_url, str) or not base_url.strip():
            raise ValueError("base_url must be a non-empty URL.")
        if timeout <= 0:
            raise ValueError("timeout must be greater than zero.")
        if not isinstance(retries, int) or isinstance(retries, bool) or retries < 0:
            raise ValueError("retries must be a non-negative integer.")
        if retry_backoff < 0:
            raise ValueError("retry_backoff must be non-negative.")

        self._api_key = api_key.strip()
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._verify = verify
        self._retries = retries
        self._retry_backoff = retry_backoff
        self._session = session

    def query(self, api_name: str, fields: str = "", **params: Any) -> Any:
        """Call an endpoint and return a pandas DataFrame.

        This mirrors ``tushare.pro.client.DataApi.query``. Endpoint-specific
        arguments remain keyword parameters, and ``fields`` is forwarded when
        it is supplied.
        """

        if not isinstance(api_name, str) or not api_name.strip():
            raise ValueError("api_name must be a non-empty string.")

        request_params = dict(params)
        if fields:
            request_params["fields"] = fields

        payload = self.raw_query(api_name, **request_params)
        return self._to_dataframe(payload, api_name)

    def raw_query(self, api_name: str, **params: Any) -> Any:
        """Call an endpoint and return its decoded JSON response unchanged."""

        response = self._get_with_retries(api_name, params)
        self._raise_for_http_error(response)

        try:
            payload = response.json()
        except ValueError as exc:
            raise RelayAPIError(
                f"Relay response for '{api_name}' was not valid JSON."
            ) from exc

        self._raise_for_api_error(payload, api_name)
        return payload

    def __getattr__(self, api_name: str) -> Any:
        """Dynamically support ``pro.daily(...)``, ``pro.fina_indicator(...)``, etc."""

        if api_name.startswith("_"):
            raise AttributeError(api_name)
        return partial(self.query, api_name)

    def _build_url(self, api_name: str) -> str:
        endpoint = quote(api_name.strip(), safe="._-")
        return f"{self._base_url}/{endpoint}"

    def _get_session(self) -> Any:
        if self._session is not None:
            return self._session

        try:
            import requests
        except ImportError as exc:
            raise ImportError(
                "requests is required for relay calls. Install dependencies with "
                "'python -m pip install -r requirements.txt'."
            ) from exc

        self._session = requests.Session()
        return self._session

    def _get_with_retries(self, api_name: str, params: Mapping[str, Any]) -> Any:
        """Retry temporary relay failures without retrying normal API errors."""

        url = self._build_url(api_name)
        for attempt in range(self._retries + 1):
            try:
                response = self._get_session().get(
                    url,
                    params=params,
                    headers={"X-API-Key": self._api_key},
                    timeout=self._timeout,
                    verify=self._verify,
                )
            except Exception as exc:
                if attempt == self._retries:
                    raise RelayAPIError(
                        f"Relay request for '{api_name}' failed before receiving a response."
                    ) from exc
                self._wait_before_retry(attempt)
                continue

            if (
                getattr(response, "status_code", None) in RETRYABLE_STATUS_CODES
                and attempt < self._retries
            ):
                self._wait_before_retry(attempt)
                continue

            return response

        raise AssertionError("Retry loop exited without returning a response.")

    def _wait_before_retry(self, attempt: int) -> None:
        delay = self._retry_backoff * (2**attempt)
        if delay:
            time.sleep(delay)

    @staticmethod
    def _raise_for_http_error(response: Any) -> None:
        try:
            response.raise_for_status()
        except Exception as exc:
            status_code = getattr(response, "status_code", "unknown")
            raise RelayAPIError(
                f"Relay HTTP request failed with status {status_code}."
            ) from exc

    @staticmethod
    def _raise_for_api_error(payload: Any, api_name: str) -> None:
        if not isinstance(payload, Mapping):
            return

        code = payload.get("code")
        if code is None or code in (0, "0", 200, "200"):
            return

        message = payload.get("msg") or payload.get("message") or "Unknown relay error"
        raise RelayAPIError(f"Relay API '{api_name}' failed (code {code}): {message}")

    @staticmethod
    def _to_dataframe(payload: Any, api_name: str) -> Any:
        try:
            import pandas as pd
        except ImportError as exc:
            raise ImportError(
                "pandas is required for Tushare-compatible DataFrame results. "
                "Install dependencies with 'python -m pip install -r requirements.txt'."
            ) from exc

        data: Any = payload
        if isinstance(payload, Mapping) and "data" in payload:
            data = payload["data"]

        # Native Tushare response shape: {"fields": [...], "items": [[...]]}.
        if isinstance(data, Mapping) and "fields" in data and "items" in data:
            return pd.DataFrame(data["items"], columns=data["fields"])

        # A few relay implementations place those keys at the top level.
        if isinstance(payload, Mapping) and "fields" in payload and "items" in payload:
            return pd.DataFrame(payload["items"], columns=payload["fields"])

        # Common REST relay shapes: {"data": [...]}, {"items": [...]}, or a
        # direct list of records.  These are all naturally understood by pandas.
        if isinstance(data, Mapping) and "items" in data:
            data = data["items"]
        elif isinstance(data, Mapping) and "records" in data:
            data = data["records"]
        elif isinstance(payload, Mapping) and "items" in payload:
            data = payload["items"]

        if isinstance(data, list):
            return pd.DataFrame(data)
        if isinstance(data, Mapping):
            return pd.DataFrame([data])

        raise RelayAPIError(
            f"Relay API '{api_name}' returned an unsupported JSON payload shape."
        )


def pro_api(
    token: str = "",
    timeout: float = 30,
    *,
    base_url: str | None = None,
    verify: bool | str = True,
    retries: int = 2,
    retry_backoff: float = 0.5,
    session: Any | None = None,
) -> RelayDataApi:
    """Create a Tushare Pro-style relay client.

    ``token`` is intentionally accepted to preserve the usual
    ``ts.pro_api(token)`` syntax, but its value must be the relay API key.
    """

    api_key = token or get_token() or DEFAULT_API_KEY
    resolved_base_url = base_url or DEFAULT_BASE_URL
    return RelayDataApi(
        api_key,
        base_url=resolved_base_url,
        timeout=timeout,
        verify=verify,
        retries=retries,
        retry_backoff=retry_backoff,
        session=session,
    )
