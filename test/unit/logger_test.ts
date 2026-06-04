// ===========================================================================
// TEST: structured leveled logger (gating, scope prefix, json shape, sink).
// CATEGORY: unit
// COVERS: lib/logger.ts (fn: makeLogger; NULL_LOGGER)
// FIXTURES: none
// NETWORK: none (mocked)
// ASSERTS:
//   - level gating: messages below the threshold are suppressed
//   - text mode: scope renders as "[scope]" prefix; level is upper-cased/padded
//   - child() composes scopes ("a:b")
//   - json mode: one JSON object per line with level/scope/msg + meta merged
//   - a custom write sink captures every emitted line
// ===========================================================================

import { assertEquals, assertStringIncludes } from "@std/assert";
import { makeLogger } from "../../lib/logger.ts";

function sink() {
  const lines: string[] = [];
  return { lines, write: (l: string) => lines.push(l) };
}

Deno.test("level gating: info logger suppresses debug/trace", () => {
  const s = sink();
  const log = makeLogger({ level: "info", write: s.write });
  log.error("e");
  log.warn("w");
  log.info("i");
  log.debug("d");
  log.trace("t");
  assertEquals(s.lines.length, 3);
});

Deno.test("text mode: scope prefix + padded upper level", () => {
  const s = sink();
  const log = makeLogger({ level: "info", scope: "dump", write: s.write });
  log.info("hello");
  assertStringIncludes(s.lines[0], "[dump] hello");
  assertStringIncludes(s.lines[0], "INFO ");
});

Deno.test("text mode: meta object appended as JSON", () => {
  const s = sink();
  const log = makeLogger({ level: "info", write: s.write });
  log.info("msg", { n: 3 });
  assertStringIncludes(s.lines[0], '{"n":3}');
});

Deno.test("child(): composes nested scopes", () => {
  const s = sink();
  const log = makeLogger({ level: "info", scope: "a", write: s.write }).child("b");
  log.info("x");
  assertStringIncludes(s.lines[0], "[a:b] x");
});

Deno.test("json mode: one object per line with level/scope/msg + meta", () => {
  const s = sink();
  const log = makeLogger({ level: "info", scope: "enrich", json: true, write: s.write });
  log.warn("oops", { id: "K1" });
  const obj = JSON.parse(s.lines[0]);
  assertEquals(obj.level, "warn");
  assertEquals(obj.scope, "enrich");
  assertEquals(obj.msg, "oops");
  assertEquals(obj.id, "K1");
  assertEquals(typeof obj.ts, "string");
});

Deno.test("custom write sink captures lines", () => {
  const s = sink();
  const log = makeLogger({ level: "trace", write: s.write });
  log.trace("a");
  log.debug("b");
  assertEquals(s.lines.length, 2);
});
