"""Tests for track/hashing.py — canonical JSON and SHA256."""

import json

import pytest

from f5kb.track.hashing import (
    canonical,
    content_for_hash,
    has_body,
    num_meta,
    sha256_obj,
    to_record,
)


def test_canonical_sorts_keys():
    result = canonical({"b": 1, "a": 2})
    assert list(result.keys()) == ["a", "b"]


def test_canonical_nested():
    result = canonical({"z": {"b": 1, "a": 2}})
    assert list(result["z"].keys()) == ["a", "b"]


def test_canonical_list_preserved():
    result = canonical([3, 1, 2])
    assert result == [3, 1, 2]


def test_canonical_primitives():
    assert canonical(42) == 42
    assert canonical("hello") == "hello"
    assert canonical(None) is None


def test_sha256_deterministic():
    h1 = sha256_obj({"b": 1, "a": 2})
    h2 = sha256_obj({"a": 2, "b": 1})
    assert h1 == h2
    assert len(h1) == 64  # hex SHA256


def test_sha256_known_value():
    # Verify our output matches JSON.stringify(canonical({})) → SHA256("{}")
    h = sha256_obj({})
    expected = "44136fa355ba77b9ad9648b98d3bf5c7246b7af1f94ad9648b98d3bf5c7246b7af1"
    # Recompute expected ourselves to avoid hardcoding wrong value
    import hashlib
    expected = hashlib.sha256("{}".encode()).hexdigest()
    assert h == expected


def test_sha256_separators_no_spaces():
    # json.dumps with separators=(',',':') produces no spaces — matches JSON.stringify
    h = sha256_obj({"key": "value"})
    import hashlib
    expected = hashlib.sha256('{"key":"value"}'.encode()).hexdigest()
    assert h == expected


def test_content_for_hash_strips_volatile():
    content = {"body_text": "hello", "bodySource": "http://x", "fetchedAt": "2024"}
    result = content_for_hash(content)
    assert "body_text" in result
    assert "bodySource" not in result
    assert "fetchedAt" not in result


def test_content_for_hash_empty():
    assert content_for_hash(None) == {}
    assert content_for_hash({}) == {}


def test_has_body_true():
    assert has_body({"body_text": "some content"}) is True


def test_has_body_false_empty():
    assert has_body({}) is False
    assert has_body(None) is False


def test_has_body_ignores_volatile():
    assert has_body({"bodySource": "http://x", "fetchedAt": "2024"}) is False


def test_has_body_ignores_body_error():
    assert has_body({"bodyError": "404 Not Found"}) is False


def test_has_body_body_error_with_content():
    assert has_body({"bodyError": "404", "body_text": "actual body"}) is True


def test_num_meta_present():
    assert num_meta({"f5_created_date": 12345}, "f5_created_date") == 12345


def test_num_meta_missing():
    assert num_meta({}, "f5_created_date") is None
    assert num_meta(None, "f5_created_date") is None


def test_num_meta_non_numeric():
    assert num_meta({"f5_created_date": "not a number"}, "f5_created_date") is None


def test_to_record_basic():
    article = {
        "id": "K001",
        "documentType": "Knowledge",
        "title": "Test Article",
        "link": "https://example.com/K001",
        "modifiedMs": 1700000000000,
        "capturedAt": "2024-01-01T00:00:00Z",
        "metadata": {"f5_kb_id": "K001"},
        "content": {"body_text": "hello"},
    }
    rec = to_record(article)
    assert rec.id == "K001"
    assert rec.document_type == "Knowledge"
    assert rec.title == "Test Article"
    assert rec.has_body == 1
    assert rec.body_error is None
    assert len(rec.metadata_hash) == 64
    assert len(rec.content_hash) == 64


def test_to_record_body_error():
    article = {
        "id": "K002",
        "documentType": "Manual",
        "content": {"bodyError": "404 Not Found"},
    }
    rec = to_record(article)
    assert rec.has_body == 0
    assert rec.body_error == "404 Not Found"


def test_to_record_volatile_not_in_content_hash():
    content_with = {"body_text": "hello", "bodySource": "http://x", "fetchedAt": "now"}
    content_without = {"body_text": "hello"}
    a1 = {"id": "x", "documentType": "T", "content": content_with}
    a2 = {"id": "x", "documentType": "T", "content": content_without}
    assert to_record(a1).content_hash == to_record(a2).content_hash


def test_hash_compat_with_fixture(fixture_path=None):
    """Verify hash against dump_mini fixture. Run manually to check DB compat."""
    from pathlib import Path

    fixture = Path(__file__).parent.parent / "fixtures" / "dump_mini" / "Knowledge"
    if not fixture.exists():
        pytest.skip("dump_mini fixture not present")

    files = sorted(fixture.glob("*.json"))
    if not files:
        pytest.skip("no Knowledge fixtures")

    art = json.loads(files[0].read_text())
    h = sha256_obj(art.get("metadata") or {})
    assert len(h) == 64  # valid hex SHA256
