// ===========================================================================
// TEST: flat-article projection helpers (fetch/recent shared)
// CATEGORY: integration
// COVERS: lib/coveo/flat.ts (buildAq, parseResult, toCSV)
// FIXTURES: coveo/search_policy.json
// NETWORK: none
// ASSERTS:
//   - buildAq composes product + type (+ neither) into the Coveo aq syntax
//   - parseResult maps the 5 flat fields (name/link/summary/pub/mod) from a real
//     Coveo result, including the clickUri/title/excerpt path
//   - toCSV emits the fixed header and quote-escapes embedded quotes
// ===========================================================================

import { assertEquals, assertStringIncludes } from "@std/assert";
import { buildAq, type FlatArticle, parseResult, toCSV } from "../../lib/coveo/flat.ts";
import type { CoveoResult } from "../../lib/coveo/client.ts";
import { loadJsonFixture } from "../_helpers/fixtures.ts";

Deno.test("buildAq: product + type, type-only, product-only, neither", () => {
  assertEquals(
    buildAq("BIG-IP", "Knowledge"),
    `@f5_document_type=="Knowledge" @f5_version=="BIG-IP"`,
  );
  assertEquals(buildAq(undefined, "Knowledge"), `@f5_document_type=="Knowledge"`);
  assertEquals(buildAq("BIG-IP", undefined), `@f5_version=="BIG-IP"`);
  assertEquals(buildAq(undefined, undefined), "");
});

Deno.test("parseResult: maps the 5 flat fields from a real Coveo result", () => {
  const data = loadJsonFixture<{ results: CoveoResult[] }>("coveo/search_policy.json");
  const r0 = data.results[0];
  const flat = parseResult(r0);
  // name <- title, link <- clickUri, summary <- excerpt.
  assertEquals(flat.name, r0.title as string);
  assertEquals(flat.link, r0.clickUri as string);
  assertEquals(flat.summary, r0.excerpt as string);
  // Dates are en-US short strings when a timestamp is present (or "" if absent).
  assertEquals(typeof flat.publicationDate, "string");
  assertEquals(typeof flat.modificationDate, "string");
});

Deno.test("toCSV: fixed header + quote escaping", () => {
  const rows: FlatArticle[] = [
    {
      name: 'He said "hi"',
      link: "https://x/1",
      summary: "line one\nline two",
      publicationDate: "Jan 1, 2025",
      modificationDate: "Feb 2, 2025",
    },
  ];
  const csv = toCSV(rows);
  const lines = csv.split("\n");
  assertEquals(lines[0], "Name,Link,Summary,Publication Date,Modification Date");
  // Embedded double-quotes are doubled; newlines collapsed to a space.
  assertStringIncludes(lines[1], '"He said ""hi"""');
  assertStringIncludes(lines[1], '"line one line two"');
});
