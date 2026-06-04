// SQLite schema + the walk/upsert/classify flow for change tracking.
//
// initDb() and diffFields() are EXTRACTED VERBATIM from track_articles.ts. The
// schema (table/column/index definitions) and the upsert SQL MUST stay
// byte-identical so the existing outputs/articles.db remains valid.
//
// trackDump() reproduces track_articles.ts main() as a library function: the
// same BEGIN/COMMIT transaction, ON CONFLICT upsert, removed-detection scoped to
// the scanned types, and runs/changes inserts. CLI plumbing (arg parsing,
// console output, Deno.exit) is replaced by parameters, a returned Summary, and
// the injected Logger; the data-affecting logic is unchanged.

import { DatabaseSync } from "node:sqlite";
import { type Logger, NULL_LOGGER } from "../logger.ts";
import { exists, listTypeDirs, walkArticleFiles } from "../fsutil.ts";
import { type Article, type Record_, toRecord } from "./hashing.ts";
import type { Changelog } from "../changelog.ts";

// Load { "<document_type> <id>" -> metadata_hash } from the DB so an incremental
// dump can skip unchanged articles. Returns an empty map if the DB doesn't exist
// yet (first run -> everything is "added"). Key matches lib/dump.ts dbKey().
export async function loadHashIndex(dbPath: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!(await exists(dbPath))) return map;
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare("SELECT document_type AS dt, id, metadata_hash AS mh FROM articles")
      .all() as Array<{ dt: string; id: string; mh: string }>;
    for (const r of rows) map.set(`${r.dt} ${r.id}`, r.mh);
  } catch {
    // fresh/empty DB without the table yet -> empty index
  } finally {
    db.close();
  }
  return map;
}

// Most recent run's id + ran_at (epoch ms) — used by `sync --since-last-run` to
// derive the lower date bound. Returns null if the DB or runs table is empty.
export async function loadLastRunAt(
  dbPath: string,
): Promise<{ runId: string; ranAtMs: number | null } | null> {
  if (!(await exists(dbPath))) return null;
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT run_id, ran_at FROM runs ORDER BY ran_at DESC LIMIT 1")
      .get() as { run_id: string; ran_at?: string } | undefined;
    if (!row) return null;
    const ms = row.ran_at ? Date.parse(row.ran_at) : NaN;
    return { runId: row.run_id, ranAtMs: Number.isNaN(ms) ? null : ms };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

// Read current (document_type, id) pairs for a set of document types — used by
// reconcile to diff the DB against the live Coveo id set.
export async function loadIdsByType(
  dbPath: string,
  documentTypes: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const dt of documentTypes) out.set(dt, []);
  if (!(await exists(dbPath))) return out;
  const db = new DatabaseSync(dbPath);
  try {
    for (const dt of documentTypes) {
      const rows = db.prepare("SELECT id FROM articles WHERE document_type=?").all(dt) as Array<
        { id: string }
      >;
      out.set(dt, rows.map((r) => r.id));
    }
  } catch {
    // table absent -> empty
  } finally {
    db.close();
  }
  return out;
}

