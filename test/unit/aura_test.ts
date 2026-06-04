// ===========================================================================
// TEST: Aura guest-token response parsing (plain JSON + */...-wrapped variant).
// CATEGORY: unit
// COVERS: lib/coveo/aura.ts (fns: fetchCoveoConfig, refreshConfig)
// FIXTURES: aura/token_response.txt (token redacted)
// NETWORK: none (mocked FetchFn returns the fixture text)
// ASSERTS:
//   - fetchCoveoConfig parses the committed Aura fixture -> platformUrl/org/token
//   - a */ ... /* wrapped body (Salesforce XSSI prefix) parses identically
//   - refreshConfig mutates the shared config object in place
// ===========================================================================

import { assertEquals } from "@std/assert";
import { fetchCoveoConfig, refreshConfig } from "../../lib/coveo/aura.ts";
import { loadFixture } from "../_helpers/fixtures.ts";
import { makeMockFetch } from "../_helpers/mock_fetch.ts";

Deno.test("fetchCoveoConfig: parses the committed plain-JSON fixture", async () => {
  const mock = makeMockFetch({ aura: loadFixture("aura/token_response.txt") });
  const cfg = await fetchCoveoConfig(mock.fetch);
  assertEquals(cfg.platformUrl, "https://f5networksproduction5vkhn00h.org.coveo.com");
  assertEquals(cfg.organizationId, "f5networksproduction5vkhn00h");
  assertEquals(cfg.accessToken, "FIXTURE_TOKEN_REDACTED");
  // It POSTs to the Aura endpoint.
  assertEquals(mock.calls[0].method, "POST");
});

Deno.test("fetchCoveoConfig: parses a */ ... /* wrapped (XSSI-prefixed) body", async () => {
  const inner = JSON.stringify({
    actions: [{
      id: "1",
      state: "SUCCESS",
      returnValue: {
        returnValue: JSON.stringify({
          platformUrl: "https://w.org.coveo.com",
          accessToken: "WRAPPED_TOKEN",
          organizationId: "wrappedorg",
        }),
      },
    }],
  });
  const wrapped = `*/${inner}/*`;
  const mock = makeMockFetch({ aura: wrapped });
  const cfg = await fetchCoveoConfig(mock.fetch);
  assertEquals(cfg.platformUrl, "https://w.org.coveo.com");
  assertEquals(cfg.organizationId, "wrappedorg");
  assertEquals(cfg.accessToken, "WRAPPED_TOKEN");
});

Deno.test("refreshConfig: mutates the shared config in place", async () => {
  const mock = makeMockFetch({ aura: loadFixture("aura/token_response.txt") });
  const cfg = { platformUrl: "old", accessToken: "old", organizationId: "old" };
  await refreshConfig(cfg, mock.fetch);
  assertEquals(cfg.accessToken, "FIXTURE_TOKEN_REDACTED");
  assertEquals(cfg.organizationId, "f5networksproduction5vkhn00h");
});
