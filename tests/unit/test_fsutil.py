"""Tests for lib/fsutil.py."""

from pathlib import Path

from f5kb.lib.fsutil import (
    id_of,
    list_type_dirs,
    path_exists,
    read_json,
    sanitize_name,
    walk_article_files,
    write_json,
)


def test_sanitize_name_basic():
    assert sanitize_name("hello world") == "hello_world"


def test_sanitize_name_special_chars():
    assert sanitize_name("foo/bar:baz") == "foo_bar_baz"


def test_sanitize_name_collapse_underscores():
    assert sanitize_name("foo__bar") == "foo_bar"


def test_sanitize_name_strip_edges():
    assert sanitize_name("_foo_") == "foo"


def test_sanitize_name_allowed_chars():
    assert sanitize_name("abc-XYZ_123") == "abc-XYZ_123"


def test_id_of_uses_f5_kb_id():
    r = {"raw": {"f5_kb_id": "K123456"}}
    assert id_of(r) == "K123456"


def test_id_of_fallback_permanentid():
    r = {"raw": {"permanentid": "perm-abc"}}
    assert id_of(r) == "perm-abc"


def test_id_of_fallback_uniqueid():
    r = {"uniqueId": "uid-xyz"}
    assert id_of(r) == "uid-xyz"


def test_id_of_fallback_title():
    r = {"title": "My Article"}
    assert id_of(r) == "My_Article"


def test_id_of_fallback_default():
    assert id_of({}) == "article"


def test_id_of_truncates_120():
    r = {"raw": {"f5_kb_id": "x" * 200}}
    assert len(id_of(r)) == 120


def test_read_write_json(tmp_path):
    data = {"key": "value", "num": 42}
    p = tmp_path / "test.json"
    write_json(p, data)
    assert p.read_text().endswith("\n")  # trailing newline
    result = read_json(p)
    assert result == data


def test_write_json_pretty(tmp_path):
    p = tmp_path / "out.json"
    write_json(p, {"a": 1})
    text = p.read_text()
    assert "\n" in text  # pretty-printed


def test_write_json_creates_parents(tmp_path):
    p = tmp_path / "deep" / "nested" / "out.json"
    write_json(p, {})
    assert p.exists()


def test_walk_article_files(tmp_path):
    (tmp_path / "K001.json").write_text("{}")
    (tmp_path / "K002.json").write_text("{}")
    (tmp_path / "_index.json").write_text("{}")
    (tmp_path / "_catalogue.json").write_text("{}")
    files = sorted(walk_article_files(tmp_path))
    names = [Path(f).name for f in files]
    assert names == ["K001.json", "K002.json"]


def test_list_type_dirs(tmp_path):
    (tmp_path / "Knowledge").mkdir()
    (tmp_path / "Manual").mkdir()
    (tmp_path / "_pending").mkdir()
    (tmp_path / "_replaced").mkdir()
    (tmp_path / "not_a_dir.json").write_text("{}")
    dirs = list_type_dirs(tmp_path)
    assert dirs == ["Knowledge", "Manual"]
    assert "_pending" not in dirs


def test_path_exists(tmp_path):
    p = tmp_path / "exists.txt"
    assert not path_exists(p)
    p.write_text("hi")
    assert path_exists(p)
