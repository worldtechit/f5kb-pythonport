"""Tests for html/docpage.py."""

from pathlib import Path

import pytest

from f5kb.html.docpage import (
    HOST_RULES,
    STRIP_SELECTORS,
    HostRule,
    extract_doc_body,
    select_container,
)
from bs4 import BeautifulSoup


def _load(name: str) -> str:
    p = Path(__file__).parent.parent / "fixtures" / "pages" / name
    if not p.exists():
        pytest.skip(f"fixture {name} not present")
    return p.read_text(encoding="utf-8")


def test_host_rules_defined():
    assert "techdocs.f5.com" in HOST_RULES
    assert "docs.nginx.com" in HOST_RULES
    assert "docs.cloud.f5.com" in HOST_RULES


def test_host_rule_selectors():
    rule = HOST_RULES["techdocs.f5.com"]
    assert isinstance(rule.selectors, list)
    assert len(rule.selectors) > 0


def test_select_container_basic():
    html = "<html><body><main>Main content here</main></body></html>"
    doc = BeautifulSoup(html, "lxml")
    rule = HostRule(selectors=["main"])
    el = select_container(doc, rule)
    assert el is not None
    assert "Main content" in (el.get_text() or "")


def test_select_container_empty_element_skipped():
    html = "<html><body><main></main><article>Article content</article></body></html>"
    doc = BeautifulSoup(html, "lxml")
    rule = HostRule(selectors=["main", "article"])
    el = select_container(doc, rule)
    assert el is not None
    assert "Article content" in (el.get_text() or "")


def test_select_container_none_rule():
    html = "<html><body><main>Content</main></body></html>"
    doc = BeautifulSoup(html, "lxml")
    # Generic selectors should find main
    el = select_container(doc, None)
    assert el is not None


def test_extract_doc_body_techdocs():
    html = _load("techdocs_kb.html")
    rule = HOST_RULES.get("techdocs.f5.com")
    result = extract_doc_body(html, "https://techdocs.f5.com/kb/en-us/test.html", rule)
    assert isinstance(result, str)
    assert len(result) > 0


def test_extract_doc_body_nginx():
    html = _load("docs_nginx.html")
    rule = HOST_RULES.get("docs.nginx.com")
    result = extract_doc_body(html, "https://docs.nginx.com/test/", rule)
    assert isinstance(result, str)
    assert len(result) > 0


def test_extract_doc_body_strips_nav():
    html = "<html><body><main><nav>Nav stuff</nav><p>Real content</p></main></body></html>"
    rule = HostRule(selectors=["main"])
    result = extract_doc_body(html, "https://example.com/", rule)
    assert "Nav stuff" not in result
    assert "Real content" in result


def test_extract_doc_body_no_triple_newlines():
    html = "<html><body><main><p>A</p><p>B</p><p>C</p></main></body></html>"
    result = extract_doc_body(html, "https://example.com/", HostRule(selectors=["main"]))
    assert "\n\n\n" not in result
