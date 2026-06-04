// ===========================================================================
// TEST: lock the field-catalogue output format   CATEGORY: regression
// COVERS: lib/coveo/fields.ts (writeCatalogue, updateCatalogue)
// FIXTURES: none (a synthetic catalogue map)
// NETWORK: none
// ASSERTS:
//   - _catalogue.json rows carry EXACTLY the schema
//     {field, source, section, types, occurrences, coverage, description, sample}
//   - section reflects the type config (content vs metadata vs unselected)
//   - _catalogue.md is a markdown table (header + separator + a row per field)
// ===========================================================================

import { assertEquals } from "@std/assert";
import { type CatalogueEntry, updateCatalogue, writeCatalogue } from "../../lib/coveo/fields.ts";
import type { TypeConfig } from "../../lib/config/types.ts";

const ROW_KEYS = [
  "coverage",
  "description",
  "field",
  "occurrences",
  "sample",
  "section",
  "source",
  "types",
].sort();

Deno.test("writeCatalogue: locked row schema + markdown table", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // Build a small catalogue from two synthetic results.
    const cat = new Map<string, CatalogueEntry>();
    const mkFields = (r: Record<string, unknown>) => {
      const m = new Map<string, { source: "top" | "raw"; value: unknown }>();
      const raw = (r.raw as Record<string, unknown>) ?? {};
      for (const [k, v] of Object.entries(raw)) m.set(k, { source: "raw", value: v });
      for (const [k, v] of Object.entries(r)) {
        if (k === "raw") continue;
        m.set(k, { source: "top", value: v });
      }
      return m;
    };
    const descriptions = { f5_bug_id: "F5 bug number" };
    updateCatalogue(
      cat,
      mkFields({ title: "A", raw: { f5_bug_id: "111", excerpt: "x" } }),
      descriptions,
    );
    updateCatalogue(
      cat,
      mkFields({ title: "B", raw: { f5_bug_id: "222", excerpt: "y" } }),
      descriptions,
    );

    const cfg: TypeConfig = {
      documentType: "Bug Tracker",
      metadata: ["f5_bug_id", "excerpt"],
      content: [], // nothing is "content" -> title is "unselected"
    };
    await writeCatalogue(dir, "Bug_Tracker", "Bug Tracker", cat, 2, cfg);

    const json = JSON.parse(await Deno.readTextFile(`${dir}/_catalogue.json`));
    assertEquals(json.typeKey, "Bug_Tracker");
    assertEquals(json.documentType, "Bug Tracker");
    assertEquals(json.totalEntries, 2);
    assertEquals(Array.isArray(json.fields), true);
    assertEquals(json.fields.length, json.fieldCount);

    // Row schema is exactly the locked key set.
    for (const row of json.fields) {
      assertEquals(Object.keys(row).sort(), ROW_KEYS);
    }
    const byField = Object.fromEntries(json.fields.map((r: { field: string }) => [r.field, r]));
    // section reflects the config.
    assertEquals(byField.f5_bug_id.section, "metadata");
    assertEquals(byField.excerpt.section, "metadata");
    assertEquals(byField.title.section, "unselected");
    // coverage is occurrences/totalEntries.
    assertEquals(byField.f5_bug_id.occurrences, 2);
    assertEquals(byField.f5_bug_id.coverage, 1);
    // description carried through.
    assertEquals(byField.f5_bug_id.description, "F5 bug number");

    // Markdown companion is a table.
    const md = await Deno.readTextFile(`${dir}/_catalogue.md`);
    const lines = md.split("\n");
    assertEquals(lines[0].startsWith("# Field catalogue"), true);
    const headerIdx = lines.findIndex((l) => l.startsWith("| field |"));
    assertEquals(headerIdx >= 0, true);
    assertEquals(lines[headerIdx + 1].startsWith("|---"), true);
    // One data row per catalogued field.
    const dataRows = lines.slice(headerIdx + 2).filter((l) => l.startsWith("| `"));
    assertEquals(dataRows.length, json.fields.length);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
