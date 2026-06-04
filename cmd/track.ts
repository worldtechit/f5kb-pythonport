// `f5kb track` — indexes a dump into the SQLite overview and reports
// new/changed/unchanged/removed. Behavior reference: track_articles.ts main().
// The DB schema/upsert come from lib/track/db.ts (byte-identical). Returns 0.
//
// Flags:
//   --dump=DIR     dump directory (default outputs/dump)
//   --db=FILE      SQLite file (default <dump>/../articles.db)
//   --types="A,B"  only index these type subdirs
//   --run-id=ID    label for this run (default current ISO timestamp)
//   --json         print the run summary as JSON to STDOUT

import { type ParsedArgs } from "../lib/args.ts";
import { flagBool, flagList, flagStr } from "../lib/args.ts";
import { type Logger, makeLogger } from "../lib/logger.ts";
import { trackDump } from "../lib/track/db.ts";
import { Changelog, changelogPathFromFlag } from "../lib/changelog.ts";

export async function run(args: ParsedArgs, logger: Logger): Promise<number> {
  const flags = args.flags;

  const dump = flagStr(flags, "dump", "outputs/dump")!;
  const db = flagStr(flags, "db");
  const types = flagList(flags, "types");
  const excludeTypes = flagList(flags, "exclude-types");
  // Pin one runId so the changelog records, the runs row, and the changes rows all
  // share it (trackDump would otherwise default to its own fresh timestamp).
  const runId = flagStr(flags, "run-id") ?? new Date().toISOString();
  const asJson = flagBool(flags, "json");

  // In --json mode, floor the logger at warn so the human info summary is dropped
  // (the JSON on STDOUT is the only payload) while skip-unreadable warnings still
  // surface on STDERR. Otherwise log the full human summary.
  const trackLogger = asJson ? makeLogger({ level: "warn", json: false, scope: "track" }) : logger;

  const changelogPath = changelogPathFromFlag(flags["changelog"], dump);
  const changelog = new Changelog(changelogPath, runId);

  const summary = await trackDump({
    dump,
    db,
    types,
    excludeTypes,
    runId,
    logger: trackLogger,
    changelog,
  });

  await changelog.flush();

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else if (changelogPath) {
    logger.info(`Changelog: ${changelogPath}`);
  }
  return 0;
}
