// ===========================================================================
// TEST: dump orchestration writes the article envelope + manifests
// CATEGORY: integration
// COVERS: lib/dump.ts (dumpTypes) + lib/coveo/fields.ts (writeCatalogue)
// FIXTURES: coveo/search_policy.json, coveo/count_policy.json
// NETWORK: none — a CoveoClient built over makeCoveoMock drives the loop
// ASSERTS:
//   - every written article JSON has EXACTLY the 9 top-level keys
//     (id, documentType, title, link, modifiedMs, modified, capturedAt,
//      metadata, content)
//   - _index.json carries per-type status + counts (types/ok/partial/failed)
//   - _catalogue.json + _catalogue.md are written for the type
// SEAM: dumpTypes() was extracted from cmd/dump.ts's per-type loop; cmd/dump.ts
//   now calls it (and accepts an optional injected client). See report.
// ===========================================================================

import { assertEquals } from "@std/assert";
import { dumpTypes } from "../../lib/dump.ts";
import { CoveoClient } from "../../lib/coveo/client.ts";
import type { CoveoConfig } from "../../lib/coveo/aura.ts";
import { makeCoveoMock, noopSleep } from "../_helpers/mock_fetch.ts";

const EXPECTED_KEYS = [
  "id",
  "documentType",
  "title",
  "link",
  "modifiedMs",
  "modified",
  "capturedAt",
  "metadata",
  "content",
];

function mockClient(): CoveoClient {
  const mock = makeCoveoMock({
    search: "coveo/search_policy.json",
    count: "coveo/count_policy.json",
  });
  const config: CoveoConfig = {
    platformUrl: "https://mock.coveo",
    accessToken: "T",
    organizationId: "org",
  };
  return new CoveoClient(config, {
    fetch: mock.fetch,
    sleep: noopSleep,
    refresh: () => Promise.resolve(),
  });
}

Deno.test("dumpTypes: article envelope (9 keys) + _index.json + catalogue", async () => {
  const root = await Deno.makeTempDir();
  const out = `${root}/dump`;
  try {
    const nowMs = Date.UTC(2026, 0, 1);
    const { manifest, total } = await dumpTypes(mockClient(), {
      typeConfigs: { Policy: { documentType: "Policy", metadata: "*", content: [] } },
      typeKeys: ["Policy"],
      descriptions: {},
      outDir: out,
      allTime: true,
      mode: "all",
      cutoffMs: Date.UTC(2000, 0, 1),
      endMs: nowMs + 86400000,
      nowMs,
      pageSize: 50,
      limit: Infinity,
      configPath: "config.yaml",
    });

    // The keyset mock returns the same 3 results each page -> deduped to 3.
    assertEquals(total, 3);
    assertEquals(manifest.length, 1);
    const st = manifest[0];
    assertEquals(st.typeKey, "Policy");
    assertEquals(st.written, 3);
    assertEquals(st.expected, 223); // from count_policy fixture
    // 3 written < 223 expected under --all -> partial (the dump's own rule).
    assertEquals(st.status, "partial");

    // Every written article file has EXACTLY the 9 envelope keys.
    let files = 0;
    for (const e of Deno.readDirSync(`${out}/Policy`)) {
      if (!e.isFile || !e.name.endsWith(".json") || e.name.startsWith("_")) continue;
      files++;
      const a = JSON.parse(Deno.readTextFileSync(`${out}/Policy/${e.name}`));
      assertEquals(Object.keys(a).sort(), [...EXPECTED_KEYS].sort());
      assertEquals(a.documentType, "Policy");
      assertEquals(typeof a.metadata, "object");
      assertEquals(typeof a.content, "object");
    }
    assertEquals(files, 3);

    // _index.json: per-type status + counts.
    const idx = JSON.parse(Deno.readTextFileSync(`${out}/_index.json`));
    assertEquals(idx.mode, "all");
    assertEquals(idx.totalArticles, 3);
    assertEquals(idx.counts.types, 1);
    assertEquals(idx.counts.ok, 0);
    assertEquals(idx.counts.partial, 1);
    assertEquals(idx.counts.failed, 0);
    assertEquals(idx.types[0].typeKey, "Policy");
    assertEquals(idx.types[0].written, 3);

    // Field catalogue companions exist.
    const cat = JSON.parse(Deno.readTextFileSync(`${out}/Policy/_catalogue.json`));
    assertEquals(cat.typeKey, "Policy");
    assertEquals(cat.documentType, "Policy");
    assertEquals(Array.isArray(cat.fields), true);
    const md = Deno.readTextFileSync(`${out}/Policy/_catalogue.md`);
    assertEquals(md.startsWith("# Field catalogue"), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
