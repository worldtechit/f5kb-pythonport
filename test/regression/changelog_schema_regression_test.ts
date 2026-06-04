// ===========================================================================
// TEST: changelog JSONL line schema is stable (documented in README.md)
// CATEGORY: regression
// COVERS: lib/changelog.ts (Changelog.record/flush serialization)
// FIXTURES: none
// NETWORK: none (mocked)
// ASSERTS:
//   - every line is a standalone JSON object (valid JSONL)
//   - required keys runId, ts, op, documentType, id are ALWAYS present
//   - optional keys appear only when supplied; no unexpected keys leak
//   - the `op` value is drawn from the documented vocabulary
// If this test fails, the changelog format changed — update README.md's
// "Changelog format" section and any downstream consumers in lockstep.
// ===========================================================================

import { assertEquals } from "@std/assert";
import { Changelog } from "../../lib/changelog.ts";

const REQUIRED = ["runId", "ts", "op", "documentType", "id"];
const OPTIONAL = ["title", "changed", "hashOld", "hashNew", "source", "detail"];
const ALLOWED = new Set([...REQUIRED, ...OPTIONAL]);
const OPS = new Set([
  "added",
  "edited",
  "deleted",
  "body-added",
  "body-changed",
  "body-error",
]);

Deno.test("changelog JSONL: required keys present, no stray keys, known ops", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/_changelog.jsonl`;
  try {
    const cl = new Changelog(path, "2026-06-04T00:00:00.000Z");
    cl.record({ op: "added", documentType: "Policy", id: "K1" }); // minimal
    cl.record({
      op: "edited",
      documentType: "Bug Tracker",
      id: "ID9",
      title: "t",
      changed: ["metadata"],
      hashOld: "a",
      hashNew: "b",
      source: "dump",
      detail: "x",
    }); // maximal
    cl.record({ op: "deleted", documentType: "Manual", id: "M1", source: "reconcile" });
    cl.record({
      op: "body-error",
      documentType: "Manual",
      id: "M2",
      source: "enrich",
      detail: "404",
    });
    await cl.flush();

    const lines = (await Deno.readTextFile(path)).trimEnd().split("\n");
    assertEquals(lines.length, 4);
    for (const line of lines) {
      const rec = JSON.parse(line); // throws if not valid JSON -> fails the test
      for (const k of REQUIRED) {
        assertEquals(k in rec, true, `missing required key "${k}" in ${line}`);
      }
      for (const k of Object.keys(rec)) {
        assertEquals(ALLOWED.has(k), true, `unexpected key "${k}" in ${line}`);
      }
      assertEquals(OPS.has(rec.op), true, `unknown op "${rec.op}"`);
      assertEquals(typeof rec.runId, "string");
      assertEquals(typeof rec.ts, "string");
    }

    // Minimal record carries ONLY the required keys (no undefined optionals leak).
    const minimal = JSON.parse(lines[0]);
    assertEquals(Object.keys(minimal).sort(), [...REQUIRED].sort());
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
