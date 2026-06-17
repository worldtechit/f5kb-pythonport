---
name: python-port-progress
description: "Python conversion of f5kb Deno/TypeScript project — current status, decisions, what's done, what's next"
metadata: 
  node_type: memory
  type: project
  originSessionId: 17746c61-2230-4689-809e-67ce99f00cb3
---

# f5kb Python Port — Implementation Notes

**Why:** Full port of Deno/TypeScript f5kb CLI to Python 3.11+. Behavioral parity required (same JSON envelopes, same DB schema, same SHA256 hashes, same JSONL changelog format).

**Stack:** Python 3.13, uv + pyproject.toml, click (CLI), httpx sync (HTTP), BeautifulSoup4+lxml (HTML), sqlite3 stdlib (DB), pytest.

**Plan file:** `/workspace/.claude/plans/functional-sniffing-barto.md`

**Source:** Original TS code in `/workspace/lib/`, `/workspace/cmd/`, `/workspace/test/`

**Target:** New Python package at `/workspace/python/` (subdir to avoid clobbering TS code)

---

## Key Design Decisions

- **DI pattern:** `httpx.Client(transport=MockTransport(...))` replaces injectable `FetchFn`
- **Async → sync:** Fully synchronous. `enrichDump` concurrency via `ThreadPoolExecutor`
- **SHA256:** `json.dumps(canonical(obj), separators=(',', ':'))` + `hashlib.sha256` — must be byte-identical to TS `JSON.stringify(canonical(obj))`
- **Types:** `@dataclass(frozen=True)` for configs; `TypedDict` for article blobs; plain `@dataclass` for result types
- **Logger:** Custom class, stderr sink, supports child/timer/json_mode/write-override for tests
- **CLI:** click group with `@click.pass_context`, logger in `ctx.obj["logger"]`
- **No args.py:** click options replace `flagStr/flagNum/flagBool/flagList` entirely
- **Fixtures:** `test/fixtures/` reused verbatim at `python/tests/fixtures/` (symlink or copy)
- **BigInt cursor:** Python `int` is arbitrary precision — no special handling needed

---

## Layer Order (bottom-up)

### Layer 0 — Pure utilities
1. `f5kb/version.py` ✓
2. `f5kb/lib/logger.py` ✓
3. `f5kb/lib/fsutil.py` ✓
4. `f5kb/track/hashing.py` ✓
5. `f5kb/lib/changelog.py` ✓
6. `f5kb/lib/progress.py` ✓
7. `f5kb/config/types.py` ✓
8. `f5kb/config/loader.py` ✓

### Layer 1 — HTTP + Coveo
9. `f5kb/http/fetcher.py`
10. `f5kb/http/github.py`
11. `f5kb/coveo/aura.py`
12. `f5kb/coveo/client.py`
13. `f5kb/coveo/dates.py`
14. `f5kb/coveo/fields.py`
15. `f5kb/coveo/paging.py`
16. `f5kb/coveo/flat.py`

### Layer 2 — HTML parsers
17. `f5kb/html/serialize.py`
18. `f5kb/html/bugtracker.py`
19. `f5kb/html/nextdata.py`
20. `f5kb/html/docpage.py`

### Layer 3 — DB + staging
21. `f5kb/track/db.py`
22. `f5kb/lib/staging.py`
23. `f5kb/lib/approve.py`

### Layer 4 — Orchestrators
24. `f5kb/enrich/enrichers.py`
25. `f5kb/enrich/driver.py`
26. `f5kb/lib/dump.py`
27. `f5kb/lib/sync.py`
28. `f5kb/lib/reconcile.py`
29. `f5kb/lib/status.py`

### Layer 5 — CLI
30. `f5kb/cli.py`
31. `f5kb/cmd/*.py` (12 subcommands)
32. `f5kb.py`, `f5kb/__main__.py`

---

## Status

**Current:** Layers 0+1+2+3+4+5 complete + 266 tests passing. CLI smoke tested (track + status work). PR creation next.

**Project root:** `/workspace/python/`

**Run tests:** `cd /workspace/python && uv run pytest tests/ -q`

**Hash compat check:**
```bash
cd /workspace/python && uv run python -c "
from f5kb.track.hashing import sha256_obj
import json
art = json.load(open('../test/fixtures/dump_mini/Knowledge/K14448.json'))
print(sha256_obj(art['metadata']))
"
```

---

## Gotchas / Notes

- `json.dumps` with `separators=(',', ':')` matches TS `JSON.stringify` (no spaces). VERIFIED.
- `VOLATILE_CONTENT_KEYS = {"bodySource", "fetchedAt"}` — excluded from content hash
- `listTypeDirs` skips dirs starting with `_` — critical for not indexing `_pending/` etc.
- `writeJson` uses `json.dumps(data, indent=2) + "\n"` — trailing newline required for parity
- Logger: `trace` level = integer 5 (custom Python level below DEBUG=10)
- Progress TTY detection: `sys.stderr.isatty()`
- `normalizeType`: defaults `metadata="*"`, `content=[]`
- `loadFieldDescriptionsFile`: handles both `{descriptions: {...}}` and bare map; returns `{}` on any error

## What to load on resume

1. Read this file
2. Read `/workspace/.claude/plans/functional-sniffing-barto.md`
3. Run `cd /workspace/python && uv run pytest tests/ -q` to see current test state
4. Check which layer is next based on Status above
