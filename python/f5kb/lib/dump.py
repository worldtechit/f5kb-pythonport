"""Dump orchestration: fetch types via Coveo, write articles + catalogue + _index."""

from __future__ import annotations

import datetime
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from f5kb.lib.logger import Logger, NULL_LOGGER
from f5kb.lib.fsutil import id_of, sanitize_name, write_json
from f5kb.lib.progress import make_progress
from f5kb.lib.staging import (
    PendingEntry,
    archive_replaced,
    live_article,
    now_stamp,
    pending_path,
)
from f5kb.config.types import TypeConfig, normalize_type
from f5kb.coveo.client import CoveoClient
from f5kb.coveo.dates import date_aq, mod_ms_of
from f5kb.coveo.paging import fetch_type_since
from f5kb.coveo.fields import (
    CatalogueEntry,
    flatten_fields_safe,
    split_entry,
    update_catalogue,
    write_catalogue,
)
from f5kb.track.hashing import sha256_obj


def db_key(document_type: str, id: str) -> str:
    """Exact match for load_hash_index key format: '<document_type> <id>'."""
    return f"{document_type} {id}"


@dataclass
class TypeStatus:
    type_key: str
    document_type: str
    dir: str
    status: str  # "ok"|"partial"|"failed"
    expected: int | None
    fetched: int
    written: int
    skipped: int
    staged: int
    replaced: int
    write_errors: int
    error: str | None = None


@dataclass
class DumpTypesResult:
    manifest: list[TypeStatus]
    index_path: str
    total: int
    current_ids: dict[str, set[str]]  # typeKey -> set of ids in Coveo this run
    pending: list[PendingEntry]


