"""Deletion reconcile: diff DB ids against live Coveo; optionally remove."""

from __future__ import annotations

import re
import shutil
import time
from dataclasses import dataclass
from pathlib import Path

from f5kb.coveo.client import CoveoClient
from f5kb.coveo.paging import fetch_ids
from f5kb.lib.fsutil import id_of, path_exists
from f5kb.lib.logger import NULL_LOGGER, Logger
from f5kb.track.db import delete_rows, load_ids_by_type


@dataclass
class ReconcileTypeResult:
    type_key: str
    document_type: str
    db_count: int
    live_count: int
    deletions: list[str]


@dataclass
class ReconcileResult:
    per_type: list[ReconcileTypeResult]
    total_deletions: int
    total_db: int
    applied: bool
    aborted: str | None = None
    backup_path: str | None = None


def _base_id(id: str) -> str:
    return re.sub(r"__\d+$", "", id)


def _now_stamp() -> str:
    return time.strftime("%Y-%m-%dT%H-%M-%SZ", time.gmtime())


def reconcile(
    client: CoveoClient,
    *,
    dump: str,
    db: str | None = None,
    type_configs: dict[str, dict],
    type_keys: list[str],
    apply: bool = False,
    purge: bool = False,
    max_delete_pct: float = 0.25,
    max_deletes: int | None = None,
    changelog=None,
    logger: Logger = NULL_LOGGER,
    page_size: int = 2000,
) -> ReconcileResult:
    log = logger
    db_path = db or str(Path(dump.rstrip("/")).parent / "articles.db")

    doc_types: dict[str, str] = {}
    for k in type_keys:
        dt = (type_configs.get(k) or {}).get("documentType")
        if dt:
            doc_types[k] = dt
        else:
            log.warn(f'reconcile: "{k}" has no documentType in config — skipping')

    db_ids = load_ids_by_type(db_path, list(doc_types.values()))
    per_type: list[ReconcileTypeResult] = []

    for type_key, document_type in doc_types.items():
        live_results = fetch_ids(client, document_type, page_size)
        live = {id_of(r) for r in live_results}
        db_list = db_ids.get(document_type) or []
        deletions = [i for i in db_list if _base_id(i) not in live]
        per_type.append(ReconcileTypeResult(
            type_key=type_key, document_type=document_type,
            db_count=len(db_list), live_count=len(live), deletions=deletions,
        ))
        log.info(f"  [{type_key}] db={len(db_list)} live={len(live)} -> {len(deletions)} deletion(s)")

    total_deletions = sum(len(t.deletions) for t in per_type)
    total_db = sum(t.db_count for t in per_type)
    result = ReconcileResult(per_type=per_type, total_deletions=total_deletions, total_db=total_db, applied=False)

    if not apply or total_deletions == 0:
        if total_deletions and not apply:
            log.info(f"Report only: {total_deletions} deletion(s) detected. Re-run with --apply to remove.")
        return result

    for t in per_type:
        if t.db_count > 0 and len(t.deletions) / t.db_count > max_delete_pct:
            got = f"{(len(t.deletions) / t.db_count * 100):.1f}%"
            result.aborted = (
                f"[{t.type_key}] {len(t.deletions)}/{t.db_count} ({got}) "
                f"exceeds --max-delete-pct={(max_delete_pct * 100):.0f}% — "
                f"aborting (no changes made). Override with a higher --max-delete-pct if this is real."
            )
            log.error(result.aborted)
            return result

    if max_deletes is not None and total_deletions > max_deletes:
        result.aborted = f"{total_deletions} deletions exceed --max-deletes={max_deletes} — aborting (no changes made)."
        log.error(result.aborted)
        return result

    if path_exists(db_path):
        backup = f"{db_path}.bak-{_now_stamp()}"
        shutil.copy2(db_path, backup)
        result.backup_path = backup
        log.info(f"Backed up DB -> {backup}")

    removed_rows: list[dict[str, str]] = []
    for t in per_type:
        if not t.deletions:
            continue
        src_dir = Path(dump) / t.type_key
        archive_dir = Path(dump) / "_deleted" / t.type_key
        if not purge:
            archive_dir.mkdir(parents=True, exist_ok=True)
        for art_id in t.deletions:
            src = src_dir / f"{art_id}.json"
            try:
                if purge:
                    src.unlink(missing_ok=True)
                else:
                    src.rename(archive_dir / f"{art_id}.json")
            except Exception:
                pass
            removed_rows.append({"documentType": t.document_type, "id": art_id})
            if changelog:
                changelog.record("deleted", t.document_type, art_id, source="reconcile",
                                 detail="purged" if purge else f"archived to _deleted/{t.type_key}/")

    dropped = delete_rows(db_path, removed_rows)
    result.applied = True
    action = "purged" if purge else "archived"
    log.info(f"Applied: {len(removed_rows)} file(s) {action}, {dropped} DB row(s) removed.")
    return result
