// Dump orchestration: given a (live or mocked) CoveoClient and resolved options,
// fetch each configured type, write one JSON per article + the per-type field
// catalogue, and emit _index.json. This is the per-type loop extracted VERBATIM
// from cmd/dump.ts so it can be driven offline in tests with an injected
// CoveoClient. cmd/dump.ts keeps arg parsing / config loading / client
// construction and calls dumpTypes(); the data-affecting logic is unchanged.

import { type Logger, NULL_LOGGER } from "./logger.ts";
import { normalizeType, type TypeConfig } from "./config/types.ts";
import { CoveoClient, type CoveoResult } from "./coveo/client.ts";
import { dateAq, modMsOf } from "./coveo/dates.ts";
import { fetchTypeSince } from "./coveo/paging.ts";
import {
  type CatalogueEntry,
  flattenFieldsSafe,
  splitEntry,
  updateCatalogue,
  writeCatalogue,
} from "./coveo/fields.ts";
import { idOf, sanitizeName } from "./fsutil.ts";
import { makeProgress } from "./progress.ts";
import { sha256 } from "./track/hashing.ts";
import type { Changelog } from "./changelog.ts";
import {
  archiveReplaced,
  liveArticle,
  nowStamp,
  type PendingEntry,
  pendingPath,
} from "./staging.ts";

// DB key for an article: matches the (document_type, id) primary key in articles.db.
export function dbKey(documentType: string, id: string): string {
  return `${documentType} ${id}`;
}

export interface TypeStatus {
  typeKey: string;
  documentType: string;
  dir: string;
  status: "ok" | "partial" | "failed";
  expected: number | null;
  fetched: number;
  written: number;
  /** incremental mode: unchanged articles left untouched (not rewritten). */
  skipped: number;
  /** approval gate: edited articles routed to _pending/ instead of overwriting live. */
  staged: number;
  /** bypass (--yes): edited live files archived to _replaced/ before overwriting. */
  replaced: number;
  writeErrors: number;
  error?: string;
}

export interface DumpTypesOpts {
  /** type key -> config (documentType + keep-lists); iterated by typeKeys order. */
  typeConfigs: Record<string, Partial<TypeConfig>>;
  /** type keys to dump (already filtered/validated by the caller). */
  typeKeys: string[];
  /** field-name -> catalogue description. */
  descriptions: Record<string, string>;
  outDir: string;
  allTime: boolean;
  /** _index.json "mode" string: "all" or "days=N" (matches dump_articles.ts). */
  mode: string;
  /** epoch ms lower bound (ignored when allTime). */
  cutoffMs: number;
  /** epoch ms upper bound. */
  endMs: number;
  /** capturedAt stamp (epoch ms) — one value across the whole run. */
  nowMs: number;
  pageSize: number;
  limit: number;
  configPath: string;
  logger?: Logger;
  /** incremental mode: skip rewriting articles whose metadata_hash is unchanged. */
  incremental?: boolean;
  /** dbKey(documentType,id) -> metadata_hash from the DB (loaded by the caller). */
  priorHashes?: Map<string, string>;
  /** optional changelog sink (records added/edited). */
  changelog?: Changelog;
  /** preview: classify + record changelog but write no files (no article/catalogue/_index). */
  dryRun?: boolean;
  /** approval gate: route edited (would-overwrite) articles to _pending/ instead of
   *  overwriting the live file. Implies classification + skip-unchanged. */
  approval?: boolean;
  /** bypass: when NOT staging, archive the live file to _replaced/ before overwriting
   *  an edited article (set when --yes is used on a gated command). */
  archiveOnOverwrite?: boolean;
}

export interface DumpTypesResult {
  manifest: TypeStatus[];
  indexPath: string;
  total: number;
  /** typeKey -> set of article ids present in Coveo this run (for deletion reconcile). */
  currentIds: Map<string, Set<string>>;
  /** approval gate: edited articles staged to _pending/ this run (caller merges the
   *  manifest, after any enrich pass that fills their bodies). */
  pending: PendingEntry[];
}

