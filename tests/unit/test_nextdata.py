"""Tests for html/nextdata.py."""

import json
from pathlib import Path

import pytest

from f5kb.html.nextdata import (
    extract_next_data_body,
    mdx_from_compiled_source,
    parse_next_data,
    swagger_to_markdown,
)


def _load(name: str) -> str:
    p = Path(__file__).parent.parent / "fixtures" / "pages" / name
    if not p.exists():
        pytest.skip(f"fixture {name} not present")
    return p.read_text(encoding="utf-8")


def test_parse_next_data_found():
    data = {"props": {"pageProps": {}}}
    html = f'<script id="__NEXT_DATA__" type="application/json">{json.dumps(data)}</script>'
    result = parse_next_data(html)
    assert result is not None
    assert "props" in result


def test_parse_next_data_not_found():
    assert parse_next_data("<html><body>no next data</body></html>") is None


def test_parse_next_data_invalid_json():
    html = '<script id="__NEXT_DATA__" type="application/json">{invalid}</script>'
    assert parse_next_data(html) is None


def test_mdx_from_compiled_source():
    source = "/* Hello world */\nsome js\n/* Second block */"
    result = mdx_from_compiled_source(source)
    assert "Hello world" in result
    assert "Second block" in result
    assert "some js" not in result


def test_mdx_filters_import_export():
    source = "/* import React from 'react' */\n/* Real content */"
    result = mdx_from_compiled_source(source)
    assert "import" not in result
    assert "Real content" in result


def test_swagger_to_markdown():
    sw = {
        "info": {"title": "My API", "description": "An API"},
        "paths": {
            "/users": {
                "get": {"summary": "List users", "description": "Returns all users"}
            }
        }
    }
    result = swagger_to_markdown(sw)
    assert "My API" in result
    assert "GET /users" in result
    assert "List users" in result


def test_extract_next_data_body_prose():
    html = _load("docs_cloud_next_content.html")
    result = extract_next_data_body(html)
    assert isinstance(result, str)


def test_extract_next_data_body_api():
    html = _load("docs_cloud_next_api.html")
    result = extract_next_data_body(html)
    assert isinstance(result, str)


def test_extract_next_data_body_empty():
    assert extract_next_data_body("<html><body>nothing</body></html>") == ""
