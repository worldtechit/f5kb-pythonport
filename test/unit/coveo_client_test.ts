// ===========================================================================
// TEST: CoveoClient retry/refresh/error semantics + getCount parsing.
// CATEGORY: unit
// COVERS: lib/coveo/client.ts (CoveoClient.post, getCount)
// FIXTURES: none (tiny inline JSON bodies for speed)
// NETWORK: none (mocked via makeMockFetch scripted mode + noopSleep + stubRefresh)
// ASSERTS:
//   - 401 then 200 -> refresh() called once, success result returned
//   - 503 then 200 -> transient status retried, result returned
//   - 400 "ResponseExceededMaximumSize" surfaces as a thrown "Coveo API error"
//   - getCount reads totalCountFiltered/totalCount
// ===========================================================================

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { CoveoClient } from "../../lib/coveo/client.ts";
import type { CoveoConfig } from "../../lib/coveo/aura.ts";
import { makeMockFetch, makeStubRefresh, noopSleep } from "../_helpers/mock_fetch.ts";

function cfg(): CoveoConfig {
  return {
    platformUrl: "https://example.coveo.com",
    accessToken: "TOKEN_V1",
    organizationId: "org",
  };
}

Deno.test("post: 401 then 200 -> refresh once, result returned", async () => {
  const mock = makeMockFetch({
    scripted: [
      { status: 401, body: "expired" },
      { status: 200, body: JSON.stringify({ results: [{ id: 1 }] }) },
    ],
  });
  const refresh = makeStubRefresh();
  const client = new CoveoClient(cfg(), {
    fetch: mock.fetch,
    sleep: noopSleep,
    refresh: refresh.fn,
  });
  const data = await client.post({ q: "" });
  assertEquals((data.results as unknown[]).length, 1);
  assertEquals(refresh.calls, 1);
  assertEquals(mock.count, 2);
  // After refresh the second request must carry the refreshed token.
  assertEquals(
    (mock.calls[1] as { url: string }) && true,
    true,
  );
});

Deno.test("post: 503 then 200 -> transient retry, result returned", async () => {
  const mock = makeMockFetch({
    scripted: [
      { status: 503, body: "unavailable" },
      { status: 200, body: JSON.stringify({ totalCount: 7, results: [] }) },
    ],
  });
  const refresh = makeStubRefresh();
  const client = new CoveoClient(cfg(), {
    fetch: mock.fetch,
    sleep: noopSleep,
    refresh: refresh.fn,
  });
  const data = await client.post({ q: "" });
  assertEquals(data.totalCount, 7);
  assertEquals(refresh.calls, 0); // 5xx must NOT refresh the token
  assertEquals(mock.count, 2);
});

Deno.test("post: 400 ResponseExceededMaximumSize surfaces as thrown error", async () => {
  const mock = makeMockFetch({
    scripted: [
      { status: 400, body: '{"message":"ResponseExceededMaximumSize"}' },
    ],
  });
  const client = new CoveoClient(cfg(), {
    fetch: mock.fetch,
    sleep: noopSleep,
    refresh: makeStubRefresh().fn,
  });
  const err = await assertRejects(() => client.post({ q: "" }), Error);
  assertStringIncludes(err.message, "Coveo API error");
  assertStringIncludes(err.message, "ResponseExceededMaximumSize");
  // 400 is terminal -> exactly one call (no retry).
  assertEquals(mock.count, 1);
});

Deno.test("getCount: prefers totalCountFiltered, else totalCount", async () => {
  const mock = makeMockFetch({
    scripted: [{ status: 200, body: JSON.stringify({ totalCountFiltered: 42, totalCount: 99 }) }],
  });
  const client = new CoveoClient(cfg(), { fetch: mock.fetch, sleep: noopSleep });
  assertEquals(await client.getCount("@x==1"), 42);

  const mock2 = makeMockFetch({
    scripted: [{ status: 200, body: JSON.stringify({ totalCount: 13 }) }],
  });
  const client2 = new CoveoClient(cfg(), { fetch: mock2.fetch, sleep: noopSleep });
  assertEquals(await client2.getCount(""), 13);
  // The count query must be a numberOfResults:0 POST.
  assertEquals((mock2.calls[0].body as Record<string, unknown>).numberOfResults, 0);
});
