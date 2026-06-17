"""Enrichment driver: walks a dump, runs per-type enrichers with a thread pool."""

from __future__ import annotations

import datetime
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock

from f5kb.enrich.enrichers import STALE_KEYS, TYPE_ENRICHERS, has_body
from f5kb.http.fetcher import HttpClient
from f5kb.lib.fsutil import path_exists, read_json, walk_article_files, write_json
from f5kb.lib.logger import NULL_LOGGER, Logger
from f5kb.lib.staging import PendingEntry, merge_pending, pending_dir, pending_path


@dataclass
class TypeReport:
    type_key: str
    files: int = 0
    enriched: int = 0
    failed: int = 0
    skipped: int = 0
    staged: int = 0
    missing_dir: bool = False
    errors: list[dict] = field(default_factory=list)


def enrich_type(
    type_key: str,
    dump: str,
    http: HttpClient,
    *,
    github_token: str | None = None,
    concurrency: int = 4,
    delay_ms: int = 0,
    limit: int | None = None,
    refetch: bool = False,
    refetch_errors: bool = False,
    logger: Logger = NULL_LOGGER,
    sleep=None,
    changelog=None,
    approval: bool = False,
    pending: list[PendingEntry] | None = None,
) -> TypeReport:
    if sleep is None:
        sleep = time.sleep
    log = logger
    report = TypeReport(type_key=type_key)
    enricher = TYPE_ENRICHERS.get(type_key)
    if not enricher:
        log.info(f"  [{type_key}] no enricher implemented — skipping")
        return report

    type_dir = str(Path(dump) / type_key)
    try:
        files = sorted(walk_article_files(type_dir))
    except Exception:
        log.info(f"  [{type_key}] no directory {type_dir} — skipping")
        report.missing_dir = True
        return report

    if limit is not None:
        files = files[:limit]
    report.files = len(files)

    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    done_count = 0
    lock = Lock()

    def _worker(file_path: str):
        nonlocal done_count
        article = read_json(file_path)
        had_error = isinstance((article.get("content") or {}).get("bodyError"), str)
        if not refetch and not (refetch_errors and had_error) and has_body(article.get("content")):
            with lock:
                report.skipped += 1
            return

        had_body_before = has_body(article.get("content"))
        try:
            result = enricher(article, now_iso, http, github_token=github_token)
            with lock:
                report.enriched += 1
        except Exception as e:
            error = str(e)
            result = {"bodySource": article.get("link") or "", "fetchedAt": now_iso, "bodyError": error}
            with lock:
                report.failed += 1
                report.errors.append({"id": article.get("id") or "", "link": article.get("link") or "", "error": error})

        if changelog:
            op = "body-error" if result.get("bodyError") else ("body-changed" if had_body_before else "body-added")
            changelog.record(op, article.get("documentType") or type_key, article.get("id") or "",
                             title=article.get("title"), source="enrich", detail=result.get("bodyError"))

        base = dict(article.get("content") or {})
        for k in STALE_KEYS:
            base.pop(k, None)
        article["content"] = {**base, **result}

        art_id = article.get("id") or ""
        if approval and refetch and had_body_before:
            pp = pending_path(dump, type_key, art_id)
            Path(pp).parent.mkdir(parents=True, exist_ok=True)
            write_json(pp, article)
            if pending is not None:
                with lock:
                    pending.append(PendingEntry(
                        type_key=type_key, id=art_id, title=article.get("title"),
                        op="edited", source="enrich", staged_at=now_iso,
                    ))
            with lock:
                report.staged += 1
        else:
            write_json(file_path, article)

        with lock:
            done_count += 1
            total_done = done_count + report.skipped
            if total_done % 25 == 0:
                log.info(f"  [{type_key}] {total_done}/{report.files} "
                         f"(ok={report.enriched} fail={report.failed} skip={report.skipped})")
            if delay_ms:
                sleep(delay_ms / 1000)

    effective_concurrency = min(concurrency, max(1, len(files)))
    with ThreadPoolExecutor(max_workers=effective_concurrency) as ex:
        futures = [ex.submit(_worker, f) for f in files]
        for fut in as_completed(futures):
            try:
                fut.result()
            except Exception as e:
                log.warn(f"  [{type_key}] worker error: {e}")

    stg = f" staged={report.staged}" if report.staged else ""
    log.info(f"  [{type_key}] DONE: {report.files} files — "
             f"enriched={report.enriched} failed={report.failed} skipped={report.skipped}{stg}")
    return report


