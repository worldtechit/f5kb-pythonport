// ===========================================================================
// TEST: field flattening, metadata/content splitting, catalogue type/sample.
// CATEGORY: unit
// COVERS: lib/coveo/fields.ts (fns: flattenFields, splitEntry, jsType, sampleOf)
// FIXTURES: none (synthetic Coveo result built inline)
// NETWORK: none (mocked)
// ASSERTS:
//   - flattenFields merges raw.* + top-level; top-level wins on a name clash
//   - splitEntry: content selection wins over metadata; "*" selects all
//   - jsType: null/list/string/number/object discrimination
//   - sampleOf: whitespace-collapsed, truncated to 200 chars + ellipsis
// ===========================================================================

import { assertEquals } from "@std/assert";
import { flattenFields, jsType, sampleOf, splitEntry } from "../../lib/coveo/fields.ts";
import type { TypeConfig } from "../../lib/config/types.ts";

function synthResult() {
  return {
    title: "Top Title",
    uniqueId: "UID",
    clash: "TOP_WINS",
    raw: {
      f5_kb_id: "K1",
      clash: "raw_value",
      n: 42,
      list: ["a", "b"],
    },
  };
}

Deno.test("flattenFields: raw + top merged, top-level overrides on clash", () => {
  const f = flattenFields(synthResult());
  assertEquals(f.get("title"), { source: "top", value: "Top Title" });
  assertEquals(f.get("f5_kb_id"), { source: "raw", value: "K1" });
  // clash present in both -> top-level wins, source flips to "top"
  assertEquals(f.get("clash"), { source: "top", value: "TOP_WINS" });
  // `raw` itself is never a flattened key
  assertEquals(f.has("raw"), false);
});

Deno.test("splitEntry: content wins over metadata even when metadata is '*'", () => {
  const fields = flattenFields(synthResult());
  const cfg: TypeConfig = {
    documentType: "X",
    metadata: "*",
    content: ["f5_kb_id"],
  };
  const { metadata, content } = splitEntry(fields, cfg);
  // f5_kb_id is content-selected -> must NOT also be in metadata
  assertEquals(content.f5_kb_id, "K1");
  assertEquals("f5_kb_id" in metadata, false);
  // everything else falls under metadata "*"
  assertEquals(metadata.title, "Top Title");
  assertEquals(metadata.clash, "TOP_WINS");
});

Deno.test("splitEntry: explicit metadata list, empty content", () => {
  const fields = flattenFields(synthResult());
  const cfg: TypeConfig = {
    documentType: "X",
    metadata: ["title", "n"],
    content: [],
  };
  const { metadata, content } = splitEntry(fields, cfg);
  assertEquals(metadata, { title: "Top Title", n: 42 });
  assertEquals(content, {});
});

Deno.test("jsType: discriminates null/list/string/number/object", () => {
  assertEquals(jsType(null), "null");
  assertEquals(jsType([1, 2]), "list");
  assertEquals(jsType("s"), "string");
  assertEquals(jsType(3), "number");
  assertEquals(jsType({ a: 1 }), "object");
});

Deno.test("sampleOf: collapses whitespace and truncates at 200 chars", () => {
  assertEquals(sampleOf("  a\n\t b   c "), "a b c");
  assertEquals(sampleOf(["x", "y"]), '["x","y"]');
  assertEquals(sampleOf(null), "");
  assertEquals(sampleOf(undefined), "");
  const long = "z".repeat(250);
  const out = sampleOf(long);
  assertEquals(out.length, 201); // 200 chars + the ellipsis character
  assertEquals(out.endsWith("…"), true);
  assertEquals(out.slice(0, 200), "z".repeat(200));
});
