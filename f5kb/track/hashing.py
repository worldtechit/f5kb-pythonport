"""Hashing / canonicalization + article->record mapping for change tracking.

The hashing scheme and record shape MUST stay byte-identical to the TypeScript
implementation so the existing outputs/articles.db remains valid across runs
(content_hash / metadata_hash must reproduce exactly).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

# content keys that are bookkeeping, not body — excluded from hash and has-body
# test so a re-fetch timestamp never looks like a change.
VOLATILE_CONTENT_KEYS: frozenset[str] = frozenset({"bodySource", "fetchedAt"})


def canonical(v: Any) -> Any:
    """Recursively sort object keys so logically-equal objects hash identically."""
    if isinstance(v, list):
        return [canonical(x) for x in v]
    if isinstance(v, dict):
        return {k: canonical(v[k]) for k in sorted(v)}
    return v


def sha256_obj(obj: Any) -> str:
    """Deterministic SHA256 hex digest. Matches TS JSON.stringify(canonical(obj))."""
    # separators=(',', ':') → no spaces, matches JSON.stringify output
    s = json.dumps(canonical(obj), separators=(",", ":"))
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def content_for_hash(content: dict | None) -> dict:
    if not content:
        return {}
    return {k: v for k, v in content.items() if k not in VOLATILE_CONTENT_KEYS}


def has_body(content: dict | None) -> bool:
    for k, v in (content or {}).items():
        if k in VOLATILE_CONTENT_KEYS or k == "bodyError":
            continue
        if isinstance(v, str):
            if v.strip():
                return True
        elif v is not None:
            return True
    return False


def num_meta(meta: dict | None, key: str) -> int | None:
    v = (meta or {}).get(key)
    return v if isinstance(v, (int, float)) else None


@dataclass
class Record_:
    id: str
    document_type: str
    title: str
    link: str
    created_ms: int | None
    original_published_ms: int | None
    updated_published_ms: int | None
    modified_ms: int | None
    captured_at: str
    metadata_hash: str
    content_hash: str
    has_body: int  # 0 or 1 (SQLite boolean)
    body_error: str | None


def to_record(a: dict) -> Record_:
    meta = a.get("metadata") or {}
    content = a.get("content") or {}
    return Record_(
        id=a.get("id") or "",
        document_type=a.get("documentType") or "",
        title=a.get("title") or "",
        link=a.get("link") or "",
        created_ms=num_meta(meta, "f5_created_date"),
        original_published_ms=num_meta(meta, "f5_original_published_date"),
        updated_published_ms=num_meta(meta, "f5_updated_published_date"),
        modified_ms=a.get("modifiedMs") if isinstance(a.get("modifiedMs"), (int, float)) else None,
        captured_at=a.get("capturedAt") or "",
        metadata_hash=sha256_obj(meta),
        content_hash=sha256_obj(content_for_hash(content)),
        has_body=1 if has_body(content) else 0,
        body_error=content.get("bodyError") if isinstance(content.get("bodyError"), str) else None,
    )
