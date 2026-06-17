# MEMORIES.md — project memory & handoff

Durable knowledge worth carrying across machines/sessions for the **f5kb** toolkit.
Survives a zip-and-move: captures the *why*, current *state*, *gotchas*, and *how to
resume* — things not obvious from the code alone. For day-to-day usage see HOWTO.md;
for CLI reference see README.md; for code architecture see OUTLINE.md; for scraped-system
facts see FINDINGS.md; for Claude Code working rules see CLAUDE.md.

_Last updated: 2026-06-17._

## What this is

A **Python 3.11+ CLI** (`f5kb`) that builds and maintains a **local, full-fidelity index
of F5 Knowledge Base articles** (metadata + full body text) for every document type, with
**no login**. F5's support portal (my.f5.com) has no public REST API; the only public path
is the **Coveo guest-token search backend**, reached with a token fetched at runtime from a
Salesforce Aura endpoint. Package managed with **uv** (hatchling build system). Everything
is one Click CLI with 12 subcommands; heavy logic lives in `f5kb/lib/`, thin wrappers in
`f5kb/cmd/`.

## Current state (2026-06-17)

- **Python port complete.** Project migrated from Deno/TypeScript to Python 3.11+/uv.
  Code lives at repo root (no `python/` subdirectory anymore). Remote:
  `worldtechit/f5kb-pythonport`, branch `python-port` pushed to `main`.
- **Test suite: 301 offline tests, 0 failed.** 5 additional `@pytest.mark.live`
  network tests in `tests/integration/test_live.py`.
- **Full corpus previously built** under `outputs/dump/` + `outputs/articles.db`:
  ~106,045 articles across 13 document types (all except Community and F5_GitHub,
  which we intentionally skip as big/low-value). Body coverage ~99–100%.
- `outputs/dump/_pending/` is empty (nothing awaiting approval).

## Run it / recreate the environment

- Install **Python 3.11+** and **uv** (see README.md Installation).
- `uv sync` — installs all dependencies from `uv.lock` (committed).
- Internet access to my.f5.com and `f5networksproduction5vkhn00h.org.coveo.com`.
- Optional `GITHUB_TOKEN` env (only for F5_GitHub enrichment, which we skip).
- Everyday refresh: `uv run f5kb sync --all --exclude-types=Community,F5_GitHub`,
  then review with `uv run f5kb approve --list` and apply with `uv run f5kb approve`.
- After unzipping on a new machine: `uv sync && uv run pytest` should pass offline
  immediately (no network). `uv run f5kb status` reports the dump/DB health.

## Access & credentials (no secrets stored)

- Coveo organization id: **`f5networksproduction5vkhn00h`**.
- The guest token is fetched at runtime via the Aura endpoint
  `HeadlessController.getHeadlessConfiguration` (no auth, no key) and auto-refreshed on
  401/419 (the JWT lives ~24h; a long full dump can outlive it). Full mechanics in
  FINDINGS.md.
- Nothing secret is committed anywhere.

## The pipeline & the safety model (the important mental model)

- First build: `dump` → `enrich` → `track`. After that, **refresh** with `sync`
  (incremental: only re-dumps/re-enriches what changed; under `--all` it also detects
  + reports upstream deletions, never removing them).
- **Overwrite protection (the approval gate):** `sync`/`dump`/`enrich` never silently
  overwrite an article that already holds good data. A changed article is **staged** to
  `outputs/dump/_pending/<type>/<id>.json` (live untouched) and recorded in
  `_pending/_manifest.json`. You apply staged edits with **`f5kb approve`**, which
  archives each replaced file to `outputs/dump/_replaced/`, then promotes — and **holds
  back** any edit flagged risky (`body-dropped`/`body-error`) unless `--include-risky`.
  `--yes` on sync/dump/enrich bypasses staging (overwrite in place; still archives to
  `_replaced/`). This exists because an upstream reformat could replace a good body with
  an empty one.
- **`reconcile`** is the ONLY command that deletes on our side — report-only unless
  `--apply` (threshold guard + DB backup + soft-delete to `_deleted/`, or `--purge`).
- **Changelog** (`outputs/dump/_changelog.jsonl`, JSONL): greppable history of every
  applied change. ON by default for `sync` and `approve`; opt-in (`--changelog`) on
  dump/enrich/track/reconcile. Records carry `changed: ["metadata"]/["content"]/both`.

## Gotchas / hard-won lessons (don't re-learn these)

