# MEMORIES.md — project memory & handoff

Durable knowledge worth carrying across machines/sessions for the **f5kb** toolkit.
This file is meant to survive a zip-and-move: it captures the *why*, the current
*state*, the *gotchas*, and *how to resume* — things not obvious from the code alone.
For day-to-day usage see `HOWTO.md`-style guide `HOWTO.txt`; for the full CLI reference
see `README.md`; for code architecture `OUTLINE.txt`; for scraped-system facts
`FINDINGS.txt`; for Claude-Code working rules `CLAUDE.md`.

_Last updated: 2026-06-04._

## What this is

A Deno/TypeScript CLI (`f5kb`) that builds and maintains a **local, full-fidelity index
of F5 Knowledge Base articles** (metadata + full body text) for every document type,
with **no login**. F5's support portal (my.f5.com) has no public REST API; the only
public path is the **Coveo guest-token search backend**, reached with a token fetched at
runtime from a Salesforce Aura endpoint. Everything is one entry point, `f5kb.ts`, with
subcommands; heavy logic lives in `lib/`, thin wrappers in `cmd/`.

## Current state (2026-06-04)

- **Full corpus built and live** under `outputs/dump/` + `outputs/articles.db`:
  **106,045 articles** across 13 document types (everything EXCEPT `Community` and
  `F5_GitHub`, which we intentionally skip as big/low-value). Body coverage ~99–100%
  (105,431 bodied; the rest are legitimate no-body cases — soft-404s, landing
  redirects, image-only/stub pages).
- The last operation was a gated `sync --all --exclude-types=Community,F5_GitHub`:
  3 new articles written, **387 edits staged then approved** (promoted to live,
  old versions archived under `outputs/dump/_replaced/`). Of those 387, only **11
  actually changed content/body**; 376 were metadata-only (date bumps etc.).
