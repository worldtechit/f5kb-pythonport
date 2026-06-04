// ===========================================================================
// TEST: status report over a seeded dump + tracking DB   CATEGORY: integration
// COVERS: lib/status.ts (computeStatus, renderStatus)
// FIXTURES: none (a temp dump + temp DB seeded in-test)
// NETWORK: none
// ASSERTS:
//   - computeStatus reads _index.json per-type + on-disk file counts + DB rows
//   - overall health/counts are sane for a fresh complete dump (OK)
//   - renderStatus emits a multi-line health report mentioning the type
// ===========================================================================

import { assertEquals, assertStringIncludes } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { computeStatus, renderStatus } from "../../lib/status.ts";
import { initDb, trackDump } from "../../lib/track/db.ts";

Deno.test("computeStatus + renderStatus: seeded dump -> sane health/counts", async () => {
  const root = await Deno.makeTempDir();
  const dump = `${root}/dump`;
  const db = `${root}/articles.db`;
  try {
    // Two article files under one type.
    await Deno.mkdir(`${dump}/Knowledge`, { recursive: true });
    const mk = (id: string, body: string) => ({
      id,
      documentType: "Knowledge",
      title: id,
      link: `https://my.f5.com/manage/s/article/${id}`,
      modifiedMs: Date.UTC(2025, 0, 1),
      capturedAt: new Date().toISOString(),
      metadata: { f5_kb_id: id },
      content: { sfdetails__c: body },
    });
    await Deno.writeTextFile(`${dump}/Knowledge/K1.json`, JSON.stringify(mk("K1", "<p>one</p>")));
    await Deno.writeTextFile(`${dump}/Knowledge/K2.json`, JSON.stringify(mk("K2", "<p>two</p>")));

    // _index.json the dump would have written.
    await Deno.writeTextFile(
      `${dump}/_index.json`,
      JSON.stringify({
        mode: "all",
        types: [{ typeKey: "Knowledge", status: "ok", expected: 2, written: 2 }],
      }),
    );

    // Build the DB via the real tracker so rows/run are consistent.
    void initDb; // schema sanity import
    const sum = await trackDump({ dump, db, runId: "R1" });
    assertEquals(sum.new, 2);

    const rep = await computeStatus({ dump, db });
    assertEquals(rep.dbPresent, true);
    assertEquals(rep.overall.totalArticles, 2);
    assertEquals(rep.overall.bodied, 2); // both have a body
    assertEquals(rep.overall.health, "OK");
    assertEquals(rep.overall.lastRun?.runId, "R1");
    const kn = rep.perType.find((t) => t.typeKey === "Knowledge")!;
    assertEquals(kn.diskCount, 2);
    assertEquals(kn.expected, 2);
    assertEquals(kn.written, 2);
    assertEquals(kn.status, "ok");

    const text = renderStatus(rep);
    assertStringIncludes(text, "Status: OK");
    assertStringIncludes(text, "Knowledge");
    assertEquals(text.split("\n").length > 3, true);

    // Sanity: the DB really was written read-consistently.
    const ro = new DatabaseSync(db);
    const c = ro.prepare("SELECT COUNT(*) AS c FROM articles").get() as { c: number };
    assertEquals(c.c, 2);
    ro.close();
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
