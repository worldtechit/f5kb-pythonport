# CLAUDE.md

Project guide for Claude Code working in this repo. Read the pointers below before
making changes.

## What this is

A toolkit that builds and maintains a local, full-fidelity index of **F5 Knowledge
Base articles** (metadata + full body text) for every document type, with **no
login**. F5's support portal (my.f5.com) has no public REST API; the only public
path is the **Coveo guest-token search backend**, accessed via a token fetched at
runtime from a Salesforce Aura endpoint.

## Runtime & dependencies

- **Deno 2.x** (`deno run …`). Not Node. Scripts are `.ts`, type-check with
  `deno check <file>.ts`.
- No package manifest. External deps are imported by URL: `jsr:@b-fuze/deno-dom`
  (HTML parsing) and `jsr:@std/yaml`. `node:sqlite` is built into Deno (no install).
- Typical perms: `--allow-net --allow-read --allow-write` (+ `--allow-env` for
  `enrich_bodies.ts` to read `GITHUB_TOKEN`).

## The pipeline (run in order)

```
dump_articles.ts  →  enrich_bodies.ts  →  track_articles.ts
```
1. **dump_articles.ts** (+ `dump_config.yaml`) — one JSON per article under
   `outputs/dump/<Type>/<id>.json`, fields split into `metadata`/`content`. Use
   `--all` (full corpus) or `--days=N`; `--out`, `--types`.
2. **enrich_bodies.ts** — fills `content` for the 5 types the Coveo index leaves
   empty (Bug_Tracker, Manual, Release_Note, Supplemental_Document, F5_GitHub).
   `--dump`, `--types`, `--refetch-errors`, `--concurrency`.
3. **track_articles.ts** — SQLite master overview (`outputs/articles.db`):
   per-article dates + metadata/content hashes; new/changed/unchanged/removed
   across runs.

Exploratory tools (pre-pipeline): `fetch_f5_articles.ts`,
`fetch_f5_articles_flex.ts`, `fetch_recent_by_type.ts`, `discover_products.ts`.

## Where the docs live (don't duplicate; update the right one)

- **readme.txt** — usage: every script, its flags, examples, output layout.
- **findings.md** — discoveries about the *scraped system* (Coveo token flow, API
  limits, field meanings, counts, deprecation/lifecycle).
- **outline.md** — our *code*: script flows, strategies, decisions, obstacles overcome.
- **TODO.txt** — open work (currently only the deferred "skip-unchanged bodies" idea).
- **available_fields.txt** — field-name → description reference (feeds the catalogue).
- (my.f5.com sitemap notes + gap analysis live in findings.md → "Sitemap".)

## Conventions & gotchas

- **`outputs/` is gitignored** (large regenerable data: dumps + `articles.db`). Commit
  code, curated config (`dump_config.yaml`), docs, and `supplemental_products.json`.
  `.claude/settings.local.json` and `.claude/*.lock` are also ignored.
- **No headless browser.** Every page's body is reachable via plain fetch — JS-rendered
  sites embed it in JSON (`__NEXT_DATA__`) or render it server-side. Don't add Puppeteer.
- **Beating Coveo's 5,000-offset cap:** `--all` uses **keyset pagination by `@rowid`**
  (the only sortable/unique field; `@date` is 1-second-resolution and misses
  null/out-of-window docs). See outline.md §3.
- **Live corpus drifts** — counts change between runs; that's expected. The dump
  validates written-vs-server and marks `partial`/`failed` in `_index.json`; re-run
  shortfalls with `--types=`. Enrichment failures land in `_enrich_report.json`; fix
  the host rule / parser then `--refetch-errors`.
- **Trust via classification:** when a body can't be extracted, record a descriptive
  `content.bodyError` — never capture nav/landing/404 text as the body.
- Scripts are resumable and idempotent; never assume a clean restart is required.

## Git

- `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` on commits.
- Commit only when work is in a coherent state (the user often says when). Use a
  file-based commit message (`git commit -F`) for multi-line bodies so backticks
  aren't mangled by the shell.

## Credentials (no secrets stored)

Coveo org `f5networksproduction5vkhn00h`; guest token fetched at runtime via
`HeadlessController.getHeadlessConfiguration` (no auth needed). Optional
`GITHUB_TOKEN` env raises the GitHub API limit for F5_GitHub enrichment. Full
token/credential details in findings.md.
