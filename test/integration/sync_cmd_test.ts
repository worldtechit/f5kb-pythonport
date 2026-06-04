// ===========================================================================
// TEST: incremental sync orchestrator end-to-end (dump -> track -> detect)
// CATEGORY: integration
// COVERS: lib/sync.ts (syncDump), lib/dump.ts (incremental), lib/track/db.ts
//   (trackDump + loadHashIndex), lib/status.ts (changelog surfacing)
// FIXTURES: coveo/search_policy.json, coveo/count_policy.json
// NETWORK: none — CoveoClient + HttpClient over mock fetch
// ASSERTS:
//   - first sync: 3 added, changelog file written, DB seeded, no deletions
//   - second sync (same upstream): all skipped, nothing added/edited
//   - deletion DETECTION: a DB id absent from the live set is reported (changelog
//     op="deleted", source=sync) but NOT removed
//   - dry-run: classifies but writes no files / DB / changelog
//   - status reads the changelog + shows the last run's ops
// ===========================================================================

import { assertEquals, assertExists } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { syncDump } from "../../lib/sync.ts";
import { computeStatus } from "../../lib/status.ts";
import { CoveoClient } from "../../lib/coveo/client.ts";
import { HttpClient } from "../../lib/http/fetcher.ts";
import type { CoveoConfig } from "../../lib/coveo/aura.ts";
import { makeCoveoMock, noopSleep } from "../_helpers/mock_fetch.ts";

function clients() {
  const mock = makeCoveoMock({
    search: "coveo/search_policy.json",
    count: "coveo/count_policy.json",
    facet: "coveo/facet_products.json",
  });
  const config: CoveoConfig = {
    platformUrl: "https://mock",
    accessToken: "T",
    organizationId: "o",
  };
  const client = new CoveoClient(config, {
    fetch: mock.fetch,
    sleep: noopSleep,
    refresh: () => Promise.resolve(),
  });
  // Policy isn't an enrichable type, so http is never exercised; stub it anyway.
  const http = new HttpClient({ fetch: () => Promise.resolve(new Response("", { status: 404 })) });
  return { client, http };
}

function baseOpts(outDir: string, dbPath: string, nowMs: number) {
  const { client, http } = clients();
  return {
    client,
    http,
    typeConfigs: { Policy: { documentType: "Policy", metadata: "*" as const, content: [] } },
    typeKeys: ["Policy"],
    descriptions: {},
    outDir,
    db: dbPath,
    mode: "all",
    allTime: true,
    cutoffMs: Date.UTC(2000, 0, 1),
    endMs: nowMs + 86400000,
    nowMs,
    pageSize: 50,
    limit: Infinity,
    configPath: "config.yaml",
    enrich: true, // Policy isn't enrichable -> enrich is a no-op
    concurrency: 2,
    delayMs: 0,
    approval: false, // these tests validate the non-gated incremental mechanics
  };
}

