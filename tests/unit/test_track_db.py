"""Tests for track/db.py."""

import json
import sqlite3
import tempfile
from pathlib import Path

import pytest

from f5kb.track.db import (
    TrackSummary,
    delete_rows,
    diff_fields,
    init_db,
    load_hash_index,
    load_ids_by_type,
    load_last_run_at,
    track_dump,
)
from f5kb.track.hashing import Record_


# ---- helpers ----

def _make_record(**kw) -> Record_:
    defaults = dict(
        id="K001",
        document_type="Knowledge",
        title="T",
        link="https://example.com",
        created_ms=None,
        original_published_ms=None,
        updated_published_ms=None,
        modified_ms=None,
        captured_at="",
        metadata_hash="aaa",
        content_hash="bbb",
        has_body=0,
        body_error=None,
    )
    defaults.update(kw)
    return Record_(**defaults)


def _open(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


# ---- init_db ----

def test_init_db_creates_tables(tmp_path):
    p = str(tmp_path / "t.db")
    conn = sqlite3.connect(p)
    init_db(conn)
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    assert {"articles", "runs", "changes"} <= tables
    conn.close()


def test_init_db_idempotent(tmp_path):
    p = str(tmp_path / "t.db")
    conn = sqlite3.connect(p)
    init_db(conn)
    init_db(conn)  # should not raise
    conn.close()


# ---- diff_fields ----

def test_diff_fields_no_change():
    rec = _make_record()
    prev = dict(
        metadata_hash="aaa", content_hash="bbb",
        updated_published_ms=None, modified_ms=None, body_error=None,
    )
    assert diff_fields(prev, rec) == []


def test_diff_fields_metadata_changed():
    rec = _make_record(metadata_hash="new")
    prev = dict(metadata_hash="old", content_hash="bbb", updated_published_ms=None, modified_ms=None, body_error=None)
    d = diff_fields(prev, rec)
    assert "metadata" in d


def test_diff_fields_content_changed():
    rec = _make_record(content_hash="new")
    prev = dict(metadata_hash="aaa", content_hash="old", updated_published_ms=None, modified_ms=None, body_error=None)
    d = diff_fields(prev, rec)
    assert "content" in d


def test_diff_fields_body_error_changed():
    rec = _make_record(body_error="fetch failed")
    prev = dict(metadata_hash="aaa", content_hash="bbb", updated_published_ms=None, modified_ms=None, body_error=None)
    d = diff_fields(prev, rec)
    assert "body_error" in d


def test_diff_fields_body_error_none_vs_empty_equiv():
    rec = _make_record(body_error="")
    prev = dict(metadata_hash="aaa", content_hash="bbb", updated_published_ms=None, modified_ms=None, body_error=None)
    # empty string treated same as None
    assert diff_fields(prev, rec) == []


# ---- load_hash_index ----

def test_load_hash_index_missing_db(tmp_path):
    result = load_hash_index(str(tmp_path / "no.db"))
    assert result == {}


def test_load_hash_index_populated(tmp_path):
    p = str(tmp_path / "t.db")
    conn = sqlite3.connect(p)
    init_db(conn)
    with conn:
        conn.execute(
            "INSERT INTO articles (document_type,id,metadata_hash) VALUES (?,?,?)",
            ("Knowledge", "K001", "abc123"),
        )
    conn.close()
    idx = load_hash_index(p)
    assert idx.get("Knowledge K001") == "abc123"


# ---- load_last_run_at ----

def test_load_last_run_at_missing(tmp_path):
    assert load_last_run_at(str(tmp_path / "no.db")) is None


def test_load_last_run_at_returns_most_recent(tmp_path):
    p = str(tmp_path / "t.db")
    conn = sqlite3.connect(p)
    init_db(conn)
    with conn:
        conn.execute(
            "INSERT INTO runs (run_id, ran_at) VALUES (?,?)",
            ("r1", "2024-01-01T00:00:00Z"),
        )
        conn.execute(
            "INSERT INTO runs (run_id, ran_at) VALUES (?,?)",
            ("r2", "2024-06-01T00:00:00Z"),
        )
    conn.close()
    result = load_last_run_at(p)
    assert result is not None
    assert result["run_id"] == "r2"


# ---- load_ids_by_type ----

def test_load_ids_by_type_empty(tmp_path):
    result = load_ids_by_type(str(tmp_path / "no.db"), ["Knowledge"])
    assert result == {"Knowledge": []}


def test_load_ids_by_type_populated(tmp_path):
    p = str(tmp_path / "t.db")
    conn = sqlite3.connect(p)
    init_db(conn)
    with conn:
        conn.execute(
            "INSERT INTO articles (document_type,id) VALUES (?,?)",
            ("Knowledge", "K001"),
        )
        conn.execute(
            "INSERT INTO articles (document_type,id) VALUES (?,?)",
            ("Knowledge", "K002"),
        )
        conn.execute(
            "INSERT INTO articles (document_type,id) VALUES (?,?)",
            ("Bug_Tracker", "ID-1"),
        )
    conn.close()
    result = load_ids_by_type(p, ["Knowledge"])
    assert set(result["Knowledge"]) == {"K001", "K002"}


# ---- delete_rows ----

def test_delete_rows_removes_rows(tmp_path):
    p = str(tmp_path / "t.db")
    conn = sqlite3.connect(p)
    init_db(conn)
    with conn:
        conn.execute("INSERT INTO articles (document_type,id) VALUES (?,?)", ("Knowledge", "K001"))
        conn.execute("INSERT INTO articles (document_type,id) VALUES (?,?)", ("Knowledge", "K002"))
    conn.close()
    n = delete_rows(p, [{"documentType": "Knowledge", "id": "K001"}])
    assert n == 1
    conn2 = sqlite3.connect(p)
    rows = conn2.execute("SELECT id FROM articles WHERE document_type='Knowledge'").fetchall()
    conn2.close()
    assert [r[0] for r in rows] == ["K002"]


def test_delete_rows_empty_list(tmp_path):
    p = str(tmp_path / "t.db")
    assert delete_rows(p, []) == 0


# ---- track_dump (end-to-end) ----

def _write_article(d: Path, doc_type: str, art_id: str, meta: dict | None = None, content: dict | None = None):
    t = d / doc_type
    t.mkdir(parents=True, exist_ok=True)
    data = {
        "id": art_id,
        "documentType": doc_type,
        "title": f"Title {art_id}",
        "link": f"https://example.com/{art_id}",
        "metadata": meta or {"f5_created_date": 1700000000000},
        "content": content or {"bodyText": "hello world"},
    }
    (t / f"{art_id}.json").write_text(json.dumps(data, indent=2))
    return data


def test_track_dump_new_articles(tmp_path):
    dump = str(tmp_path / "dump")
    db = str(tmp_path / "t.db")
    _write_article(Path(dump), "Knowledge", "K001")
    _write_article(Path(dump), "Knowledge", "K002")
    result = track_dump(dump, db_path=db, run_id="run1")
    assert isinstance(result, TrackSummary)
    assert result.scanned == 2
    assert result.new == 2
    assert result.changed == 0
    assert result.unchanged == 0


def test_track_dump_unchanged_second_run(tmp_path):
    dump = str(tmp_path / "dump")
    db = str(tmp_path / "t.db")
    _write_article(Path(dump), "Knowledge", "K001")
    track_dump(dump, db_path=db, run_id="run1")
    result = track_dump(dump, db_path=db, run_id="run2")
    assert result.new == 0
    assert result.unchanged == 1
    assert result.changed == 0


def test_track_dump_changed_metadata(tmp_path):
    dump = str(tmp_path / "dump")
    db = str(tmp_path / "t.db")
    art = _write_article(Path(dump), "Knowledge", "K001")
    track_dump(dump, db_path=db, run_id="run1")
    # update metadata
    art["metadata"]["f5_created_date"] = 9999999999999
    (Path(dump) / "Knowledge" / "K001.json").write_text(json.dumps(art, indent=2))
    result = track_dump(dump, db_path=db, run_id="run2")
    assert result.changed == 1
    assert result.unchanged == 0


def test_track_dump_detects_removed(tmp_path):
    dump = str(tmp_path / "dump")
    db = str(tmp_path / "t.db")
    _write_article(Path(dump), "Knowledge", "K001")
    _write_article(Path(dump), "Knowledge", "K002")
    track_dump(dump, db_path=db, run_id="run1")
    # delete K002
    (Path(dump) / "Knowledge" / "K002.json").unlink()
    result = track_dump(dump, db_path=db, run_id="run2")
    assert result.removed == 1


def test_track_dump_skips_underscore_dirs(tmp_path):
    dump = str(tmp_path / "dump")
    db = str(tmp_path / "t.db")
    _write_article(Path(dump), "Knowledge", "K001")
    # Put a file under _pending — should not be counted
    pending = Path(dump) / "_pending" / "Knowledge"
    pending.mkdir(parents=True)
    _write_article(Path(dump) / ".." / "_pending", "Knowledge", "K099")  # won't land right
    result = track_dump(dump, db_path=db, run_id="run1")
    assert result.scanned == 1
    assert result.types == 1


def test_track_dump_records_run(tmp_path):
    dump = str(tmp_path / "dump")
    db = str(tmp_path / "t.db")
    _write_article(Path(dump), "Knowledge", "K001")
    track_dump(dump, db_path=db, run_id="myrun")
    conn = sqlite3.connect(db)
    row = conn.execute("SELECT run_id FROM runs WHERE run_id='myrun'").fetchone()
    conn.close()
    assert row is not None
