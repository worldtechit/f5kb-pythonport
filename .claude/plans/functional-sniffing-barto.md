# Python Conversion Plan: f5kb Deno → Python

## Context

f5kb is a CLI toolkit that indexes F5 Knowledge Base articles (via Coveo search API) into
a local SQLite database. Currently Deno 2.x + TypeScript. Goal: full port to Python 3.11+
with identical output semantics (same JSON envelopes, same DB schema, same JSONL changelog,
same SHA256 hashes). No new features; strict behavioral parity.

Chosen stack: **Python 3.11+**, **uv + pyproject.toml**, **click** (CLI), **httpx sync**
(HTTP), **BeautifulSoup4 + lxml** (HTML), **sqlite3 stdlib** (DB), **pytest** (tests).

---

## Target Project Structure

```
f5kb/                          ← Python package
    __init__.py
    __main__.py                ← python -m f5kb
    cli.py                     ← click group + global options
    version.py                 ← VERSION, USER_AGENT
    config/types.py            ← TypeConfig, ProductEntry, AppConfig dataclasses
    config/loader.py           ← load_config(path) → AppConfig  (pyyaml)
    coveo/aura.py              ← fetch_coveo_config, refresh_config, CoveoConfig
    coveo/client.py            ← CoveoClient(config, *, httpx_client, logger, sleep, refresh)
    coveo/dates.py             ← to_coveo_date, date_aq, mod_ms_of, format_date
    coveo/paging.py            ← fetch_paged, fetch_keyset, fetch_chunked, fetch_ids, fetch_type_since
    coveo/fields.py            ← flatten_fields, split_entry, update_catalogue, write_catalogue
    coveo/flat.py              ← FlatArticle, build_aq, fetch_flat_paged, to_csv
    html/serialize.py          ← make_serializer(base_url) → Callable[[Tag], str]
    html/bugtracker.py         ← parse_bug_content, parse_labeled_fields, bug_tracker_url
    html/nextdata.py           ← parse_next_data, extract_next_data_body
    html/docpage.py            ← HOST_RULES, extract_doc_body
    http/fetcher.py            ← HttpClient(*, httpx_client, logger, sleep)
    http/github.py             ← parse_github_url, github_api
    track/hashing.py           ← canonical, sha256_obj, content_for_hash, has_body, to_record
    track/db.py                ← init_db, load_hash_index, track_dump, load_ids_by_type
    lib/logger.py              ← Logger, make_logger, NULL_LOGGER
    lib/progress.py            ← Progress, make_progress
    lib/changelog.py           ← Changelog, ChangeRecord, changelog_path_from_flag
    lib/fsutil.py              ← sanitize_name, id_of, read_json, write_json, walk_article_files, list_type_dirs
    lib/staging.py             ← pending_dir, merge_pending, compute_risk, diff_parts, archive_replaced
    lib/dump.py                ← db_key, DumpTypesOpts, dump_types
    lib/sync.py                ← SyncOpts, sync_dump
    lib/reconcile.py           ← ReconcileOpts, reconcile
    lib/status.py              ← StatusReport, compute_status
    lib/approve.py             ← ApproveOpts, approve
    enrich/enrichers.py        ← Enricher protocol, TYPE_ENRICHERS registry
    enrich/driver.py           ← run_pool (ThreadPoolExecutor), enrich_dump
    cmd/dump.py … cmd/discover.py  ← 12 click subcommands

f5kb.py                        ← shim: from f5kb.cli import cli; cli()
pyproject.toml
tests/
    conftest.py                ← fixture helpers, MockTransport, noop_sleep
    fixtures/                  ← REUSE UNCHANGED from test/fixtures/
    unit/                      ← 21 test files (one per lib module)
    integration/               ← 8 test files (end-to-end cmd flows)
    regression/                ← 5 test files (schema/output locks)
```

---

## pyproject.toml (key sections)

```toml
[project]
name = "f5kb"
version = "1.0.0"
requires-python = ">=3.11"
dependencies = [
    "click>=8.1",
    "httpx>=0.27",
    "beautifulsoup4>=4.12",
    "lxml>=5.0",
    "pyyaml>=6.0",
]

[project.scripts]
f5kb = "f5kb.cli:cli"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = "-ra -q"
markers = ["live: requires network (skip by default)"]

[tool.uv]
dev-dependencies = ["pytest>=8.0", "pytest-mock>=3.12"]
```

---

## Migration Order (bottom-up, each layer testable immediately)

### Layer 0 — Pure utilities (no internal deps)
1. `f5kb/version.py`
2. `f5kb/lib/logger.py`
3. `f5kb/lib/fsutil.py`
4. `f5kb/track/hashing.py`  ← **hash compat MUST be verified before any DB work**
5. `f5kb/lib/changelog.py`
6. `f5kb/lib/progress.py`
7. `f5kb/config/types.py`
8. `f5kb/config/loader.py`

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
17. `f5kb/html/serialize.py`  ← **byte-identical output required; iterate against regression fixtures**
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
30. `f5kb/cli.py` (click group + global flags)
31. `f5kb/cmd/*.py` (12 subcommands)
32. `f5kb.py`, `f5kb/__main__.py`

---

## Key Design Decisions

### Dependency injection → httpx transport
Replace the `FetchFn` injectable with `httpx.Client(transport=...)`.
Production: `httpx.HTTPTransport()`. Tests: custom `MockTransport(routes)` implementing
`httpx.BaseTransport.handle_request()` — exact analogue of `makeMockFetch`, no monkey-patching.
`HttpClient` and `CoveoClient` accept `httpx_client: httpx.Client | None = None`.

