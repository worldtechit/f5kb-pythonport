"""Promote (or reject) overwrites staged under _pending/ by the approval gate."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from f5kb.lib.logger import Logger, NULL_LOGGER
from f5kb.lib.fsutil import path_exists, read_json
from f5kb.lib.staging import (
    PendingEntry,
    archive_replaced,
    change_kind,
    compute_risk,
    diff_parts,
    live_path,
    load_pending_manifest,
    now_stamp,
    pending_path,
    save_pending_manifest,
)


@dataclass
class ApproveItem:
    type_key: str
    id: str
    title: str | None
    risk: list[str]
    changed: list[str]
    action: str  # "promoted"|"rejected"|"held-risky"|"missing-pending"|"preview"
    archived: str | None = None


@dataclass
class ApproveResult:
    items: list[ApproveItem]
    promoted: int
    rejected: int
    held_risky: int
    remaining: int


def _matches(entry: dict, opts: dict) -> bool:
    type_keys = opts.get("type_keys")
    exclude = opts.get("exclude_type_keys") or []
    ids = opts.get("ids")
    if type_keys and entry.get("typeKey") not in type_keys:
        return False
    if entry.get("typeKey") in exclude:
        return False
    if ids and entry.get("id") not in ids:
        return False
    return True


def approve(
    dump: str,
    *,
    reject: bool = False,
    type_keys: list[str] | None = None,
    exclude_type_keys: list[str] | None = None,
    ids: list[str] | None = None,
    archive: bool = True,
    include_risky: bool = False,
    dry_run: bool = False,
    changelog=None,
    now_ms: int,
    logger: Logger = NULL_LOGGER,
) -> ApproveResult:
    log = logger
    data = load_pending_manifest(dump)
    stamp = now_stamp(now_ms)
    items: list[ApproveItem] = []
    kept: list[dict] = []
    promoted = rejected = held_risky = 0
    opts = {
        "type_keys": type_keys,
        "exclude_type_keys": exclude_type_keys,
        "ids": ids,
    }

    for e in data.get("entries") or []:
        if not _matches(e, opts):
            kept.append(e)
            continue

        type_key = e.get("typeKey") or ""
        art_id = e.get("id") or ""
        title = e.get("title")
        pp = pending_path(dump, type_key, art_id)
        lp = live_path(dump, type_key, art_id)

        if not path_exists(pp):
            items.append(ApproveItem(type_key, art_id, title, [], [], "missing-pending"))
            continue

        risk: list[str] = []
        changed: list[str] = e.get("changed") or []
        doc_type = type_key
        try:
            pend = read_json(pp)
            doc_type = pend.get("documentType") or type_key
            live = read_json(lp) if path_exists(lp) else None
            risk = compute_risk(live, pend)
            parts = diff_parts(live, pend)
            if parts:
                changed = parts
        except Exception:
            pass

        if dry_run:
            items.append(ApproveItem(type_key, art_id, title, risk, changed, "preview"))
            kept.append(e)
            continue

        if reject:
            try:
                Path(pp).unlink(missing_ok=True)
            except Exception:
                pass
            rejected += 1
            items.append(ApproveItem(type_key, art_id, title, risk, changed, "rejected"))
            continue

        if risk and not include_risky:
            held_risky += 1
            kept.append(e)
            items.append(ApproveItem(type_key, art_id, title, risk, changed, "held-risky"))
            continue

        # Promote: archive live, move pending into place
        archived: str | None = None
        if archive:
            archived = archive_replaced(dump, type_key, art_id, stamp)
        Path(lp).parent.mkdir(parents=True, exist_ok=True)
        Path(pp).rename(lp)
        promoted += 1
        items.append(ApproveItem(type_key, art_id, title, risk, changed, "promoted", archived))

        notes = [change_kind(changed)]
        if archived:
            notes.append("replaced file archived")
        if risk:
            notes.append(f"risk: {','.join(risk)}")
        if changelog:
            changelog.record(
                "edited", doc_type, art_id,
                title=title, changed=changed,
                hashOld=e.get("hashOld"), hashNew=e.get("hashNew"),
                source="approve", detail="; ".join(notes),
            )

    if not dry_run:
        import time as _t
        import datetime
        data["entries"] = kept
        data["generatedAt"] = datetime.datetime.fromtimestamp(
            now_ms / 1000, tz=datetime.timezone.utc
        ).isoformat().replace("+00:00", "Z")
        save_pending_manifest(dump, data)

    log.info(
        f"approve: promoted={promoted} rejected={rejected} "
        f"held-risky={held_risky} remaining={len(kept)}"
    )
    return ApproveResult(items, promoted, rejected, held_risky, len(kept))
