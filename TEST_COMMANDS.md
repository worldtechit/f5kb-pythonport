# f5kb Python — Feature Test Commands

All commands run from inside the `python/` directory.
Offline tests (no network) are marked **[offline]**.
Commands that hit my.f5.com / Coveo are marked **[network]**.

> **pip+venv users:** activate your venv first (`source .venv/bin/activate`), then drop
> the `uv run` prefix from every command below — e.g. `f5kb --version` instead of
> `uv run f5kb --version`.

---

## 0. Setup

From the repo root:

```bash
cd python
```

**Option A — uv:**
```bash
# Install uv if needed
brew install uv                                     # macOS (recommended)
curl -LsSf https://astral.sh/uv/install.sh | sh   # macOS/Linux curl installer
# Windows: powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
# Note: do NOT use pip install uv on macOS — Homebrew Python will reject it

uv sync
uv run f5kb --version    # → f5kb, version 1.0.0
uv run f5kb --help       # lists all 12 subcommands
```

**Option B — pip + venv:**
```bash
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -e .
f5kb --version                   # → f5kb, version 1.0.0
f5kb --help
```

---

## 1. Run the full test suite [offline]

```bash
uv run pytest tests/ -q
# Expected: 275 passed

uv run pytest tests/unit/ -v          # unit tests per module
uv run pytest tests/integration/ -v   # CLI smoke tests (subprocess)
```

---

## 2. track — index a dump into SQLite [offline]

Uses the mini fixture dump (25 articles across 5 types).

```bash
DUMP=tests/fixtures/dump_mini
DB=/tmp/f5kb_test.db

# First run — all new
uv run f5kb track --dump $DUMP --db $DB
# Expected stderr: "25 articles" and "new=25"

# Second run — all unchanged (idempotent)
uv run f5kb track --dump $DUMP --db $DB
# Expected stderr: "unchanged=25"

# JSON output
uv run f5kb track --dump $DUMP --db $DB --json
# Expected stdout: {"scanned": 25, "new": 0, "changed": 0, "unchanged": 25, ...}

# Scoped to one type
uv run f5kb track --dump $DUMP --db $DB --types=Knowledge
uv run f5kb track --dump $DUMP --db $DB --exclude-types=Knowledge
```

---

## 3. status — health report [offline]

```bash
DUMP=tests/fixtures/dump_mini
DB=/tmp/f5kb_test2.db
uv run f5kb track --dump $DUMP --db $DB

# Human-readable table
uv run f5kb status --dump $DUMP --db $DB
# Expected: "Status:" header, article counts per type

# JSON output
uv run f5kb status --dump $DUMP --db $DB --json
# Expected: {"overall": {"totalArticles": 25, ...}, "types": [...]}

# Status with no DB (graceful degradation)
uv run f5kb status --dump $DUMP
```

---

## 4. approve — stage/promote/reject [offline]

```bash
# List pending (empty dump = 0 pending)
TMP_DUMP=$(mktemp -d)
uv run f5kb approve --dump $TMP_DUMP --list
# Expected: "0 pending"

# Reject everything (noop on empty)
uv run f5kb approve --dump $TMP_DUMP --reject
# Expected: "0 pending"

# JSON output
uv run f5kb approve --dump $TMP_DUMP --list --json
```

---

## 5. changelog — verify JSONL output [offline]

```bash
DUMP=tests/fixtures/dump_mini
DB=/tmp/f5kb_cl.db
CL=/tmp/f5kb_test.jsonl

uv run f5kb track --dump $DUMP --db $DB --changelog $CL
# Expected: CL file created, each line is a JSON object with op="added"

head -1 $CL | python3 -m json.tool
# Verify keys: runId, ts, op, documentType, id, source
```

---

## 6. dump — full corpus dump [network]

```bash
mkdir -p /tmp/f5kb_dump

# Small test: 3 articles of one type
uv run f5kb dump --all --out /tmp/f5kb_dump --types=Knowledge --limit=3 --config ../config.yaml
# Expected: /tmp/f5kb_dump/Knowledge/<id>.json files

# Verify output structure
ls /tmp/f5kb_dump/Knowledge/
cat /tmp/f5kb_dump/_index.json | python3 -m json.tool

# 7 days, one type, approval gate active (edits go to _pending/)
uv run f5kb dump --days=7 --out /tmp/f5kb_dump --types=Support_Solution --limit=5 --config ../config.yaml
```

