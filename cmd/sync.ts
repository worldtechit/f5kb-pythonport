// `f5kb sync` — incremental update of a dump + its tracking DB. Reuses the dump,
// enrich and track building blocks but only rewrites articles whose metadata_hash
// changed, enriches just those (enrich is resumable), updates the DB, and DETECTS
// + REPORTS upstream deletions (never removes them — use `f5kb reconcile --apply`).
// Every change is recorded to a JSONL changelog (on by default; --no-changelog or
// --changelog=FILE to control). Behavior reference: lib/sync.ts syncDump.
//
// Flags:
//   --all                 full corpus (deletion detection valid)
//   --days=N              only articles modified in the last N days (no deletion detect)
//   --since-last-run      window from the DB's most recent run (no deletion detect)
//   --types="A,B"         subset of config type keys
//   --out=DIR             dump directory (default outputs/dump)
//   --config=FILE         config YAML (default config.yaml)
//   --db=FILE             SQLite file (default <out>/../articles.db)
//   --no-enrich           skip body enrichment
//   --changelog[=FILE]    changelog path (default <out>/_changelog.jsonl)
//   --no-changelog        disable the changelog
//   --dry-run             classify + report only; write no files / DB / changelog
//   --page-size=N         results per call (default 200, max 500)
//   --limit=N             cap articles per type (testing)
//   --concurrency=N       enrich parallelism (default 4)
//   --delay-ms=N          enrich min delay per worker (default 200)

import { type ParsedArgs } from "../lib/args.ts";
import { flagBool, flagNum, flagStr } from "../lib/args.ts";
import { type Logger } from "../lib/logger.ts";
import { loadConfig } from "../lib/config/loader.ts";
import { CoveoClient } from "../lib/coveo/client.ts";
import { fetchCoveoConfig, refreshConfig } from "../lib/coveo/aura.ts";
import { HttpClient } from "../lib/http/fetcher.ts";
import { changelogPathFromFlag } from "../lib/changelog.ts";
import { loadLastRunAt } from "../lib/track/db.ts";
import { syncDump } from "../lib/sync.ts";

// Optional injected dependencies — used by tests to drive sync offline with mocked
// clients. Production callers omit this; the global-fetch path is unchanged.
export interface SyncDeps {
  client?: CoveoClient;
  http?: HttpClient;
  nowMs?: number;
}

