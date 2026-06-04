// ===========================================================================
// TEST: merged config.yaml loading + type normalization defaults.
// CATEGORY: unit
// COVERS: lib/config/loader.ts (fn: loadConfig) + lib/config/types.ts (normalizeType)
// FIXTURES: config.yaml (the committed merged config) + a tiny inline temp yaml
// NETWORK: none (mocked)
// ASSERTS:
//   - loadConfig parses 15 types, 175 field descriptions, 330 products
//   - known type keys are present and structured (documentType/metadata/content)
//   - normalizeType defaults: metadata "*", content []
//   - a yaml missing sections yields empty-but-safe defaults
// ===========================================================================

import { assertArrayIncludes, assertEquals } from "@std/assert";
import { loadConfig } from "../../lib/config/loader.ts";
import { normalizeType } from "../../lib/config/types.ts";

// loadConfig resolves config.yaml relative to cwd; the test task runs from the
// repo root, so the default path works. Resolve explicitly to be cwd-robust.
const CONFIG_PATH = decodeURIComponent(
  new URL("../../config.yaml", import.meta.url).pathname,
);

Deno.test("loadConfig: 15 types, 175 field descriptions, 330 products", async () => {
  const c = await loadConfig(CONFIG_PATH);
  assertEquals(Object.keys(c.types).length, 15);
  assertEquals(Object.keys(c.fieldDescriptions).length, 175);
  assertEquals(c.products.entries.length, 330);
});

Deno.test("loadConfig: known type keys present and well-formed", async () => {
  const c = await loadConfig(CONFIG_PATH);
  assertArrayIncludes(Object.keys(c.types), [
    "Knowledge",
    "Bug_Tracker",
    "Manual",
    "Release_Note",
    "Security_Advisory",
  ]);
  const k = c.types["Knowledge"];
  assertEquals(k.documentType, "Knowledge");
  assertEquals(Array.isArray(k.metadata) || k.metadata === "*", true);
  assertEquals(Array.isArray(k.content) || k.content === "*", true);
});

Deno.test("normalizeType: defaults metadata '*' and content []", () => {
  assertEquals(normalizeType({}), { documentType: "", metadata: "*", content: [] });
  assertEquals(
    normalizeType({ documentType: "X", content: ["a"] }),
    { documentType: "X", metadata: "*", content: ["a"] },
  );
});

Deno.test("loadConfig: missing sections -> safe empty defaults", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".yaml" });
  try {
    await Deno.writeTextFile(tmp, "types:\n  Foo:\n    documentType: Foo\n");
    const c = await loadConfig(tmp);
    assertEquals(Object.keys(c.types), ["Foo"]);
    assertEquals(c.fieldDescriptions, {}); // section absent -> {}
    assertEquals(c.products, { entries: [] }); // section absent -> { entries: [] }
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("loadConfig: empty file -> all-empty config", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".yaml" });
  try {
    await Deno.writeTextFile(tmp, "");
    const c = await loadConfig(tmp);
    assertEquals(c.types, {});
    assertEquals(c.fieldDescriptions, {});
    assertEquals(c.products, { entries: [] });
  } finally {
    await Deno.remove(tmp);
  }
});
