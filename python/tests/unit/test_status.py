"""Tests for lib/status.py."""

import json
import sqlite3
from pathlib import Path

import pytest

from f5kb.lib.status import (
    StatusReport,
    classify_error,
    compute_status,
    render_status,
)
from f5kb.track.db import init_db


# ---- classify_error ----

def test_classify_not_found():
    assert classify_error("404 page not found") == "not-found"


def test_classify_forbidden():
    assert classify_error("403 forbidden") == "forbidden"


def test_classify_timeout():
    assert classify_error("connection timed out") == "timeout"


def test_classify_rate():
    assert classify_error("429 rate limit exceeded") == "rate-limited"


def test_classify_server():
    assert classify_error("503 server error") == "server-error"


def test_classify_parse():
    assert classify_error("no body extracted") == "parse/empty"


def test_classify_network():
    assert classify_error("network connection refused") == "network"


def test_classify_other():
    assert classify_error("something random") == "other"


# ---- compute_status ----

def _dump(tmp_path, types=None) -> str:
    d = str(tmp_path / "dump")
    Path(d).mkdir(parents=True, exist_ok=True)
    for t in (types or []):
        (Path(d) / t).mkdir(parents=True, exist_ok=True)
        (Path(d) / t / "K001.json").write_text('{"id": "K001"}')
    return d


def test_compute_status_empty_dump(tmp_path):
    dump = _dump(tmp_path)
    report = compute_status(dump)
    assert isinstance(report, StatusReport)
    assert report.dump == dump
    assert report.db_present is False
    assert "DB" in " ".join(report.notes)


def test_compute_status_with_db(tmp_path):
    dump = _dump(tmp_path, types=["Knowledge"])
    db_path = str(tmp_path / "articles.db")
    conn = sqlite3.connect(db_path)
    init_db(conn)
    with conn:
        conn.execute(
            "INSERT INTO articles (document_type,id,has_body,captured_at) VALUES (?,?,?,?)",
            ("Knowledge", "K001", 1, "2024-01-01T00:00:00Z"),
        )
        conn.execute(
            "INSERT INTO runs (run_id,ran_at,scanned,new,changed,unchanged,removed) VALUES (?,?,?,?,?,?,?)",
            ("r1", "2024-01-01T00:00:00Z", 1, 1, 0, 0, 0),
        )
    conn.close()
    report = compute_status(dump, db=db_path)
    assert report.db_present is True
    assert report.overall["totalArticles"] == 1
    assert report.overall["lastRun"] is not None
    assert report.overall["lastRun"].run_id == "r1"


def test_compute_status_index_json(tmp_path):
    dump = _dump(tmp_path, types=["Knowledge"])
    (Path(dump) / "_index.json").write_text(json.dumps({
        "types": [{"typeKey": "Knowledge", "status": "ok", "expected": 10, "written": 10, "skipped": 0}]
    }))
    report = compute_status(dump, db=str(tmp_path / "missing.db"))
    kt = next((t for t in report.per_type if t.type_key == "Knowledge"), None)
    assert kt is not None
    assert kt.expected == 10
    assert kt.written == 10
    assert kt.status == "ok"


def test_compute_status_health_partial(tmp_path):
    dump = _dump(tmp_path, types=["Knowledge"])
    (Path(dump) / "_index.json").write_text(json.dumps({
        "types": [{"typeKey": "Knowledge", "status": "partial", "expected": 10, "written": 8}]
    }))
    report = compute_status(dump, db=str(tmp_path / "missing.db"))
    assert report.overall["health"] == "PARTIAL"


def test_compute_status_skips_underscore_dirs(tmp_path):
    dump = _dump(tmp_path, types=["Knowledge"])
    (Path(dump) / "_pending" / "Knowledge").mkdir(parents=True, exist_ok=True)
    (Path(dump) / "_pending" / "Knowledge" / "K999.json").write_text('{}')
    report = compute_status(dump, db=str(tmp_path / "missing.db"))
    type_keys = [t.type_key for t in report.per_type]
    assert "_pending" not in type_keys
    assert "Knowledge" in type_keys


# ---- render_status ----

def test_render_status_returns_string(tmp_path):
    dump = _dump(tmp_path, types=["Knowledge"])
    report = compute_status(dump, db=str(tmp_path / "missing.db"))
    s = render_status(report)
    assert isinstance(s, str)
    assert "Status:" in s
    assert "Knowledge" in s


def test_render_status_contains_db_line(tmp_path):
    dump = _dump(tmp_path)
    report = compute_status(dump, db=str(tmp_path / "missing.db"))
    s = render_status(report)
    assert "DB:" in s


def test_render_status_pending_approval(tmp_path):
    dump = _dump(tmp_path)
    pend = Path(dump) / "_pending"
    pend.mkdir(parents=True, exist_ok=True)
    (pend / "_manifest.json").write_text(json.dumps({
        "generatedAt": "", "entries": [{"typeKey": "K", "id": "1"}]
    }))
    report = compute_status(dump, db=str(tmp_path / "missing.db"))
    assert report.overall["pendingApproval"] == 1
    s = render_status(report)
    assert "PENDING APPROVAL" in s