export async function run(args: ParsedArgs, logger: Logger, deps: SyncDeps = {}): Promise<number> {
  const flags = args.flags;

  const allTime = flagBool(flags, "all");
  const sinceLastRun = flagBool(flags, "since-last-run");
  const daysRaw = flagStr(flags, "days");
  const days = Number(daysRaw);
  const haveDays = !!daysRaw && Number.isFinite(days) && days > 0;
  const modeCount = [allTime, sinceLastRun, haveDays].filter(Boolean).length;
  if (modeCount === 0) {
    logger.error("provide one of --all, --days=N, or --since-last-run");
    return 1;
  }
  if (modeCount > 1) {
    logger.error("--all, --days=N and --since-last-run are mutually exclusive");
    return 1;
  }

  const outDir = flagStr(flags, "out", "outputs/dump")!;
  const configPath = flagStr(flags, "config", "config.yaml")!;
  const db = flagStr(flags, "db");
  const pageSize = Math.min(flagNum(flags, "page-size", 200)!, 500);
  const limit = flags.limit ? parseInt(String(flags.limit)) : Infinity;
  const concurrency = Math.max(1, flagNum(flags, "concurrency", 4) || 4);
  const delayMs = Math.max(0, flagNum(flags, "delay-ms", 200) ?? 200);
  const enrich = !flagBool(flags, "no-enrich");
  const dryRun = flagBool(flags, "dry-run");
  // Approval gate ON by default: edited articles are staged to _pending/ for review
  // instead of overwriting good data. --yes bypasses it (overwrite in place, after
  // archiving the replaced file to _replaced/).
  const bypass = flagBool(flags, "yes");
  const typeKeyFilter = typeof flags.types === "string"
    ? flags.types.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  // Changelog defaults ON for sync (the whole point is recording what changed);
  // --no-changelog disables, --changelog=FILE redirects.
  const changelogPath = flagBool(flags, "no-changelog")
    ? null
    : changelogPathFromFlag(flags["changelog"] ?? true, outDir);

  // ---- config ----
  let config;
  try {
    config = await loadConfig(configPath);
  } catch (e) {
    logger.error(`could not read/parse config ${configPath}: ${(e as Error).message}`);
    return 1;
  }
  const typeConfigs = config.types;
  let typeKeys = Object.keys(typeConfigs);
  if (!typeKeys.length) {
    logger.error(`config ${configPath} has no types`);
    return 1;
  }
  if (typeKeyFilter) {
    const unknown = typeKeyFilter.filter((k) => !typeKeys.includes(k));
    if (unknown.length) logger.warn(`type key(s) not in config ignored: ${unknown.join(", ")}`);
    typeKeys = typeKeys.filter((k) => typeKeyFilter.includes(k));
    if (!typeKeys.length) {
      logger.error("no valid type keys selected");
      return 1;
    }
  }
  const descriptions = { ...config.fieldDescriptions };

  const nowMs = deps.nowMs ?? Date.now();
  const dbPath = db ?? `${outDir.replace(/\/+$/, "")}/../articles.db`;

  // ---- window ----
  let mode: string;
  let cutoffMs: number;
  if (allTime) {
    mode = "all";
    cutoffMs = Date.UTC(2000, 0, 1);
  } else if (sinceLastRun) {
    const last = await loadLastRunAt(dbPath);
    if (last?.ranAtMs == null) {
      logger.warn("--since-last-run: no prior run recorded — falling back to --days=7");
      cutoffMs = nowMs - 7 * 86400000;
    } else {
      cutoffMs = last.ranAtMs;
      logger.info(
        `--since-last-run: window since ${new Date(cutoffMs).toISOString()} (${last.runId})`,
      );
    }
    mode = "since-last-run";
  } else {
    mode = `days=${days}`;
    cutoffMs = nowMs - days * 86400000;
  }
  const endMs = nowMs + 86400000; // slightly future so newest items are never clipped

  logger.info(
    allTime
      ? "Window: entire corpus (--all; deletion detection enabled)"
      : `Window: articles modified since ${new Date(cutoffMs).toISOString().slice(0, 10)} ` +
        `(deletion detection disabled — needs --all)`,
  );
  if (dryRun) logger.info("DRY RUN: no files, DB rows, or changelog will be written.");

  // ---- token / clients ----
  let client = deps.client;
  if (!client) {
    logger.info("Fetching Coveo configuration from F5 portal...");
    const coveoConfig = await fetchCoveoConfig();
    logger.info(`Organization ID: ${coveoConfig.organizationId}`);
    client = new CoveoClient(coveoConfig, {
      logger: logger.child("coveo"),
      refresh: (c) => refreshConfig(c),
    });
  }
  const http = deps.http ?? new HttpClient({ logger: logger.child("http") });

  let githubToken: string | undefined;
  try {
    githubToken = Deno.env.get("GITHUB_TOKEN") || undefined;
  } catch {
    githubToken = undefined;
  }

  const result = await syncDump({
    client,
    http,
    typeConfigs,
    typeKeys,
    descriptions,
    outDir,
    db: dbPath,
    mode,
    allTime,
    cutoffMs,
    endMs,
    nowMs,
    pageSize,
    limit,
    configPath,
    enrich,
    githubToken,
    concurrency,
    delayMs,
    changelogPath,
    dryRun,
    approval: !bypass,
    archiveOnOverwrite: bypass,
    logger,
  });

  // ---- summary ----
  logger.info(
    `Sync ${result.dryRun ? "(dry-run) " : ""}done [${result.mode}]: ` +
      `written=${result.written} skipped=${result.skipped} staged=${result.staged} ` +
      `added=${result.added} edited=${result.edited} ` +
      `body(added=${result.bodyAdded} changed=${result.bodyChanged} err=${result.bodyError})`,
  );
  if (result.staged) {
    logger.warn(
      `${result.staged} edited article(s) STAGED for review (good data not overwritten). ` +
        `Inspect ${outDir}/_pending/, then: f5kb approve  (or re-run sync with --yes to skip review)`,
    );
  }
  if (result.deletionDetectionRan) {
    logger.info(
      `Upstream deletions detected: ${result.deletionsDetected} ` +
        `(reported only; run \`f5kb reconcile --apply\` to remove)`,
    );
  } else {
    logger.info("Upstream deletion detection skipped (needs --all).");
  }
  if (result.changelogPath) logger.info(`Changelog: ${result.changelogPath}`);

  // ---- products-drift note (advisory) ----
  // Compare the SET of live top-level product names (f5_version values with no "|"
  // version suffix) against config.yaml's product list, and flag only names that
  // are live-but-unknown — the actionable drift. (A raw count comparison would
  // always differ: `discover` finds far more products via per-type probing than
  // the global facet exposes as top-level values.)
  if (!dryRun) {
    try {
      const live = await client.listFacetValues("f5_version");
      const cfgNames = new Set(config.products.entries.map((e) => e.product));
      const novel = live
        .map((v) => v.value)
        .filter((v) => !v.includes("|") && !cfgNames.has(v));
      if (novel.length) {
        logger.warn(
          `products drift: ${novel.length} live product(s) not in config.yaml: ` +
            `${novel.slice(0, 10).join(", ")}${novel.length > 10 ? ", …" : ""}. ` +
            `Re-run \`f5kb discover\` to refresh the products: snapshot.`,
        );
      }
    } catch {
      // advisory only — never fail sync on the facet probe
    }
  }

  return 0;
}