### Async → sync + ThreadPoolExecutor
Fully sync everywhere. `enrichDump`'s `runPool` (was async concurrency) becomes:
```python
from concurrent.futures import ThreadPoolExecutor, as_completed
def run_pool(items, concurrency, worker):
    with ThreadPoolExecutor(max_workers=min(concurrency, len(items))) as ex:
        for f in as_completed(ex.submit(worker, i) for i in items):
            f.result()
```
`httpx.Client` is thread-safe; share one instance across threads. `time.sleep(delay_ms/1000)` in worker.

### SHA256 canonical hash (highest-risk compat point)
```python
import hashlib, json

def canonical(v):
    if isinstance(v, list): return [canonical(x) for x in v]
    if isinstance(v, dict): return {k: canonical(v[k]) for k in sorted(v)}
    return v

def sha256_obj(obj: object) -> str:
    s = json.dumps(canonical(obj), separators=(',', ':'))
    return hashlib.sha256(s.encode()).hexdigest()
```
`json.dumps(..., separators=(',', ':'))` matches TypeScript `JSON.stringify` output exactly.
Verify against existing `articles.db` before any other DB work.

### Types
- `@dataclass(frozen=True)` for `TypeConfig`, `ProductEntry`, `AppConfig`
- `TypedDict` annotations for article JSON blobs (no runtime overhead)
- `@dataclass` for `Record_` (DB row), `ChangeRecord`, result types
- No Pydantic (zero validation benefit for self-generated data)

### Logger
Custom `Logger` class wrapping `sys.stderr.write`. Supports `child(scope)`, `timer()`, json_mode
(NDJSON), levels error/warn/info/debug/trace. `NULL_LOGGER` uses `write=lambda _: None`.
Tests inject `write` callable to capture output. Trace = custom level 5.

### BigInt cursor
TypeScript uses `BigInt` for `@rowid` because JS ints overflow. Python `int` is arbitrary
precision — no special handling.

### click CLI structure
Global flags (`--verbose/--quiet/--debug/--json-logs`) on the `@click.group`, stored in
`ctx.obj["logger"]` via `@click.pass_context`. Subcommands receive logger from `ctx.obj`.
`@cli.command()` in `f5kb/cmd/*.py` replaces `cmd/*.ts` `run(args, logger, deps?)`.
Exit codes via `sys.exit(code)` at the click boundary.

### args.ts → click
No `args.py` module. `applyTypeFilters` / `warnUnknownTypes` logic is 5–10 lines inlined
per subcommand. `flagStr/flagNum/flagBool/flagList` replaced by `@click.option` declarations.

### Fixtures
`test/fixtures/` copied verbatim into `tests/fixtures/` (JSON, HTML, dump_mini — all
platform-agnostic). `conftest.py` provides `fixture_path(rel)`, `load_fixture(rel)`,
`load_json_fixture(rel)`. `tmp_path` pytest fixture replaces `Deno.makeTempDir()`.

---

## Testing Strategy

### MockTransport (replaces makeMockFetch)
```python
class MockTransport(httpx.BaseTransport):
    def __init__(self, routes): self.routes = routes; self.calls = []
    def handle_request(self, req):
        self.calls.append(RecordedCall(...))
        return self._route(req)
    def _route(self, req): ...  # same URL/body-shape routing as makeMockFetch
```

### Test mapping
| Deno pattern | Python equivalent |
|---|---|
| `Deno.test(name, fn)` | `def test_name(tmp_path)` |
| `assertEquals(a, b)` | `assert a == b` |
| `assertRejects(fn, Err)` | `pytest.raises(Err)` |
| `makeMockFetch({scripted})` | `MockTransport(scripted=[...])` |
| `noopSleep` | `lambda _: None` |
| `loadFixture("pages/x.html")` | `load_fixture("pages/x.html")` |

---

## Verification Steps

1. **Hash compat** — after `hashing.py`, run:
   ```
   python -c "from f5kb.track.hashing import sha256_obj; import json; \
     art=json.load(open('tests/fixtures/dump_mini/Knowledge/K14448.json')); \
     print(sha256_obj(art['metadata']))"
   # compare against: sqlite3 outputs/articles.db \
   #   "SELECT metadata_hash FROM articles WHERE id='K14448'"
   ```

2. **DB schema lock** — `pytest tests/regression/test_db_schema.py -v`

3. **HTML serializer** — `pytest tests/regression/test_enrich_output.py tests/unit/test_html_serialize.py -v`
   Iterate on `html/serialize.py` until byte-identical output.

4. **Full unit suite** — `pytest tests/unit/ -v` (all offline)

5. **Integration suite** — `pytest tests/integration/ -v`

6. **All regression tests** — `pytest tests/regression/ -v`

7. **Full offline suite** — `pytest -v` (zero network calls)

8. **Entry point smoke**:
   ```
   uv run python f5kb.py --version
   uv run python f5kb.py --help
   uv run python f5kb.py track --dump tests/fixtures/dump_mini --db /tmp/t.db
   ```

9. **Output compat check** — run Python `track` against existing `outputs/dump/`;
   compare `metadata_hash` / `content_hash` columns against TypeScript-generated `articles.db`.

10. **Live smoke** (optional, `F5_LIVE=1`):
    ```
    uv run f5kb dump --all --out /tmp/py_dump --types Knowledge --limit 5
    uv run f5kb track --dump /tmp/py_dump --db /tmp/py.db
    ```
