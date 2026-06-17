"""Tests for enrich/driver.py."""

import json
from pathlib import Path

import pytest
import httpx

from f5kb.enrich.driver import TypeReport, enrich_type
from f5kb.http.fetcher import HttpClient


class _ScriptedTransport(httpx.BaseTransport):
    def __init__(self, responses):
        self._responses = list(responses)

    def handle_request(self, request):
        if not self._responses:
            return httpx.Response(404, text="not found")
        return self._responses.pop(0)


def _http(responses=()):
    transport = _ScriptedTransport(list(responses))
    client = httpx.Client(transport=transport)
    return HttpClient(client=client)


def _write_article(d: Path, type_key: str, art_id: str, content: dict | None = None):
    (d / type_key).mkdir(parents=True, exist_ok=True)
    art = {
        "id": art_id,
        "documentType": type_key,
        "title": f"T {art_id}",
        "link": f"https://example.com/{art_id}",
        "metadata": {},
        "content": content or {},
    }
    (d / type_key / f"{art_id}.json").write_text(json.dumps(art))
    return art


BUG_HTML = """<html><body>
<div class="bug-content">
<h4>Description</h4>
<p>This is the bug description text with enough content here.</p>
<h4>Impact</h4>
<p>Significant impact on production systems.</p>
</div>
</body></html>"""


def test_enrich_type_skips_already_bodied(tmp_path):
    _write_article(tmp_path, "Bug_Tracker", "ID-1", content={"body_text": "existing"})
    http = _http()
    report = enrich_type("Bug_Tracker", str(tmp_path), http)
    assert report.skipped == 1
    assert report.enriched == 0


def test_enrich_type_enriches_new(tmp_path):
    _write_article(tmp_path, "Bug_Tracker", "ID-1")
    http = _http([httpx.Response(200, text=BUG_HTML)])
    report = enrich_type("Bug_Tracker", str(tmp_path), http)
    assert report.enriched == 1
    art = json.loads((tmp_path / "Bug_Tracker" / "ID-1.json").read_text())
    assert "body_text" in art["content"]


def test_enrich_type_records_error(tmp_path):
    _write_article(tmp_path, "Bug_Tracker", "ID-1")
    http = _http([httpx.Response(500, text="error")])
    report = enrich_type("Bug_Tracker", str(tmp_path), http)
    assert report.failed == 1
    assert len(report.errors) == 1


def test_enrich_type_missing_dir(tmp_path):
    http = _http()
    report = enrich_type("Manual", str(tmp_path), http)
    assert report.missing_dir is True


def test_enrich_type_no_enricher(tmp_path):
    http = _http()
    report = enrich_type("Unknown_Type", str(tmp_path), http)
    assert report.enriched == 0
    assert report.files == 0


def test_enrich_type_refetch_replaces_body(tmp_path):
    _write_article(tmp_path, "Bug_Tracker", "ID-1", content={"body_text": "old"})
    http = _http([httpx.Response(200, text=BUG_HTML)])
    report = enrich_type("Bug_Tracker", str(tmp_path), http, refetch=True)
    assert report.enriched == 1
    art = json.loads((tmp_path / "Bug_Tracker" / "ID-1.json").read_text())
    assert "Bug description" in art["content"].get("body_text", "") or "Description" in str(art["content"])


def test_enrich_type_clears_stale_keys(tmp_path):
    _write_article(tmp_path, "Bug_Tracker", "ID-1", content={"bodyError": "old error"})
    http = _http([httpx.Response(200, text=BUG_HTML)])
    report = enrich_type("Bug_Tracker", str(tmp_path), http, refetch_errors=True)
    art = json.loads((tmp_path / "Bug_Tracker" / "ID-1.json").read_text())
    assert "bodyError" not in art["content"]
    assert "body_text" in art["content"]


def test_enrich_type_limit(tmp_path):
    for i in range(3):
        _write_article(tmp_path, "Bug_Tracker", f"ID-{i}")
    http = _http([httpx.Response(200, text=BUG_HTML)] * 2)
    report = enrich_type("Bug_Tracker", str(tmp_path), http, limit=2)
    assert report.files == 2
