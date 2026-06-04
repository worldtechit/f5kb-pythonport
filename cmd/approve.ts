// `f5kb approve` — review and apply (or reject) the overwrites the approval gate
// staged under <dump>/_pending/. This is the human checkpoint that protects good
// saved data from being clobbered by a bad upstream change. Behavior reference:
// lib/approve.ts.
//
// Default: promote staged edits into the live dump, archiving each replaced file to
// _replaced/, then update the tracking DB. Edits flagged risky (body-dropped /
// body-error) are HELD BACK and reported — pass --include-risky to apply them too.
//
// Flags:
//   --dump=DIR          dump directory (default outputs/dump)
//   --db=FILE           SQLite file (default <dump>/../articles.db)
//   --types="A,B"       only act on these type dirs
//   --ids="K1,K2"       only act on these article ids
//   --list              preview: show pending edits + risk, change nothing
//   --reject            discard the staged files instead of promoting them
//   --include-risky     also promote edits flagged risky (default: hold them back)
//   --no-archive        don't keep a _replaced/ copy of overwritten files
//   --changelog[=FILE]  record promotions to a JSONL changelog
//   --json              print the result as JSON on STDOUT

import { type ParsedArgs } from "../lib/args.ts";
import { flagBool, flagStr } from "../lib/args.ts";
import { type Logger } from "../lib/logger.ts";
import { approve } from "../lib/approve.ts";
import { trackDump } from "../lib/track/db.ts";
import { Changelog, changelogPathFromFlag } from "../lib/changelog.ts";

export interface ApproveDeps {
  nowMs?: number;
}

export async function run(
  args: ParsedArgs,
  logger: Logger,
  deps: ApproveDeps = {},
): Promise<number> {
  const flags = args.flags;
  const dump = flagStr(flags, "dump", "outputs/dump")!;
  const db = flagStr(flags, "db");
  const dbPath = db ?? `${dump.replace(/\/+$/, "")}/../articles.db`;
  const typeKeys = typeof flags.types === "string"
    ? flags.types.split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  const ids = typeof flags.ids === "string"
    ? flags.ids.split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  const list = flagBool(flags, "list");
  const reject = flagBool(flags, "reject");
  const includeRisky = flagBool(flags, "include-risky");
  const archive = !flagBool(flags, "no-archive");
  const asJson = flagBool(flags, "json");

  const nowMs = deps.nowMs ?? Date.now();
  const changelogPath = changelogPathFromFlag(flags["changelog"], dump);
  const changelog = new Changelog(changelogPath, new Date(nowMs).toISOString());

  const result = await approve({
    dump,
    reject,
    typeKeys,
    ids,
    archive,
    includeRisky,
    dryRun: list,
    changelog,
    nowMs,
    logger,
  });

  await changelog.flush();

  // A promotion changes live files -> reindex so the DB matches.
  if (!list && !reject && result.promoted > 0) {
    await trackDump({ dump, db: dbPath, runId: new Date(nowMs).toISOString(), logger });
  }

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  // Human summary: list each item with its risk flags.
  for (const it of result.items) {
    const risk = it.risk.length ? `  [risk: ${it.risk.join(", ")}]` : "";
    logger.info(`  ${it.action.padEnd(15)} ${it.typeKey}/${it.id}${risk}`);
  }
  if (list) {
    logger.info(
      `${result.items.length} pending edit(s). Run \`f5kb approve\` to apply` +
        ` (risky ones need --include-risky).`,
    );
  } else if (reject) {
    logger.info(`Rejected ${result.rejected} staged edit(s); ${result.remaining} still pending.`);
  } else {
    logger.info(
      `Promoted ${result.promoted} edit(s)` +
        (result.heldRisky
          ? `; HELD ${result.heldRisky} risky (re-run with --include-risky to apply)`
          : "") +
        `; ${result.remaining} still pending.`,
    );
  }
  return 0;
}