def dump_types(
    client: CoveoClient,
    *,
    type_configs: dict[str, dict],
    type_keys: list[str],
    descriptions: dict[str, str],
    out_dir: str,
    all_time: bool,
    mode: str,
    cutoff_ms: int,
    end_ms: int,
    now_ms: int,
    page_size: int,
    limit: int,
    config_path: str,
    logger: Logger = NULL_LOGGER,
    incremental: bool = False,
    prior_hashes: dict[str, str] | None = None,
    changelog=None,
    dry_run: bool = False,
    approval: bool = False,
    archive_on_overwrite: bool = False,
) -> DumpTypesResult:
    log = logger
    if not dry_run:
        Path(out_dir).mkdir(parents=True, exist_ok=True)

    manifest: list[TypeStatus] = []
    current_ids: dict[str, set[str]] = {}
    pending: list[PendingEntry] = []
    stamp = now_stamp(now_ms)
    captured_iso = datetime.datetime.fromtimestamp(now_ms / 1000, tz=datetime.timezone.utc).isoformat().replace("+00:00", "Z")

    for type_key in type_keys:
        raw_cfg = type_configs.get(type_key) or {}
        cfg = normalize_type({
            "documentType": raw_cfg.get("documentType"),
            "metadata": raw_cfg.get("metadata"),
            "content": raw_cfg.get("content"),
        })
        dir_name = sanitize_name(type_key)
        if not cfg.document_type:
            log.warn(f'Skipping "{type_key}": no documentType in config')
            manifest.append(TypeStatus(
                type_key=type_key, document_type="", dir=dir_name, status="failed",
                expected=None, fetched=0, written=0, skipped=0, staged=0, replaced=0,
                write_errors=0, error="no documentType in config",
            ))
            continue

        st = TypeStatus(
            type_key=type_key, document_type=cfg.document_type, dir=dir_name,
            status="ok", expected=None, fetched=0, written=0, skipped=0,
            staged=0, replaced=0, write_errors=0,
        )
        id_set: set[str] = set()
        current_ids[type_key] = id_set
        progress = make_progress(log)

        try:
            expect_aq = (
                f'@f5_document_type=="{cfg.document_type}"'
                if all_time
                else f'@f5_document_type=="{cfg.document_type}" {date_aq(cutoff_ms, end_ms)}'.strip()
            )
            st.expected = client.get_count(expect_aq)
            progress.start(type_key, st.expected)

            results = fetch_type_since(
                client, cfg.document_type, cutoff_ms, end_ms, page_size, limit,
                progress_cb=lambda n: progress.update(n),
                use_date_window=not all_time,
            )
            st.fetched = len(results)

            type_dir = str(Path(out_dir) / dir_name)
            if not dry_run:
                Path(type_dir).mkdir(parents=True, exist_ok=True)

            catalogue: dict[str, CatalogueEntry] = {}
            seen_ids: dict[str, int] = {}

            for r in results:
                fields = flatten_fields_safe(r)
                update_catalogue(catalogue, fields, descriptions)

                metadata, content = split_entry(fields, cfg)
                raw = r.get("raw") or {}
                art_id = id_of(r)

                n = seen_ids.get(art_id, 0) + 1
                seen_ids[art_id] = n
                if n > 1:
                    art_id = f"{art_id}__{n}"

                id_set.add(art_id)

                mod_ms = mod_ms_of(raw)
                title = r.get("title") or ""
                entry = {
                    "id": art_id,
                    "documentType": cfg.document_type,
                    "title": title,
                    "link": r.get("clickUri") or raw.get("clickableuri") or "",
                    "modifiedMs": mod_ms,
                    "modified": datetime.datetime.fromtimestamp(mod_ms / 1000, tz=datetime.timezone.utc).isoformat().replace("+00:00", "Z") if mod_ms else None,
                    "capturedAt": captured_iso,
                    "metadata": metadata,
                    "content": content,
                }

                gated = approval or archive_on_overwrite
                classify = incremental or changelog or gated
                unchanged = False
                is_edited = False
                is_new = False
                mh: str | None = None
                prior: str | None = None

                if classify:
                    mh = sha256_obj(metadata)
                    prior = (prior_hashes or {}).get(db_key(cfg.document_type, art_id))
                    if prior is None and gated:
                        lf = live_article(out_dir, dir_name, art_id)
                        if lf:
                            prior = sha256_obj(lf.get("metadata") or {})
                    unchanged = prior is not None and prior == mh
                    is_edited = prior is not None and prior != mh
                    is_new = prior is None

                if unchanged and (incremental or gated):
                    st.skipped += 1
                    continue

                if is_new and changelog:
                    changelog.record("added", cfg.document_type, art_id, title=title, hashNew=mh, source="dump")

                if is_edited and approval:
                    if not dry_run:
                        pp = pending_path(out_dir, dir_name, art_id)
                        Path(pp).parent.mkdir(parents=True, exist_ok=True)
                        Path(pp).write_text(json.dumps(entry, indent=2))
                    st.staged += 1
                    pending.append(PendingEntry(
                        type_key=dir_name, id=art_id, title=title,
                        op="edited", changed=["metadata"], source="dump",
                        hash_old=prior, hash_new=mh, staged_at=captured_iso,
                    ))
                    continue

                if is_edited:
                    if changelog:
                        changelog.record("edited", cfg.document_type, art_id, title=title, hashOld=prior, hashNew=mh, source="dump")
                    if archive_on_overwrite and not dry_run:
                        arch = archive_replaced(out_dir, dir_name, art_id, stamp)
                        if arch:
                            st.replaced += 1

                try:
                    if not dry_run:
                        Path(type_dir, f"{art_id}.json").write_text(json.dumps(entry, indent=2))
                    st.written += 1
                except Exception as e:
                    st.write_errors += 1
                    if st.write_errors <= 3:
                        log.warn(f"write failed for {art_id}: {e}")

            if not dry_run:
                write_catalogue(type_dir, type_key, cfg.document_type, catalogue, len(results), cfg)

            present = st.written + st.skipped + st.staged
            undercount = all_time and st.expected is not None and limit == 0 and present < st.expected
            if st.write_errors > 0 or undercount:
                st.status = "partial"

            exp = f"/{st.expected}" if st.expected is not None else ""
            skip = f" ({st.skipped} unchanged)" if st.skipped else ""
            stg = f" ({st.staged} staged for approval)" if st.staged else ""
            flag = f"  [{st.status.upper()}]" if st.status != "ok" else ""
            progress.done(f"{st.written}{exp} written{skip}{stg} article{'s' if st.written != 1 else ''} -> {type_dir}/{flag}")

        except Exception as e:
            st.status = "failed"
            st.error = str(e)
            progress.done(f"FAILED: {st.error}")

        manifest.append(st)

    total = sum(m.written for m in manifest)
    index_path = str(Path(out_dir) / "_index.json")
    if not dry_run:
        Path(index_path).write_text(json.dumps({
            "mode": mode,
            "cutoff": datetime.datetime.fromtimestamp(cutoff_ms / 1000, tz=datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
            "generatedAt": datetime.datetime.fromtimestamp(now_ms / 1000, tz=datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
            "config": config_path,
            "totalArticles": total,
            "counts": {
                "types": len(manifest),
                "ok": sum(1 for m in manifest if m.status == "ok"),
                "partial": sum(1 for m in manifest if m.status == "partial"),
                "failed": sum(1 for m in manifest if m.status == "failed"),
            },
            "types": [
                {
                    "typeKey": m.type_key,
                    "documentType": m.document_type,
                    "dir": m.dir,
                    "status": m.status,
                    "expected": m.expected,
                    "fetched": m.fetched,
                    "written": m.written,
                    "skipped": m.skipped,
                    "staged": m.staged,
                    "replaced": m.replaced,
                    "writeErrors": m.write_errors,
                    **({"error": m.error} if m.error else {}),
                }
                for m in manifest
            ],
        }, indent=2))

    return DumpTypesResult(manifest=manifest, index_path=index_path, total=total, current_ids=current_ids, pending=pending)
