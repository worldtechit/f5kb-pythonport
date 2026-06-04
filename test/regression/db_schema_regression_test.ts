// ===========================================================================
// TEST: lock the SQLite schema so the on-disk articles.db stays valid
// CATEGORY: regression
// COVERS: lib/track/db.ts (initDb)
// FIXTURES: none (a fresh temp DB; optionally the real outputs/articles.db)
// NETWORK: none
// ASSERTS:
//   - initDb creates tables articles/runs/changes + the two named indexes
//   - the articles table has EXACTLY the expected column set, with the
//     composite PK on (document_type, id)
//   - if outputs/articles.db exists, its articles columns equal the fresh
//     schema's (skipped gracefully when absent)
// ===========================================================================

import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { initDb } from "../../lib/track/db.ts";

// Hardcoded from lib/track/db.ts initDb() — the contract this test guards.
const ARTICLES_COLUMNS = [
  "document_type",
  "id",
  "title",
  "link",
  "created_ms",
  "original_published_ms",
  "updated_published_ms",
  "modified_ms",
  "captured_at",
  "metadata_hash",
  "content_hash",
  "has_body",
  "body_error",
  "first_seen_run",
  "last_seen_run",
  "last_changed_run",
];
const ARTICLES_PK = ["document_type", "id"]; // pk order 1, 2

function articleColumns(db: DatabaseSync): string[] {
  return (db.prepare("PRAGMA table_info(articles)").all() as Array<{ name: string }>).map((c) =>
    c.name
  );
}
function articlePk(db: DatabaseSync): string[] {
  return (db.prepare("PRAGMA table_info(articles)").all() as Array<{ name: string; pk: number }>)
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
}

Deno.test("initDb: fresh schema has the locked tables/indexes/columns/PK", () => {
  const dir = Deno.makeTempDirSync();
  const path = `${dir}/fresh.db`;
  const db = new DatabaseSync(path);
  try {
    initDb(db);

    // Tables + indexes present.
    const objs = db.prepare(
      "SELECT name, type FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string; type: string }>;
    const tables = objs.filter((o) => o.type === "table").map((o) => o.name).sort();
    const indexes = objs.filter((o) => o.type === "index").map((o) => o.name).sort();
    assertEquals(tables, ["articles", "changes", "runs"]);
    assertEquals(indexes, ["idx_articles_seen", "idx_changes_run"]);

    // articles columns + PK.
    assertEquals(articleColumns(db), ARTICLES_COLUMNS);
    assertEquals(articlePk(db), ARTICLES_PK);
  } finally {
    db.close();
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("articles.db on disk (if present) matches the fresh schema's columns", () => {
  const REAL = "outputs/articles.db";
  let present = false;
  try {
    present = Deno.statSync(REAL).isFile;
  } catch {
    present = false;
  }
  if (!present) {
    console.log("  (skip) outputs/articles.db absent — comparison half skipped");
    return;
  }
  let real: DatabaseSync | null = null;
  try {
    // Open read-only so the test never mutates the real DB.
    real = new DatabaseSync(REAL, { readOnly: true } as unknown as undefined);
    assertEquals(articleColumns(real), ARTICLES_COLUMNS);
    assertEquals(articlePk(real), ARTICLES_PK);
  } finally {
    real?.close();
  }
});
