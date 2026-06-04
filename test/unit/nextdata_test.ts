// ===========================================================================
// TEST: Next.js __NEXT_DATA__ body extraction (MDX compiledSource + swaggerFile).
// CATEGORY: unit
// COVERS: lib/html/nextdata.ts (fns: parseNextData, extractNextDataBody,
//   mdxFromCompiledSource, swaggerToMarkdown)
// FIXTURES: pages/docs_cloud_next_content.html, pages/docs_cloud_next_api.html
// NETWORK: none (mocked)
// ASSERTS:
//   - parseNextData recovers the embedded JSON blob
//   - a compiledSource (prose) page -> recovered MDX markdown
//   - a swaggerFile (API) page -> rendered markdown with the title heading
//   - a page without __NEXT_DATA__ -> null / empty body
// ===========================================================================

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  extractNextDataBody,
  mdxFromCompiledSource,
  parseNextData,
  swaggerToMarkdown,
} from "../../lib/html/nextdata.ts";
import { loadFixture } from "../_helpers/fixtures.ts";

Deno.test("parseNextData: extracts the JSON blob; null when absent", () => {
  const data = parseNextData(loadFixture("pages/docs_cloud_next_content.html"));
  assertEquals(data !== null, true);
  assertEquals(parseNextData("<html><body>no script</body></html>"), null);
});

Deno.test("extractNextDataBody: compiledSource (MDX prose) page", () => {
  const body = extractNextDataBody(loadFixture("pages/docs_cloud_next_content.html"));
  assertEquals(body.length > 100, true);
});

Deno.test("extractNextDataBody: swaggerFile (API) page renders title heading", () => {
  const body = extractNextDataBody(loadFixture("pages/docs_cloud_next_api.html"));
  assertStringIncludes(body, "# F5 Distributed Cloud Services API");
});

Deno.test("extractNextDataBody: empty when no NEXT_DATA / no docData", () => {
  assertEquals(extractNextDataBody("<html><body>plain</body></html>"), "");
});

Deno.test("mdxFromCompiledSource: recovers /* ... */ blocks, drops import/export", () => {
  const compiled = [
    "/* import {x} from 'y' */",
    "var _ = 1;",
    "/* # Heading\n\nbody text */",
    "/* export const z = 2 */",
  ].join("\n");
  const md = mdxFromCompiledSource(compiled);
  assertStringIncludes(md, "# Heading");
  assertStringIncludes(md, "body text");
  assertEquals(md.includes("import"), false);
  assertEquals(md.includes("export"), false);
});

Deno.test("swaggerToMarkdown: title + path/method rendering", () => {
  const md = swaggerToMarkdown({
    info: { title: "My API", description: "desc here" },
    paths: {
      "/things": {
        get: { summary: "List things", description: "returns things" },
        options: { summary: "ignored" }, // non-CRUD verb skipped
      },
    },
  });
  assertStringIncludes(md, "# My API");
  assertStringIncludes(md, "desc here");
  assertStringIncludes(md, "## GET /things");
  assertStringIncludes(md, "**List things**");
  assertEquals(md.includes("ignored"), false);
});