---

## 7. enrich — fill article bodies [network]

Requires an existing dump that includes Bug_Tracker or Manual articles.

```bash
# First dump some enrichable articles
uv run f5kb dump --all --out /tmp/f5kb_dump --types=Bug_Tracker --limit=3 --config ../config.yaml

# Enrich them (fetches body HTML from cdn.f5.com)
uv run f5kb enrich --dump /tmp/f5kb_dump --types=Bug_Tracker --limit=2 --concurrency=2

# Re-fetch only errored articles
uv run f5kb enrich --dump /tmp/f5kb_dump --refetch-errors

# Skip F5_GitHub (avoids GitHub rate limit)
uv run f5kb enrich --dump /tmp/f5kb_dump --exclude-types=F5_GitHub

# Check enrich report
cat /tmp/f5kb_dump/_enrich_report.json | python3 -m json.tool
```

---

## 8. sync — incremental refresh [network]

```bash
mkdir -p /tmp/f5kb_sync
DB=/tmp/f5kb_sync.db

# Dry run first — no writes
uv run f5kb sync --days=3 --out /tmp/f5kb_sync --db $DB --dry-run \
    --types=Knowledge --limit=5 --config ../config.yaml
# Expected: classifies articles, writes nothing

# Real sync — last 3 days, Knowledge only, bypass gate
uv run f5kb sync --days=3 --out /tmp/f5kb_sync --db $DB --yes \
    --types=Knowledge --limit=5 --no-enrich --config ../config.yaml

# Incremental: since last run
uv run f5kb sync --since-last-run --out /tmp/f5kb_sync --db $DB \
    --types=Knowledge --no-enrich --limit=5 --config ../config.yaml

# Full corpus with deletion detection (slow — all types, skip this for quick test)
# uv run f5kb sync --all --out /tmp/f5kb_sync --db $DB --exclude-types=Community,F5_GitHub --config ../config.yaml
```

---

## 9. reconcile — deletion detection [network]

Requires a populated DB (run sync above first).

```bash
DB=/tmp/f5kb_sync.db

# Report only (no deletes) — safe to run anytime
uv run f5kb reconcile --dump /tmp/f5kb_sync --db $DB --types=Knowledge --config ../config.yaml
# Expected: lists any KB ids in DB but gone upstream

# JSON report
uv run f5kb reconcile --dump /tmp/f5kb_sync --db $DB --types=Knowledge --json --config ../config.yaml

# Apply soft-delete (moves to _deleted/) — only after reviewing the report
# uv run f5kb reconcile --dump /tmp/f5kb_sync --db $DB --types=Knowledge --apply --config ../config.yaml
```

---

## 10. fetch — flat article fetch [network]

```bash
# NGINX Plus security advisories, JSON + CSV
uv run f5kb fetch --product="NGINX Plus" --type="Security Advisory" \
    --limit=5 --output /tmp/nginx_sec.json --csv /tmp/nginx_sec.csv

python3 -m json.tool /tmp/nginx_sec.json | head -30
head -3 /tmp/nginx_sec.csv

# BIG-IP articles, limit 10
uv run f5kb fetch --product="BIG-IP" --limit=10 --output /tmp/bigip.json
```

---

## 11. recent — last-N-days dump [network]

```bash
# Last 7 days, two types
uv run f5kb recent --days=7 --out /tmp/f5kb_recent \
    --types=Knowledge,Support_Solution --limit=5 --config ../config.yaml

ls /tmp/f5kb_recent/
cat /tmp/f5kb_recent/_index.json | python3 -m json.tool

# Last 1 day, all types
uv run f5kb recent --days=1 --out /tmp/f5kb_recent2 --config ../config.yaml
```

---

## 12. list-types — document type facet [network]

```bash
uv run f5kb list-types
# Expected: table of type names + counts, e.g.:
#   Support Solution                          48123
#   Bug Tracker                                6750

uv run f5kb list-types --json | python3 -m json.tool | head -20
```

---

