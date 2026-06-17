"""Tests for lib/changelog.py."""

import json
from pathlib import Path

from f5kb.lib.changelog import CHANGELOG_BASENAME, Changelog, changelog_path_from_flag


def test_changelog_path_none():
    assert changelog_path_from_flag(None, "/dump") is None


def test_changelog_path_true():
    p = changelog_path_from_flag(True, "/dump/out")
    assert p == f"/dump/out/{CHANGELOG_BASENAME}"


def test_changelog_path_empty_string():
    p = changelog_path_from_flag("", "/dump")
    assert p == f"/dump/{CHANGELOG_BASENAME}"


def test_changelog_path_custom():
    p = changelog_path_from_flag("/custom/path.jsonl", "/dump")
    assert p == "/custom/path.jsonl"


def test_changelog_path_strips_trailing_slash():
    p = changelog_path_from_flag(True, "/dump/")
    assert p == f"/dump/{CHANGELOG_BASENAME}"


def test_changelog_disabled_counts():
    cl = Changelog(None, "run1")
    cl.record("added", "Knowledge", "K001", title="T")
    cl.record("edited", "Knowledge", "K002", title="T2")
    assert cl.total == 2
    assert cl.by_op()["added"] == 1
    assert cl.by_op()["edited"] == 1


def test_changelog_disabled_no_file(tmp_path):
    cl = Changelog(None, "run1")
    cl.record("added", "Knowledge", "K001")
    cl.flush()
    assert not any(tmp_path.iterdir())


def test_changelog_enabled_writes_jsonl(tmp_path):
    path = str(tmp_path / "log.jsonl")
    cl = Changelog(path, "run42")
    cl.record("added", "Knowledge", "K001", title="Article 1")
    cl.record("body-added", "Manual", "M001")
    cl.flush()
    lines = Path(path).read_text().splitlines()
    assert len(lines) == 2
    obj = json.loads(lines[0])
    assert obj["runId"] == "run42"
    assert obj["op"] == "added"
    assert obj["documentType"] == "Knowledge"
    assert obj["id"] == "K001"
    assert obj["title"] == "Article 1"
    assert "ts" in obj


def test_changelog_appends_across_flushes(tmp_path):
    path = str(tmp_path / "log.jsonl")
    cl = Changelog(path, "run1")
    cl.record("added", "T", "id1")
    cl.flush()
    cl.record("edited", "T", "id2")
    cl.flush()
    lines = Path(path).read_text().splitlines()
    assert len(lines) == 2


def test_changelog_enabled_property():
    assert Changelog("/some/path", "r").enabled is True
    assert Changelog(None, "r").enabled is False


def test_changelog_creates_parent_dirs(tmp_path):
    path = str(tmp_path / "deep" / "nested" / "log.jsonl")
    cl = Changelog(path, "r1")
    cl.record("added", "T", "x")
    cl.flush()
    assert Path(path).exists()
