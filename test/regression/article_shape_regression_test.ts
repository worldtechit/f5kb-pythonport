// ===========================================================================
// TEST: lock the per-article JSON envelope across the whole dump_mini corpus
// CATEGORY: regression
// COVERS: dump output envelope (lib/dump.ts dumpTypes / enrich content shape)
// FIXTURES: dump_mini/<Type>/*.json (25 real articles, 13 types)
// NETWORK: none
// ASSERTS:
//   - every article has EXACTLY the 9 top-level keys
//   - metadata + content are objects
//   - for the 5 enriched types, a non-empty content carries body_text | sections
//     | bodyError (never an enriched-but-bodyless envelope)
// ===========================================================================

import { assertEquals } from "@std/assert";
import { fixturePath } from "../_helpers/fixtures.ts";

const DUMP_MINI = fixturePath("dump_mini");

const EXPECTED_KEYS = [
  "capturedAt",
  "content",
  "documentType",
  "id",
  "link",
  "metadata",
  "modified",
  "modifiedMs",
  "title",
].sort();

const ENRICHED_TYPES = new Set([
  "Bug_Tracker",
  "Manual",
  "Release_Note",
  "Supplemental_Document",
  "F5_GitHub",
]);

function* articleFiles(): Generator<{ type: string; path: string }> {
  for (const t of Deno.readDirSync(DUMP_MINI)) {
    if (!t.isDirectory) continue;
    for (const f of Deno.readDirSync(`${DUMP_MINI}/${t.name}`)) {
      if (f.isFile && f.name.endsWith(".json") && !f.name.startsWith("_")) {
        yield { type: t.name, path: `${DUMP_MINI}/${t.name}/${f.name}` };
      }
    }
  }
}

Deno.test("article envelope: every dump_mini file has exactly the 9 keys", () => {
  let count = 0;
  for (const { type, path } of articleFiles()) {
    count++;
    const a = JSON.parse(Deno.readTextFileSync(path));
    assertEquals(
      Object.keys(a).sort(),
      EXPECTED_KEYS,
      `${path} top-level keys`,
    );
    assertEquals(typeof a.metadata, "object", `${path} metadata`);
    assertEquals(a.metadata !== null, true, `${path} metadata not null`);
    assertEquals(typeof a.content, "object", `${path} content`);
    assertEquals(a.content !== null, true, `${path} content not null`);

    if (ENRICHED_TYPES.has(type)) {
      const c = a.content as Record<string, unknown>;
      const keys = Object.keys(c);
      // A non-empty content for an enriched type must carry a body signal.
      if (keys.length > 0) {
        const hasSignal = typeof c.body_text === "string" ||
          typeof c.sections === "object" ||
          typeof c.bodyError === "string";
        assertEquals(
          hasSignal,
          true,
          `${path} enriched content lacks body_text|sections|bodyError`,
        );
      }
    }
  }
  // Guard against an empty corpus silently passing.
  assertEquals(count >= 25, true, `expected >=25 articles, saw ${count}`);
});
