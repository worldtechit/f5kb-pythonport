// ===========================================================================
// TEST: doc-page body extraction (host-rule selection, chrome stripping, fallbacks).
// CATEGORY: unit
// COVERS: lib/html/docpage.ts (fns: extractDocBody, selectContainer, HOST_RULES)
// FIXTURES: pages/{clouddocs_content,techdocs_kb,docs_nginx,nginx_changelog,
//   clouddocs_landing}.html
// NETWORK: none (mocked)
// ASSERTS:
//   - host-rule container chosen per host; nav/header/footer chrome stripped
//   - clouddocs / techdocs / docs.nginx.com extract substantial body markdown
//   - nginx.org changelog (no standard container) falls back to the <pre> block
//   - selectContainer uses the generic fallback when no rule is given
//   - a too-short body extracted by the doc-page ENRICHER throws (see note)
// NOTE: extractDocBody itself does not enforce a min length (deno-dom always
//   synthesizes a <body>, so "container not found" is unreachable for normal
//   HTML); the <40-char guard lives in enrichDocPage, exercised here against a
//   trivially short page.
// ===========================================================================

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { DOMParser } from "@b-fuze/deno-dom";
import { extractDocBody, HOST_RULES, selectContainer } from "../../lib/html/docpage.ts";
import { enrichDocPage } from "../../lib/enrich/enrichers.ts";
import { HttpClient } from "../../lib/http/fetcher.ts";
import { loadFixture } from "../_helpers/fixtures.ts";
import { makeMockFetch } from "../_helpers/mock_fetch.ts";

Deno.test("extractDocBody: clouddocs.f5.com host rule selects [role=main]", () => {
  const body = extractDocBody(
    loadFixture("pages/clouddocs_content.html"),
    "https://clouddocs.f5.com/x",
    HOST_RULES["clouddocs.f5.com"],
  );
  assertStringIncludes(body, "# LTM Virtual Server");
  assertEquals(body.length > 1000, true);
  // Chrome must be stripped — no nav/footer artifacts.
  assertEquals(/Edit on GitHub/i.test(body), false);
});

Deno.test("extractDocBody: techdocs.f5.com host rule", () => {
  const body = extractDocBody(
    loadFixture("pages/techdocs_kb.html"),
    "https://techdocs.f5.com/x",
    HOST_RULES["techdocs.f5.com"],
  );
  assertStringIncludes(body, "# Configuring HTTP Headers");
  assertEquals(body.length > 500, true);
});

Deno.test("extractDocBody: docs.nginx.com host rule", () => {
  const body = extractDocBody(
    loadFixture("pages/docs_nginx.html"),
    "https://docs.nginx.com/x",
    HOST_RULES["docs.nginx.com"],
  );
  assertEquals(body.length > 500, true);
});

Deno.test("extractDocBody: nginx.org changelog falls back to the <pre> block", () => {
  const body = extractDocBody(
    loadFixture("pages/nginx_changelog.html"),
    "https://nginx.org/x",
    HOST_RULES["nginx.org"],
  );
  // Plain text-file page: rendered inside a fenced code block.
  assertStringIncludes(body, "Changes with nginx");
  assertEquals(body.length > 10000, true);
});

Deno.test("selectContainer: generic fallback when no host rule is supplied", () => {
  const doc = new DOMParser().parseFromString(
    loadFixture("pages/clouddocs_landing.html"),
    "text/html",
  );
  const el = selectContainer(doc, undefined);
  assertEquals(el !== null, true);
});

Deno.test("selectContainer: returns null when no candidate matches", () => {
  const doc = new DOMParser().parseFromString(
    "<html><head></head><body><span></span></body></html>",
    "text/html",
  );
  // No main/article/etc with text content -> null.
  const el = selectContainer(doc, { selectors: ["main", "article"] });
  assertEquals(el, null);
});

Deno.test("enrichDocPage: body shorter than 40 chars throws (too short)", async () => {
  // A mapped host with a tiny rendered body -> extracted body < 40 chars.
  const html = "<html><body><div class='pageContent'>tiny</div></body></html>";
  const mock = makeMockFetch({ urlMap: { "techdocs.f5.com": html } });
  const http = new HttpClient({ fetch: mock.fetch });
  await assertRejects(
    () =>
      enrichDocPage(
        { id: "x", documentType: "Manual", link: "https://techdocs.f5.com/kb/page" },
        new Date().toISOString(),
        { http },
      ),
    Error,
    "too short",
  );
});
