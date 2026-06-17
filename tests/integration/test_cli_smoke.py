"""CLI smoke tests using the mini fixture dump."""

from pathlib import Path
import json
import subprocess
import sys

import pytest

FIXTURES = Path(__file__).parent.parent / "fixtures" / "dump_mini"


def _run(*args):
    return subprocess.run(
        [sys.executable, "-m", "f5kb", *args],
        capture_output=True, text=True, cwd=Path(__file__).parent.parent,
    )


def test_version():
    r = _run("--version")
    assert r.returncode == 0
    assert "1.0.0" in r.stdout


def test_help():
    r = _run("--help")
    assert r.returncode == 0
    assert "dump" in r.stdout
    assert "track" in r.stdout


def test_track_smoke(tmp_path):
    db = str(tmp_path / "t.db")
    r = _run("track", "--dump", str(FIXTURES), "--db", db)
    assert r.returncode == 0, r.stderr
    assert "25 articles" in r.stderr


def test_track_json(tmp_path):
    db = str(tmp_path / "t.db")
    r = _run("track", "--dump", str(FIXTURES), "--db", db, "--json")
    assert r.returncode == 0
    data = json.loads(r.stdout)
    assert data["scanned"] == 25
    assert data["new"] == 25


def test_status_smoke(tmp_path):
    db = str(tmp_path / "t.db")
    _run("track", "--dump", str(FIXTURES), "--db", db)
    r = _run("status", "--dump", str(FIXTURES), "--db", db)
    assert r.returncode == 0
    assert "Status:" in r.stdout
    assert "Knowledge" in r.stdout


def test_status_json(tmp_path):
    db = str(tmp_path / "t.db")
    _run("track", "--dump", str(FIXTURES), "--db", db)
    r = _run("status", "--dump", str(FIXTURES), "--db", db, "--json")
    assert r.returncode == 0
    data = json.loads(r.stdout)
    assert "overall" in data
    assert data["overall"]["totalArticles"] == 25


def test_track_idempotent(tmp_path):
    db = str(tmp_path / "t.db")
    _run("track", "--dump", str(FIXTURES), "--db", db)
    r = _run("track", "--dump", str(FIXTURES), "--db", db)
    assert r.returncode == 0
    assert "unchanged=25" in r.stderr


def test_approve_list_empty(tmp_path):
    dump = str(tmp_path / "dump")
    Path(dump).mkdir()
    r = _run("approve", "--dump", dump, "--list")
    assert r.returncode == 0
    assert "0 pending" in r.stderr


def test_unknown_subcommand():
    r = _run("not-a-command")
    assert r.returncode != 0
