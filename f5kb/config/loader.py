"""Loads the merged config.yaml into a typed AppConfig."""

from __future__ import annotations

from pathlib import Path

import yaml

from f5kb.config.types import AppConfig, ProductEntry, ProductsSection, normalize_type


def load_config(path: str = "config.yaml") -> AppConfig:
    text = Path(path).read_text(encoding="utf-8")
    doc = yaml.safe_load(text) or {}

    raw_types = doc.get("types") or {}
    types = {k: normalize_type(v or {}) for k, v in raw_types.items()}

    field_descriptions: dict[str, str] = doc.get("field_descriptions") or {}

    raw_products = doc.get("products") or {}
    raw_entries = raw_products.get("entries") or []
    entries = tuple(
        ProductEntry(
            product=e.get("product") or "",
            count=int(e.get("count") or 0),
            source=e.get("source") or "",
            hidden_from_global_facet=bool(e.get("hiddenFromGlobalFacet") or False),
            discovered_via_types=tuple(e.get("discoveredViaTypes") or []),
        )
        for e in raw_entries
    )
    products = ProductsSection(
        generated_at=raw_products.get("generatedAt"),
        entries=entries,
    )

    return AppConfig(types=types, field_descriptions=field_descriptions, products=products)


def load_field_descriptions_file(path: str) -> dict[str, str]:
    """Optional override file for field descriptions. Returns {} on any error."""
    try:
        text = Path(path).read_text(encoding="utf-8")
        doc = yaml.safe_load(text)
        if not doc or not isinstance(doc, dict):
            return {}
        maybe = doc.get("descriptions")
        if isinstance(maybe, dict):
            return maybe
        return doc
    except Exception:
        return {}
