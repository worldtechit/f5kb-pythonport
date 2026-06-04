// `f5kb reconcile` — find articles that exist in our DB/dump but no longer exist
// upstream in Coveo, and (only with --apply) remove them on our side. Report-only
// by default. --apply soft-deletes (archive the file under _deleted/<type>/, drop
// the DB row) after backing up the DB and enforcing a deletion-threshold guard;
// --purge hard-removes the file instead of archiving. Behavior reference:
// lib/reconcile.ts reconcile.
//
// Flags:
//   --types="A,B"          subset of config type keys (default: all in config)
//   --dump=DIR             dump directory (default outputs/dump)
//   --config=FILE          config YAML (default config.yaml)
//   --db=FILE              SQLite file (default <dump>/../articles.db)
//   --apply                actually remove (default: report only / dry-run)
//   --purge                hard-remove files instead of archiving to _deleted/
//   --max-delete-pct=N     abort if a type's deletions exceed N% of its DB rows (default 10)
//   --max-deletes=N        abort if total deletions exceed N (optional absolute cap)
//   --changelog[=FILE]     record deletions to a JSONL changelog
//   --page-size=N          IDs-only sweep page size (default 2000)
//   --json                 print the result as JSON to STDOUT

import { type ParsedArgs } from "../lib/args.ts";
import { flagBool, flagNum, flagStr } from "../lib/args.ts";
import { type Logger } from "../lib/logger.ts";
import { loadConfig } from "../lib/config/loader.ts";
import { CoveoClient } from "../lib/coveo/client.ts";
import { fetchCoveoConfig, refreshConfig } from "../lib/coveo/aura.ts";
import { Changelog, changelogPathFromFlag } from "../lib/changelog.ts";
import { reconcile } from "../lib/reconcile.ts";

export interface ReconcileDeps {
  client?: CoveoClient;
  nowMs?: number;
}

export async function run(
  args: ParsedArgs,
  logger: Logger,
  deps: ReconcileDeps = {},
): Promise<number> {
  const flags = args.flags;

  const dump = flagStr(flags, "dump", "outputs/dump")!;
  const configPath = flagStr(flags, "config", "config.yaml")!;
  const db = flagStr(flags, "db");
  const apply = flagBool(flags, "apply");
  const purge = flagBool(flags, "purge");
  const pageSize = flagNum(flags, "page-size", 2000)!;
  const asJson = flagBool(flags, "json");
  const maxDeletePct = (flagNum(flags, "max-delete-pct", 10)!) / 100;
  const maxDeletes = flags["max-deletes"] !== undefined ? flagNum(flags, "max-deletes") : undefined;
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

  const dbPath = db ?? `${dump.replace(/\/+$/, "")}/../articles.db`;
  const changelogPath = changelogPathFromFlag(flags["changelog"], dump);
  const runId = new Date(deps.nowMs ?? Date.now()).toISOString();
  // No file written in report-only mode (path stays null unless --changelog given).
  const changelog = new Changelog(changelogPath, runId);

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

  logger.info(
    apply
      ? `Reconcile (APPLY${purge ? ", PURGE" : ""}): removing upstream-deleted articles`
      : "Reconcile (report only): pass --apply to remove",
  );

  const result = await reconcile({
    client,
    dump,
    db: dbPath,
    typeConfigs,
    typeKeys,
    apply,
    purge,
    maxDeletePct,
    maxDeletes,
    changelog,
    logger,
    pageSize,
  });

  await changelog.flush();

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  }

  logger.info(
    `Reconcile done: ${result.totalDeletions} deletion(s) across ${result.perType.length} type(s)` +
      (result.applied
        ? ` — applied${result.backupPath ? ` (DB backup: ${result.backupPath})` : ""}`
        : " — reported only"),
  );
  if (changelogPath && result.totalDeletions) logger.info(`Changelog: ${changelogPath}`);

  // A tripped threshold guard is a non-zero exit so scripts notice the abort.
  if (result.aborted) return 1;
  return 0;
}