## 13. list-products — product facet [network]

```bash
uv run f5kb list-products
# Expected: ~73 products with counts

uv run f5kb list-products --json | python3 -m json.tool | head -20
```

---

## 14. discover — deep product discovery [network, ~3–4 min]

```bash
uv run f5kb discover --out /tmp/discovered_products.yaml --config ../config.yaml
# Expected: ~320 products written to YAML

uv run f5kb discover --format=json --out /tmp/discovered_products.json --config ../config.yaml
python3 -m json.tool /tmp/discovered_products.json | head -30
```

---

## 15. Global flags [offline / network]

```bash
# Verbose logging (debug level)
uv run f5kb --verbose track --dump tests/fixtures/dump_mini --db /tmp/v.db

# Quiet (warn only)
uv run f5kb --quiet track --dump tests/fixtures/dump_mini --db /tmp/q.db

# JSON-formatted log lines to stderr
uv run f5kb --json-logs track --dump tests/fixtures/dump_mini --db /tmp/j.db 2>/tmp/logs.jsonl
head -1 /tmp/logs.jsonl | python3 -m json.tool

# Separate stdout (JSON payload) from stderr (logs)
uv run f5kb track --dump tests/fixtures/dump_mini --db /tmp/sep.db --json \
    > /tmp/track_result.json 2>/tmp/track_logs.txt
cat /tmp/track_result.json
```

---

## 16. Approval gate end-to-end [offline]

Simulate a full gate cycle without touching the network.

```bash
# Step 1: initial index
cp -r tests/fixtures/dump_mini /tmp/gate_test_dump
export DB=/tmp/gate_test.db
uv run f5kb track --dump /tmp/gate_test_dump --db $DB

# Step 2: manually stage an edit
PDIR=/tmp/gate_test_dump/_pending/Knowledge
mkdir -p $PDIR
cp /tmp/gate_test_dump/Knowledge/K14448.json $PDIR/K14448.json
python3 -c "
import json, pathlib
m = {
    'K14448': {
        'type': 'Knowledge',
        'id': 'K14448',
        'risk': {'bodyDropped': False, 'bodyError': False, 'bodyShrunk': False},
        'changed': ['metadata'],
        'stagedAt': '2026-06-15T00:00:00Z'
    }
}
pathlib.Path('/tmp/gate_test_dump/_pending/_manifest.json').write_text(json.dumps(m, indent=2))
"

# Step 3: list pending
uv run f5kb approve --dump /tmp/gate_test_dump --db $DB --list
# Expected: shows K14448 pending

# Step 4: apply
uv run f5kb approve --dump /tmp/gate_test_dump --db $DB
# Expected: "1 promoted"

# Step 5: verify archive
ls /tmp/gate_test_dump/_replaced/Knowledge/ && echo "archive present"
```

---

## 17. Error handling [offline]

```bash
# Missing required flag
uv run f5kb dump --out /tmp/x
# Expected: error "provide --all or --days=N", exit 1

# Unknown subcommand
uv run f5kb not-a-command
# Expected: exit 1

# Conflicting sync modes
uv run f5kb sync --all --days=3 --out /tmp/x
# Expected: error "mutually exclusive", exit 1

# status on non-existent dump (graceful)
uv run f5kb status --dump /tmp/does_not_exist
# Expected: exits 0 with a mostly-empty report
```

---

## 18. SHA256 hash compatibility check [offline]

Verifies Python hashes match the TypeScript implementation for existing DB rows.

```bash
uv run python3 -c "
from f5kb.track.hashing import sha256_obj
import json
art = json.load(open('tests/fixtures/dump_mini/Knowledge/K14448.json'))
print('metadata hash:', sha256_obj(art['metadata']))
print('content hash: ', sha256_obj(art.get('content', {})))
"
# To compare against a TypeScript-generated DB:
# sqlite3 ../outputs/articles.db \
#   \"SELECT metadata_hash, content_hash FROM articles WHERE id='K14448'\"
```

---

## Cleanup

```bash
rm -rf /tmp/f5kb_* /tmp/gate_test* /tmp/nginx_sec* /tmp/bigip.json \
       /tmp/discovered_products* /tmp/f5kb_recent*
```
