"""Read-only status report for a dump + its tracking DB."""

from __future__ import annotations

import re
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from f5kb.lib.fsutil import list_type_dirs, path_exists, read_json
from f5kb.lib.changelog import CHANGELOG_BASENAME
from f5kb.lib.staging import load_pending_manifest

STALE_MS = 7 * 24 * 60 * 60 * 1000  # 1 week


@dataclass
class TypeStatus:
    type_key: str
    disk_count: int
    expected: int | None
    written: int | None
    status: str | None
    bodied: int | None
    errors: int | None


@dataclass
class ErrorClass:
    klass: str
    count: int


@dataclass
class LastRun:
    run_id: str
    ran_at: str | None
    dump_dir: str | None
    scanned: int | None
    new: int | None
    changed: int | None
    unchanged: int | None
    removed: int | None


@dataclass
class StatusReport:
    dump: str
    db: str
    db_present: bool
    per_type: list[TypeStatus]
    overall: dict  # totalArticles, bodied, health, lastRun, ...
    error_classes: list[ErrorClass]
    notes: list[str]


def classify_error(msg: str) -> str:
    m = msg.lower()
    if "404" in m or "not found" in m:
        return "not-found"
    if any(x in m for x in ("403", "forbidden", "401", "unauthor")):
        return "forbidden"
    if "timeout" in m or "timed out" in m:
        return "timeout"
    if "429" in m or "rate" in m:
        return "rate-limited"
    if re.search(r"\b5\d\d\b", m) or "server error" in m:
        return "server-error"
    if any(x in m for x in ("parse", "no body", "empty", "extract")):
        return "parse/empty"
    if any(x in m for x in ("network", "fetch", "connection")):
        return "network"
    return "other"


def _count_disk_json(type_dir: str) -> int:
    n = 0
    try:
        for p in Path(type_dir).iterdir():
            if p.is_file() and p.suffix == ".json" and not p.name.startswith("_"):
                n += 1
    except Exception:
        pass
    return n


