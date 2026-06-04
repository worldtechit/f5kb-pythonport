// ===========================================================================
// TEST: dumpTypes incremental mode (skip-unchanged) + changelog classification
// CATEGORY: unit
// COVERS: lib/dump.ts (dumpTypes incremental/priorHashes/changelog/currentIds, dbKey)
// FIXTURES: coveo/search_policy.json, coveo/count_policy.json
// NETWORK: none — CoveoClient over makeCoveoMock
// ASSERTS:
//   - a baseline dump exposes currentIds; rebuilding priorHashes from the written
//     files + an identical re-dump skips ALL (written=0, skipped=N), no changelog
//   - a stale prior hash for one id -> that one rewritten + changelog op="edited"
//   - a missing prior hash for one id -> rewritten + changelog op="added"
//   - skipped files are left byte-identical (not rewritten)
// ===========================================================================

import { assertEquals } from "@std/assert";
import { dbKey, dumpTypes } from "../../lib/dump.ts";
import { sha256 } from "../../lib/track/hashing.ts";
import { Changelog } from "../../lib/changelog.ts";
import { CoveoClient } from "../../lib/coveo/client.ts";
import type { CoveoConfig } from "../../lib/coveo/aura.ts";
import { makeCoveoMock, noopSleep } from "../_helpers/mock_fetch.ts";

function mockClient(): CoveoClient {
  const mock = makeCoveoMock({
    search: "coveo/search_policy.json",
    count: "coveo/count_policy.json",
  });
  const config: CoveoConfig = {
    platformUrl: "https://mock.coveo",
    accessToken: "T",
    organizationId: "org",
  };
  return new CoveoClient(config, {
    fetch: mock.fetch,
    sleep: noopSleep,
    refresh: () => Promise.resolve(),
  });
}

const BASE_OPTS = {
  typeConfigs: { Policy: { documentType: "Policy", metadata: "*" as const, content: [] } },
  typeKeys: ["Policy"],
  descriptions: {},
  allTime: true,
  mode: "all",
  cutoffMs: Date.UTC(2000, 0, 1),
  pageSize: 50,
  limit: Infinity,
  configPath: "config.yaml",
};

// Read every written article id -> sha256(metadata), keyed exactly like the DB.
async function hashIndexFromDir(dir: string): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const e of Deno.readDirSync(dir)) {
    if (!e.isFile || !e.name.endsWith(".json") || e.name.startsWith("_")) continue;
    const a = JSON.parse(await Deno.readTextFile(`${dir}/${e.name}`));
    m.set(dbKey("Policy", a.id), await sha256(a.metadata));
  }
  return m;
}

Deno.test("dumpTypes incremental: identical re-dump skips all, no changelog", async () => {
  const root = await Deno.makeTempDir();
  const out = `${root}/dump`;
  try {
    const nowMs = Date.UTC(2026, 0, 1);
    // Baseline (non-incremental) dump.
    const base = await dumpTypes(mockClient(), {
      ...BASE_OPTS,
      outDir: out,
      endMs: nowMs + 86400000,
      nowMs,
    });
    assertEquals(base.manifest[0].written, 3);
    assertEquals(base.currentIds.get("Policy")!.size, 3);

    // Capture mtimes so we can prove skipped files aren't rewritten.
    const dir = `${out}/Policy`;
    const before = new Map<string, number>();
    for (const e of Deno.readDirSync(dir)) {
      if (e.isFile && e.name.endsWith(".json") && !e.name.startsWith("_")) {
        before.set(e.name, Deno.statSync(`${dir}/${e.name}`).mtime!.getTime());
      }
    }

    const priorHashes = await hashIndexFromDir(dir);
    const changelog = new Changelog(null, "run-2");
    const inc = await dumpTypes(mockClient(), {
      ...BASE_OPTS,
      outDir: out,
      endMs: nowMs + 2 * 86400000,
      nowMs: nowMs + 86400000, // different capturedAt — must NOT count as a change
      incremental: true,
      priorHashes,
      changelog,
    });
    assertEquals(inc.manifest[0].written, 0);
    assertEquals(inc.manifest[0].skipped, 3);
    assertEquals(changelog.total, 0);

    // Skipped files left untouched (same mtime).
    for (const e of Deno.readDirSync(dir)) {
      if (e.isFile && e.name.endsWith(".json") && !e.name.startsWith("_")) {
        assertEquals(Deno.statSync(`${dir}/${e.name}`).mtime!.getTime(), before.get(e.name));
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("dumpTypes incremental: stale hash -> edited; missing hash -> added", async () => {
  const root = await Deno.makeTempDir();
  const out = `${root}/dump`;
  try {
    const nowMs = Date.UTC(2026, 0, 1);
    await dumpTypes(mockClient(), { ...BASE_OPTS, outDir: out, endMs: nowMs + 86400000, nowMs });
    const dir = `${out}/Policy`;
    const prior = await hashIndexFromDir(dir);
    const ids = [...prior.keys()]; // dbKey("Policy", id)

    // One id gets a stale hash (looks edited); one id is dropped (looks added);
    // the third stays correct (skipped).
    prior.set(ids[0], "STALE_HASH_0000");
    prior.delete(ids[1]);

    const changelog = new Changelog(null, "run-3");
    const inc = await dumpTypes(mockClient(), {
      ...BASE_OPTS,
      outDir: out,
      endMs: nowMs + 86400000,
      nowMs,
      incremental: true,
      priorHashes: prior,
      changelog,
    });
    assertEquals(inc.manifest[0].written, 2); // edited + added rewritten
    assertEquals(inc.manifest[0].skipped, 1); // the unchanged one
    assertEquals(changelog.byOp(), { edited: 1, added: 1 });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