// Run the per-type dump loop and write _index.json. Returns the manifest so the
// caller can compute the exit code (1 if any type FAILED).
export async function dumpTypes(
  client: CoveoClient,
  opts: DumpTypesOpts,
): Promise<DumpTypesResult> {
  const logger = opts.logger ?? NULL_LOGGER;
  const {
    typeConfigs,
    typeKeys,
    descriptions,
    outDir,
    allTime,
    mode,
    cutoffMs,
    endMs,
    nowMs,
    pageSize,
    limit,
    configPath,
    incremental,
    priorHashes,
    changelog,
    dryRun,
    approval,
    archiveOnOverwrite,
  } = opts;

  if (!dryRun) await Deno.mkdir(outDir, { recursive: true });

  const manifest: TypeStatus[] = [];
  const currentIds = new Map<string, Set<string>>();
  const pending: PendingEntry[] = [];
  const stamp = nowStamp(nowMs);
  const capturedIso = new Date(nowMs).toISOString();

  for (const typeKey of typeKeys) {
    const cfg: TypeConfig = normalizeType({
      documentType: typeConfigs[typeKey]?.documentType,
      metadata: typeConfigs[typeKey]?.metadata,
      content: typeConfigs[typeKey]?.content,
    });
    const dir = sanitizeName(typeKey);
    if (!cfg.documentType) {
      logger.warn(`Skipping "${typeKey}": no documentType in config`);
      manifest.push({
        typeKey,
        documentType: "",
        dir,
        status: "failed",
        expected: null,
        fetched: 0,
        written: 0,
        skipped: 0,
        staged: 0,
        replaced: 0,
        writeErrors: 0,
        error: "no documentType in config",
      });
      continue;
    }

    const st: TypeStatus = {
      typeKey,
      documentType: cfg.documentType,
      dir,
      status: "ok",
      expected: null,
      fetched: 0,
      written: 0,
      skipped: 0,
      staged: 0,
      replaced: 0,
      writeErrors: 0,
    };
    const idSet = new Set<string>();
    currentIds.set(typeKey, idSet);
    const progress = makeProgress(logger);
    try {
      // Server-side count over the window — the target to validate against.
      const expectAq = allTime
        ? `@f5_document_type=="${cfg.documentType}"`
        : `@f5_document_type=="${cfg.documentType}" ${dateAq(cutoffMs, endMs)}`.trim();
      st.expected = await client.getCount(expectAq);

      progress.start(typeKey, st.expected ?? undefined);
      const results = await fetchTypeSince(
        client,
        cfg.documentType,
        cutoffMs,
        endMs,
        pageSize,
        limit,
        (n) => progress.update(n),
        !allTime,
      );
      st.fetched = results.length;

      const typeDir = `${outDir}/${dir}`;
      if (!dryRun) await Deno.mkdir(typeDir, { recursive: true });

      const catalogue = new Map<string, CatalogueEntry>();
      const seenIds = new Map<string, number>();

      for (const r of results) {
        const fields = flattenFieldsSafe(r);
        updateCatalogue(catalogue, fields, descriptions);

        const { metadata, content } = splitEntry(fields, cfg);
        const raw = (r.raw as CoveoResult) ?? {};

        let id = idOf(r);
        const n = (seenIds.get(id) ?? 0) + 1;
        seenIds.set(id, n);
        if (n > 1) id = `${id}__${n}`;

        idSet.add(id); // present in Coveo this run (for deletion reconcile)

        const modMs = modMsOf(raw);
        const title = (r.title as string) ?? "";

        const entry = {
          id,
          documentType: cfg.documentType,
          title,
          link: (r.clickUri as string) ?? (raw.clickableuri as string) ?? "",
          modifiedMs: modMs ?? null,
          modified: modMs ? new Date(modMs).toISOString() : null,
          capturedAt: capturedIso,
          metadata,
          content,
        };

        // Classify this article vs the saved state when any consumer needs it:
        // incremental skip, the changelog, or the approval gate. The approval gate
        // also falls back to the live FILE's metadata when the DB has no entry, so a
        // would-overwrite is protected even without a tracking DB.
        // The gate (stage on edit) and bypass (archive+overwrite on edit) both need
        // edited-vs-unchanged classification; so do incremental skip and the changelog.
        const gated = approval || archiveOnOverwrite;
        const classify = incremental || changelog || gated;
        let unchanged = false, isEdited = false, isNew = false;
        let mh: string | undefined, prior: string | undefined;
        if (classify) {
          mh = await sha256(metadata);
          prior = priorHashes?.get(dbKey(cfg.documentType, id));
          if (prior === undefined && gated) {
            // protect/recognize an edit even without a DB entry: hash the live file
            const lf = await liveArticle(outDir, dir, id);
            if (lf) prior = await sha256(lf.metadata ?? {});
          }
          unchanged = prior !== undefined && prior === mh;
          isEdited = prior !== undefined && prior !== mh;
          isNew = prior === undefined;
        }

        // Unchanged: leave the existing (possibly-enriched) file alone. Skip under
        // incremental OR the gate/bypass (all protect/needn't-rewrite saved data); a
        // plain changelog-only dump still rewrites it (byte-identical) without logging.
        if (unchanged && (incremental || gated)) {
          st.skipped++;
          continue;
        }
        // A new article is applied immediately (nothing to overwrite) -> log it now.
        if (isNew && changelog) {
          changelog.record({
            op: "added",
            documentType: cfg.documentType,
            id,
            title,
            hashNew: mh,
            source: "dump",
          });
        }

        // Approval gate: an edit would OVERWRITE saved data -> stage to _pending/
        // instead, leaving the live file untouched for review. NOT recorded to the
        // changelog here — it isn't applied yet; `approve` logs it on promotion.
        if (isEdited && approval) {
          if (!dryRun) {
            const pp = pendingPath(outDir, dir, id);
            await Deno.mkdir(pp.slice(0, pp.lastIndexOf("/")), { recursive: true });
            await Deno.writeTextFile(pp, JSON.stringify(entry, null, 2));
          }
          st.staged++;
          pending.push({
            typeKey: dir,
            id,
            title,
            op: "edited",
            changed: ["metadata"],
            source: "dump",
            hashOld: prior,
            hashNew: mh,
            stagedAt: capturedIso,
          });
          continue;
        }

        // Edit being APPLIED in place (no gate, or --yes bypass): log it, and under
        // bypass archive the live file first so a bad overwrite stays recoverable.
        if (isEdited) {
          if (changelog) {
            changelog.record({
              op: "edited",
              documentType: cfg.documentType,
              id,
              title,
              hashOld: prior,
              hashNew: mh,
              source: "dump",
            });
          }
          if (archiveOnOverwrite && !dryRun) {
            const arch = await archiveReplaced(outDir, dir, id, stamp);
            if (arch) st.replaced++;
          }
        }

        try {
          if (!dryRun) {
            await Deno.writeTextFile(`${typeDir}/${id}.json`, JSON.stringify(entry, null, 2));
          }
          st.written++;
        } catch (e) {
          st.writeErrors++;
          if (st.writeErrors <= 3) logger.warn(`write failed for ${id}: ${(e as Error).message}`);
        }
      }

      if (!dryRun) {
        await writeCatalogue(typeDir, typeKey, cfg.documentType, catalogue, results.length, cfg);
      }

      // Undercount=partial only under --all. Unchanged articles are present-but-
      // skipped and staged ones are present-but-pending, so completeness counts all.
      const present = st.written + st.skipped + st.staged;
      const undercount = allTime && st.expected !== null && limit === Infinity &&
        present < st.expected;
      if (st.writeErrors > 0 || undercount) st.status = "partial";

      const flag = st.status === "ok" ? "" : `  [${st.status.toUpperCase()}]`;
      const exp = st.expected !== null ? `/${st.expected}` : "";
      const skip = st.skipped ? ` (${st.skipped} unchanged)` : "";
      const stg = st.staged ? ` (${st.staged} staged for approval)` : "";
      progress.done(
        `${st.written}${exp} written${skip}${stg} article${
          st.written === 1 ? "" : "s"
        } -> ${typeDir}/${flag}`,
      );
    } catch (e) {
      st.status = "failed";
      st.error = (e as Error).message;
      progress.done(`FAILED: ${st.error}`);
    }
    manifest.push(st);
  }

  const failed = manifest.filter((m) => m.status === "failed");
  const partial = manifest.filter((m) => m.status === "partial");
  const total = manifest.reduce((a, m) => a + m.written, 0);

  const indexPath = `${outDir}/_index.json`;
  if (!dryRun) {
    await Deno.writeTextFile(
      indexPath,
      JSON.stringify(
        {
          mode,
          cutoff: new Date(cutoffMs).toISOString(),
          generatedAt: new Date(nowMs).toISOString(),
          config: configPath,
          totalArticles: total,
          counts: {
            types: manifest.length,
            ok: manifest.filter((m) => m.status === "ok").length,
            partial: partial.length,
            failed: failed.length,
          },
          types: manifest,
        },
        null,
        2,
      ),
    );
  }

  return { manifest, indexPath, total, currentIds, pending };
}
