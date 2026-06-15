"""Shared config types. config.yaml has three top-level sections:
  types:              per-document-type field keep-lists
  field_descriptions: field-name -> description
  products:           read-only product snapshot
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Union


@dataclass(frozen=True)
class TypeConfig:
    document_type: str
    metadata: Union[str, list[str]]  # "*" or explicit list
    content: Union[str, list[str]]   # "*" or explicit list (usually [])


@dataclass(frozen=True)
class ProductEntry:
    product: str
    count: int
    source: str
    hidden_from_global_facet: bool = False
    discovered_via_types: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class ProductsSection:
    generated_at: str | None
    entries: tuple[ProductEntry, ...]


@dataclass(frozen=True)
class AppConfig:
    types: dict[str, TypeConfig]
    field_descriptions: dict[str, str]
    products: ProductsSection


def normalize_type(c: dict) -> TypeConfig:
    """Defaults: metadata='*', content=[]."""
    return TypeConfig(
        document_type=c.get("documentType") or "",
        metadata=c.get("metadata") or "*",
        content=c.get("content") or [],
    )
