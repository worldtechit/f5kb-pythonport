// Incremental sync orchestrator. Reuses the existing building blocks:
//   1. load prior metadata_hash map from the DB
//   2. dumpTypes(incremental) — rewrite only new/changed articles, leave unchanged
//   3. enrichDump — bodies only for the rewritten (resumable skips already-bodied)
//   4. trackDump — update the DB + its changes/runs tables
//   5. DETECT + REPORT upstream deletions (DB ids absent from this run's Coveo set);
//      never removes them (use `reconcile --apply` for that)
//   6. flush the changelog (added/edited/body-* this run; deletions recorded as
//      "detected", source=sync)
//
// Deletion detection requires the full current id set, so it only runs under
// --all (allTime). A --days / --since-last-run window classifies adds/edits but
// cannot see deletions.

import { type Logger, NULL_LOGGER } from "./logger.ts";
import { CoveoClient } from "./coveo/client.ts";
import { HttpClient } from "./http/fetcher.ts";
import type { TypeConfig } from "./config/types.ts";
import { dumpTypes } from "./dump.ts";
import { enrichDump } from "./enrich/driver.ts";
import { loadHashIndex, loadIdsByType, trackDump } from "./track/db.ts";
import { Changelog } from "./changelog.ts";
import { mergePending } from "./staging.ts";

// type keys whose body lives off-API and so benefits from enrich.
const ENRICHABLE = new Set([
  "Bug_Tracker",
  "Manual",
  "Release_Note",
  "Supplemental_Document",
  "F5_GitHub",
]);

export interface SyncOpts {
  client: CoveoClient;
  http: HttpClient;
  typeConfigs: Record<string, Partial<TypeConfig>>;
  typeKeys: string[];
  descriptions: Record<string, string>;
  outDir: string;
  db?: string;
  mode: string; // "all" | "days=N" | "since-last-run"
  allTime: boolean; // true => deletion detection is valid
  cutoffMs: number;
  endMs: number;
  nowMs: number;
  pageSize: number;
  limit: number;
  configPath: string;
  enrich: boolean;
  githubToken?: string;
  concurrency: number;
  delayMs: number;
  changelogPath: string | null;
  dryRun: boolean;
  /** approval gate ON (default): edited articles are staged to _pending/ for review
   *  instead of overwriting live data. */
  approval: boolean;
  /** bypass (--yes): overwrite edited articles in place, archiving the replaced file
   *  to _replaced/ first. */
  archiveOnOverwrite?: boolean;
  logger?: Logger;
}

export interface SyncResult {
  runId: string;
  mode: string;
  dryRun: boolean;
  written: number;
  skipped: number;
  added: number;
  edited: number;
  bodyAdded: number;
  bodyChanged: number;
  bodyError: number;
  /** edited articles staged to _pending/ this run (awaiting `f5kb approve`). */
  staged: number;
  deletionsDetected: number;
  deletions: Record<string, string[]>; // typeKey -> ids detected as deleted upstream
  deletionDetectionRan: boolean;
  changelogPath: string | null;
}