def compute_status(dump: str, db: str | None = None) -> StatusReport:
    dump = dump.rstrip("/")
    db_path = db or str(Path(dump).parent / "articles.db")
    notes: list[str] = []

    # _index.json
    index_by_type: dict[str, dict] = {}
    index_path = str(Path(dump) / "_index.json")
    if path_exists(index_path):
        try:
            idx = read_json(index_path)
            for t in idx.get("types") or []:
                key = t.get("typeKey") or t.get("dir")
                if key:
                    index_by_type[key] = t
        except Exception as e:
            notes.append(f"could not parse _index.json: {e}")
    else:
        notes.append("_index.json missing")

    # _enrich_report.json
    enrich_by_type: dict[str, dict] = {}
    enrich_path = str(Path(dump) / "_enrich_report.json")
    if path_exists(enrich_path):
        try:
            er = read_json(enrich_path)
            for t in er.get("types") or []:
                if t.get("typeKey"):
                    enrich_by_type[t["typeKey"]] = t
        except Exception as e:
            notes.append(f"could not parse _enrich_report.json: {e}")
    else:
        notes.append("_enrich_report.json missing")

    # disk type dirs
    type_keys: list[str] = []
    try:
        type_keys = list_type_dirs(dump)
    except Exception:
        notes.append(f"dump dir {dump} not readable")
    for k in index_by_type:
        if k not in type_keys:
            type_keys.append(k)
    type_keys.sort()

    per_type: list[TypeStatus] = []
    for type_key in type_keys:
        disk_count = _count_disk_json(str(Path(dump) / type_key))
        idx = index_by_type.get(type_key)
        enr = enrich_by_type.get(type_key)
        present_from_index = ((idx.get("written") or 0) + (idx.get("skipped") or 0)) if idx else None
        per_type.append(TypeStatus(
            type_key=type_key,
            disk_count=disk_count,
            expected=idx.get("expected") if idx else None,
            written=present_from_index,
            status=idx.get("status") if idx else None,
            bodied=enr.get("enriched") if enr else None,
            errors=enr.get("failed") if enr else None,
        ))

    # DB
    total_articles: int | None = None
    bodied: int | None = None
    last_run: LastRun | None = None
    newest_captured_at: str | None = None
    error_classes: list[ErrorClass] = []
    db_by_type: dict[str, dict] = {}
    db_present = path_exists(db_path)
    if db_present:
        try:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            total_articles = conn.execute("SELECT COUNT(*) AS c FROM articles").fetchone()["c"]
            bodied = conn.execute("SELECT COUNT(*) AS c FROM articles WHERE has_body=1").fetchone()["c"]

            err_rows = conn.execute(
                "SELECT body_error FROM articles WHERE body_error IS NOT NULL AND body_error != ''"
            ).fetchall()
            tally: dict[str, int] = {}
            for r in err_rows:
                k = classify_error(str(r["body_error"]))
                tally[k] = tally.get(k, 0) + 1
            error_classes = [ErrorClass(klass=k, count=c) for k, c in sorted(tally.items(), key=lambda x: -x[1])]

            run_row = conn.execute("SELECT * FROM runs ORDER BY ran_at DESC LIMIT 1").fetchone()
            if run_row:
                last_run = LastRun(
                    run_id=run_row["run_id"],
                    ran_at=run_row["ran_at"],
                    dump_dir=run_row["dump_dir"],
                    scanned=run_row["scanned"],
                    new=run_row["new"],
                    changed=run_row["changed"],
                    unchanged=run_row["unchanged"],
                    removed=run_row["removed"],
                )

            cap_row = conn.execute("SELECT MAX(captured_at) AS m FROM articles").fetchone()
            newest_captured_at = cap_row["m"] if cap_row else None

            grp_rows = conn.execute(
                "SELECT document_type AS dt, "
                "SUM(CASE WHEN has_body=1 THEN 1 ELSE 0 END) AS bodied, "
                "SUM(CASE WHEN body_error IS NOT NULL AND body_error != '' THEN 1 ELSE 0 END) AS errors "
                "FROM articles GROUP BY document_type"
            ).fetchall()
            for r in grp_rows:
                db_by_type[str(r["dt"])] = {"bodied": int(r["bodied"]), "errors": int(r["errors"])}

            conn.close()
        except Exception as e:
            notes.append(f"could not read DB {db_path}: {e}")
    else:
        notes.append(f"DB {db_path} missing")

    for t in per_type:
        d = db_by_type.get(t.type_key.replace("_", " "))
        if d:
            t.bodied = d["bodied"]
            t.errors = d["errors"]

    # changelog
    changelog_path_val: str | None = None
    changelog_last_run: dict[str, int] | None = None
    cl_path = str(Path(dump) / CHANGELOG_BASENAME)
    if path_exists(cl_path):
        changelog_path_val = cl_path
        if last_run:
            try:
                tally2: dict[str, int] = {}
                with open(cl_path, encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            rec = __import__("json").loads(line)
                        except Exception:
                            continue
                        if rec.get("runId") == last_run.run_id and rec.get("op"):
                            op = rec["op"]
                            tally2[op] = tally2.get(op, 0) + 1
                changelog_last_run = tally2
            except Exception:
                notes.append(f"could not read changelog {cl_path}")

    # pending approval
    pending_approval = 0
    try:
        manifest = load_pending_manifest(dump)
        pending_approval = len(manifest.get("entries") or [])
    except Exception:
        pass

    # staleness + health
    now_ms = int(time.time() * 1000)
    stamps: list[int] = []
    if newest_captured_at:
        try:
            import datetime
            dt = datetime.datetime.fromisoformat(newest_captured_at.replace("Z", "+00:00"))
            stamps.append(int(dt.timestamp() * 1000))
        except Exception:
            pass
    if last_run and last_run.ran_at:
        try:
            import datetime
            dt = datetime.datetime.fromisoformat(last_run.ran_at.replace("Z", "+00:00"))
            stamps.append(int(dt.timestamp() * 1000))
        except Exception:
            pass
    newest = max(stamps) if stamps else None
    staleness_ms = (now_ms - newest) if newest is not None else None

    any_partial = any(t.status not in (None, "ok") for t in per_type)
    if staleness_ms is not None and staleness_ms > STALE_MS:
        health = "STALE"
    elif any_partial or not db_present:
        health = "PARTIAL"
    else:
        health = "OK"

    return StatusReport(
        dump=dump,
        db=db_path,
        db_present=db_present,
        per_type=per_type,
        overall={
            "totalArticles": total_articles,
            "bodied": bodied,
            "health": health,
            "lastRun": last_run,
            "newestCapturedAt": newest_captured_at,
            "stalenessMs": staleness_ms,
            "changelogPath": changelog_path_val,
            "changelogLastRun": changelog_last_run,
            "pendingApproval": pending_approval,
        },
        error_classes=error_classes,
        notes=notes,
    )


def _fmt_age(ms: int | None) -> str:
    if ms is None:
        return "?"
    sec = ms / 1000
    if sec < 60:
        return f"{sec:.0f}s ago"
    min_ = sec / 60
    if min_ < 60:
        return f"{min_:.0f}m ago"
    hr = min_ / 60
    if hr < 24:
        return f"{hr:.1f}h ago"
    return f"{hr / 24:.1f}d ago"


def _pad(s: str, w: int) -> str:
    return s if len(s) >= w else s + " " * (w - len(s))


def _padl(s: str, w: int) -> str:
    return s if len(s) >= w else " " * (w - len(s)) + s


def render_status(report: StatusReport) -> str:
    lines: list[str] = []
    o = report.overall
    lines.append(f"Status: {o['health']}   dump={report.dump}")
    lines.append(
        f"  DB: {report.db if report.db_present else '(missing)'}  "
        f"articles={o['totalArticles'] or '?'}  bodied={o['bodied'] or '?'}"
    )
    lr = o.get("lastRun")
    if lr:
        lines.append(
            f"  last run {lr.run_id} ({_fmt_age(o.get('stalenessMs'))}): "
            f"scanned={lr.scanned or '?'} new={lr.new or '?'} changed={lr.changed or '?'} "
            f"unchanged={lr.unchanged or '?'} removed={lr.removed or '?'}"
        )
    else:
        lines.append("  last run: (none recorded)")
    if o.get("newestCapturedAt"):
        lines.append(f"  newest capturedAt: {o['newestCapturedAt']} ({_fmt_age(o.get('stalenessMs'))})")
    if o.get("changelogPath"):
        cl = o.get("changelogLastRun")
        summary = (
            " ".join(f"{k}={v}" for k, v in cl.items())
            if cl and cl
            else "(no records for last run)"
        )
        lines.append(f"  changelog: {o['changelogPath']}")
        lines.append(f"    last run: {summary}")
    if o.get("pendingApproval", 0) > 0:
        lines.append(
            f"  PENDING APPROVAL: {o['pendingApproval']} staged edit(s) in {report.dump}/_pending/ "
            f"— review then `f5kb approve`"
        )

    head = (
        f"  {_pad('TYPE', 26)} {_padl('DISK', 8)} {_padl('EXP', 8)} "
        f"{_padl('WRIT', 8)} {_pad('STATUS', 9)} {_padl('BODIED', 8)} {_padl('ERR', 6)}"
    )
    lines.append("")
    lines.append(head)
    lines.append("  " + "-" * (len(head) - 2))
    for t in report.per_type:
        lines.append(
            f"  {_pad(t.type_key, 26)} {_padl(str(t.disk_count), 8)} "
            f"{_padl(str(t.expected) if t.expected is not None else '-', 8)} "
            f"{_padl(str(t.written) if t.written is not None else '-', 8)} "
            f"{_pad(t.status or '-', 9)} "
            f"{_padl(str(t.bodied) if t.bodied is not None else '-', 8)} "
            f"{_padl(str(t.errors) if t.errors is not None else '-', 6)}"
        )

    if report.error_classes:
        lines.append("")
        lines.append("  body errors by class:")
        for ec in report.error_classes:
            lines.append(f"    {_pad(ec.klass, 16)} {ec.count}")
    if report.notes:
        lines.append("")
        lines.append("  notes:")
        for n in report.notes:
            lines.append(f"    - {n}")
    return "\n".join(lines)
