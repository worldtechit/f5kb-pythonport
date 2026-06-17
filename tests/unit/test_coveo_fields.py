"""Tests for coveo/fields.py."""

import json
from pathlib import Path

import pytest

from f5kb.config.types import TypeConfig
from f5kb.coveo.fields import (
    CatalogueEntry,
    flatten_fields,
    flatten_fields_safe,
    js_type,
    sample_of,
    selects,
    split_entry,
    update_catalogue,
    write_catalogue,
)


def make_tc(metadata="*", content=None):
    return TypeConfig(
        document_type="Test",
        metadata=metadata,
        content=content or [],
    )


def test_flatten_fields_raw_and_top():
    r = {"title": "T", "raw": {"f5_kb_id": "K001", "title": "raw_title"}}
    fields = flatten_fields(r)
    # top-level title overrides raw.title
    assert fields["title"]["source"] == "top"
    assert fields["title"]["value"] == "T"
    assert fields["f5_kb_id"]["source"] == "raw"
    assert fields["f5_kb_id"]["value"] == "K001"


def test_flatten_fields_safe_bad_input():
    result = flatten_fields_safe(None)  # type: ignore
    assert result == {}


def test_selects_star():
    assert selects("*", "any_field") is True


def test_selects_list_match():
    assert selects(["a", "b"], "a") is True


def test_selects_list_miss():
    assert selects(["a", "b"], "c") is False


def test_split_entry_basic():
    cfg = make_tc(metadata=["f5_kb_id"], content=["body_text"])
    fields = {
        "f5_kb_id": {"source": "raw", "value": "K001"},
        "body_text": {"source": "raw", "value": "hello"},
        "other": {"source": "raw", "value": "ignored"},
    }
    result = split_entry(fields, cfg)
    assert result["metadata"]["f5_kb_id"] == "K001"
    assert result["content"]["body_text"] == "hello"
    assert "other" not in result["metadata"]
    assert "other" not in result["content"]


def test_split_entry_content_precedence():
    # field in both metadata=* and content list → goes to content only
    cfg = make_tc(metadata="*", content=["shared_field"])
    fields = {"shared_field": {"source": "raw", "value": "v"}}
    result = split_entry(fields, cfg)
    assert "shared_field" in result["content"]
    assert "shared_field" not in result["metadata"]


def test_js_type_values():
    assert js_type(None) == "null"
    assert js_type([]) == "list"
    assert js_type({}) == "object"
    assert js_type("hello") == "string"
    assert js_type(42) == "number"
    assert js_type(True) == "boolean"


def test_sample_of_truncates():
    long_str = "x" * 250
    result = sample_of(long_str)
    assert len(result) <= 202  # 200 + ellipsis
    assert result.endswith("…")


def test_sample_of_empty():
    assert sample_of(None) == ""


def test_update_catalogue():
    cat = {}
    fields = {
        "f5_kb_id": {"source": "raw", "value": "K001"},
        "f5_title": {"source": "raw", "value": "Title"},
    }
    update_catalogue(cat, fields, {"f5_kb_id": "K-number"})
    assert "f5_kb_id" in cat
    assert cat["f5_kb_id"].occurrences == 1
    assert cat["f5_kb_id"].description == "K-number"
    assert "string" in cat["f5_kb_id"].types


def test_write_catalogue(tmp_path):
    cat = {}
    fields = {"f5_kb_id": {"source": "raw", "value": "K001"}}
    update_catalogue(cat, fields, {})
    cfg = make_tc(metadata=["f5_kb_id"])
    write_catalogue(tmp_path, "Knowledge", "Knowledge", cat, 1, cfg)
    assert (tmp_path / "_catalogue.json").exists()
    assert (tmp_path / "_catalogue.md").exists()
    data = json.loads((tmp_path / "_catalogue.json").read_text())
    assert data["typeKey"] == "Knowledge"
    assert data["totalEntries"] == 1
    assert len(data["fields"]) == 1
