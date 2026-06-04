// ===========================================================================
// TEST: Changelog JSONL recorder + changelogPathFromFlag resolution
// CATEGORY: unit
// COVERS: lib/changelog.ts (Changelog.record/byOp/total/flush, changelogPathFromFlag)
// FIXTURES: none
// NETWORK: none (mocked)
// ASSERTS:
//   - record() tallies per-op even when path=null (no file written)
//   - flush() appends one JSON object per line, each carrying runId + ts + record
//   - a second flush() appends (does not truncate) and clears the buffer
//   - changelogPathFromFlag: undefined->null, bare/empty->default, string->verbatim
// ===========================================================================

import { assertEquals, assertMatch } from "@std/assert";
import { Changelog, CHANGELOG_BASENAME, changelogPathFromFlag } from "../../lib/changelog.ts";

Deno.test("changelogPathFromFlag: flag value -> path", () => {
  assertEquals(changelogPathFromFlag(undefined, "/d/dump"), null);
  assertEquals(changelogPathFromFlag(true, "/d/dump"), `/d/dump/${CHANGELOG_BASENAME}`);
  assertEquals(changelogPathFromFlag("", "/d/dump"), `/d/dump/${CHANGELOG_BASENAME}`);
  // trailing slash on dir is normalized
  assertEquals(changelogPathFromFlag(true, "/d/dump/"), `/d/dump/${CHANGELOG_BASENAME}`);
  assertEquals(changelogPathFromFlag("custom.jsonl", "/d/dump"), "custom.jsonl");
});

Deno.test("Changelog: counts tally even when disabled (path=null)", async () => {
  const cl = new Changelog(null, "run-1");
  assertEquals(cl.enabled, false);
  cl.record({ op: "added", documentType: "Policy", id: "K1" });
  cl.record({ op: "added", documentType: "Policy", id: "K2" });
  cl.record({ op: "edited", documentType: "Policy", id: "K3" });
  assertEquals(cl.byOp(), { added: 2, edited: 1 });
  assertEquals(cl.total, 3);
  await cl.flush(); // no-op, must not throw
});

Deno.test("Changelog: flush writes JSONL, appends, clears buffer", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/${CHANGELOG_BASENAME}`;
  try {
    const cl = new Changelog(path, "2026-06-04T00:00:00.000Z");
    cl.record({ op: "added", documentType: "Policy", id: "K1", title: "t1", source: "dump" });
    cl.record({
      op: "edited",
      documentType: "Bug Tracker",
      id: "ID862224",
      changed: ["metadata", "updated_published"],
      hashOld: "aaa",
      hashNew: "bbb",
      source: "dump",
    });
    await cl.flush();

    let text = await Deno.readTextFile(path);
    let lines = text.trimEnd().split("\n");
    assertEquals(lines.length, 2);
    const r0 = JSON.parse(lines[0]);
    assertEquals(r0.runId, "2026-06-04T00:00:00.000Z");
    assertEquals(r0.op, "added");
    assertEquals(r0.documentType, "Policy");
    assertEquals(r0.id, "K1");
    assertEquals(r0.source, "dump");
    assertMatch(r0.ts, /^\d{4}-\d{2}-\d{2}T.*Z$/); // ISO timestamp present
    const r1 = JSON.parse(lines[1]);
    assertEquals(r1.op, "edited");
    assertEquals(r1.changed, ["metadata", "updated_published"]);
    assertEquals(r1.hashOld, "aaa");

    // A second flush appends rather than truncating.
    cl.record({ op: "deleted", documentType: "Policy", id: "K9", source: "reconcile" });
    await cl.flush();
    text = await Deno.readTextFile(path);
    lines = text.trimEnd().split("\n");
    assertEquals(lines.length, 3);
    assertEquals(JSON.parse(lines[2]).op, "deleted");

    // byOp reflects every recorded op across both flushes.
    assertEquals(cl.byOp(), { added: 1, edited: 1, deleted: 1 });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