def enrich_dump(
    dump: str,
    *,
    types: list[str] | None = None,
    exclude_types: list[str] | None = None,
    http: HttpClient,
    github_token: str | None = None,
    concurrency: int = 4,
    delay_ms: int = 0,
    limit: int | None = None,
    refetch: bool = False,
    refetch_errors: bool = False,
    logger: Logger = NULL_LOGGER,
    sleep=None,
    changelog=None,
    approval: bool = False,
) -> list[TypeReport]:
    log = logger
    requested = types or list(TYPE_ENRICHERS.keys())
    excluded = set(exclude_types or [])
    to_run = [t for t in requested if t not in excluded and TYPE_ENRICHERS.get(t)]
    for t in requested:
        if t not in excluded and not TYPE_ENRICHERS.get(t):
            log.error(f"  [{t}] no enricher implemented — skipping")

    if not to_run:
        raise ValueError("Nothing to do. Implemented types: " + ", ".join(TYPE_ENRICHERS.keys()))

    log.info(f"Enriching bodies in {dump} for: {', '.join(to_run)}")
    log.info(f"(concurrency={concurrency}, delay={delay_ms}ms, refetch={refetch})")
    if "F5_GitHub" in to_run:
        _gh_auth = "token present (5000/hr)" if github_token else "UNAUTHENTICATED (60/hr) — set GITHUB_TOKEN to raise"
        log.info(f"GitHub auth: {_gh_auth}")

    staged: list[PendingEntry] = []
    reports: list[TypeReport] = []
    for t in to_run:
        reports.append(enrich_type(
            t, dump, http,
            github_token=github_token,
            concurrency=concurrency,
            delay_ms=delay_ms,
            limit=limit,
            refetch=refetch,
            refetch_errors=refetch_errors,
            logger=logger,
            sleep=sleep,
            changelog=changelog,
            approval=approval,
            pending=staged,
        ))

    # Also enrich articles in _pending/ (so reviewers see complete new articles)
    pdir = pending_dir(dump)
    if path_exists(pdir):
        for t in to_run:
            r = enrich_type(
                t, pdir, http,
                github_token=github_token,
                concurrency=concurrency,
                delay_ms=delay_ms,
                limit=limit,
                refetch=False,
                refetch_errors=False,
                logger=logger,
                sleep=sleep,
            )
            if not r.missing_dir and (r.enriched or r.failed):
                log.info(f"  [{t}] (_pending) filled {r.enriched} body(ies), {r.failed} failed")

    if staged:
        now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        merge_pending(dump, staged, now_iso)

    report_path = str(Path(dump) / "_enrich_report.json")
    total_failed = sum(r.failed for r in reports)
    try:
        write_json(report_path, {
            "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
            "types": [
                {
                    "typeKey": r.type_key,
                    "files": r.files,
                    "enriched": r.enriched,
                    "failed": r.failed,
                    "skipped": r.skipped,
                    "staged": r.staged,
                    "errors": r.errors,
                }
                for r in reports
            ],
        })
        log.info(f"\nReport: {report_path}")
    except Exception as e:
        log.warn(f"Could not write report: {e}")

    if total_failed:
        failed_parts = ", ".join(f"{r.type_key}={r.failed}" for r in reports if r.failed)
        log.warn(f"\nFAILURES ({total_failed}): {failed_parts} — see {report_path}; "
                 "re-run with --refetch-errors after fixing.")

    log.info("All done.")
    return reports
