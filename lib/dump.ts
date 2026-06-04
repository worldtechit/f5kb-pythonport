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
}

export interface DumpTypesResult {
  manifest: TypeStatus[];
  indexPath: string;
  total: number;
  /** typeKey -> set of article ids present in Coveo this run (for deletion reconcile). */
  currentIds: Map<string, Set<string>>;
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
  } = opts;

  if (!dryRun) await Deno.mkdir(outDir, { recursive: true });

  const manifest: TypeStatus[] = [];
  const currentIds = new Map<string, Set<string>>();

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

        // Compare against the DB's stored metadata_hash when we have one (incremental
        // skip and/or a changelog need it). Incremental: an unchanged article is left
        // untouched (the existing, possibly-enriched file stays). Non-incremental with
        // a changelog: we still rewrite, but only log genuinely added/edited articles.
        if (priorHashes && (incremental || changelog)) {
          const mh = await sha256(metadata);
          const prior = priorHashes.get(dbKey(cfg.documentType, id));
          const unchanged = prior !== undefined && prior === mh;
          if (unchanged) {
            if (incremental) {
              st.skipped++;
              continue; // skip write; enrich (resumable) won't touch it either
            }
            // non-incremental: rewritten but not a change — don't log it.
          } else {
            changelog?.record({
              op: prior === undefined ? "added" : "edited",
              documentType: cfg.documentType,
              id,
              title,
              hashOld: prior,
              hashNew: mh,
              source: "dump",
            });
          }
        }

        const entry = {
          id,
          documentType: cfg.documentType,
          title,
          link: (r.clickUri as string) ?? (raw.clickableuri as string) ?? "",
          modifiedMs: modMs ?? null,
          modified: modMs ? new Date(modMs).toISOString() : null,
          capturedAt: new Date(nowMs).toISOString(),
          metadata,
          content,
        };
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

      // Undercount=partial only under --all. In incremental mode unchanged articles
      // are present-but-skipped, so completeness = written + skipped.
      const present = st.written + st.skipped;
      const undercount = allTime && st.expected !== null && limit === Infinity &&
        present < st.expected;
      if (st.writeErrors > 0 || undercount) st.status = "partial";

      const flag = st.status === "ok" ? "" : `  [${st.status.toUpperCase()}]`;
      const exp = st.expected !== null ? `/${st.expected}` : "";
      const skip = st.skipped ? ` (${st.skipped} unchanged)` : "";
      progress.done(
        `${st.written}${exp} written${skip} article${
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

  return { manifest, indexPath, total, currentIds };
}
