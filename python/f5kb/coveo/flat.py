"""Flat-article helpers for the fetch and recent subcommands."""

from __future__ import annotations

import datetime
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from f5kb.coveo.client import CoveoClient, CoveoResult

COVEO_MAX_OFFSET = 5000

FLAT_FIELDS_TO_INCLUDE = [
    "clickableuri",
    "f5_original_published_date",
    "f5_updated_published_date",
    "sffirstpublisheddate",
    "sflastmodifieddate",
    "date",
]


@dataclass
class FlatArticle:
    name: str
    link: str
    summary: str
    publication_date: str
    modification_date: str
    mod_ms: int | None = field(default=None)


def _to_coveo_date(ms: int) -> str:
    d = datetime.datetime.fromtimestamp(ms / 1000, tz=datetime.timezone.utc)
    return f"{d.year}/{d.month:02d}/{d.day:02d}@{d.hour:02d}:{d.minute:02d}:{d.second:02d}"


def _format_date(ms: int | None) -> str:
    if not ms:
        return ""
    # "en-US" locale short date matching original JS toLocaleDateString behavior
    d = datetime.datetime.fromtimestamp(ms / 1000, tz=datetime.timezone.utc)
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
               "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    return f"{months[d.month - 1]} {d.day}, {d.year}"


def _mod_ms_of(raw: dict | None) -> int | None:
    if not raw:
        return None
    return raw.get("f5_updated_published_date") or raw.get("sflastmodifieddate") or raw.get("date")


def build_aq(
    product: str | None = None,
    type_: str | None = None,
    date_start_ms: int | None = None,
    date_end_ms: int | None = None,
) -> str:
    parts = []
    if type_:
        parts.append(f'@f5_document_type=="{type_}"')
    if product:
        parts.append(f'@f5_version=="{product}"')
    if date_start_ms is not None:
        parts.append(f"@date>={_to_coveo_date(date_start_ms)}")
    if date_end_ms is not None:
        parts.append(f"@date<{_to_coveo_date(date_end_ms)}")
    return " ".join(parts)


def parse_result(r: CoveoResult) -> FlatArticle:
    raw = r.get("raw") or {}
    mod_ms = _mod_ms_of(raw)
    return FlatArticle(
        name=r.get("title") or "",
        link=r.get("clickUri") or raw.get("clickableuri") or "",
        summary=r.get("excerpt") or "",
        publication_date=_format_date(
            raw.get("f5_original_published_date") or raw.get("sffirstpublisheddate")
        ),
        modification_date=_format_date(mod_ms),
        mod_ms=mod_ms,
    )


def to_csv(articles: list[FlatArticle]) -> str:
    def esc(s: str) -> str:
        return '"' + s.replace('"', '""').replace("\n", " ") + '"'

    header = "Name,Link,Summary,Publication Date,Modification Date"
    rows = [
        ",".join(esc(x) for x in [
            a.name, a.link, a.summary, a.publication_date, a.modification_date
        ])
        for a in articles
    ]
    return "\n".join([header] + rows)


def fetch_flat_paged(
    client: CoveoClient,
    aq: str,
    page_size: int,
    max_results: int,
    on_progress: Callable[[int], None] | None = None,
    pause_ms: int = 150,
) -> list[FlatArticle]:
    articles: list[FlatArticle] = []
    first_result = 0
    while len(articles) < max_results:
        to_fetch = min(page_size, max_results - len(articles), COVEO_MAX_OFFSET - first_result)
        if to_fetch <= 0:
            break
        data = client.post({
            "q": "",
            "aq": aq or None,
            "numberOfResults": to_fetch,
            "firstResult": first_result,
            "searchHub": "myF5",
            "sortCriteria": "date descending",
            "fieldsToInclude": FLAT_FIELDS_TO_INCLUDE,
        })
        batch = [parse_result(r) for r in (data.get("results") or [])]
        articles.extend(batch)
        first_result += len(batch)
        if on_progress:
            on_progress(len(articles))
        if len(batch) < to_fetch:
            break
        if first_result >= COVEO_MAX_OFFSET:
            break
        time.sleep(pause_ms / 1000)
    return articles


def fetch_flat_chunked(
    client: CoveoClient,
    base_aq: str,
    start_ms: int,
    end_ms: int,
    page_size: int,
    max_results: int,
    on_progress: Callable[[int], None],
    collected: list[FlatArticle],
    pause_ms: int = 150,
    depth: int = 0,
) -> None:
    if len(collected) >= max_results:
        return
    window_aq = build_aq(date_start_ms=start_ms, date_end_ms=end_ms)
    aq = f"{base_aq} {window_aq}".strip() if window_aq else base_aq
    total = client.get_count(aq)
    if total == 0:
        return

    if total <= COVEO_MAX_OFFSET or depth >= 25:
        remaining = max_results - len(collected)
        batch = fetch_flat_paged(
            client, aq, page_size, min(total, remaining),
            lambda n: on_progress(len(collected) + n),
            pause_ms,
        )
        collected.extend(batch)
        return

    mid_ms = (start_ms + end_ms) // 2
    if mid_ms == start_ms:
        batch = fetch_flat_paged(
            client, aq, page_size, max_results - len(collected), None, pause_ms
        )
        collected.extend(batch)
        return

    fetch_flat_chunked(client, base_aq, start_ms, mid_ms, page_size, max_results, on_progress, collected, pause_ms, depth + 1)
    fetch_flat_chunked(client, base_aq, mid_ms, end_ms, page_size, max_results, on_progress, collected, pause_ms, depth + 1)
