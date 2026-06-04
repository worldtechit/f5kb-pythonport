// ===========================================================================
// TEST: Bug Tracker body extraction (standard sections + CVE field selection).
// CATEGORY: unit
// COVERS: lib/html/bugtracker.ts (fns: parseBugContent, parseLabeledFields)
// FIXTURES: pages/bug_standard.html, pages/bug_cve.html
// NETWORK: none (mocked)
// ASSERTS:
//   - standard template: <h4> sections kept (Symptoms/Impact/Conditions/Workaround/
//     Fix Information/Guides & references); hidden "Behavior Change" skipped; footer
//     h4s (outside div.bug-content) excluded
//   - CVE template: only CVE / Related Article / Vulnerability Severity kept
// ===========================================================================

import { assertArrayIncludes, assertEquals } from "@std/assert";
import { parseBugContent } from "../../lib/html/bugtracker.ts";
import { loadFixture } from "../_helpers/fixtures.ts";

Deno.test("parseBugContent: standard bug -> labelled sections, hidden skipped", () => {
  const sections = parseBugContent(loadFixture("pages/bug_standard.html"));
  const keys = Object.keys(sections);
  assertArrayIncludes(keys, [
    "Symptoms",
    "Impact",
    "Conditions",
    "Workaround",
    "Fix Information",
    "Guides & references",
  ]);
  // Hidden (display:none) "Behavior Change" must be dropped.
  assertEquals(keys.includes("Behavior Change"), false);
  // Site-footer h4s live outside div.bug-content and must not leak in.
  assertEquals(keys.includes("About F5"), false);
  assertEquals(keys.includes("Follow Us"), false);
  // Sections carry non-empty body text.
  for (const k of keys) assertEquals(sections[k].length > 0, true);
});

Deno.test("parseBugContent: CVE template keeps only the vuln fields", () => {
  const sections = parseBugContent(loadFixture("pages/bug_cve.html"));
  const keys = Object.keys(sections).sort();
  assertEquals(keys, ["CVE", "Related Article", "Vulnerability Severity"]);
  // Metadata-duplicating fields must be excluded.
  assertEquals(keys.includes("Affected Product(s)"), false);
  assertEquals(keys.includes("Last Modified"), false);
});
