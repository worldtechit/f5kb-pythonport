// Promote (or reject) the overwrites staged under _pending/ by the approval gate.
//
// `approve` is the human checkpoint: a gated sync/dump/enrich never overwrites a
// live article that already holds good data — it stages the new version under
// _pending/ and records it in _pending/_manifest.json. This module promotes those
// staged files into the live dump: each replaced live file is first archived to
// _replaced/ (recoverable), then the pending file is moved into place.
//
// Safety default: an edit flagged risky (body-dropped / body-error — i.e. the new
// version would lose or fail to capture a body the live file has) is HELD BACK and
// only promoted when includeRisky is set. So a reformatted-upstream regression can
// never be approved by accident; the reviewer must opt into it explicitly.

import { type Logger, NULL_LOGGER } from "./logger.ts";
import { exists, readJson } from "./fsutil.ts";
import type { Article } from "./track/hashing.ts";
import type { Changelog } from "./changelog.ts";
import {
  archiveReplaced,
  computeRisk,
  livePath,
  loadPendingManifest,
  nowStamp,
  type PendingEntry,
  pendingPath,
  savePendingManifest,
} from "./staging.ts";

export interface ApproveOpts {
  dump: string;
  /** discard the staged files instead of promoting them. */
  reject?: boolean;
  /** restrict to these type dirs (null/undefined = all). */
  typeKeys?: string[] | null;
  /** exclude these type dirs (applied after typeKeys). */
  excludeTypeKeys?: string[] | null;
  /** restrict to these article ids (null/undefined = all). */
  ids?: string[] | null;
  /** archive the replaced live file to _replaced/ before overwriting (default true). */
  archive?: boolean;
  /** also promote edits flagged risky (body-dropped/body-error). */
  includeRisky?: boolean;
  /** preview only: compute + report, change nothing on disk. */
  dryRun?: boolean;
  changelog?: Changelog;
  nowMs: number;
  logger?: Logger;
}

export interface ApproveItem {
  typeKey: string;
  id: string;
  title?: string;
  risk: string[];
  action: "promoted" | "rejected" | "held-risky" | "missing-pending" | "preview";
  archived?: string | null;
}

export interface ApproveResult {
  items: ApproveItem[];
  promoted: number;
  rejected: number;
  heldRisky: number;
  remaining: number; // pending entries still awaiting approval after this op
}

function matches(e: PendingEntry, opts: ApproveOpts): boolean {
  if (opts.typeKeys && opts.typeKeys.length && !opts.typeKeys.includes(e.typeKey)) return false;
  if (opts.excludeTypeKeys && opts.excludeTypeKeys.includes(e.typeKey)) return false;
  if (opts.ids && opts.ids.length && !opts.ids.includes(e.id)) return false;
  return true;
}

export async function approve(opts: ApproveOpts): Promise<ApproveResult> {
  const log = opts.logger ?? NULL_LOGGER;
  const data = await loadPendingManifest(opts.dump);
  const stamp = nowStamp(opts.nowMs);
  const items: ApproveItem[] = [];
  const kept: PendingEntry[] = [];
  let promoted = 0, rejected = 0, heldRisky = 0;

  for (const e of data.entries) {
    if (!matches(e, opts)) {
      kept.push(e);
      continue;
    }
    const pp = pendingPath(opts.dump, e.typeKey, e.id);
    const lp = livePath(opts.dump, e.typeKey, e.id);

    if (!(await exists(pp))) {
      // Manifest entry whose pending file is gone — drop it (don't keep dangling).
      items.push({
        typeKey: e.typeKey,
        id: e.id,
        title: e.title,
        risk: [],
        action: "missing-pending",
      });
      continue;
    }

    // Recompute risk fresh from the actual files so it reflects reality (e.g. after
    // an enrich pass filled the staged article's body).
    let risk: string[] = [];
    let docType = e.typeKey;
    try {
      const pend = await readJson<Article>(pp);
      docType = pend.documentType ?? e.typeKey;
      const live = (await exists(lp)) ? await readJson<Article>(lp) : null;
      risk = computeRisk(live, pend);
    } catch {
      // unreadable pending file -> treat as no risk info
    }

    if (opts.dryRun) {
      items.push({ typeKey: e.typeKey, id: e.id, title: e.title, risk, action: "preview" });
      kept.push(e);
      continue;
    }

    if (opts.reject) {
      await Deno.remove(pp).catch(() => {});
      rejected++;
      items.push({ typeKey: e.typeKey, id: e.id, title: e.title, risk, action: "rejected" });
      continue;
    }

    if (risk.length && !opts.includeRisky) {
      heldRisky++;
      kept.push(e); // stays pending until explicitly included
      items.push({ typeKey: e.typeKey, id: e.id, title: e.title, risk, action: "held-risky" });
      continue;
    }

    // Promote: archive the replaced live file, then move pending into place.
    let archived: string | null = null;
    if (opts.archive !== false) archived = await archiveReplaced(opts.dump, e.typeKey, e.id, stamp);
    await Deno.mkdir(lp.slice(0, lp.lastIndexOf("/")), { recursive: true });
    await Deno.rename(pp, lp);
    promoted++;
    items.push({
      typeKey: e.typeKey,
      id: e.id,
      title: e.title,
      risk,
      action: "promoted",
      archived,
    });
    opts.changelog?.record({
      op: "edited",
      documentType: docType,
      id: e.id,
      title: e.title,
      changed: e.changed,
      hashOld: e.hashOld,
      hashNew: e.hashNew,
      source: "approve",
      detail: archived
        ? `replaced live file archived${risk.length ? ` (risk: ${risk.join(",")})` : ""}`
        : undefined,
    });
  }

  if (!opts.dryRun) {
    data.entries = kept;
    data.generatedAt = new Date(opts.nowMs).toISOString();
    await savePendingManifest(opts.dump, data);
  }
  log.info(
    `approve: promoted=${promoted} rejected=${rejected} held-risky=${heldRisky} ` +
      `remaining=${kept.length}`,
  );
  return { items, promoted, rejected, heldRisky, remaining: kept.length };
}
