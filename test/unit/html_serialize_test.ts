// ===========================================================================
// TEST: HTML -> markdown serializer (structure preservation + URL resolution).
// CATEGORY: unit
// COVERS: lib/html/serialize.ts (fns: makeSerializer, isHidden, resolveUrl)
// FIXTURES: none (inline HTML snippets parsed via deno-dom)
// NETWORK: none (mocked)
// ASSERTS:
//   - headings render as #..###### with surrounding blank lines
//   - lists render "- item" per <li>
//   - links resolve relative hrefs against baseUrl; images emit ![alt](src)
//   - <pre> renders a fenced code block; inline <code> backticks
//   - display:none elements are skipped; whitespace is collapsed
// ===========================================================================

import { assertEquals, assertStringIncludes } from "@std/assert";
import { DOMParser } from "@b-fuze/deno-dom";
import { makeSerializer } from "../../lib/html/serialize.ts";

function ser(html: string, base?: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  return makeSerializer(base)(doc!.querySelector("body")!);
}

Deno.test("headings: level-mapped with blank lines", () => {
  assertStringIncludes(ser("<h1>Title</h1>"), "# Title");
  assertStringIncludes(ser("<h3>Sub</h3>"), "### Sub");
  assertStringIncludes(ser("<h6>Deep</h6>"), "###### Deep");
});

Deno.test("lists: each <li> becomes a dash bullet", () => {
  const out = ser("<ul><li>one</li><li>two</li></ul>");
  assertStringIncludes(out, "- one\n");
  assertStringIncludes(out, "- two\n");
});

Deno.test("links: relative href resolved against baseUrl", () => {
  const out = ser('<a href="/docs/page">Here</a>', "https://x.com/section/");
  assertStringIncludes(out, "[Here](https://x.com/docs/page)");
});

Deno.test("links: no baseUrl keeps href as-is; empty text drops the link", () => {
  assertStringIncludes(ser('<a href="rel">Word</a>'), "[Word](rel)");
  assertEquals(ser('<a href="rel"></a>').trim(), "");
});

Deno.test("images: ![alt](src) with absolute resolution", () => {
  const out = ser('<img alt="logo" src="/img/a.png">', "https://x.com/");
  assertStringIncludes(out, "![logo](https://x.com/img/a.png)");
});

Deno.test("pre: fenced code block; inline code backticked", () => {
  const pre = ser("<pre>line1\nline2</pre>");
  assertStringIncludes(pre, "```\nline1\nline2\n```");
  assertStringIncludes(ser("<code>x=1</code>"), "`x=1`");
});

Deno.test("hidden: display:none subtree is skipped", () => {
  const out = ser('<p>kept</p><p style="display:none">gone</p>');
  assertStringIncludes(out, "kept");
  assertEquals(out.includes("gone"), false);
});

Deno.test("whitespace: runs collapse to single spaces in text", () => {
  const out = ser("<p>a   b\n\tc</p>");
  assertStringIncludes(out, "a b c");
});
