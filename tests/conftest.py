"""Shared pytest fixtures and helpers."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

FIXTURES_DIR = Path(__file__).parent / "fixtures"


def fixture_path(rel: str) -> Path:
    return FIXTURES_DIR / rel


def load_fixture(rel: str) -> str:
    return (FIXTURES_DIR / rel).read_text(encoding="utf-8")


def load_json_fixture(rel: str) -> object:
    return json.loads(load_fixture(rel))


@pytest.fixture
def noop_sleep():
    return lambda _: None
