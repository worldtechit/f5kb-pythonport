// ===========================================================================
// TEST: approval gate in dumpTypes — stage overwrites, bypass archives
// CATEGORY: integration
// COVERS: lib/dump.ts (approval / archiveOnOverwrite), lib/staging.ts
// FIXTURES: coveo/search_policy.json, coveo/count_policy.json
// NETWORK: none — CoveoClient over makeCoveoMock
// ASSERTS:
//   - gate ON: an edited (would-overwrite) article is staged to _pending/ and the
//     live file is left byte-identical; new->written, unchanged->skipped
//   - bypass (archiveOnOverwrite): the live file is archived to _replaced/ then
//     overwritten in place (nothing staged)
// ===========================================================================

import { assertEquals } from "@std/assert";
import { dbKey, dumpTypes } from "../../lib/dump.ts";
import { sha256 } from "../../lib/track/hashing.ts";
import { CoveoClient } from "../../lib/coveo/client.ts";
import type { CoveoConfig } from "../../lib/coveo/aura.ts";
import { makeCoveoMock, noopSleep } from "../_helpers/mock_fetch.ts";

function mockClient(): CoveoClient {
  const mock = makeCoveoMock({
    search: "coveo/search_policy.json",
    count: "coveo/count_policy.json",
  });
  const config: CoveoConfig = { platformUrl: "https://m", accessToken: "T", organizationId: "o" };
  return new CoveoClient(config, {
    fetch: mock.fetch,
    sleep: noopSleep,
    refresh: () => Promise.resolve(),
  });
}

const BASE = {
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

async function hashIndex(dir: string): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const e of Deno.readDirSync(dir)) {
    if (!e.isFile || !e.name.endsWith(".json") || e.name.startsWith("_")) continue;
    const a = JSON.parse(await Deno.readTextFile(`${dir}/${e.name}`));
    m.set(dbKey("Policy", a.id), await sha256(a.metadata));
  }
  return m;
}

Deno.test("gate ON: edited article staged to _pending, live untouched", async () => {
  const root = await Deno.makeTempDir();
  const out = `${root}/dump`;
  try {
    const nowMs = Date.UTC(2026, 0, 1);
    // First dump: everything new -> written live, nothing staged.
    const r1 = await dumpTypes(mockClient(), {
      ...BASE,
      outDir: out,
      endMs: nowMs + 86400000,
      nowMs,
      approval: true,
    });
    assertEquals(r1.manifest[0].written, 3);
    assertEquals(r1.manifest[0].staged, 0);
    assertEquals(r1.pending.length, 0);

    const dir = `${out}/Policy`;
    const prior = await hashIndex(dir);
    const editedKey = [...prior.keys()][0];
    const editedId = editedKey.slice("Policy ".length);
    prior.set(editedKey, "STALE_HASH"); // force one to classify as edited

    // capture live mtimes to prove the staged one is NOT rewritten
    const before = new Map<string, number>();
    for (const e of Deno.readDirSync(dir)) {
      if (e.isFile && !e.name.startsWith("_")) {
        before.set(e.name, Deno.statSync(`${dir}/${e.name}`).mtime!.getTime());
      }
    }

    const r2 = await dumpTypes(mockClient(), {
      ...BASE,
      outDir: out,
      endMs: nowMs + 2 * 86400000,
      nowMs: nowMs + 86400000,
      approval: true,
      priorHashes: prior,
    });
    assertEquals(r2.manifest[0].written, 0);
    assertEquals(r2.manifest[0].skipped, 2);
    assertEquals(r2.manifest[0].staged, 1);
    assertEquals(r2.pending.length, 1);
    assertEquals(r2.pending[0].id, editedId);

    // staged file exists under _pending/, live file untouched (same mtime, present)
    assertEquals(Deno.statSync(`${out}/_pending/Policy/${editedId}.json`).isFile, true);
    assertEquals(
      Deno.statSync(`${dir}/${editedId}.json`).mtime!.getTime(),
      before.get(`${editedId}.json`),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("bypass: archiveOnOverwrite archives the live file then overwrites", async () => {
  const root = await Deno.makeTempDir();
  const out = `${root}/dump`;
  try {
    const nowMs = Date.UTC(2026, 0, 1);
    await dumpTypes(mockClient(), {
      ...BASE,
      outDir: out,
      endMs: nowMs + 86400000,
      nowMs,
      approval: true,
    });

    const dir = `${out}/Policy`;
    const prior = await hashIndex(dir);
    const editedId = [...prior.keys()][0].slice("Policy ".length);
    prior.set([...prior.keys()][0], "STALE_HASH");

    const r2 = await dumpTypes(mockClient(), {
      ...BASE,
      outDir: out,
      endMs: nowMs + 86400000,
      nowMs: nowMs + 86400000,
      approval: false,
      archiveOnOverwrite: true,
      priorHashes: prior,
    });
    assertEquals(r2.manifest[0].written, 1); // overwritten in place
    assertEquals(r2.manifest[0].replaced, 1);
    assertEquals(r2.pending.length, 0);
    // a _replaced/ copy of the old version exists; no _pending tree
    let replacedFound = false;
    for await (const e of Deno.readDir(`${out}/_replaced/Policy`)) {
      if (e.name.startsWith(`${editedId}.`)) replacedFound = true;
    }
    assertEquals(replacedFound, true);
    let pendingExists = true;
    try {
      Deno.statSync(`${out}/_pending`);
    } catch {
      pendingExists = false;
    }
    assertEquals(pendingExists, false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