// Delete article rows by (document_type, id). Returns the number removed.
export function deleteRows(
  dbPath: string,
  rows: Array<{ documentType: string; id: string }>,
): number {
  if (rows.length === 0) return 0;
  const db = new DatabaseSync(dbPath);
  let n = 0;
  try {
    const del = db.prepare("DELETE FROM articles WHERE document_type=? AND id=?");
    db.exec("BEGIN");
    for (const r of rows) n += del.run(r.documentType, r.id).changes as number;
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  return n;
}

// ---------------------------------------------------------------------------
// DB schema
// ---------------------------------------------------------------------------
export function initDb(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS articles (
      document_type TEXT NOT NULL,
      id TEXT NOT NULL,
      title TEXT, link TEXT,
      created_ms INTEGER, original_published_ms INTEGER,
      updated_published_ms INTEGER, modified_ms INTEGER,
      captured_at TEXT,
      metadata_hash TEXT, content_hash TEXT,
      has_body INTEGER, body_error TEXT,
      first_seen_run TEXT, last_seen_run TEXT, last_changed_run TEXT,
      PRIMARY KEY (document_type, id)
    );
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      ran_at TEXT, dump_dir TEXT, types TEXT,
      scanned INTEGER, new INTEGER, changed INTEGER, unchanged INTEGER, removed INTEGER
    );
    CREATE TABLE IF NOT EXISTS changes (
      run_id TEXT, document_type TEXT, id TEXT, change_type TEXT, detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_changes_run ON changes(run_id);
    CREATE INDEX IF NOT EXISTS idx_articles_seen ON articles(last_seen_run);
  `);
}

// What changed between the stored row and the new record.
// deno-lint-ignore no-explicit-any -- sqlite row is dynamically shaped
export function diffFields(prev: any, rec: Record_): string[] {
  const changed: string[] = [];
  if (prev.metadata_hash !== rec.metadata_hash) changed.push("metadata");
  if (prev.content_hash !== rec.content_hash) changed.push("content");
  if (prev.updated_published_ms !== rec.updated_published_ms) changed.push("updated_published");
  if (prev.modified_ms !== rec.modified_ms) changed.push("modified");
  if ((prev.body_error ?? null) !== (rec.body_error ?? null)) changed.push("body_error");
  return changed;
}

// ---------------------------------------------------------------------------
// Public flow
// ---------------------------------------------------------------------------
export interface PerTypeStat {
  scanned: number;
  new: number;
  changed: number;
}

export interface Summary {
  runId: string;
  db: string;
  dump: string;
  types: number;
  scanned: number;
  new: number;
  changed: number;
  unchanged: number;
  removed: number;
  perType: Record<string, PerTypeStat>;
}

export interface TrackDumpOpts {
  dump: string;
  db?: string;
  types?: string[] | null;
  runId?: string;
  logger?: Logger;
  /** optional changelog sink — records new->added / changed->edited for this run. */
  changelog?: Changelog;
}

export async function trackDump(opts: TrackDumpOpts): Promise<Summary> {
  const log = opts.logger ?? NULL_LOGGER;
  const DUMP = opts.dump;
  const DB_PATH = opts.db ?? `${DUMP.replace(/\/+$/, "")}/../articles.db`;
  const RUN_ID = opts.runId ?? new Date().toISOString();
  const TYPE_FILTER = opts.types ?? null;

  // Discover type subdirs to index.
  let typeKeys: string[];
  try {
    typeKeys = await listTypeDirs(DUMP);
  } catch (e) {
    throw new Error(`Cannot read dump dir ${DUMP}: ${(e as Error).message}`);
  }
  if (TYPE_FILTER) typeKeys = typeKeys.filter((t) => TYPE_FILTER.includes(t));
  if (!typeKeys.length) {
    throw new Error(`No type directories to index under ${DUMP}.`);
  }

  const db = new DatabaseSync(DB_PATH);
  initDb(db);

  const sel = db.prepare("SELECT * FROM articles WHERE document_type=? AND id=?");
  const ins = db.prepare(`
    INSERT INTO articles (document_type,id,title,link,created_ms,original_published_ms,
      updated_published_ms,modified_ms,captured_at,metadata_hash,content_hash,has_body,
      body_error,first_seen_run,last_seen_run,last_changed_run)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(document_type,id) DO UPDATE SET
      title=excluded.title, link=excluded.link, created_ms=excluded.created_ms,
      original_published_ms=excluded.original_published_ms,
      updated_published_ms=excluded.updated_published_ms, modified_ms=excluded.modified_ms,
      captured_at=excluded.captured_at, metadata_hash=excluded.metadata_hash,
      content_hash=excluded.content_hash, has_body=excluded.has_body,
      body_error=excluded.body_error, last_seen_run=excluded.last_seen_run,
      last_changed_run=excluded.last_changed_run
  `);
  const logChange = db.prepare(
    "INSERT INTO changes (run_id,document_type,id,change_type,detail) VALUES (?,?,?,?,?)",
  );

  let scanned = 0, nNew = 0, nChanged = 0, nUnchanged = 0;
  const perType: Record<string, PerTypeStat> = {};

  db.exec("BEGIN");
  for (const typeKey of typeKeys) {
    const typeDir = `${DUMP}/${typeKey}`;
    perType[typeKey] = { scanned: 0, new: 0, changed: 0 };
    for await (const file of walkArticleFiles(typeDir)) {
      let a: Article;
      try {
        a = JSON.parse(await Deno.readTextFile(file));
      } catch (e) {
        log.warn(`  skip unreadable ${file}: ${(e as Error).message}`);
        continue;
      }
      const rec = await toRecord(a);
      if (!rec.id) continue;
      scanned++;
      perType[typeKey].scanned++;

      // deno-lint-ignore no-explicit-any -- sqlite row is dynamically shaped
      const prev = sel.get(rec.document_type, rec.id) as any;
      let changeType: "new" | "changed" | "unchanged";
      let lastChanged: string;
      if (!prev) {
        changeType = "new";
        lastChanged = RUN_ID;
        nNew++;
        perType[typeKey].new++;
        logChange.run(RUN_ID, rec.document_type, rec.id, "new", "");
        opts.changelog?.record({
          op: "added",
          documentType: rec.document_type,
          id: rec.id,
          title: rec.title ?? undefined,
          source: "track",
        });
      } else {
        const diff = diffFields(prev, rec);
        if (diff.length) {
          changeType = "changed";
          lastChanged = RUN_ID;
          nChanged++;
          perType[typeKey].changed++;
          logChange.run(RUN_ID, rec.document_type, rec.id, "changed", diff.join(","));
          opts.changelog?.record({
            op: "edited",
            documentType: rec.document_type,
            id: rec.id,
            title: rec.title ?? undefined,
            changed: diff,
            source: "track",
          });
        } else {
          changeType = "unchanged";
          lastChanged = prev.last_changed_run ?? RUN_ID;
          nUnchanged++;
        }
      }
      const firstSeen = prev?.first_seen_run ?? RUN_ID;
      ins.run(
        rec.document_type,
        rec.id,
        rec.title,
        rec.link,
        rec.created_ms,
        rec.original_published_ms,
        rec.updated_published_ms,
        rec.modified_ms,
        rec.captured_at,
        rec.metadata_hash,
        rec.content_hash,
        rec.has_body,
        rec.body_error,
        firstSeen,
        RUN_ID,
        lastChanged,
      );
      void changeType;
    }
  }

  // Removed = previously-seen rows in the scanned types that this run did not touch.
  const placeholders = typeKeys.map(() => "?").join(",");
  const removedRows = db.prepare(
    `SELECT document_type,id FROM articles WHERE document_type IN (${placeholders}) AND last_seen_run!=?`,
  ).all(...typeKeys, RUN_ID) as Array<{ document_type: string; id: string }>;
  for (const r of removedRows) {
    logChange.run(RUN_ID, r.document_type, r.id, "removed", "");
  }
  const removed = removedRows.length;

  db.prepare(
    "INSERT OR REPLACE INTO runs (run_id,ran_at,dump_dir,types,scanned,new,changed,unchanged,removed) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    RUN_ID,
    new Date().toISOString(),
    DUMP,
    typeKeys.join(","),
    scanned,
    nNew,
    nChanged,
    nUnchanged,
    removed,
  );
  db.exec("COMMIT");
  db.close();

  const summary: Summary = {
    runId: RUN_ID,
    db: DB_PATH,
    dump: DUMP,
    types: typeKeys.length,
    scanned,
    new: nNew,
    changed: nChanged,
    unchanged: nUnchanged,
    removed,
    perType,
  };
  log.info(`Indexed ${scanned} articles across ${typeKeys.length} type(s) -> ${DB_PATH}`);
  log.info(
    `  new=${nNew} changed=${nChanged} unchanged=${nUnchanged} removed=${removed} (run ${RUN_ID})`,
  );
  if (removed) {
    log.info(`  (removed = rows in scanned types not present in this dump; not deleted)`);
  }
  return summary;
}
