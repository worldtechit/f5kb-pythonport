"""Doc-page body extraction (Manual / Release Note / Supplemental Document)."""

from __future__ import annotations

import re
from dataclasses import dataclass

from bs4 import BeautifulSoup, Tag

from f5kb.html.serialize import make_serializer


@dataclass
class HostRule:
    selectors: list[str]
    js_rendered: bool = False
    next_data: bool = False


HOST_RULES: dict[str, HostRule] = {
    "clouddocs.f5.com": HostRule(selectors=["[role=main]", "article.docs-container"]),
    "techdocs.f5.com": HostRule(selectors=["div.pageContent", "div.manual-chapter", "main"]),
    "docs.nginx.com": HostRule(selectors=["[data-testid=content]", "main.content", "article"]),
    "nginx.org": HostRule(selectors=["#content", "#main"]),
    "unit.nginx.org": HostRule(selectors=["#content", "div.body", "#main"]),
    "docs.cloud.f5.com": HostRule(selectors=["main"], next_data=True),
}

GENERIC_SELECTORS = ["main", "article", "[role=main]", "#main-content", "div.content"]

STRIP_SELECTORS = [
    "nav", "header", "footer", "aside", "script", "style", "noscript", "form",
    ".next-prev-btn-row", ".document-navigation", ".doc-nav", ".site-breadcrumb-nav",
    "[class*=breadcrumb]", "[class*=pagination]", "[class*=edit-on]", "[class*=feedback]",
    "[aria-label*=breadcrumb]", "[aria-label*=pagination]",
    "button", ".headerlink", "a.headerlink",
]


def select_container(doc: BeautifulSoup, rule: HostRule | None) -> Tag | None:
    selectors = (rule.selectors if rule and rule.selectors else None) or GENERIC_SELECTORS
    for sel in selectors:
        try:
            el = doc.select_one(sel)
        except Exception:
            continue
        if el and (el.get_text() or "").strip():
            return el
    return None


def extract_doc_body(html: str, final_url: str, rule: HostRule | None) -> str:
    doc = BeautifulSoup(html, "lxml")
    container = select_container(doc, rule)
    if not container:
        pre = doc.select_one("pre")
        if pre and len((pre.get_text() or "").strip()) > 200:
            container = pre
        else:
            container = doc.find("body")
    if not container:
        raise ValueError("content container not found")

    for sel in STRIP_SELECTORS:
        try:
            for el in container.select(sel):
                el.decompose()
        except Exception:
            continue

    serialize = make_serializer(final_url)
    md = serialize(container)
    md = re.sub(r"[ \t]+\n", "\n", md)
    md = re.sub(r"\n{3,}", "\n\n", md)
    return md.strip()
