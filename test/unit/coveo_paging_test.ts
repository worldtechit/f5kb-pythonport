// ===========================================================================
// TEST: Coveo pagination strategies (offset halving, keyset cursor, chunking).
// CATEGORY: unit
// COVERS: lib/coveo/paging.ts (fns: fetchPaged, fetchKeyset, fetchChunked)
// FIXTURES: none (scripted in-memory pages; rowids span past MAX_SAFE_INTEGER)
// NETWORK: none (a stub CoveoClient stands in for post/getCount)
// ASSERTS:
//   - fetchPaged halves the page size when post throws a "maximum size" error
//   - fetchKeyset advances the @rowid>=cursor, dedups the boundary overlap, and
//     stops when a full page yields nothing new
//   - fetchChunked splits a >5000 window, and at 1-second resolution defers to
//     keyset paging (no offset cap)
// NOTE: paging has a hard-coded 120ms inter-page setTimeout; page counts are kept
//   tiny so the suite stays fast.
// ===========================================================================

import { assertEquals } from "@std/assert";
import { CURSOR_MARGIN, fetchChunked, fetchKeyset, fetchPaged } from "../../lib/coveo/paging.ts";
import type { CoveoClient, CoveoResult } from "../../lib/coveo/client.ts";

// A minimal stand-in for CoveoClient: paging only calls .post()/.getCount().
function stubClient(handlers: {
  post: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  getCount?: (aq: string) => Promise<number>;
}): CoveoClient {
  return handlers as unknown as CoveoClient;
}

function row(rowid: bigint | number, pid: string): CoveoResult {
  return { uniqueId: pid, raw: { rowid: Number(rowid), permanentid: pid } };
}

Deno.test("fetchPaged: halves page size on a response-size error then succeeds", async () => {
  const sizes: number[] = [];
  let firstCall = true;
  const client = stubClient({
    post: (body) => {
      sizes.push(body.numberOfResults as number);
      if (firstCall) {
        firstCall = false;
        return Promise.reject(new Error("Coveo API error 400: ResponseExceededMaximumSize"));
      }
      // After halving, return the last (short) page so paging stops.
      return Promise.resolve({ results: [row(1, "a"), row(2, "b")] });
    },
  });
  const out = await fetchPaged(client, "@x==1", 10, 100);
  assertEquals(out.length, 2);
  // First attempt at 10, then halved to 5 on retry.
  assertEquals(sizes[0], 10);
  assertEquals(sizes[1], 5);
});

Deno.test("fetchKeyset: advances cursor by rowid, dedups boundary, stops on no progress", async () => {
  // rowids near 1.8e18 exceed Number.MAX_SAFE_INTEGER (9.007e15) — the real case.
  const base = 1_800_000_000_000_000_000n;
  let call = 0;
  const seenAq: string[] = [];
  const client = stubClient({
    post: (body) => {
      seenAq.push((body.aq as string) ?? "");
      call++;
      if (call === 1) {
        // full page of 3, last rowid = base
        return Promise.resolve({
          results: [
            row(base + 2000n, "p1"),
            row(base + 1000n, "p2"),
            row(base, "p3"),
          ],
        });
      }
      if (call === 2) {
        // boundary doc p3 re-fetched by the safety margin (deduped) + one new
        return Promise.resolve({
          results: [row(base, "p3"), row(base - 5000n, "p4")],
        });
      }
      // call 3: a full page that yields ONLY already-seen docs -> no progress, stop
      return Promise.resolve({ results: [row(base - 5000n, "p4"), row(base - 6000n, "p4")] });
    },
  });
  const out = await fetchKeyset(client, "@type==X", 3, 100);
  const pids = out.map((r) => (r.raw as CoveoResult).permanentid);
  assertEquals(pids, ["p1", "p2", "p3", "p4"]); // p3 deduped, no dup p4
  // First query has no cursor; later queries append @rowid>=<cursor>.
  assertEquals(seenAq[0], "@type==X");
  const expectedCursor = base - CURSOR_MARGIN;
  assertEquals(seenAq[1], `@type==X @rowid>=${expectedCursor}`);
});

Deno.test("fetchKeyset: empty first page returns nothing", async () => {
  const client = stubClient({ post: () => Promise.resolve({ results: [] }) });
  const out = await fetchKeyset(client, "@type==X", 50, 100);
  assertEquals(out.length, 0);
});

Deno.test("fetchChunked: splits a >5000 window, defers to keyset at 1s resolution", async () => {
  // A single calendar second (start..end within the same toCoveoDate) that holds
  // >5000 docs is irreducible by @date -> fetchChunked must fall through to keyset.
  const start = Date.UTC(2024, 0, 1, 0, 0, 0);
  const end = start + 500; // sub-second window -> same toCoveoDate(start)==toCoveoDate(mid)
  const base = 1_800_000_000_000_000_000n;
  let keysetPages = 0;
  const client = stubClient({
    getCount: () => Promise.resolve(6000), // > COVEO_MAX_OFFSET
    post: (body) => {
      // Only the keyset path uses "@rowid ascending"; assert we got there.
      assertEquals(body.sortCriteria, "@rowid ascending");
      keysetPages++;
      if (keysetPages === 1) {
        return Promise.resolve({ results: [row(base, "k1"), row(base - 9000n, "k2")] });
      }
      return Promise.resolve({ results: [] }); // drain
    },
  });
  const collected: CoveoResult[] = [];
  await fetchChunked(client, "@type==X", start, end, 2, 100, () => {}, collected);
  const pids = collected.map((r) => (r.raw as CoveoResult).permanentid);
  assertEquals(pids, ["k1", "k2"]);
});

Deno.test("fetchChunked: a window within the offset cap pages directly", async () => {
  const start = Date.UTC(2024, 0, 1, 0, 0, 0);
  const end = Date.UTC(2024, 0, 2, 0, 0, 0);
  let usedSort = "";
  const client = stubClient({
    getCount: () => Promise.resolve(3), // <= COVEO_MAX_OFFSET -> direct paging
    post: (body) => {
      usedSort = body.sortCriteria as string;
      return Promise.resolve({ results: [row(1, "d1"), row(2, "d2"), row(3, "d3")] });
    },
  });
  const collected: CoveoResult[] = [];
  await fetchChunked(client, "@type==X", start, end, 50, 100, () => {}, collected);
  assertEquals(collected.length, 3);
  assertEquals(usedSort, "date descending"); // offset paging path, not keyset
});
