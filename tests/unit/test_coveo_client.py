"""Tests for coveo/client.py — retry, backoff, token refresh."""

import json
from pathlib import Path

import httpx
import pytest

from f5kb.coveo.aura import CoveoConfig
from f5kb.coveo.client import CoveoClient


def _make_config() -> CoveoConfig:
    return CoveoConfig(
        platform_url="https://org.coveo.com",
        access_token="test_token",
        organization_id="testorg",
    )


def _search_response(results=None, total=10) -> dict:
    return {
        "totalCount": total,
        "totalCountFiltered": total,
        "results": results or [],
    }


class _ScriptedTransport(httpx.BaseTransport):
    """Returns responses in order."""

    def __init__(self, responses: list[httpx.Response]) -> None:
        self._responses = list(responses)
        self.calls: list[httpx.Request] = []

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        return self._responses.pop(0)


def _json_resp(data: dict, status: int = 200) -> httpx.Response:
    return httpx.Response(status, json=data)


def _text_resp(text: str, status: int = 200) -> httpx.Response:
    return httpx.Response(status, text=text)


def test_post_success():
    transport = _ScriptedTransport([_json_resp(_search_response())])
    client = httpx.Client(transport=transport)
    cc = CoveoClient(_make_config(), client=client, sleep=lambda _: None)
    data = cc.post({"q": "", "numberOfResults": 0, "searchHub": "myF5"})
    assert data["totalCount"] == 10
    assert len(transport.calls) == 1


def test_post_retries_on_token_expired():
    new_token_called = []

    def fake_refresh(cfg: CoveoConfig) -> None:
        new_token_called.append(True)
        cfg.access_token = "new_token"

    transport = _ScriptedTransport([
        _text_resp("Unauthorized", 401),
        _json_resp(_search_response()),
    ])
    client = httpx.Client(transport=transport)
    cc = CoveoClient(_make_config(), client=client, sleep=lambda _: None, refresh=fake_refresh)
    cc.post({"q": "", "numberOfResults": 0, "searchHub": "myF5"})
    assert new_token_called
    assert len(transport.calls) == 2


def test_post_retries_on_5xx():
    transport = _ScriptedTransport([
        _text_resp("Server Error", 500),
        _json_resp(_search_response()),
    ])
    client = httpx.Client(transport=transport)
    cc = CoveoClient(_make_config(), client=client, sleep=lambda _: None)
    cc.post({"q": "", "numberOfResults": 0, "searchHub": "myF5"})
    assert len(transport.calls) == 2


def test_post_raises_after_max_retries():
    transport = _ScriptedTransport([_text_resp("Error", 500)] * 6)
    client = httpx.Client(transport=transport)
    cc = CoveoClient(_make_config(), client=client, sleep=lambda _: None)
    with pytest.raises(RuntimeError, match="Coveo API error 500"):
        cc.post({"q": "", "numberOfResults": 0, "searchHub": "myF5"})


def test_get_count():
    transport = _ScriptedTransport([_json_resp({"totalCount": 42, "totalCountFiltered": 42, "results": []})])
    client = httpx.Client(transport=transport)
    cc = CoveoClient(_make_config(), client=client, sleep=lambda _: None)
    assert cc.get_count("@f5_document_type==\"Knowledge\"") == 42


def test_list_facet_values():
    resp = {
        "totalCount": 0,
        "results": [],
        "facets": [{
            "field": "f5_document_type",
            "values": [
                {"value": "Knowledge", "numberOfResults": 100},
                {"value": "Manual", "numberOfResults": 50},
            ]
        }]
    }
    transport = _ScriptedTransport([_json_resp(resp)])
    client = httpx.Client(transport=transport)
    cc = CoveoClient(_make_config(), client=client, sleep=lambda _: None)
    values = cc.list_facet_values("f5_document_type")
    assert len(values) == 2
    assert values[0]["value"] == "Knowledge"
    assert values[0]["numberOfResults"] == 100


def test_load_search_fixture():
    """Smoke test: parse the search_policy.json fixture."""
    p = Path(__file__).parent.parent / "fixtures" / "coveo" / "search_policy.json"
    if not p.exists():
        pytest.skip("fixture not present")
    data = json.loads(p.read_text())
    assert "results" in data
    assert "totalCount" in data
