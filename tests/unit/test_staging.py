"""Tests for lib/staging.py."""

import json
from pathlib import Path

import pytest

from f5kb.lib.staging import (
    PendingEntry,
    archive_replaced,
    change_kind,
    compute_risk,
    diff_parts,
    live_article,
    load_pending_manifest,
    manifest_path,
    merge_pending,
    now_stamp,
    pending_dir,
    pending_path,
    replaced_path,
    save_pending_manifest,
)


# ---- path helpers ----

def test_pending_dir(tmp_path):
    assert pending_dir(str(tmp_path)) == str(tmp_path / "_pending")


def test_pending_path(tmp_path):
    p = pending_path(str(tmp_path), "Knowledge", "K001")
    assert p.endswith("_pending/Knowledge/K001.json")


def test_replaced_path(tmp_path):
    p = replaced_path(str(tmp_path), "Knowledge", "K001", "2024-01-01T00-00-00Z")
    assert "_replaced" in p
    assert "K001" in p


def test_manifest_path(tmp_path):
    p = manifest_path(str(tmp_path))
    assert p.endswith("_pending/_manifest.json")


# ---- now_stamp ----

def test_now_stamp_no_colons():
    s = now_stamp(1705315200000)
    assert ":" not in s
    assert "." not in s


def test_now_stamp_ends_z():
    s = now_stamp(1705315200000)
    assert s.endswith("Z")


# ---- PendingEntry ----

def test_pending_entry_roundtrip():
    e = PendingEntry(
        type_key="Knowledge", id="K001", op="edited",
        source="sync", title="T", changed=["metadata"],
        hash_old="aaa", hash_new="bbb", staged_at="2024-01-01T00:00:00Z",
    )
    d = e.to_dict()
    assert d["typeKey"] == "Knowledge"
    assert d["id"] == "K001"
    assert d["changed"] == ["metadata"]
    e2 = PendingEntry.from_dict(d)
    assert e2.type_key == "Knowledge"
    assert e2.hash_old == "aaa"


def test_pending_entry_no_changed_skipped():
    e = PendingEntry(type_key="K", id="1", op="edited", source="s", changed=[])
    d = e.to_dict()
    assert "changed" not in d


# ---- manifest load/save/merge ----

def test_load_pending_manifest_missing(tmp_path):
    data = load_pending_manifest(str(tmp_path))
    assert data["entries"] == []


def test_save_and_load_manifest(tmp_path):
    d = str(tmp_path)
    save_pending_manifest(d, {"generatedAt": "2024", "entries": [{"typeKey": "K", "id": "1"}]})
    loaded = load_pending_manifest(d)
    assert loaded["entries"][0]["id"] == "1"


def test_merge_pending_adds(tmp_path):
    d = str(tmp_path)
    entries = [
        PendingEntry(type_key="Knowledge", id="K001", op="edited", source="sync"),
        PendingEntry(type_key="Knowledge", id="K002", op="edited", source="sync"),
    ]
    merge_pending(d, entries, "2024-01-01T00:00:00Z")
    data = load_pending_manifest(d)
    ids = {e["id"] for e in data["entries"]}
    assert ids == {"K001", "K002"}


def test_merge_pending_deduplicates(tmp_path):
    d = str(tmp_path)
    e1 = PendingEntry(type_key="Knowledge", id="K001", op="edited", source="s1", hash_new="v1")
    merge_pending(d, [e1], "t1")
    e2 = PendingEntry(type_key="Knowledge", id="K001", op="edited", source="s2", hash_new="v2")
    merge_pending(d, [e2], "t2")
    data = load_pending_manifest(d)
    assert len(data["entries"]) == 1
    assert data["entries"][0].get("hashNew") == "v2"


# ---- compute_risk ----

def test_compute_risk_no_live():
    assert compute_risk(None, {"content": {}}) == []


def test_compute_risk_body_error():
    live = {"content": {"bodyText": "hello"}}
    pending = {"content": {"bodyError": "timeout"}}
    flags = compute_risk(live, pending)
    assert "body-error" in flags


def test_compute_risk_body_dropped():
    live = {"content": {"bodyText": "hello world"}}
    pending = {"content": {}}
    flags = compute_risk(live, pending)
    assert "body-dropped" in flags


def test_compute_risk_body_shrank():
    live = {"content": {"bodyText": "x" * 1000}}
    pending = {"content": {"bodyText": "x" * 100}}
    flags = compute_risk(live, pending)
    assert any("body-shrank" in f for f in flags)


def test_compute_risk_no_shrink_new_article():
    pending = {"content": {"bodyText": "hello"}}
    assert compute_risk(None, pending) == []


# ---- diff_parts ----

def test_diff_parts_no_live():
    assert diff_parts(None, {}) == []


def test_diff_parts_metadata_changed():
    live = {"metadata": {"a": 1}, "content": {}}
    pending = {"metadata": {"a": 2}, "content": {}}
    assert "metadata" in diff_parts(live, pending)


def test_diff_parts_content_changed():
    live = {"metadata": {}, "content": {"bodyText": "old"}}
    pending = {"metadata": {}, "content": {"bodyText": "new"}}
    assert "content" in diff_parts(live, pending)


def test_diff_parts_no_change():
    a = {"metadata": {"x": 1}, "content": {"bodyText": "same"}}
    assert diff_parts(a, a) == []


# ---- change_kind ----

def test_change_kind_both():
    assert change_kind(["metadata", "content"]) == "metadata+content"


def test_change_kind_metadata_only():
    assert change_kind(["metadata"]) == "metadata-only"


def test_change_kind_content_only():
    assert change_kind(["content"]) == "content-only"


def test_change_kind_noop():
    assert change_kind([]) == "no-op"


# ---- archive_replaced ----

def test_archive_replaced_moves_file(tmp_path):
    out = str(tmp_path / "dump")
    (Path(out) / "Knowledge").mkdir(parents=True)
    live = Path(out) / "Knowledge" / "K001.json"
    live.write_text('{"id": "K001"}')
    dest = archive_replaced(out, "Knowledge", "K001", "stamp")
    assert dest is not None
    assert not live.exists()
    assert Path(dest).exists()


def test_archive_replaced_no_live(tmp_path):
    out = str(tmp_path / "dump")
    result = archive_replaced(out, "Knowledge", "K999", "stamp")
    assert result is None


# ---- live_article ----

def test_live_article_found(tmp_path):
    out = str(tmp_path / "dump")
    (Path(out) / "Knowledge").mkdir(parents=True)
    (Path(out) / "Knowledge" / "K001.json").write_text('{"id": "K001"}')
    a = live_article(out, "Knowledge", "K001")
    assert a is not None
    assert a["id"] == "K001"


def test_live_article_missing(tmp_path):
    assert live_article(str(tmp_path), "Knowledge", "K999") is None
