"""Field flattening, metadata/content splitting, and field-catalogue building."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from f5kb.config.types import TypeConfig


@dataclass
class CatalogueEntry:
    field_name: str
    source: str  # "top" | "raw"
    types: set[str] = field(default_factory=set)
    occurrences: int = 0
    sample: str = ""
    description: str = ""


def flatten_fields(r: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Flat view: raw.* keys then top-level keys (top wins on clash).

    Returns {field_name: {"source": "top"|"raw", "value": ...}}
    """
    fields: dict[str, dict[str, Any]] = {}
    raw = r.get("raw") or {}
    for k, v in raw.items():
        fields[k] = {"source": "raw", "value": v}
    for k, v in r.items():
        if k == "raw":
            continue
        fields[k] = {"source": "top", "value": v}
    return fields


def flatten_fields_safe(r: dict[str, Any]) -> dict[str, dict[str, Any]]:
    try:
        return flatten_fields(r)
    except Exception:
        return {}


def selects(sel: str | list[str], name: str) -> bool:
    return sel == "*" or (isinstance(sel, list) and name in sel)


def split_entry(
    fields: dict[str, dict[str, Any]],
    cfg: TypeConfig,
) -> dict[str, dict[str, Any]]:
    """Split article fields into {metadata, content} per type config.
    Content takes precedence: a field in content never also appears in metadata.
    """
    metadata: dict[str, Any] = {}
    content: dict[str, Any] = {}
    for name, entry in fields.items():
        v = entry["value"]
        if selects(cfg.content, name):
            content[name] = v
        elif selects(cfg.metadata, name):
            metadata[name] = v
    return {"metadata": metadata, "content": content}


def js_type(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, list):
        return "list"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, int) or isinstance(v, float):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, dict):
        return "object"
    return type(v).__name__


def sample_of(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, str):
        s = v
    elif isinstance(v, (list, dict)):
        s = json.dumps(v)
    else:
        s = str(v)
    s = " ".join(s.split()).strip()
    return (s[:200] + "…") if len(s) > 200 else s


def update_catalogue(
    cat: dict[str, CatalogueEntry],
    fields: dict[str, dict[str, Any]],
    descriptions: dict[str, str],
) -> None:
    for name, entry in fields.items():
        v = entry["value"]
        src = entry["source"]
        if name not in cat:
            cat[name] = CatalogueEntry(
                field_name=name,
                source=src,
                description=descriptions.get(name, ""),
            )
        e = cat[name]
        e.occurrences += 1
        e.types.add(js_type(v))
        if not e.sample:
            s = sample_of(v)
            if s:
                e.sample = s


def write_catalogue(
    dir_path: str | Path,
    type_key: str,
    document_type: str,
    cat: dict[str, CatalogueEntry],
    total_entries: int,
    cfg: TypeConfig,
) -> None:
    rows = []
    for e in sorted(cat.values(), key=lambda x: x.field_name):
        if selects(cfg.content, e.field_name):
            section = "content"
        elif selects(cfg.metadata, e.field_name):
            section = "metadata"
        else:
            section = "unselected"
        coverage = round(e.occurrences / total_entries, 3) if total_entries else 0
        rows.append({
            "field": e.field_name,
            "source": e.source,
            "section": section,
            "types": sorted(e.types),
            "occurrences": e.occurrences,
            "coverage": coverage,
            "description": e.description,
            "sample": e.sample,
        })

    catalogue_json = {
        "typeKey": type_key,
        "documentType": document_type,
        "totalEntries": total_entries,
        "fieldCount": len(rows),
        "note": (
            "Every field returned by the API across the dumped entries. 'section' "
            "reflects the current config. Replace metadata: \"*\" in the config with "
            "an explicit list of the field names you want to keep."
        ),
        "fields": rows,
    }

    d = Path(dir_path)
    (d / "_catalogue.json").write_text(
        json.dumps(catalogue_json, indent=2), encoding="utf-8"
    )

    # Human-readable markdown companion
    def esc(s: str) -> str:
        return s.replace("|", "\\|").replace("\n", " ")

    md_lines = [
        f"# Field catalogue — {document_type} ({type_key})",
        "",
        f"Entries surveyed: {total_entries}  •  Fields seen: {len(rows)}",
        "",
        "| field | source | section | type(s) | coverage | description | sample |",
        "|-------|--------|---------|---------|----------|-------------|--------|",
    ]
    for r in rows:
        pct = f"{r['coverage'] * 100:.0f}%"
        types_str = ", ".join(r["types"])
        md_lines.append(
            f"| `{r['field']}` | {r['source']} | {r['section']} | {types_str} | "
            f"{pct} | {esc(r['description'])} | {esc(r['sample'])} |"
        )
    md_lines.append("")

    (d / "_catalogue.md").write_text("\n".join(md_lines), encoding="utf-8")
