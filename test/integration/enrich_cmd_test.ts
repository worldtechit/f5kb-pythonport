// ===========================================================================
// TEST: body-enrichment driver over a temp dump   CATEGORY: integration
// COVERS: lib/enrich/driver.ts (enrichDump, enrichType) + enrichers
// FIXTURES: pages/bug_standard.html, pages/clouddocs_content.html
// NETWORK: none — HttpClient built with makeMockFetch URL routing
// ASSERTS:
//   - Bug_Tracker article (f5_bug_id -> cdn.f5.com) gets sections + body_text
//   - Manual article (clouddocs.f5.com link) gets body_text from the DOM
//   - _enrich_report.json carries the per-type {files, enriched, failed, skipped}
//   - resumability: a 2nd run with already-bodied articles skips them
//   - --refetch-errors re-processes ONLY the article that previously errored
// ===========================================================================

import { assertEquals, assertStringIncludes } from "@std/assert";
import { enrichDump } from "../../lib/enrich/driver.ts";
import { HttpClient } from "../../lib/http/fetcher.ts";
import { makeMockFetch, noopSleep } from "../_helpers/mock_fetch.ts";
import { loadFixture } from "../_helpers/fixtures.ts";

// Unenriched article stubs (content has no body yet, so they will be processed).
const BUG = {
  id: "ID1991717",
  documentType: "Bug Tracker",
  title: "Some bug",
  link: "https://cdn.f5.com/product/bugtracker/ID1991717.html",
  metadata: { f5_bug_id: "1991717" },
  content: {},
};
const MANUAL = {
  id: "manual-1",
  documentType: "Manual",
  title: "LTM Virtual Server",
  link: "https://clouddocs.f5.com/manuals/ltm/virtual-server.html",
  metadata: {},
  content: {},
};

async function seedDump(): Promise<{ root: string; dump: string }> {
  const root = await Deno.makeTempDir();
  const dump = `${root}/dump`;
  await Deno.mkdir(`${dump}/Bug_Tracker`, { recursive: true });
  await Deno.mkdir(`${dump}/Manual`, { recursive: true });
  await Deno.writeTextFile(`${dump}/Bug_Tracker/${BUG.id}.json`, JSON.stringify(BUG, null, 2));
  await Deno.writeTextFile(`${dump}/Manual/${MANUAL.id}.json`, JSON.stringify(MANUAL, null, 2));
  return { root, dump };
}

function mockHttp() {
  const mock = makeMockFetch({
    urlMap: {
      "cdn.f5.com": loadFixture("pages/bug_standard.html"),
      "clouddocs.f5.com": loadFixture("pages/clouddocs_content.html"),
    },
  });
  return { mock, http: new HttpClient({ fetch: mock.fetch, sleep: noopSleep }) };
}

const baseOpts = {
  concurrency: 2,
  delayMs: 0,
  limit: null,
  refetch: false,
  refetchErrors: false,
  sleep: noopSleep,
};

Deno.test("enrichDump: writes bodies, report shape, resumability, --refetch-errors", async () => {
  const { root, dump } = await seedDump();
  try {
    // ----- Run 1: both articles enriched. -----
    const { mock, http } = mockHttp();
    const reports = await enrichDump({
      dump,
      http,
      types: ["Bug_Tracker", "Manual"],
      ...baseOpts,
    });
    const calls1 = mock.count;

    const bug = JSON.parse(await Deno.readTextFile(`${dump}/Bug_Tracker/${BUG.id}.json`));
    assertStringIncludes(bug.content.body_text, "## Symptoms");
    assertEquals(typeof bug.content.sections, "object");
    assertEquals(Object.keys(bug.content.sections).includes("Symptoms"), true);
    assertEquals(bug.content.bodySource, BUG.link);

    const man = JSON.parse(await Deno.readTextFile(`${dump}/Manual/${MANUAL.id}.json`));
    assertStringIncludes(man.content.body_text, "Virtual Server");
    assertEquals(man.content.bodyError, undefined);

    // _enrich_report.json shape.
    const report = JSON.parse(await Deno.readTextFile(`${dump}/_enrich_report.json`));
    assertEquals(typeof report.generatedAt, "string");
    assertEquals(Array.isArray(report.types), true);
    const byType = Object.fromEntries(report.types.map((t: { typeKey: string }) => [t.typeKey, t]));
    assertEquals(byType.Bug_Tracker.files, 1);
    assertEquals(byType.Bug_Tracker.enriched, 1);
    assertEquals(byType.Bug_Tracker.failed, 0);
    assertEquals(byType.Bug_Tracker.skipped, 0);
    assertEquals(byType.Manual.enriched, 1);
    // The returned reports mirror the on-disk file.
    assertEquals(reports.length, 2);

    // ----- Run 2: both already bodied -> skipped, no new fetches. -----
    const { mock: mock2, http: http2 } = mockHttp();
    await enrichDump({ dump, http: http2, types: ["Bug_Tracker", "Manual"], ...baseOpts });
    assertEquals(mock2.count, 0); // nothing re-fetched
    const report2 = JSON.parse(await Deno.readTextFile(`${dump}/_enrich_report.json`));
    const bt2 = report2.types.find((t: { typeKey: string }) => t.typeKey === "Bug_Tracker");
    assertEquals(bt2.skipped, 1);
    assertEquals(bt2.enriched, 0);

    // ----- Inject an error into the Manual article, then --refetch-errors. -----
    const manObj = JSON.parse(await Deno.readTextFile(`${dump}/Manual/${MANUAL.id}.json`));
    delete manObj.content.body_text;
    delete manObj.content.sections;
    manObj.content.bodyError = "HTTP 500";
    await Deno.writeTextFile(`${dump}/Manual/${MANUAL.id}.json`, JSON.stringify(manObj, null, 2));

    const { mock: mock3, http: http3 } = mockHttp();
    await enrichDump({
      dump,
      http: http3,
      types: ["Bug_Tracker", "Manual"],
      ...baseOpts,
      refetchErrors: true,
    });
    // Only the errored Manual is re-fetched; the bodied Bug_Tracker is skipped.
    assertEquals(mock3.count, 1);
    const report3 = JSON.parse(await Deno.readTextFile(`${dump}/_enrich_report.json`));
    const m3 = report3.types.find((t: { typeKey: string }) => t.typeKey === "Manual");
    assertEquals(m3.enriched, 1);
    assertEquals(m3.skipped, 0);
    const bt3 = report3.types.find((t: { typeKey: string }) => t.typeKey === "Bug_Tracker");
    assertEquals(bt3.skipped, 1);

    // Manual now has a body again (error cleared).
    const manFixed = JSON.parse(await Deno.readTextFile(`${dump}/Manual/${MANUAL.id}.json`));
    assertStringIncludes(manFixed.content.body_text, "Virtual Server");
    assertEquals(manFixed.content.bodyError, undefined);

    void calls1;
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