- **`db_key` must equal `load_hash_index`'s key byte-for-byte.** `db_key(document_type, id)`
  in `f5kb/lib/dump.py` builds `"<document_type> <id>"`. A separator mismatch makes every
  lookup miss and silently disables skip-unchanged — every article looks new.
- **`list_type_dirs` skips `_`-prefixed dirs** so `track`/`status` never index
  `_pending/_replaced/_deleted` as article types. A real type dir is a sanitized type key
  which never starts with `_`.
- **`config.yaml` excluded from formatters** (`ruff format`). Hand-edit only — a formatter
  would rewrite the curated YAML and produce a huge spurious diff.
- **"Changed" = `metadata_hash` differs** (metadata includes the published/updated dates).
  A body-only upstream change that bumps no date is NOT auto-detected — use
  `enrich --refetch` to force those. `capturedAt` is excluded from the hash, so a re-dump
  of an unchanged article reproduces the same hash.
- **The gate stages; `approve` applies.** A staged edit is not in the DB and not logged as
  applied until `approve` promotes it. `approve` recomputes risk AND the metadata/content
  split fresh from the live-vs-pending files.
- **No headless browser.** Every body is reachable via plain httpx — JS-rendered sites embed
  it in `__NEXT_DATA__` JSON or render server-side. Don't add Playwright.
- **`--all` uses `@rowid` keyset pagination** to beat Coveo's 5,000-offset cap (and to
  catch docs a date window would miss). See OUTLINE.md §4.
- **Network is dependency-injected** (`CoveoClient` / `HttpClient` take an httpx client
  or transport) — that's why the whole test suite runs offline. Don't reach for `httpx`
  directly in lib code.
- **`has_body()` has two implementations** in `f5kb/track/hashing.py` and
  `f5kb/enrich/enrichers.py` with different semantics. Do NOT consolidate.
- **`_now_stamp()` uses dashes (`%H-%M-%S`)** in `staging.py` / `reconcile.py` for
  filesystem-safe filenames. Do NOT change to colons.
- **`limit=0` means "no cap"** throughout. `paging.py` normalizes it to `float("inf")`
  internally.
- **`--types` / `--exclude-types`** work on every type-aware command; include first, then
  exclude (exclude wins). Standard selection: `--exclude-types=Community,F5_GitHub`.

## Data layout (what's in the zip)

`outputs/` is **git-ignored** (large, regenerable) but IS in the zip:

```
outputs/
  articles.db                      SQLite overview (articles / runs / changes tables)
  dump/
    _index.json                    last dump manifest (per-type status + counts)
    _enrich_report.json            last enrich per-type enriched/failed/skipped
    _changelog.jsonl               applied-change history (JSONL)
    _pending/_manifest.json        staged edits awaiting approve (empty now)
    _replaced/<type>/<id>.<ts>.json  archived pre-overwrite versions (recoverable)
    <Type>/<id>.json               one file per article (metadata + content)
    <Type>/_catalogue.{json,md}    per-type field catalogue
```

After unzip on a new machine the data is present but untracked by git (expected).
To rebuild from scratch: delete `outputs/` and run the build pipeline.

## Documentation map (where everything lives)

- **README.md** — full CLI reference (every subcommand, flags, examples, output, config).
- **HOWTO.md** — task-oriented user guide (quick start + common workflows).
- **OUTLINE.md** — code architecture: module tree, dump→enrich→track→sync flow, the
  DI design, pagination strategy, testing, decisions, war stories.
- **FINDINGS.md** — discoveries about the scraped system (Coveo token flow, API limits,
  field meanings, counts, lifecycle). Appendix A is the full field inventory; the
  my.f5.com sitemap gap analysis (incl. the 47 unindexed K-IDs) is in its "Sitemap"
  section.
- **TODO.md** — open work + a dated log of shipped work.
- **CLAUDE.md** — orientation + working rules for Claude Code in this repo.
- **config.yaml** — the machine config the CLI reads (`types:` keep-lists +
  `field_descriptions:` + a read-only `products:` snapshot).

## Open work / watch-list (from TODO.md)

- **Products drift:** run `f5kb discover` and copy the refreshed `products:` block into
  `config.yaml` if you want the latest product list captured (the pipeline doesn't read
  `products:`, so this is reference-only).
- **Sitemap gap:** ~47 K-articles appear in the my.f5.com sitemap but are absent from the
  Coveo index. IDs + analysis are in TODO.md / FINDINGS.md. Decide whether the old ones
  merit a targeted per-article SPA scrape (probably not).
- **Possible future guards:** a `--max-staged` abort for a sync that would stage an
  enormous `_pending/`; a combined "sync then reconcile --apply" wrapper.
