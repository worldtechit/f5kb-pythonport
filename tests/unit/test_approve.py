"""Tests for lib/approve.py."""

import json
from pathlib import Path

import pytest

from f5kb.lib.approve import ApproveResult, approve
from f5kb.lib.staging import (
    PendingEntry,
    live_path,
    manifest_path,
    merge_pending,
    pending_path,
    save_pending_manifest,
)


NOW_MS = 1705315200000  # fixed timestamp for tests


def _dump(tmp_path) -> str:
    d = str(tmp_path / "dump")
    Path(d).mkdir(parents=True, exist_ok=True)
    return d


def _stage(dump: str, type_key: str, art_id: str, content: dict, live_content: dict | None = None):
    pp = pending_path(dump, type_key, art_id)
    Path(pp).parent.mkdir(parents=True, exist_ok=True)
    article = {
        "id": art_id,
        "documentType": type_key,
        "title": f"T {art_id}",
        "metadata": {"version": 2},
        "content": content,
    }
    Path(pp).write_text(json.dumps(article))
    if live_content is not None:
        lp = live_path(dump, type_key, art_id)
        Path(lp).parent.mkdir(parents=True, exist_ok=True)
        live_article = {
            "id": art_id,
            "documentType": type_key,
            "title": f"T {art_id}",
            "metadata": {"version": 1},
            "content": live_content,
        }
        Path(lp).write_text(json.dumps(live_article))
    entry = PendingEntry(
        type_key=type_key, id=art_id, op="edited", source="sync",
        title=f"T {art_id}", hash_old="old", hash_new="new",
    )
    merge_pending(dump, [entry], "2024-01-01T00:00:00Z")


# ---- promote ----

def test_approve_promotes_pending(tmp_path):
    dump = _dump(tmp_path)
    _stage(dump, "Knowledge", "K001", {"bodyText": "hello"})
    result = approve(dump, now_ms=NOW_MS)
    assert isinstance(result, ApproveResult)
    assert result.promoted == 1
    assert result.rejected == 0
    # file moved to live path
    lp = live_path(dump, "Knowledge", "K001")
    assert Path(lp).exists()
    # removed from manifest
    data = json.loads(Path(manifest_path(dump)).read_text())
    assert data["entries"] == []


def test_approve_archives_live(tmp_path):
    dump = _dump(tmp_path)
    _stage(dump, "Knowledge", "K001", {"bodyText": "new"}, live_content={"bodyText": "old"})
    result = approve(dump, now_ms=NOW_MS)
    assert result.promoted == 1
    item = result.items[0]
    assert item.archived is not None
    assert Path(item.archived).exists()


# ---- risky holds ----

def test_approve_holds_body_error(tmp_path):
    dump = _dump(tmp_path)
    _stage(dump, "Knowledge", "K001", {"bodyError": "timeout"}, live_content={"bodyText": "good"})
    result = approve(dump, now_ms=NOW_MS)
    assert result.held_risky == 1
    assert result.promoted == 0
    # manifest still has the entry
    data = json.loads(Path(manifest_path(dump)).read_text())
    assert len(data["entries"]) == 1


def test_approve_include_risky_promotes(tmp_path):
    dump = _dump(tmp_path)
    _stage(dump, "Knowledge", "K001", {"bodyError": "timeout"}, live_content={"bodyText": "good"})
    result = approve(dump, include_risky=True, now_ms=NOW_MS)
    assert result.promoted == 1


def test_approve_holds_body_dropped(tmp_path):
    dump = _dump(tmp_path)
    _stage(dump, "Knowledge", "K001", {}, live_content={"bodyText": "hello"})
    result = approve(dump, now_ms=NOW_MS)
    assert result.held_risky == 1


# ---- reject ----

def test_approve_reject_deletes_pending(tmp_path):
    dump = _dump(tmp_path)
    _stage(dump, "Knowledge", "K001", {"bodyText": "hello"})
    pp = pending_path(dump, "Knowledge", "K001")
    result = approve(dump, reject=True, now_ms=NOW_MS)
    assert result.rejected == 1
    assert not Path(pp).exists()


# ---- filters ----

def test_approve_filter_by_type_key(tmp_path):
    dump = _dump(tmp_path)
    _stage(dump, "Knowledge", "K001", {"bodyText": "a"})
    _stage(dump, "Bug_Tracker", "BUG-1", {"bodyText": "b"})
    result = approve(dump, type_keys=["Knowledge"], now_ms=NOW_MS)
    assert result.promoted == 1
    # Bug_Tracker entry still in manifest
    data = json.loads(Path(manifest_path(dump)).read_text())
    assert any(e["typeKey"] == "Bug_Tracker" for e in data["entries"])


def test_approve_filter_by_id(tmp_path):
    dump = _dump(tmp_path)
    _stage(dump, "Knowledge", "K001", {"bodyText": "a"})
    _stage(dump, "Knowledge", "K002", {"bodyText": "b"})
    result = approve(dump, ids=["K001"], now_ms=NOW_MS)
    assert result.promoted == 1
    items_promoted = [i for i in result.items if i.action == "promoted"]
    assert items_promoted[0].id == "K001"


# ---- dry_run ----

def test_approve_dry_run_no_side_effects(tmp_path):
    dump = _dump(tmp_path)
    _stage(dump, "Knowledge", "K001", {"bodyText": "hello"})
    pp = pending_path(dump, "Knowledge", "K001")
    result = approve(dump, dry_run=True, now_ms=NOW_MS)
    assert result.items[0].action == "preview"
    # file still there
    assert Path(pp).exists()
    # manifest unchanged
    data = json.loads(Path(manifest_path(dump)).read_text())
    assert len(data["entries"]) == 1


# ---- missing pending ----

def test_approve_missing_pending_file(tmp_path):
    dump = _dump(tmp_path)
    # add to manifest but don't create file
    save_pending_manifest(dump, {
        "generatedAt": "",
        "entries": [{"typeKey": "Knowledge", "id": "K999", "op": "edited", "source": "sync", "stagedAt": ""}],
    })
    result = approve(dump, now_ms=NOW_MS)
    assert result.items[0].action == "missing-pending"


# ---- changelog integration ----

def test_approve_calls_changelog(tmp_path):
    dump = _dump(tmp_path)
    _stage(dump, "Knowledge", "K001", {"bodyText": "hello"})
    records = []
    class FakeChangelog:
        def record(self, op, doc_type, art_id, **kw):
            records.append({"op": op, "doc_type": doc_type, "id": art_id, **kw})
    approve(dump, changelog=FakeChangelog(), now_ms=NOW_MS)
    assert len(records) == 1
    assert records[0]["op"] == "edited"
    assert records[0]["id"] == "K001"
