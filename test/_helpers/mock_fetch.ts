// ===========================================================================
// TEST HELPER: offline FetchFn factory + call recorder.
// CATEGORY: unit (support)
// COVERS: n/a (test infrastructure)   FIXTURES: caller-supplied
// NETWORK: none — never touches the network; returns Response objects built
//   from in-memory text.
// ASSERTS: n/a — provides makeMockFetch (route + scripted modes), noopSleep,
//   stubRefresh for the Coveo/Aura/HTTP layers.
// ===========================================================================

import { loadFixture } from "./fixtures.ts";
import type { CoveoConfig } from "../../lib/coveo/aura.ts";

// The exact signature lib's FetchFn uses (lib/coveo/aura.ts, lib/http/fetcher.ts).
export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface RecordedCall {
  url: string;
  method: string;
  /** Parsed JSON body when the request body was JSON; else the raw string. */
  body: unknown;
}

// One scripted reply, returned by call index (SCRIPTED mode).
export interface ScriptedReply {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

export interface MockFetchRoutes {
  // -- Coveo (POST /rest/search/v2) ----------------------------------------
  /** Returned when body.numberOfResults===0 and no body.facets (a count query). */
  coveoCount?: string;
  /** Returned when body.facets is present (a facet query). */
  coveoFacet?: string;
  /** Returned for every other Coveo search query. */
  coveoSearch?: string;

  // -- Aura (token endpoint) -----------------------------------------------
  /** Returned for any URL containing "/sfsites/aura". */
  aura?: string;

  // -- Arbitrary http(s) URLs ----------------------------------------------
  /** Substring -> response text. First matching substring wins (insertion order). */
  urlMap?: Record<string, string>;
  /** Default body for an unmatched http(s) URL (else a 404 Response). */
  fallback?: string;

  // -- SCRIPTED mode -------------------------------------------------------
  /**
   * When set, EVERY call is answered from this array by call index (clamped to
   * the last entry). Used for 401-then-200 / 429-then-200 retry tests. Takes
   * precedence over the route maps above.
   */
  scripted?: ScriptedReply[];
}

export interface MockFetch {
  fetch: FetchFn;
  /** Every call seen, in order. */
  calls: RecordedCall[];
  /** Total number of calls. */
  get count(): number;
}

function parseBody(init?: RequestInit): unknown {
  const raw = init?.body;
  if (raw == null) return undefined;
  const s = typeof raw === "string" ? raw : String(raw);
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function res(text: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(text, { status, headers });
}

export function makeMockFetch(routes: MockFetchRoutes = {}): MockFetch {
  const calls: RecordedCall[] = [];
  let scriptIdx = 0;

  const fetch: FetchFn = (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const body = parseBody(init);
    calls.push({ url, method, body });

    // SCRIPTED mode: answer purely by call index.
    if (routes.scripted) {
      const i = Math.min(scriptIdx, routes.scripted.length - 1);
      scriptIdx++;
      const r = routes.scripted[i];
      return Promise.resolve(res(r.body ?? "", r.status ?? 200, r.headers ?? {}));
    }

    // Aura token endpoint.
    if (url.includes("/sfsites/aura")) {
      if (routes.aura == null) throw new Error(`mock: no aura route for ${url}`);
      return Promise.resolve(res(routes.aura));
    }

    // Coveo search backend: pick by request shape.
    if (url.includes("/rest/search/v2")) {
      const b = (body ?? {}) as Record<string, unknown>;
      if (Array.isArray(b.facets)) {
        if (routes.coveoFacet == null) throw new Error("mock: no coveoFacet route");
        return Promise.resolve(res(routes.coveoFacet));
      }
      if (b.numberOfResults === 0) {
        if (routes.coveoCount == null) throw new Error("mock: no coveoCount route");
        return Promise.resolve(res(routes.coveoCount));
      }
      if (routes.coveoSearch == null) throw new Error("mock: no coveoSearch route");
      return Promise.resolve(res(routes.coveoSearch));
    }

    // Arbitrary http(s) URLs via substring map.
    for (const [needle, text] of Object.entries(routes.urlMap ?? {})) {
      if (url.includes(needle)) return Promise.resolve(res(text));
    }
    if (routes.fallback != null) return Promise.resolve(res(routes.fallback));
    return Promise.resolve(res(`mock 404: ${url}`, 404));
  };

  return {
    fetch,
    calls,
    get count() {
      return calls.length;
    },
  };
}

/** Convenience: build a mock from named fixtures (loaded lazily). */
export function makeCoveoMock(opts: {
  search?: string;
  count?: string;
  facet?: string;
  aura?: string;
} = {}): MockFetch {
  return makeMockFetch({
    coveoSearch: opts.search ? loadFixture(opts.search) : undefined,
    coveoCount: opts.count ? loadFixture(opts.count) : undefined,
    coveoFacet: opts.facet ? loadFixture(opts.facet) : undefined,
    aura: opts.aura ? loadFixture(opts.aura) : undefined,
  });
}

/** A sleep that resolves immediately — injected so retry/backoff tests are fast. */
export const noopSleep = async (_ms?: number): Promise<void> => {};

/**
 * A refresh stub for CoveoClient: records how many times it was called and
 * (optionally) mutates the config token so a post-refresh retry can verify the
 * new token is used. Pass `stubRefresh.fn` as the client's `refresh` dep.
 */
export function makeStubRefresh(newToken = "REFRESHED_TOKEN") {
  let calls = 0;
  const fn = (c: CoveoConfig): Promise<void> => {
    calls++;
    c.accessToken = newToken;
    return Promise.resolve();
  };
  return {
    fn,
    get calls() {
      return calls;
    },
  };
}

/** Default refresh stub (no token mutation) for the common case. */
export const stubRefresh = makeStubRefresh();
