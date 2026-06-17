"""Tests for coveo/aura.py using fixture response."""

import json
from pathlib import Path

import httpx
import pytest

from f5kb.coveo.aura import CoveoConfig, fetch_coveo_config, refresh_config


class _AuraTransport(httpx.BaseTransport):
    """Returns the fixture aura token response."""

    def __init__(self, fixture_text: str) -> None:
        self._text = fixture_text

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=self._text)


def _load_fixture() -> str:
    p = Path(__file__).parent.parent / "fixtures" / "aura" / "token_response.txt"
    if not p.exists():
        pytest.skip("aura fixture not present")
    return p.read_text()


def test_fetch_coveo_config_parses_fixture():
    text = _load_fixture()
    client = httpx.Client(transport=_AuraTransport(text))
    cfg = fetch_coveo_config(client)
    assert isinstance(cfg, CoveoConfig)
    assert cfg.platform_url.startswith("https://")
    assert cfg.access_token  # non-empty
    assert cfg.organization_id  # non-empty


def test_refresh_config_mutates():
    text = _load_fixture()
    client = httpx.Client(transport=_AuraTransport(text))
    cfg = CoveoConfig(
        platform_url="https://old.example.com",
        access_token="old_token",
        organization_id="old_org",
    )
    refresh_config(cfg, client)
    assert cfg.access_token != "old_token"
    assert cfg.platform_url != "https://old.example.com"


def test_fetch_coveo_config_wrapped_response():
    """Aura response wrapped in */ ... /* delimiter."""
    inner = json.dumps({
        "actions": [{
            "id": "1",
            "state": "SUCCESS",
            "returnValue": {
                "returnValue": json.dumps({
                    "platformUrl": "https://example.com",
                    "accessToken": "tok123",
                    "organizationId": "orgXYZ",
                })
            },
            "error": [],
        }]
    })
    wrapped = f"*/{inner}/*"

    class _Transport(httpx.BaseTransport):
        def handle_request(self, request):
            return httpx.Response(200, text=wrapped)

    client = httpx.Client(transport=_Transport())
    cfg = fetch_coveo_config(client)
    assert cfg.access_token == "tok123"
    assert cfg.organization_id == "orgXYZ"


def test_fetch_coveo_config_action_failed():
    body = json.dumps({
        "actions": [{
            "id": "1",
            "state": "ERROR",
            "returnValue": None,
            "error": ["something went wrong"],
        }]
    })

    class _Transport(httpx.BaseTransport):
        def handle_request(self, request):
            return httpx.Response(200, text=body)

    client = httpx.Client(transport=_Transport())
    with pytest.raises(RuntimeError, match="Aura action failed"):
        fetch_coveo_config(client)
