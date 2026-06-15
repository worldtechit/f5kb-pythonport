"""Tests for html/bugtracker.py using fixture HTML files."""

from pathlib import Path

import pytest

from f5kb.html.bugtracker import bug_tracker_url, parse_bug_content


def _load(name: str) -> str:
    p = Path(__file__).parent.parent / "fixtures" / "pages" / name
    if not p.exists():
        pytest.skip(f"fixture {name} not present")
    return p.read_text(encoding="utf-8")


def test_parse_bug_standard():
    html = _load("bug_standard.html")
    sections = parse_bug_content(html)
    assert isinstance(sections, dict)
    assert len(sections) > 0
    # Standard bug sections must include at least Symptoms
    assert any("Symptom" in k for k in sections)


def test_parse_bug_cve():
    html = _load("bug_cve.html")
    sections = parse_bug_content(html)
    assert isinstance(sections, dict)
    # CVE template should have CVE or Related/Severity field
    assert len(sections) > 0


def test_bug_tracker_url_from_bug_id():
    article = {"metadata": {"f5_bug_id": "1234567"}}
    url = bug_tracker_url(article)
    assert url == "https://cdn.f5.com/product/bugtracker/ID1234567.html"


def test_bug_tracker_url_fallback_link():
    article = {"metadata": {}, "link": "https://cdn.f5.com/product/bugtracker/IDxxx.html"}
    url = bug_tracker_url(article)
    assert "IDxxx" in url


def test_bug_tracker_url_no_id_no_link():
    with pytest.raises((ValueError, Exception)):
        bug_tracker_url({"metadata": {}})
