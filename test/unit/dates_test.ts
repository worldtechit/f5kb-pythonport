// ===========================================================================
// TEST: Coveo date helpers (UTC formatting, aq bounds, mod-time precedence).
// CATEGORY: unit
// COVERS: lib/coveo/dates.ts (fns: toCoveoDate, dateAq, modMsOf, formatDate)
// FIXTURES: none
// NETWORK: none (mocked)
// ASSERTS:
//   - toCoveoDate renders UTC YYYY/MM/DD@HH:MM:SS with zero-padding + @ join
//   - dateAq emits @date>= / @date< for each provided bound, joined by a space
//   - modMsOf prefers f5_updated_published_date > sflastmodifieddate > date
//   - formatDate renders "MMM D, YYYY" (UTC) and "" for null/undefined
// ===========================================================================

import { assertEquals } from "@std/assert";
import { dateAq, formatDate, modMsOf, toCoveoDate } from "../../lib/coveo/dates.ts";

Deno.test("toCoveoDate: UTC, @ join, zero-padded", () => {
  // 2021-01-02T03:04:05.000Z
  const ms = Date.UTC(2021, 0, 2, 3, 4, 5);
  assertEquals(toCoveoDate(ms), "2021/01/02@03:04:05");
});

Deno.test("toCoveoDate: pads double-digit months/days without leading zero loss", () => {
  const ms = Date.UTC(2023, 11, 25, 23, 59, 9); // Dec 25 23:59:09
  assertEquals(toCoveoDate(ms), "2023/12/25@23:59:09");
});

Deno.test("dateAq: both bounds -> @date>=START @date<END", () => {
  const start = Date.UTC(2024, 0, 1, 0, 0, 0);
  const end = Date.UTC(2024, 0, 2, 0, 0, 0);
  assertEquals(
    dateAq(start, end),
    "@date>=2024/01/01@00:00:00 @date<2024/01/02@00:00:00",
  );
});

Deno.test("dateAq: each bound optional", () => {
  const start = Date.UTC(2024, 0, 1, 0, 0, 0);
  const end = Date.UTC(2024, 0, 2, 0, 0, 0);
  assertEquals(dateAq(start, undefined), "@date>=2024/01/01@00:00:00");
  assertEquals(dateAq(undefined, end), "@date<2024/01/02@00:00:00");
  assertEquals(dateAq(undefined, undefined), "");
});

Deno.test("modMsOf: precedence f5_updated_published_date > sflastmodifieddate > date", () => {
  assertEquals(
    modMsOf({ f5_updated_published_date: 3, sflastmodifieddate: 2, date: 1 }),
    3,
  );
  assertEquals(modMsOf({ sflastmodifieddate: 2, date: 1 }), 2);
  assertEquals(modMsOf({ date: 1 }), 1);
  assertEquals(modMsOf({}), undefined);
  assertEquals(modMsOf(undefined), undefined);
});

Deno.test("formatDate: MMM D, YYYY (UTC); empty for null/undefined", () => {
  const ms = Date.UTC(2022, 2, 5, 0, 0, 0); // Mar 5, 2022
  assertEquals(formatDate(ms), "Mar 5, 2022");
  assertEquals(formatDate(null), "");
  assertEquals(formatDate(undefined), "");
});
