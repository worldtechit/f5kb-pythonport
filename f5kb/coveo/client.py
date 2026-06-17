"""Coveo search client with retry/backoff, token refresh, and timeout."""

from __future__ import annotations

import json
import time
from typing import Any, Callable

import httpx

from f5kb.coveo.aura import CoveoConfig, refresh_config
from f5kb.lib.logger import NULL_LOGGER, Logger

CoveoResult = dict[str, Any]
MAX_RETRIES = 5


def _default_sleep(s: float) -> None:
    time.sleep(s)


class CoveoClient:
    def __init__(
        self,
        config: CoveoConfig,
        *,
        client: httpx.Client | None = None,
        logger: Logger = NULL_LOGGER,
        sleep: Callable[[float], None] = _default_sleep,
        refresh: Callable[[CoveoConfig], None] | None = None,
        timeout_s: float = 60.0,
    ) -> None:
        self.config = config
        self._client = client or httpx.Client(timeout=timeout_s)
        self._logger = logger
        self._sleep = sleep
        self._refresh = refresh or (lambda c: refresh_config(c, self._client))
        self._timeout_s = timeout_s

    def post(self, body: dict[str, Any], attempt: int = 0) -> dict[str, Any]:
        """POST to /rest/search/v2 with retry/backoff and token refresh."""
        cfg = self.config
        url = f"{cfg.platform_url}/rest/search/v2?organizationId={cfg.organization_id}"
        self._logger.trace(
            "coveo post",
            aq=body.get("aq"),
            first_result=body.get("firstResult"),
            n=body.get("numberOfResults"),
            attempt=attempt,
        )
        try:
            res = self._client.post(
                url,
                content=json.dumps(body).encode("utf-8"),
                headers={
                    "Authorization": f"Bearer {cfg.access_token}",
                    "Content-Type": "application/json",
                },
                timeout=self._timeout_s,
            )
            if not res.is_success:
                text = res.text
                if (res.status_code in (401, 419)) and attempt < MAX_RETRIES:
                    self._logger.trace(
                        f"token rejected {res.status_code} — refreshing", attempt=attempt
                    )
                    self._refresh(cfg)
                    self._sleep(0.25)
                    return self.post(body, attempt + 1)
                if (res.status_code >= 500 or res.status_code == 429) and attempt < MAX_RETRIES:
                    self._logger.trace(
                        "coveo retry (transient)", status=res.status_code, attempt=attempt
                    )
                    self._sleep(0.75 * (2 ** attempt))
                    return self.post(body, attempt + 1)
                raise RuntimeError(f"Coveo API error {res.status_code}: {text[:300]}")
            return res.json()
        except (httpx.RequestError, RuntimeError) as e:
            msg = str(e)
            if attempt < MAX_RETRIES and "Coveo API error" not in msg:
                self._logger.trace("coveo retry (network)", msg=msg, attempt=attempt)
                self._sleep(0.75 * (2 ** attempt))
                return self.post(body, attempt + 1)
            raise

    def get_count(self, aq: str) -> int:
        data = self.post({
            "q": "",
            "aq": aq or None,
            "numberOfResults": 0,
            "searchHub": "myF5",
        })
        return int(data.get("totalCountFiltered") or data.get("totalCount") or 0)

    def list_facet_values(
        self, field: str, filter_aq: str | None = None
    ) -> list[dict[str, Any]]:
        bare_field = field.lstrip("@")
        data = self.post({
            "q": "",
            **({"aq": filter_aq} if filter_aq else {}),
            "numberOfResults": 0,
            "searchHub": "myF5",
            "facets": [{"field": bare_field, "numberOfValues": 5000, "type": "specific"}],
        })
        facets = data.get("facets") or []
        facet = next((f for f in facets if f.get("field") == bare_field), None)
        if not facet:
            return []
        return [
            {"value": v.get("value", ""), "numberOfResults": v.get("numberOfResults", 0)}
            for v in (facet.get("values") or [])
        ]
