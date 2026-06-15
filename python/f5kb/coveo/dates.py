"""Date helpers for Coveo API queries."""

from __future__ import annotations

import datetime

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def to_coveo_date(ms: int) -> str:
    """Format ms epoch as YYYY/MM/DD@HH:MM:SS (UTC)."""
    d = datetime.datetime.fromtimestamp(ms / 1000, tz=datetime.timezone.utc)
    return f"{d.year}/{d.month:02d}/{d.day:02d}@{d.hour:02d}:{d.minute:02d}:{d.second:02d}"


def date_aq(start_ms: int | None = None, end_ms: int | None = None) -> str:
    """Build @date AQ fragment: '@date>=START @date<END' (either bound optional)."""
    parts = []
    if start_ms is not None:
        parts.append(f"@date>={to_coveo_date(start_ms)}")
    if end_ms is not None:
        parts.append(f"@date<{to_coveo_date(end_ms)}")
    return " ".join(parts)


def mod_ms_of(raw: dict | None) -> int | None:
    """Most specific modification timestamp (ms) from a Coveo raw bag."""
    if not raw:
        return None
    return (
        raw.get("f5_updated_published_date")
        or raw.get("sflastmodifieddate")
        or raw.get("date")
    )


def format_date(ms: int | None) -> str:
    """ms epoch -> 'MMM D, YYYY' (UTC)."""
    if ms is None:
        return ""
    d = datetime.datetime.fromtimestamp(ms / 1000, tz=datetime.timezone.utc)
    return f"{MONTHS[d.month - 1]} {d.day}, {d.year}"
