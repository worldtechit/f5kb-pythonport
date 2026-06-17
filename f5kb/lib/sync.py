"""Incremental sync orchestrator: dump → enrich → track → detect deletions."""

from __future__ import annotations

import datetime
from dataclasses import dataclass, field

from f5kb.lib.logger import Logger, NULL_LOGGER
from f5kb.lib.changelog import Changelog
from f5kb.lib.staging import merge_pending
from f5kb.lib.dump import dump_types
from f5kb.enrich.driver import enrich_dump
from f5kb.track.db import load_hash_index, load_ids_by_type, track_dump
from f5kb.coveo.client import CoveoClient
from f5kb.http.fetcher import HttpClient
from f5kb.config.types import TypeConfig

ENRICHABLE = {"Bug_Tracker", "Manual", "Release_Note", "Supplemental_Document", "F5_GitHub"}


@dataclass
class SyncResult:
    run_id: str
    mode: str
    dry_run: bool
    written: int
    skipped: int
    added: int
    edited: int
    body_added: int
    body_changed: int
    body_error: int
    staged: int
    deletions_detected: int
    deletions: dict[str, list[str]]
    deletion_detection_ran: bool
    changelog_path: str | None


def sync_dump(
    *,
    client: CoveoClient,
    http: HttpClient,
    type_configs: dict[str, dict],
    type_keys: list[str],
    descriptions: dict[str, str],
    out_dir: str,
    db: str | None = None,
    mode: str,
    all_time: bool,
    cutoff_ms: int,
    end_ms: int,
    now_ms: int,
    page_size: int,
    limit: int,
    config_path: str,
    enrich: bool = True,
    github_token: str | None = None,
    concurrency: int = 4,
    delay_ms: int = 0,
    changelog_path: str | None = None,
    dry_run: bool = False,
    approval: bool = True,
    archive_on_overwrite: bool = False,
    logger: Logger = NULL_LOGGER,
) -> SyncResult:
    log = logger
    run_id = datetime.datetime.fromtimestamp(now_ms / 1000, tz=datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    db_path = db or str(__import__("pathlib").Path(out_dir.rstrip("/")).parent / "articles.db")
    cl = Changelog(None if dry_run else changelog_path, run_id)

    prior_hashes = load_hash_index(db_path)
    log.info(f"Loaded {len(prior_hashes)} prior hash(es) from {db_path}")

    dump_result = dump_types(
        client,
        type_configs=type_configs,
        type_keys=type_keys,
        descriptions=descriptions,
        out_dir=out_dir,
        all_time=all_time,
        mode=mode,
        cutoff_ms=cutoff_ms,
        end_ms=end_ms,
        now_ms=now_ms,
        page_size=page_size,
        limit=limit,
        config_path=config_path,
        logger=log,
        incremental=True,
        prior_hashes=prior_hashes,
        changelog=cl,
        dry_run=dry_run,
        approval=approval,
        archive_on_overwrite=archive_on_overwrite,
    )

    if enrich and not dry_run:
        enrich_types = [t for t in type_keys if t in ENRICHABLE]
        if enrich_types:
            enrich_dump(
                out_dir,
                types=enrich_types,
                http=http,
                github_token=github_token,
                concurrency=concurrency,
                delay_ms=delay_ms,
                limit=None,
                refetch=False,
                refetch_errors=False,
                logger=log.child("enrich"),
                changelog=cl,
            )

    if approval and not dry_run and dump_result.pending:
        merge_pending(out_dir, dump_result.pending, run_id)
        log.warn(
            f"{len(dump_result.pending)} edited article(s) STAGED for review (not applied). "
            f"Inspect {out_dir}/_pending/ then run: f5kb approve"
        )

    if not dry_run:
        track_dump(out_dir, db_path=db_path, types=type_keys, run_id=run_id, logger=log)

    deletions: dict[str, list[str]] = {}
    deletions_detected = 0
    deletion_detection_ran = all_time
    if deletion_detection_ran:
        doc_types: dict[str, str] = {}
        for k in type_keys:
            dt = (type_configs.get(k) or {}).get("documentType")
            if dt:
                doc_types[k] = dt
        db_ids = load_ids_by_type(db_path, list(doc_types.values()))
        for type_key, document_type in doc_types.items():
            cur = dump_result.current_ids.get(type_key) or set()
            gone = [i for i in (db_ids.get(document_type) or []) if i not in cur]
            if gone:
                deletions[type_key] = gone
                deletions_detected += len(gone)
                for art_id in gone:
                    cl.record("deleted", document_type, art_id, source="sync",
                               detail="detected upstream (not removed; run `reconcile --apply` to remove)")
        if deletions_detected:
            log.warn(f"{deletions_detected} upstream deletion(s) detected (reported, NOT removed). Run: f5kb reconcile --apply  to remove them.")

    cl.flush()
    by = cl.by_op()

    return SyncResult(
        run_id=run_id,
        mode=mode,
        dry_run=dry_run,
        written=sum(m.written for m in dump_result.manifest),
        skipped=sum(m.skipped for m in dump_result.manifest),
        added=by.get("added", 0),
        edited=by.get("edited", 0),
        body_added=by.get("body-added", 0),
        body_changed=by.get("body-changed", 0),
        body_error=by.get("body-error", 0),
        staged=sum(m.staged for m in dump_result.manifest),
        deletions_detected=deletions_detected,
        deletions=deletions,
        deletion_detection_ran=deletion_detection_ran,
        changelog_path=None if dry_run else changelog_path,
    )
