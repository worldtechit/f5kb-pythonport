// ===========================================================================
// TEST: filesystem/id helpers (name sanitization + per-article id derivation).
// CATEGORY: unit
// COVERS: lib/fsutil.ts (fns: sanitizeName, idOf)
// FIXTURES: none
// NETWORK: none (mocked)
// ASSERTS:
//   - sanitizeName replaces non-[A-Za-z0-9_-] with _, collapses runs, trims edges
//   - idOf candidate precedence: f5_kb_id > permanentid > uniqueId > title > "article"
//   - idOf slices to 120 chars
// ===========================================================================

import { assertEquals } from "@std/assert";
import { idOf, sanitizeName } from "../../lib/fsutil.ts";

Deno.test("sanitizeName: collapse, replace, trim", () => {
  assertEquals(sanitizeName("K123: Hello / World!"), "K123_Hello_World");
  assertEquals(sanitizeName("___leading and trailing___"), "leading_and_trailing");
  assertEquals(sanitizeName("a@@@b"), "a_b");
  assertEquals(sanitizeName("keep-_keep"), "keep-_keep"); // - and _ preserved
});

Deno.test("idOf: f5_kb_id wins over everything", () => {
  const r = {
    raw: { f5_kb_id: "K14448", permanentid: "PID" },
    uniqueId: "UID",
    title: "Some Title",
  };
  assertEquals(idOf(r), "K14448");
});

Deno.test("idOf: permanentid when no f5_kb_id", () => {
  const r = { raw: { permanentid: "abc123" }, uniqueId: "UID", title: "T" };
  assertEquals(idOf(r), "abc123");
});

Deno.test("idOf: uniqueId then title then 'article'", () => {
  assertEquals(idOf({ raw: {}, uniqueId: "UID" }), "UID");
  assertEquals(idOf({ raw: {}, title: "Hello World" }), "Hello_World");
  assertEquals(idOf({}), "article");
  assertEquals(idOf({ raw: {} }), "article");
});

Deno.test("idOf: sanitizes the chosen candidate", () => {
  assertEquals(idOf({ title: "K1: A/B C" }), "K1_A_B_C");
});

Deno.test("idOf: slices to 120 chars", () => {
  const long = "K".repeat(300);
  const id = idOf({ raw: { f5_kb_id: long } });
  assertEquals(id.length, 120);
  assertEquals(id, "K".repeat(120));
});
