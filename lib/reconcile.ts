// Deletion reconcile: find articles that exist in our DB/dump but no longer exist
// upstream in Coveo, and (only on explicit --apply) remove them on our side.
//
// Detection: a cheap IDs-only keyset sweep of each type's current Coveo id set,
// diffed against the DB. Safety for execution: dry-run by default, a DB backup
// before any change, and a deletion-threshold guard so a bad/empty Coveo response
// can't wipe data. Soft-delete (archive the file under _deleted/, drop the DB row)
// by default; --purge hard-removes the file instead of archiving.

import { type Logger, NULL_LOGGER } from "./logger.ts";
import { CoveoClient } from "./coveo/client.ts";
import { fetchIds } from "./coveo/paging.ts";
import { idOf } from "./fsutil.ts";
import { exists } from "./fsutil.ts";
import type { TypeConfig } from "./config/types.ts";
import { deleteRows, loadIdsByType } from "./track/db.ts";
import type { Changelog } from "./changelog.ts";

export interface ReconcileOpts {
  client: CoveoClient;
  dump: string;
  db?: string;
  typeConfigs: Record<string, Partial<TypeConfig>>;
  typeKeys: string[];
  apply: boolean; // false = report only (dry-run)
  purge: boolean; // true = hard-remove file; false = archive to _deleted/
  maxDeletePct: number; // abort if deletions exceed this fraction of a type's DB rows (0..1)
  maxDeletes?: number; // optional absolute cap
  changelog?: Changelog;
  logger?: Logger;
  pageSize?: number;
}

export interface ReconcileTypeResult {
  typeKey: string;
  documentType: string;
  dbCount: number;
  liveCount: number;
  deletions: string[]; // article ids present in DB but not upstream
}

export interface ReconcileResult {
  perType: ReconcileTypeResult[];
  totalDeletions: number;
  totalDb: number;
  applied: boolean;
  aborted?: string; // set if a threshold guard tripped
  backupPath?: string;
}

// Strip the dedup "__n" filename suffix so a duplicate-permanentid pair (id, id__2)
// both match the single live id from fetchIds (idOf collapses them).
function baseId(id: string): string {
  return id.replace(/__\d+$/, "");
}

export async function reconcile(opts: ReconcileOpts): Promise<ReconcileResult> {
  const log = opts.logger ?? NULL_LOGGER;
  const dbPath = opts.db ?? `${opts.dump.replace(/\/+$/, "")}/../articles.db`;

  // documentType per requested typeKey.
  const docTypes = new Map<string, string>();
  for (const k of opts.typeKeys) {
    const dt = opts.typeConfigs[k]?.documentType;
    if (dt) docTypes.set(k, dt);
    else log.warn(`reconcile: "${k}" has no documentType in config — skipping`);
  }

  const dbIdsByType = await loadIdsByType(dbPath, [...docTypes.values()]);

  const perType: ReconcileTypeResult[] = [];
  for (const [typeKey, documentType] of docTypes) {
    const liveResults = await fetchIds(opts.client, documentType, opts.pageSize ?? 2000);
    const live = new Set(liveResults.map((r) => idOf(r)));
    const dbIds = dbIdsByType.get(documentType) ?? [];
    const deletions = dbIds.filter((id) => !live.has(baseId(id)));
    perType.push({ typeKey, documentType, dbCount: dbIds.length, liveCount: live.size, deletions });
    log.info(
      `  [${typeKey}] db=${dbIds.length} live=${live.size} -> ${deletions.length} deletion(s)`,
    );
  }

  const totalDeletions = perType.reduce((a, t) => a + t.deletions.length, 0);
  const totalDb = perType.reduce((a, t) => a + t.dbCount, 0);
  const result: ReconcileResult = { perType, totalDeletions, totalDb, applied: false };

  if (!opts.apply || totalDeletions === 0) {
    if (totalDeletions && !opts.apply) {
      log.info(
        `Report only: ${totalDeletions} deletion(s) detected. Re-run with --apply to remove.`,
      );
    }
    return result;
  }

  // Threshold guard (per-type pct + optional absolute cap) — protects against a
  // bad/empty Coveo response that would otherwise look like a mass deletion.
  for (const t of perType) {
    if (t.dbCount > 0 && t.deletions.length / t.dbCount > opts.maxDeletePct) {
      result.aborted = `${typePctMsg(t, opts.maxDeletePct)} — aborting (no changes made). ` +
        `Override with a higher --max-delete-pct if this is real.`;
      log.error(result.aborted);
      return result;
    }
  }
  if (opts.maxDeletes != null && totalDeletions > opts.maxDeletes) {
    result.aborted =
      `${totalDeletions} deletions exceed --max-deletes=${opts.maxDeletes} — aborting (no changes made).`;
    log.error(result.aborted);
    return result;
  }

  // Back up the DB before any destructive change.
  if (await exists(dbPath)) {
    const backupPath = `${dbPath}.bak-${nowStamp()}`;
    await Deno.copyFile(dbPath, backupPath);
    result.backupPath = backupPath;
    log.info(`Backed up DB -> ${backupPath}`);
  }

  // Apply: archive (soft) or remove (purge) each file, then drop the DB rows.
  const removedRows: Array<{ documentType: string; id: string }> = [];
  for (const t of perType) {
    if (t.deletions.length === 0) continue;
    const srcDir = `${opts.dump}/${t.typeKey}`;
    const archiveDir = `${opts.dump}/_deleted/${t.typeKey}`;
    if (!opts.purge) await Deno.mkdir(archiveDir, { recursive: true });
    for (const id of t.deletions) {
      const src = `${srcDir}/${id}.json`;
      try {
        if (opts.purge) {
          await Deno.remove(src);
        } else {
          await Deno.rename(src, `${archiveDir}/${id}.json`);
        }
      } catch {
        // file already gone — still drop the DB row + log.
      }
      removedRows.push({ documentType: t.documentType, id });
      opts.changelog?.record({
        op: "deleted",
        documentType: t.documentType,
        id,
        source: "reconcile",
        detail: opts.purge ? "purged" : `archived to _deleted/${t.typeKey}/`,
      });
    }
  }
  const dropped = deleteRows(dbPath, removedRows);
  result.applied = true;
  log.info(
    `Applied: ${removedRows.length} file(s) ${
      opts.purge ? "purged" : "archived"
    }, ${dropped} DB row(s) removed.`,
  );
  return result;
}

function typePctMsg(t: ReconcileTypeResult, pct: number): string {
  const got = ((t.deletions.length / t.dbCount) * 100).toFixed(1);
  return `[${t.typeKey}] ${t.deletions.length}/${t.dbCount} (${got}%) exceeds --max-delete-pct=${
    (pct * 100).toFixed(0)
  }%`;
}

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
