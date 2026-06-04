// ===========================================================================
// TEST: deletion reconcile — diff, threshold guard, soft-delete + purge
// CATEGORY: unit
// COVERS: lib/reconcile.ts (reconcile), lib/coveo/paging.ts (fetchIds),
//   lib/track/db.ts (loadIdsByType, deleteRows, loadLastRunAt)
// FIXTURES: none — a CoveoClient over an inline fetch returns a controlled id set
// NETWORK: none (mocked)
// ASSERTS:
//   - report-only: detects DB ids absent upstream, writes/removes nothing
//   - threshold guard: deletions over --max-delete-pct abort with no changes
//   - --apply soft-delete: file archived to _deleted/, DB row dropped, DB backed
//     up, changelog op="deleted"
//   - --purge: file removed (not archived)
// ===========================================================================

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { reconcile } from "../../lib/reconcile.ts";
import { initDb, loadIdsByType, loadLastRunAt } from "../../lib/track/db.ts";
import { Changelog } from "../../lib/changelog.ts";
import { CoveoClient } from "../../lib/coveo/client.ts";
import type { CoveoConfig } from "../../lib/coveo/aura.ts";
import { noopSleep } from "../_helpers/mock_fetch.ts";

const CFG: CoveoConfig = { platformUrl: "https://mock", accessToken: "T", organizationId: "org" };

// A CoveoClient whose search backend returns exactly `liveIds` (one keyset page).
function liveClient(liveIds: string[]): CoveoClient {
  const results = liveIds.map((id, i) => ({
    title: id,
    raw: { f5_kb_id: id, permanentid: `pid-${id}`, rowid: 1000 + i },
  }));
  const fetch = (input: string | URL): Promise<Response> => {
    const url = input.toString();
    if (url.includes("/rest/search/v2")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results,
            totalCount: results.length,
            totalCountFiltered: results.length,
          }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response("404", { status: 404 }));
  };
  return new CoveoClient(CFG, { fetch, sleep: noopSleep, refresh: () => Promise.resolve() });
}

// Build a dump dir + DB seeded with `ids` under document_type "Policy".
function seed(root: string, ids: string[]): { dump: string; dbPath: string } {
  const dump = `${root}/dump`;
  const dir = `${dump}/Policy`;
  Deno.mkdirSync(dir, { recursive: true });
  for (const id of ids) {
    Deno.writeTextFileSync(`${dir}/${id}.json`, JSON.stringify({ id, documentType: "Policy" }));
  }
  const dbPath = `${root}/articles.db`;
  const db = new DatabaseSync(dbPath);
  initDb(db);
  const ins = db.prepare("INSERT INTO articles (document_type,id) VALUES (?,?)");
  for (const id of ids) ins.run("Policy", id);
  db.close();
  return { dump, dbPath };
}

const RECONCILE_BASE = {
  typeConfigs: { Policy: { documentType: "Policy" } },
  typeKeys: ["Policy"],
  purge: false,
  maxDeletePct: 1, // 100% — disabled unless a case overrides
};

