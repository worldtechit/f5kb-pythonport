// Changelog recorder: a structured, append-only log of every change a mutating
// operation makes to the dump or the DB. Records are buffered and flushed as JSONL
// (one JSON object per line) so the file is a greppable, streamable history across
// runs. A null path makes it a no-op (the operation just doesn't log).
//
// The JSONL line schema is documented for users in README.md.

export type ChangeOp =
  | "added" // a new article file written
  | "edited" // an existing article rewritten (metadata changed)
  | "deleted" // an article removed/archived on our side (reconcile)
  | "body-added" // enrich filled a previously-empty body
  | "body-changed" // enrich replaced an existing body
  | "body-error"; // enrich recorded a bodyError instead of a body

export interface ChangeRecord {
  op: ChangeOp;
  documentType: string;
  id: string;
  title?: string;
  /** which fields changed (for op="edited"), e.g. ["metadata","updated_published"]. */
  changed?: string[];
  hashOld?: string;
  hashNew?: string;
  /** the operation that produced this record: "dump" | "enrich" | "reconcile" | "sync". */
  source?: string;
  /** free-text extra (e.g. bodyError message, archive path). */
  detail?: string;
}

// Default changelog filename, placed alongside the dump (next to _index.json).
export const CHANGELOG_BASENAME = "_changelog.jsonl";

// Resolve a `--changelog[=FILE]` flag to a path, or null when the flag is absent.
//   (absent)            -> null  (logging disabled)
//   --changelog         -> <dumpDir>/_changelog.jsonl
//   --changelog=FILE    -> FILE
export function changelogPathFromFlag(
  flagValue: string | boolean | undefined,
  dumpDir: string,
): string | null {
  if (flagValue === undefined) return null;
  if (flagValue === true || flagValue === "") {
    return `${dumpDir.replace(/\/+$/, "")}/${CHANGELOG_BASENAME}`;
  }
  return String(flagValue);
}

export class Changelog {
  private buf: string[] = [];
  private counts: Record<string, number> = {};

  /** path=null disables logging; runId labels every record from this run. */
  constructor(private readonly path: string | null, private readonly runId: string) {}

  get enabled(): boolean {
    return this.path !== null;
  }

  record(rec: ChangeRecord): void {
    this.counts[rec.op] = (this.counts[rec.op] ?? 0) + 1;
    if (!this.path) return; // count even when not persisting, for summaries
    this.buf.push(
      JSON.stringify({ runId: this.runId, ts: new Date().toISOString(), ...rec }),
    );
  }

  /** Per-op tally (works even when disabled, so callers can still summarize). */
  byOp(): Record<string, number> {
    return { ...this.counts };
  }

  get total(): number {
    return Object.values(this.counts).reduce((a, b) => a + b, 0);
  }

  /** Append buffered records to the JSONL file (creating it if needed). No-op if
   *  disabled or nothing buffered. */
  async flush(): Promise<void> {
    if (!this.path || this.buf.length === 0) return;
    const text = this.buf.join("\n") + "\n";
    await Deno.writeTextFile(this.path, text, { append: true });
    this.buf = [];
  }
}
