"""Tests for http/github.py."""

import pytest

from f5kb.http.github import GhTarget, parse_github_url


def test_parse_github_url_issue():
    t = parse_github_url("https://github.com/F5Networks/f5-ansible/issues/123")
    assert t.kind == "issue"
    assert t.api_path == "/repos/F5Networks/f5-ansible/issues/123"


def test_parse_github_url_pull():
    t = parse_github_url("https://github.com/F5Networks/f5-ansible/pull/456")
    assert t.kind == "pull"
    assert t.api_path == "/repos/F5Networks/f5-ansible/pulls/456"


def test_parse_github_url_blob_file():
    t = parse_github_url("https://github.com/F5Networks/k8s-bigip-ctlr/blob/master/README.md")
    assert t.kind == "file"
    assert t.raw_url is not None
    assert "raw.githubusercontent.com" in t.raw_url
    assert "README.md" in t.raw_url


def test_parse_github_url_readme():
    t = parse_github_url("https://github.com/F5Networks/f5-ansible")
    assert t.kind == "readme"
    assert t.api_path == "/repos/F5Networks/f5-ansible/readme"


def test_parse_github_url_invalid():
    with pytest.raises(ValueError):
        parse_github_url("https://github.com/only-one-part")


def test_parse_github_url_unsupported_shape():
    with pytest.raises(ValueError, match="unsupported"):
        parse_github_url("https://github.com/F5Networks/repo/tree/main")
