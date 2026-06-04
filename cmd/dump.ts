// `f5kb dump` — dumps full metadata + content for F5 KB articles, one JSON per
// article, split by document type, driven by config.yaml. Behavior reference:
// dump_articles.ts main(). File formats (per-article JSON, _catalogue.*,
// _index.json) and the exit code (1 if any type FAILED) are preserved exactly.
//
// Flags:
//   --days=N | --all     (one required) window; --all = entire corpus
//   --out=DIR            REQUIRED output directory
//   --config=FILE        config YAML (default config.yaml)
//   --fields-doc=FILE    DEPRECATED — descriptions now come from config.yaml;
//                        if given, still loaded + merged over config descriptions
//   --types="A,B"        subset of config type keys
//   --page-size=N        results per call (default 200, max 500)
//   --limit=N            cap articles per type (testing)

import { type ParsedArgs } from "../lib/args.ts";
import { type Logger } from "../lib/logger.ts";
import { flagBool, flagNum, flagStr } from "../lib/args.ts";
import { loadConfig, loadFieldDescriptionsFile } from "../lib/config/loader.ts";
import { CoveoClient } from "../lib/coveo/client.ts";
import { fetchCoveoConfig, refreshConfig } from "../lib/coveo/aura.ts";
import { dumpTypes } from "../lib/dump.ts";
import { Changelog, changelogPathFromFlag } from "../lib/changelog.ts";
import { loadHashIndex } from "../lib/track/db.ts";
import { mergePending } from "../lib/staging.ts";

// Optional injected dependencies — used by tests to drive the dump loop offline
// with a mocked CoveoClient. Production callers omit this; the global-fetch path
// (token fetch + CoveoClient) is unchanged.
export interface DumpDeps {
  client?: CoveoClient;
}

export async function run(args: ParsedArgs, logger: Logger, deps: DumpDeps = {}): Promise<number> {
  const flags = args.flags;

  const allTime = "all" in flags;
  const daysRaw = flagStr(flags, "days");
  const days = Number(daysRaw);
  if (!allTime && (!daysRaw || !Number.isFinite(days) || days <= 0)) {
    logger.error("provide --all or --days=N (a positive number)");
    return 1;
  }

  const outDir = flagStr(flags, "out");
  if (!outDir) {
    logger.error("--out (output directory) is required");
    return 1;
  }

  const configPath = flagStr(flags, "config", "config.yaml")!;
  const fieldsDocPath = flagStr(flags, "fields-doc");
  const pageSize = Math.min(flagNum(flags, "page-size", 200)!, 500);
  const limit = flags.limit ? parseInt(String(flags.limit)) : Infinity;
  const typeKeyFilter = typeof flags.types === "string"
    ? flags.types.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

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

  // Field descriptions: from config.yaml, with the deprecated --fields-doc merged on top.
  let descriptions = { ...config.fieldDescriptions };
  if (fieldsDocPath) {
    logger.warn(
      "--fields-doc is DEPRECATED: field descriptions now come from config.yaml. " +
        `Merging ${fieldsDocPath} over the config descriptions.`,
    );
    const extra = await loadFieldDescriptionsFile(fieldsDocPath);
    descriptions = { ...descriptions, ...extra };
  }

  // ---- token / client ----
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

  logger.info(`Field descriptions loaded: ${Object.keys(descriptions).length}`);

  const nowMs = Date.now();
  const cutoffMs = allTime ? Date.UTC(2000, 0, 1) : nowMs - days * 86400000;
  const endMs = nowMs + 86400000; // slightly future so newest items are never clipped

  logger.info(
    allTime
      ? "Window: entire corpus (--all, no lower date bound)"
      : `Window: articles modified since ${new Date(cutoffMs).toISOString().slice(0, 10)} ` +
        `(last ${days} day${days === 1 ? "" : "s"})`,
  );

  // Approval gate ON by default: an article that already exists and changed is an
  // OVERWRITE of saved data, so it is staged to _pending/ for review instead of
  // clobbering the live file (unchanged articles are skipped; new ones written
  // directly). --yes bypasses: overwrite in place, archiving the replaced file to
  // _replaced/. Classification needs prior hashes (DB, with a live-file fallback).
  const bypass = flagBool(flags, "yes");
  const dbPath = flagStr(flags, "db") ?? `${outDir.replace(/\/+$/, "")}/../articles.db`;
  const changelogPath = changelogPathFromFlag(flags["changelog"], outDir);
  const changelog = new Changelog(changelogPath, new Date(nowMs).toISOString());
  const priorHashes = await loadHashIndex(dbPath);

  const { manifest, total, pending } = await dumpTypes(client, {
    typeConfigs,
    typeKeys,
    descriptions,
    outDir,
    allTime,
    mode: allTime ? "all" : `days=${days}`,
    cutoffMs,
    endMs,
    nowMs,
    pageSize,
    limit,
    configPath,
    logger,
    priorHashes,
    changelog,
    approval: !bypass,
    archiveOnOverwrite: bypass,
  });
  await changelog.flush();
  if (changelogPath) logger.info(`Changelog: ${changelogPath}`);
  if (pending.length) {
    await mergePending(outDir, pending, new Date(nowMs).toISOString());
    logger.warn(
      `${pending.length} edited article(s) STAGED to ${outDir}/_pending/ (live data not ` +
        `overwritten). Run enrich to fill their bodies, then \`f5kb approve\` ` +
        `(or re-dump with --yes to overwrite in place).`,
    );
  }

  const failed = manifest.filter((m) => m.status === "failed");
  const partial = manifest.filter((m) => m.status === "partial");

  logger.info(
    `Done. ${total} article${total === 1 ? "" : "s"} across ${manifest.length} type(s) ` +
      `written to ${outDir}/ (manifest: ${outDir}/_index.json)`,
  );
  if (partial.length) {
    logger.warn(
      `PARTIAL (${partial.length}): ` +
        partial.map((m) =>
          `${m.typeKey} (${m.written}/${m.expected ?? "?"}, writeErr=${m.writeErrors})`
        )
          .join(", "),
    );
  }
  if (failed.length) {
    logger.error(
      `FAILED (${failed.length}): ` +
        failed.map((m) => `${m.typeKey}: ${m.error}`).join("; "),
    );
    logger.error(`Re-run just these with --types="${failed.map((m) => m.typeKey).join(",")}"`);
    return 1;
  }
  return 0;
}