- The `_changelog.jsonl` was **backfilled** with those 387 `approve` edits (they
  predated approve's default-on changelog), so the JSONL history is now complete:
  390 lines (3 `added` + 387 `edited`).
- `outputs/dump/_pending/` is **empty** (nothing awaiting approval).
- Tests: **134 passing, 0 failed**, fully offline. `deno task check` + `lint` clean.
- Git branch: **master** (this repo's working branch; `main` exists for PRs but work
  has landed on master). Tree clean at handoff.

## Run it / recreate the environment

- Install **Deno 2.x** (<https://deno.com>). Nothing else — no Node, no package install;
  deps are fetched by URL on first run (`jsr:@std/*`, `jsr:@b-fuze/deno-dom`);
  `node:sqlite` is built into Deno.
- Internet access to my.f5.com and `f5networksproduction5vkhn00h.org.coveo.com`.
- Optional `GITHUB_TOKEN` env (only matters for F5_GitHub enrichment, which we skip).
- Everyday refresh: `deno task sync --all --exclude-types=Community,F5_GitHub`, then
  review with `deno task approve --list` and apply with `deno task approve`.
- After unzipping on the new machine: `deno task check && deno task test` should pass
  offline immediately (no network). `deno task status` reports the dump/DB health.

## Access & credentials (no secrets stored)

- Coveo organization id: **`f5networksproduction5vkhn00h`**.
- The guest token is fetched at runtime via the Aura endpoint
  `HeadlessController.getHeadlessConfiguration` (no auth, no key) and auto-refreshed in
  place on 401/419 (the JWT lives ~24h; a long full dump can outlive it). Full
  token/credential mechanics are in `FINDINGS.txt`.
- No credentials are committed anywhere; nothing secret needs to move with the project.

## The pipeline & the safety model (the important mental model)

- First build: `dump` → `enrich` → `track`. After that you **refresh** with `sync`
  (incremental: only re-dumps/re-enriches what changed; under `--all` it also detects +
  reports upstream deletions, never removing them).
- **Overwrite protection (the approval gate):** `sync`/`dump`/`enrich` never silently
  overwrite an article that already holds good data. A changed article is **staged** to
  `outputs/dump/_pending/<type>/<id>.json` (live untouched) and recorded in
  `_pending/_manifest.json`. You apply staged edits with **`f5kb approve`**, which
  archives each replaced file to `outputs/dump/_replaced/`, then promotes — and **holds
  back** any edit flagged risky (`body-dropped`/`body-error`) unless `--include-risky`.
  `--yes` on sync/dump/enrich bypasses staging (overwrite in place). This exists because
  an upstream reformat could otherwise replace a good body with an empty one.
- **`reconcile`** is the ONLY command that deletes on our side — report-only unless
  `--apply` (threshold guard + DB backup + soft-delete to `_deleted/`, or `--purge`).
- **Changelog** (`outputs/dump/_changelog.jsonl`, JSONL): a greppable history of every
  applied change. ON by default for `sync` and `approve`; opt-in (`--changelog`) on
  dump/enrich/track/reconcile. Records carry `changed: ["metadata"]/["content"]/both`.

## Gotchas / hard-won lessons (don't re-learn these)

- **`dbKey` must equal `loadHashIndex`'s key byte-for-byte.** `dbKey(documentType,id)` in
  `lib/dump.ts` builds `"<document_type> <id>"`; the DB index uses the same. A separator
  mismatch (we shipped a NUL once) makes every lookup miss and silently disables
  skip-unchanged — every article looks new. Locked by `test/integration/sync_cmd_test.ts`.
- **`listTypeDirs` skips `_`-prefixed dirs** so `track`/`status` never index
  `_pending/_replaced/_deleted` as article types. A real type dir is a sanitized type
  key, which never starts with `_`. Don't name a type dir with a leading underscore.
- **`config.yaml` is excluded from `deno fmt`** (a bare `deno fmt` reformats YAML and
  produced a huge spurious diff once). Hand-edit `config.yaml`; don't reformat it.
- **"Changed" = `metadata_hash` differs** (metadata includes the published/updated
  dates). A body-only upstream change that bumps no date is NOT auto-detected — use
  `enrich --refetch` to force those. `capturedAt` is excluded from the hash, so a
  re-dump of an unchanged article reproduces the same hash (that's the skip signal).
- **The gate stages; `approve` applies.** A staged edit is not in the DB and not logged
  as applied until `approve` promotes it. `approve` recomputes risk AND the
  metadata/content split fresh from the live-vs-pending files.
- **No headless browser.** Every body is reachable via plain fetch — JS-rendered sites
  embed it in `__NEXT_DATA__` JSON or render server-side. Don't add Puppeteer.
- **`--all` uses `@rowid` keyset pagination** to beat Coveo's 5,000-offset cap (and to
  catch docs a date window would miss). See `OUTLINE.txt` §4.
- **Network is dependency-injected** (`CoveoClient`/`HttpClient` take a `fetch` fn) —
  that's why the whole test suite runs offline. Don't reach for global `fetch` in `lib`.
- **`--types` / `--exclude-types`** work on every type-aware command; include is applied
  first, then exclude (exclude wins). Our standard selection is
  `--exclude-types=Community,F5_GitHub`.

## Data layout (what's in the zip)

`outputs/` is **git-ignored** (large, regenerable) but IS in the zip:

```
outputs/
  articles.db                      SQLite overview (articles / runs / changes tables)
  dump/
    _index.json                    last dump manifest (per-type status + counts)
    _enrich_report.json            last enrich per-type enriched/failed/skipped
    _changelog.jsonl               applied-change history (390 lines as of handoff)
    _pending/_manifest.json        staged edits awaiting approve (empty now)
    _replaced/<type>/<id>.<ts>.json  archived pre-overwrite versions (387 from the
                                     last approve — recoverable if an approval was wrong)
    <Type>/<id>.json               one file per article (metadata + content)
    <Type>/_catalogue.{json,md}    per-type field catalogue
```

After unzip on a new machine the data is all present but **untracked by git** (that's
expected — only code, `config.yaml`, and docs are committed). To rebuild from scratch
instead of moving data: delete `outputs/` and run the build pipeline.

## Documentation map (where everything lives)

- **README.md** — full CLI reference (every subcommand, flags, examples, output, config,
  API limits). Markdown; GitHub-renderable. The canonical usage doc going forward.
- **HOWTO.txt** — task-oriented user guide (quick start + common workflows with
  copy-paste commands).
- **OUTLINE.txt** — code architecture: module tree, the dump→enrich→track→sync flow, the
  dependency-injection design, pagination strategy, testing, decisions, war stories.
- **FINDINGS.txt** — discoveries about the scraped system (Coveo token flow, the two API
  limits, field meanings, counts, lifecycle). Appendix A is the full field inventory; the
  my.f5.com sitemap gap analysis (incl. the 47 unindexed K-IDs) is in its "Sitemap"
  section.
- **TODO.txt** — open work + a dated log of shipped work.
- **CLAUDE.md** — orientation + working rules for Claude Code in this repo (Markdown
  exception #1; README.md is #2; this file is #3).
- **config.yaml** — the machine config the CLI reads (`types:` keep-lists +
  `field_descriptions:` + a read-only `products:` snapshot).

## Open work / watch-list (from TODO.txt)

- **Products drift:** the last sync flagged one live product not in `config.yaml` —
  **"BIG-IP Next CNF"**. Run `f5kb discover` and copy the refreshed `products:` block
  into `config.yaml` if you want it captured (the pipeline doesn't read `products:`, so
  this is reference-only).
- **Sitemap gap:** ~47 K-articles appear in the my.f5.com sitemap but are absent from the
  Coveo index, so the pipeline can't reach them (~2 recent = likely indexing lag; ~45 old
  = likely superseded). The IDs + analysis are in `TODO.txt` / `FINDINGS.txt`. Decide
  whether the old ones merit a targeted per-article SPA scrape (probably not).
- **Possible future guards:** a `--max-staged` abort for a sync that would stage an
  enormous `_pending/` (mirrors reconcile's threshold); a combined "sync then
  reconcile --apply" wrapper if the two-step ever gets tedious.
