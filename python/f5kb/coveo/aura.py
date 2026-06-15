"""Coveo guest-token acquisition via the F5 Salesforce Aura endpoint."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Callable
from urllib.parse import urlencode

import httpx

AURA_URL = "https://my.f5.com/manage/s/sfsites/aura?r=7"
AURA_CONTEXT = json.dumps({
    "mode": "PROD",
    "fwuid": "ZkJhOVpLN2NZQkJrd2NWd3pMcnFOdzJEa1N5enhOU3R5QWl2VzNveFZTbGcxMy4tMjE0NzQ4MzY0OC4xMzEwNzIwMA",
    "app": "siteforce:communityApp",
    "loaded": {
        "APPLICATION@markup://siteforce:communityApp": "1547_6p-2GBd9IQWZ4UXs1Im3BQ",
    },
    "dn": [],
    "globals": {},
    "uad": False,
})


@dataclass
class CoveoConfig:
    platform_url: str
    access_token: str
    organization_id: str


def fetch_coveo_config(client: httpx.Client | None = None) -> CoveoConfig:
    """Fetch a fresh Coveo guest token from the Aura endpoint."""
    message = json.dumps({
        "actions": [
            {
                "id": "1",
                "descriptor": "aura://ApexActionController/ACTION$execute",
                "callingDescriptor": "UNKNOWN",
                "params": {
                    "classname": "HeadlessController",
                    "method": "getHeadlessConfiguration",
                    "params": {},
                    "cacheable": False,
                    "isContinuation": False,
                },
            }
        ]
    })

    body = urlencode({
        "message": message,
        "aura.context": AURA_CONTEXT,
        "aura.pageURI": "/manage/s/global-search/%40uri",
        "aura.token": "null",
    })

    c = client or httpx.Client()
    res = c.post(
        AURA_URL,
        content=body.encode("utf-8"),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=60.0,
    )
    res.raise_for_status()

    text = res.text
    # Response may be wrapped: */<json>/*ERROR*/
    m = re.match(r"^\*/(.+?)/\*(?:ERROR\*\/)?$", text, re.DOTALL)
    if m:
        text = m.group(1)
    data = json.loads(text)

    action = data["actions"][0]
    if action["state"] != "SUCCESS":
        raise RuntimeError(f"Aura action failed: {json.dumps(action.get('error'))}")

    cfg = json.loads(action["returnValue"]["returnValue"])
    return CoveoConfig(
        platform_url=cfg["platformUrl"],
        access_token=cfg["accessToken"],
        organization_id=cfg["organizationId"],
    )


def refresh_config(config: CoveoConfig, client: httpx.Client | None = None) -> None:
    """Refresh an expired token in place (mutates the shared CoveoConfig)."""
    fresh = fetch_coveo_config(client)
    config.access_token = fresh.access_token
    config.platform_url = fresh.platform_url
    config.organization_id = fresh.organization_id
