"""Next.js __NEXT_DATA__ extraction (docs.cloud.f5.com)."""

from __future__ import annotations

import json
import re
from typing import Any


def parse_next_data(html: str) -> dict | None:
    m = re.search(
        r'<script id="__NEXT_DATA__" type="application/json">([\s\S]*?)</script>',
        html,
    )
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except Exception:
        return None


def mdx_from_compiled_source(compiled_source: str) -> str:
    """Recover MDX from /* ... */ comment blocks in compiled Next.js source."""
    blocks = []
    for m in re.finditer(r"/\*([\s\S]*?)\*/", compiled_source):
        b = m.group(1).strip()
        if b and not re.match(r"^(import|export)\s", b):
            blocks.append(b)
    result = "\n\n".join(blocks)
    return re.sub(r"\n{3,}", "\n\n", result).strip()


def swagger_to_markdown(sw: dict[str, Any]) -> str:
    out: list[str] = []
    info = sw.get("info") or {}
    if info.get("title"):
        out.append(f"# {info['title']}")
    if info.get("description"):
        out.append(info["description"])
    paths = sw.get("paths") or {}
    for path, ops in paths.items():
        if not isinstance(ops, dict):
            continue
        for method, op in ops.items():
            if method not in ("get", "post", "put", "delete", "patch"):
                continue
            if not isinstance(op, dict):
                continue
            out.append(f"## {method.upper()} {path}")
            summary = op.get("summary") or op.get("x-displayname")
            if summary:
                out.append(f"**{summary}**")
            if op.get("description"):
                out.append(op["description"])
    return "\n\n".join(out).strip()


def extract_next_data_body(html: str) -> str:
    data = parse_next_data(html)
    if not data:
        return ""
    page_props = (data.get("props") or {}).get("pageProps") or {}
    doc_data = page_props.get("docData")
    if not doc_data:
        return ""
    if isinstance(doc_data.get("compiledSource"), str):
        return mdx_from_compiled_source(doc_data["compiledSource"])
    if doc_data.get("swaggerFile"):
        return swagger_to_markdown(doc_data["swaggerFile"])
    return ""