Deno.test("syncDump: first run adds, second run skips all", async () => {
  const root = await Deno.makeTempDir();
  const out = `${root}/dump`;
  const dbPath = `${root}/articles.db`;
  const changelogPath = `${out}/_changelog.jsonl`;
  try {
    const r1 = await syncDump({
      ...baseOpts(out, dbPath, Date.UTC(2026, 0, 1)),
      changelogPath,
      dryRun: false,
    });
    assertEquals(r1.written, 3);
    assertEquals(r1.added, 3);
    assertEquals(r1.edited, 0);
    assertEquals(r1.skipped, 0);
    assertEquals(r1.deletionDetectionRan, true);
    assertEquals(r1.deletionsDetected, 0);

    // changelog file has 3 "added" records for this run.
    const lines = (await Deno.readTextFile(changelogPath)).trimEnd().split("\n");
    assertEquals(lines.length, 3);
    assertEquals(lines.every((l) => JSON.parse(l).op === "added"), true);
    assertEquals(lines.every((l) => JSON.parse(l).runId === r1.runId), true);

    // DB seeded with 3 rows.
    const db = new DatabaseSync(dbPath);
    assertEquals((db.prepare("SELECT COUNT(*) c FROM articles").get() as { c: number }).c, 3);
    db.close();

    // Second run, same upstream -> everything skipped.
    const r2 = await syncDump({
      ...baseOpts(out, dbPath, Date.UTC(2026, 0, 2)),
      changelogPath,
      dryRun: false,
    });
    assertEquals(r2.written, 0);
    assertEquals(r2.skipped, 3);
    assertEquals(r2.added, 0);
    assertEquals(r2.edited, 0);
    // No new changelog lines for run 2 (nothing changed).
    const lines2 = (await Deno.readTextFile(changelogPath)).trimEnd().split("\n");
    assertEquals(lines2.filter((l) => JSON.parse(l).runId === r2.runId).length, 0);

    // status surfaces the changelog, and after an incremental run WRIT counts
    // written + skipped (run 2 wrote 0, skipped 3) so it lines up with DISK/EXP.
    const status = await computeStatus({ dump: out, db: dbPath });
    assertEquals(status.overall.changelogPath, changelogPath);
    const policy = status.perType.find((t) => t.typeKey === "Policy")!;
    assertEquals(policy.written, 3); // 0 written + 3 skipped this run
    assertEquals(policy.diskCount, 3);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("syncDump: detects an upstream deletion, reports but does not remove", async () => {
  const root = await Deno.makeTempDir();
  const out = `${root}/dump`;
  const dbPath = `${root}/articles.db`;
  const changelogPath = `${out}/_changelog.jsonl`;
  try {
    await syncDump({
      ...baseOpts(out, dbPath, Date.UTC(2026, 0, 1)),
      changelogPath,
      dryRun: false,
    });

    // Inject a phantom DB row that the live Coveo set will never contain.
    let db = new DatabaseSync(dbPath);
    db.prepare("INSERT INTO articles (document_type,id) VALUES (?,?)").run("Policy", "KPHANTOM");
    db.close();

    const r = await syncDump({
      ...baseOpts(out, dbPath, Date.UTC(2026, 0, 3)),
      changelogPath,
      dryRun: false,
    });
    assertEquals(r.deletionsDetected, 1);
    assertEquals(r.deletions["Policy"], ["KPHANTOM"]);

    // It is REPORTED (changelog op="deleted", source=sync) but not removed: the
    // phantom row still exists (sync never deletes — reconcile does).
    const delLines = (await Deno.readTextFile(changelogPath)).trimEnd().split("\n")
      .map((l) => JSON.parse(l)).filter((r) => r.op === "deleted");
    assertEquals(delLines.length, 1);
    assertEquals(delLines[0].source, "sync");
    db = new DatabaseSync(dbPath);
    assertEquals(
      (db.prepare("SELECT COUNT(*) c FROM articles WHERE id='KPHANTOM'").get() as { c: number }).c,
      1,
    );
    db.close();
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("syncDump: dry-run writes nothing", async () => {
  const root = await Deno.makeTempDir();
  const out = `${root}/dump`;
  const dbPath = `${root}/articles.db`;
  const changelogPath = `${out}/_changelog.jsonl`;
  try {
    const r = await syncDump({
      ...baseOpts(out, dbPath, Date.UTC(2026, 0, 1)),
      changelogPath,
      dryRun: true,
    });
    // Classified as new (added) but nothing persisted.
    assertEquals(r.added, 3);
    assertEquals(r.changelogPath, null);
    let exists = true;
    try {
      Deno.statSync(out);
    } catch {
      exists = false;
    }
    assertEquals(exists, false); // no dump dir created
    let dbExists = true;
    try {
      Deno.statSync(dbPath);
    } catch {
      dbExists = false;
    }
    assertEquals(dbExists, false); // no DB created
    assertExists(r.runId);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
