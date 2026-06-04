// ===========================================================================
// TEST: change-tracking pipeline over a real mini dump   CATEGORY: integration
// COVERS: lib/track/db.ts (trackDump, initDb, diffFields) FIXTURES: dump_mini/*
// NETWORK: none (mocked)
// ASSERTS:
//   - first run over the mini dump -> every article `new`
//   - re-run, no changes -> every article `unchanged` (0 new/changed)
//   - mutate one article's content -> exactly that one `changed`, rest unchanged
//   - the `runs` row records scanned/new/changed/unchanged/removed for the run
//   - `removed` is scoped to the SCANNED types (a type not scanned is untouched)
//   - the returned Summary (the --json payload) carries the expected counts
// ===========================================================================

import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { trackDump } from "../../lib/track/db.ts";
import { fixturePath } from "../_helpers/fixtures.ts";

const DUMP_MINI = fixturePath("dump_mini");

// Copy the committed dump_mini tree into a writable temp dir so the mutation
// step doesn't touch the fixtures.
async function copyDump(): Promise<{ root: string; dump: string }> {
  const root = await Deno.makeTempDir();
  const dump = `${root}/dump`;
  await Deno.mkdir(dump, { recursive: true });
  for await (const typeEntry of Deno.readDir(DUMP_MINI)) {
    if (!typeEntry.isDirectory) continue;
    const srcDir = `${DUMP_MINI}/${typeEntry.name}`;
    const dstDir = `${dump}/${typeEntry.name}`;
    await Deno.mkdir(dstDir, { recursive: true });
    for await (const f of Deno.readDir(srcDir)) {
      if (f.isFile) await Deno.copyFile(`${srcDir}/${f.name}`, `${dstDir}/${f.name}`);
    }
  }
  return { root, dump };
}

function countArticleFiles(dump: string): number {
  let n = 0;
  for (const typeEntry of Deno.readDirSync(dump)) {
    if (!typeEntry.isDirectory) continue;
    for (const f of Deno.readDirSync(`${dump}/${typeEntry.name}`)) {
      if (f.isFile && f.name.endsWith(".json") && !f.name.startsWith("_")) n++;
    }
  }
  return n;
}

Deno.test("trackDump: new -> unchanged -> one changed, runs row + scoped removed", async () => {
  const { root, dump } = await copyDump();
  const db = `${root}/articles.db`;
  try {
    const total = countArticleFiles(dump);
    assertEquals(total > 0, true);

    // --- Run 1: everything is new. ---
    const r1 = await trackDump({ dump, db, runId: "RUN1" });
    assertEquals(r1.scanned, total);
    assertEquals(r1.new, total);
    assertEquals(r1.changed, 0);
    assertEquals(r1.unchanged, 0);
    assertEquals(r1.removed, 0);
    assertEquals(r1.runId, "RUN1");

    // --- Run 2: identical dump -> all unchanged. ---
    const r2 = await trackDump({ dump, db, runId: "RUN2" });
    assertEquals(r2.scanned, total);
    assertEquals(r2.new, 0);
    assertEquals(r2.changed, 0);
    assertEquals(r2.unchanged, total);
    assertEquals(r2.removed, 0);

    // --- Mutate ONE article's content body, re-run. ---
    const target = `${dump}/Knowledge/K14448.json`;
    const a = JSON.parse(await Deno.readTextFile(target));
    a.content.sfdetails__c = (a.content.sfdetails__c ?? "") + "<p>APPENDED CHANGE</p>";
    await Deno.writeTextFile(target, JSON.stringify(a, null, 2));

    const r3 = await trackDump({ dump, db, runId: "RUN3" });
    assertEquals(r3.scanned, total);
    assertEquals(r3.new, 0);
    assertEquals(r3.changed, 1);
    assertEquals(r3.unchanged, total - 1);
    assertEquals(r3.removed, 0);

    // The `changes` row for RUN3 names the mutated article + the content field.
    const ro = new DatabaseSync(db);
    const chg = ro.prepare(
      "SELECT document_type,id,change_type,detail FROM changes WHERE run_id='RUN3' AND change_type='changed'",
    ).all() as Array<{ document_type: string; id: string; change_type: string; detail: string }>;
    assertEquals(chg.length, 1);
    assertEquals(chg[0].id, "K14448");
    assertEquals(chg[0].detail.includes("content"), true);

    // The `runs` row for RUN3 mirrors the Summary.
    const run = ro.prepare("SELECT * FROM runs WHERE run_id='RUN3'").get() as {
      scanned: number;
      new: number;
      changed: number;
      unchanged: number;
      removed: number;
    };
    assertEquals(run.scanned, total);
    assertEquals(run.new, 0);
    assertEquals(run.changed, 1);
    assertEquals(run.unchanged, total - 1);
    assertEquals(run.removed, 0);
    ro.close();

    // --- removed is scoped to scanned types. Scan ONLY Knowledge: the other
    //     types' rows must NOT be reported removed (they weren't scanned). ---
    const r4 = await trackDump({ dump, db, runId: "RUN4", types: ["Knowledge"] });
    assertEquals(r4.types, 1);
    assertEquals(r4.scanned, countTypeFiles(dump, "Knowledge"));
    assertEquals(r4.removed, 0); // every scanned (Knowledge) row was present

    const ro2 = new DatabaseSync(db);
    const removedRows = ro2.prepare(
      "SELECT DISTINCT document_type FROM changes WHERE run_id='RUN4' AND change_type='removed'",
    ).all() as Array<{ document_type: string }>;
    // No non-Knowledge type may appear as removed in the Knowledge-only run.
    for (const r of removedRows) assertEquals(r.document_type, "Knowledge");
    ro2.close();

    // --- Now actually remove a Knowledge article and scan Knowledge only. ---
    await Deno.remove(`${dump}/Knowledge/K7850.json`);
    const r5 = await trackDump({ dump, db, runId: "RUN5", types: ["Knowledge"] });
    assertEquals(r5.removed, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

function countTypeFiles(dump: string, typeKey: string): number {
  let n = 0;
  for (const f of Deno.readDirSync(`${dump}/${typeKey}`)) {
    if (f.isFile && f.name.endsWith(".json") && !f.name.startsWith("_")) n++;
  }
  return n;
}