Deno.test("reconcile report-only: detects deletions, changes nothing", async () => {
  const root = await Deno.makeTempDir();
  try {
    const { dump, dbPath } = seed(root, ["K1", "K2", "K3"]);
    const cl = new Changelog(null, "run");
    const result = await reconcile({
      ...RECONCILE_BASE,
      client: liveClient(["K1", "K2"]), // K3 gone upstream
      dump,
      db: dbPath,
      apply: false,
      changelog: cl,
    });
    assertEquals(result.applied, false);
    assertEquals(result.totalDeletions, 1);
    assertEquals(result.perType[0].deletions, ["K3"]);
    assertEquals(result.perType[0].dbCount, 3);
    assertEquals(result.perType[0].liveCount, 2);
    // Nothing removed/archived/logged.
    assertEquals(Deno.statSync(`${dump}/Policy/K3.json`).isFile, true);
    assertEquals(cl.total, 0);
    const db = new DatabaseSync(dbPath);
    assertEquals(
      (db.prepare("SELECT COUNT(*) c FROM articles").get() as { c: number }).c,
      3,
    );
    db.close();
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("reconcile threshold guard: over --max-delete-pct aborts cleanly", async () => {
  const root = await Deno.makeTempDir();
  try {
    const { dump, dbPath } = seed(root, ["K1", "K2", "K3"]);
    const result = await reconcile({
      ...RECONCILE_BASE,
      maxDeletePct: 0.1, // 10% — 1/3 deletions (33%) exceeds it
      client: liveClient(["K1", "K2"]),
      dump,
      db: dbPath,
      apply: true,
    });
    assertEquals(result.applied, false);
    assertExists(result.aborted);
    assertStringIncludes(result.aborted!, "max-delete-pct");
    // Untouched.
    assertEquals(Deno.statSync(`${dump}/Policy/K3.json`).isFile, true);
    const db = new DatabaseSync(dbPath);
    assertEquals((db.prepare("SELECT COUNT(*) c FROM articles").get() as { c: number }).c, 3);
    db.close();
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("reconcile --apply: soft-delete archives file, drops row, backs up DB", async () => {
  const root = await Deno.makeTempDir();
  try {
    const { dump, dbPath } = seed(root, ["K1", "K2", "K3"]);
    const cl = new Changelog(null, "run");
    const result = await reconcile({
      ...RECONCILE_BASE,
      client: liveClient(["K1", "K2"]),
      dump,
      db: dbPath,
      apply: true,
      changelog: cl,
    });
    assertEquals(result.applied, true);
    assertExists(result.backupPath);
    assertEquals(Deno.statSync(result.backupPath!).isFile, true);
    // File archived to _deleted/, gone from the live tree.
    assertEquals(Deno.statSync(`${dump}/_deleted/Policy/K3.json`).isFile, true);
    let live = false;
    try {
      Deno.statSync(`${dump}/Policy/K3.json`);
      live = true;
    } catch { /* expected: moved out */ }
    assertEquals(live, false);
    // DB row dropped; changelog recorded the deletion.
    assertEquals(cl.byOp(), { deleted: 1 });
    const db = new DatabaseSync(dbPath);
    assertEquals((db.prepare("SELECT COUNT(*) c FROM articles").get() as { c: number }).c, 2);
    assertEquals(
      (db.prepare("SELECT COUNT(*) c FROM articles WHERE id='K3'").get() as { c: number }).c,
      0,
    );
    db.close();
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("reconcile --purge: hard-removes the file (no archive)", async () => {
  const root = await Deno.makeTempDir();
  try {
    const { dump, dbPath } = seed(root, ["K1", "K2", "K3"]);
    const cl = new Changelog(null, "run");
    const result = await reconcile({
      ...RECONCILE_BASE,
      purge: true,
      client: liveClient(["K1", "K2"]),
      dump,
      db: dbPath,
      apply: true,
      changelog: cl,
    });
    assertEquals(result.applied, true);
    // Gone entirely, and no archive copy.
    let archived = false;
    try {
      Deno.statSync(`${dump}/_deleted/Policy/K3.json`);
      archived = true;
    } catch { /* expected: no archive */ }
    assertEquals(archived, false);
    let live = false;
    try {
      Deno.statSync(`${dump}/Policy/K3.json`);
      live = true;
    } catch { /* expected: removed */ }
    assertEquals(live, false);
    assertEquals(cl.byOp(), { deleted: 1 });
    // Row dropped.
    const db = new DatabaseSync(dbPath);
    assertEquals((db.prepare("SELECT COUNT(*) c FROM articles").get() as { c: number }).c, 2);
    db.close();
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("loadIdsByType / loadLastRunAt: read DB helpers", async () => {
  const root = await Deno.makeTempDir();
  try {
    const { dbPath } = seed(root, ["K1", "K2"]);
    const byType = await loadIdsByType(dbPath, ["Policy", "Manual"]);
    assertEquals([...byType.get("Policy")!].sort(), ["K1", "K2"]);
    assertEquals(byType.get("Manual"), []);

    // No runs rows yet -> null.
    assertEquals(await loadLastRunAt(dbPath), null);
    // Insert a run; loadLastRunAt returns its id + parsed ran_at.
    const db = new DatabaseSync(dbPath);
    db.prepare(
      "INSERT INTO runs (run_id,ran_at,dump_dir,types,scanned,new,changed,unchanged,removed) " +
        "VALUES (?,?,?,?,?,?,?,?,?)",
    ).run("2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z", "/d", "Policy", 2, 2, 0, 0, 0);
    db.close();
    const last = await loadLastRunAt(dbPath);
    assertEquals(last?.runId, "2026-06-01T00:00:00.000Z");
    assertEquals(last?.ranAtMs, Date.parse("2026-06-01T00:00:00.000Z"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