export async function syncDump(opts: SyncOpts): Promise<SyncResult> {
  const log = opts.logger ?? NULL_LOGGER;
  const runId = new Date(opts.nowMs).toISOString();
  const dbPath = opts.db ?? `${opts.outDir.replace(/\/+$/, "")}/../articles.db`;
  // In dry-run, the changelog still tallies counts but writes no file (path=null).
  const changelog = new Changelog(opts.dryRun ? null : opts.changelogPath, runId);

  const priorHashes = await loadHashIndex(dbPath);
  log.info(`Loaded ${priorHashes.size} prior hash(es) from ${dbPath}`);

  // 1+2. incremental dump (only new/changed written).
  const dump = await dumpTypes(opts.client, {
    typeConfigs: opts.typeConfigs,
    typeKeys: opts.typeKeys,
    descriptions: opts.descriptions,
    outDir: opts.outDir,
    allTime: opts.allTime,
    mode: opts.mode,
    cutoffMs: opts.cutoffMs,
    endMs: opts.endMs,
    nowMs: opts.nowMs,
    pageSize: opts.pageSize,
    limit: opts.limit,
    configPath: opts.configPath,
    logger: log,
    incremental: true,
    priorHashes,
    changelog,
    dryRun: opts.dryRun,
    approval: opts.approval,
    archiveOnOverwrite: opts.archiveOnOverwrite,
  });

  // 3. enrich only the rewritten (resumability skips already-bodied) — live + writes,
  //    so skipped in dry-run.
  if (opts.enrich && !opts.dryRun) {
    const enrichTypes = opts.typeKeys.filter((t) => ENRICHABLE.has(t));
    if (enrichTypes.length) {
      await enrichDump({
        dump: opts.outDir,
        types: enrichTypes,
        http: opts.http,
        githubToken: opts.githubToken,
        concurrency: opts.concurrency,
        delayMs: opts.delayMs,
        limit: null,
        refetch: false,
        refetchErrors: false,
        logger: log.child("enrich"),
        changelog,
      });
    }
  }

  // 3b. record the staged overwrites in the pending manifest (after enrich filled
  //     their bodies). Only meaningful when the gate is on and not a dry run.
  if (opts.approval && !opts.dryRun && dump.pending.length) {
    await mergePending(opts.outDir, dump.pending, runId);
    log.warn(
      `${dump.pending.length} edited article(s) STAGED for review (not applied). ` +
        `Inspect ${opts.outDir}/_pending/ then run: f5kb approve`,
    );
  }

  // 4. track (update DB) — skipped in dry-run. Indexes the LIVE dump only; staged
  //    (_pending) edits are excluded until approved.
  if (!opts.dryRun) {
    await trackDump({ dump: opts.outDir, db: dbPath, types: opts.typeKeys, runId, logger: log });
  }

  // 5. deletion DETECTION (only valid with the full current id set, i.e. --all).
  const deletions: Record<string, string[]> = {};
  let deletionsDetected = 0;
  const deletionDetectionRan = opts.allTime;
  if (deletionDetectionRan) {
    const docTypes = new Map<string, string>();
    for (const k of opts.typeKeys) {
      const dt = opts.typeConfigs[k]?.documentType;
      if (dt) docTypes.set(k, dt);
    }
    const dbIdsByType = await loadIdsByType(dbPath, [...docTypes.values()]);
    for (const [typeKey, documentType] of docTypes) {
      const cur = dump.currentIds.get(typeKey) ?? new Set<string>();
      const gone = (dbIdsByType.get(documentType) ?? []).filter((id) => !cur.has(id));
      if (gone.length) {
        deletions[typeKey] = gone;
        deletionsDetected += gone.length;
        for (const id of gone) {
          changelog.record({
            op: "deleted",
            documentType,
            id,
            source: "sync",
            detail: "detected upstream (not removed; run `reconcile --apply` to remove)",
          });
        }
      }
    }
    if (deletionsDetected) {
      log.warn(
        `${deletionsDetected} upstream deletion(s) detected (reported, NOT removed). ` +
          `Run: f5kb reconcile --apply  to remove them.`,
      );
    }
  }

  await changelog.flush();

  const by = changelog.byOp();
  return {
    runId,
    mode: opts.mode,
    dryRun: opts.dryRun,
    written: dump.manifest.reduce((a, m) => a + m.written, 0),
    skipped: dump.manifest.reduce((a, m) => a + m.skipped, 0),
    added: by["added"] ?? 0,
    edited: by["edited"] ?? 0,
    bodyAdded: by["body-added"] ?? 0,
    bodyChanged: by["body-changed"] ?? 0,
    bodyError: by["body-error"] ?? 0,
    staged: dump.manifest.reduce((a, m) => a + m.staged, 0),
    deletionsDetected,
    deletions,
    deletionDetectionRan,
    changelogPath: opts.dryRun ? null : opts.changelogPath,
  };
}
