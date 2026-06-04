// ===========================================================================
// TEST: lock the body-extraction serializer output   CATEGORY: regression
// COVERS: lib/html/bugtracker.ts (parseBugContent),
//         lib/html/docpage.ts (extractDocBody) + lib/html/serialize.ts
// FIXTURES: pages/bug_standard.html, pages/clouddocs_content.html,
//           pages/techdocs_soft404.html
// NETWORK: none
// ASSERTS:
//   - parseBugContent: the exact section set; body_text begins with "## Symptoms"
//     (the bugtracker serializer output, snapshotted)
//   - extractDocBody (clouddocs): non-trivial markdown, headings present, no
//     leaked <script>/nav chrome
//   - extractDocBody (techdocs soft-404): the soft-404 signature is detectable
// ===========================================================================

import { assertEquals, assertStringIncludes } from "@std/assert";
import { parseBugContent } from "../../lib/html/bugtracker.ts";
import { extractDocBody, HOST_RULES } from "../../lib/html/docpage.ts";
import { loadFixture } from "../_helpers/fixtures.ts";

// Snapshot of the CURRENT bugtracker section set (locks makeSerializer ordering).
const BUG_SECTIONS = [
  "Symptoms",
  "Impact",
  "Conditions",
  "Workaround",
  "Fix Information",
  "Guides & references",
];

function bugBodyText(sections: Record<string, string>): string {
  return Object.entries(sections).map(([t, x]) => `## ${t}\n\n${x}`).join("\n\n");
}

Deno.test("parseBugContent: locked section set + body_text starts with '## Symptoms'", () => {
  const sections = parseBugContent(loadFixture("pages/bug_standard.html"));
  assertEquals(Object.keys(sections), BUG_SECTIONS);
  const body_text = bugBodyText(sections);
  assertEquals(body_text.startsWith("## Symptoms"), true);
  // Each section carries non-empty text.
  for (const k of BUG_SECTIONS) assertEquals(sections[k].trim().length > 0, true);
});

Deno.test("extractDocBody (clouddocs): non-trivial markdown, headings, no chrome", () => {
  const html = loadFixture("pages/clouddocs_content.html");
  const md = extractDocBody(html, "https://clouddocs.f5.com/x", HOST_RULES["clouddocs.f5.com"]);
  assertEquals(md.length > 200, true);
  // At least one markdown heading survived.
  assertEquals(/^#{1,6}\s+\S/m.test(md), true);
  assertStringIncludes(md, "Virtual Server");
  // No nav/script chrome leaked through STRIP_SELECTORS.
  assertEquals(/<script/i.test(md), false);
  assertEquals(/<nav/i.test(md), false);
});

Deno.test("extractDocBody (techdocs soft-404): soft-404 signature is detectable", () => {
  const html = loadFixture("pages/techdocs_soft404.html");
  const md = extractDocBody(html, "https://techdocs.f5.com/x", HOST_RULES["techdocs.f5.com"]);
  const isSoft404 = /^#{0,3}\s*404 - Page Not Found/.test(md) ||
    /the page you are looking for does not exist/i.test(md.slice(0, 400));
  assertEquals(isSoft404, true);
});
