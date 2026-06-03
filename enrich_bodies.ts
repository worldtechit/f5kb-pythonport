/**
 * Enriches an existing article dump with article BODIES for the document types
 * whose body is not present in the Coveo search index (so dump_articles.ts left
 * their `content` object empty).
 *
 * The real body lives on each article's public rendered page. This post-processor
 * walks a dump directory, fetches those pages, extracts ONLY the article body
 * (no site header/footer/nav, and nothing that merely repeats the metadata the
 * dump already has), and writes it back into each article JSON's `content`.
 *
 * Status: Bug Tracker is implemented (deterministic static page on cdn.f5.com).
 * The remaining empty-body types (Manual, Release Note, Supplemental Document,
 * F5 GitHub) are stubbed in TYPE_ENRICHERS and not yet wired up — see TODO.txt.
 *
 * Usage:
 *   deno run --allow-net --allow-read --allow-write enrich_bodies.ts \
 *       --dump=outputs/dump [--types="Bug_Tracker"] [--concurrency=4] \
 *       [--limit=N] [--refetch]
 *
 * Options:
 *   --dump=DIR       Dump directory produced by dump_articles.ts
 *                    (default: outputs/dump).
 *   --types="A,B"    Subset of type keys to enrich (default: all implemented).
 *   --concurrency=N  Parallel fetches (default: 4). Be polite.
 *   --delay-ms=N     Min delay between requests per worker (default: 200).
 *   --limit=N        Cap articles processed per type (default: no cap).
 *   --refetch        Re-fetch even if the article already has a body / error.
 *
 * Resumability: by default an article is skipped if its content already has a
 * non-empty `body_text` or a recorded `bodyError`, so a re-run only fills gaps.
 */

import { DOMParser, type Element, type Node } from "jsr:@b-fuze/deno-dom";

const USER_AGENT =
  "f5-articles-indexer/1.0 (personal KB archival; contact ryanparas@yahoo.com)";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
interface Args {
  dump: string;
  types: string[] | null;
  concurrency: number;
  delayMs: number;
  limit: number | null;
  refetch: boolean;
}

function parseArgs(): Args {
  const a: Args = {
    dump: "outputs/dump",
    types: null,
    concurrency: 4,
    delayMs: 200,
    limit: null,
    refetch: false,
  };
  for (const arg of Deno.args) {
    const [k, v] = arg.startsWith("--") ? arg.slice(2).split("=") : ["", ""];
    switch (k) {
      case "dump":
        a.dump = v;
        break;
      case "types":
        a.types = v.split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "concurrency":
        a.concurrency = Math.max(1, parseInt(v, 10) || 4);
        break;
      case "delay-ms":
        a.delayMs = Math.max(0, parseInt(v, 10) || 0);
        break;
      case "limit":
        a.limit = parseInt(v, 10) || null;
        break;
      case "refetch":
        a.refetch = true;
        break;
      default:
        if (arg.startsWith("--")) {
          console.error(`Unknown flag: ${arg}`);
          Deno.exit(2);
        }
    }
  }
  return a;
}

// ---------------------------------------------------------------------------
// Article JSON shape (only the fields we touch)
// ---------------------------------------------------------------------------
interface Article {
  id: string;
  documentType: string;
  title?: string;
  link?: string;
  metadata?: Record<string, unknown>;
  content?: Record<string, unknown>;
  [k: string]: unknown;
}

interface EnrichResult {
  /** Section title -> body markdown, in document order. */
  sections?: Record<string, string>;
  /** Full readable body (sections joined). */
  body_text?: string;
  /** Where the body came from. */
  bodySource: string;
  /** ISO time of the fetch attempt. */
  fetchedAt: string;
  /** Set instead of body when the page could not be fetched/parsed. */
  bodyError?: string;
}

// An enricher turns one article into a body (or throws → recorded as bodyError).
type Enricher = (article: Article, nowIso: string) => Promise<EnrichResult>;

// ---------------------------------------------------------------------------
// HTTP with retry/backoff (mirrors dump_articles.ts coveoPost behavior)
// ---------------------------------------------------------------------------
async function fetchText(url: string, attempt = 0): Promise<string> {
  const MAX_RETRIES = 5;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    });
    if (!res.ok) {
      // 404/403/410 are terminal (page gone / restricted) — don't retry.
      if ((res.status >= 500 || res.status === 429) && attempt < MAX_RETRIES) {
        await sleep(750 * 2 ** attempt);
        return fetchText(url, attempt + 1);
      }
      // Drain body to free the connection before throwing.
      await res.body?.cancel();
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.text();
  } catch (e) {
    const msg = (e as Error).message ?? "";
    // Retry network-level failures, not HTTP errors we already classified.
    if (attempt < MAX_RETRIES && !/^HTTP \d/.test(msg)) {
      await sleep(750 * 2 ** attempt);
      return fetchText(url, attempt + 1);
    }
    throw e;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// HTML -> markdown for inline/block body content
// ---------------------------------------------------------------------------
// deno-dom node type constants
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function isElement(n: Node): n is Element {
  return n.nodeType === ELEMENT_NODE;
}

function isHidden(el: Element): boolean {
  const style = (el.getAttribute("style") ?? "").replace(/\s+/g, "");
  return /display:none/i.test(style);
}

// Serialize a node's subtree to compact markdown, preserving links and emphasis
// but dropping tags/attributes that are pure presentation.
function nodeToMarkdown(node: Node): string {
  if (node.nodeType === TEXT_NODE) {
    return (node.textContent ?? "").replace(/\s+/g, " ");
  }
  if (!isElement(node)) return "";
  const el = node;
  if (isHidden(el)) return "";
  const tag = el.tagName.toLowerCase();
  const inner = () =>
    Array.from(el.childNodes).map(nodeToMarkdown).join("");
  switch (tag) {
    case "script":
    case "style":
      return "";
    case "br":
      return "\n";
    case "a": {
      const href = el.getAttribute("href") ?? "";
      const text = inner().trim();
      if (!text) return "";
      return href ? `[${text}](${href})` : text;
    }
    case "b":
    case "strong":
      return `**${inner().trim()}**`;
    case "i":
    case "em":
      return `*${inner().trim()}*`;
    case "code":
      return `\`${inner().trim()}\``;
    case "li":
      return `- ${inner().trim()}\n`;
    case "ul":
    case "ol":
      return `${inner()}\n`;
    case "p":
    case "div":
      return `${inner().trim()}\n\n`;
    default:
      return inner();
  }
}

// ---------------------------------------------------------------------------
// Bug Tracker enricher
// ---------------------------------------------------------------------------
// The body is the labelled sections inside <div class="bug-content">
// (Symptoms / Conditions / Impact / Workaround / Fix Information / Behavior
// Change / Guides & references). Everything above it (Affected Product(s),
// Known Affected Versions, Opened, Severity, Last Modified) duplicates the
// metadata we already have, and the site header/footer are outside it — so we
// extract ONLY this container.
function bugTrackerUrl(a: Article): string {
  const bugId = a.metadata?.["f5_bug_id"];
  if (typeof bugId === "string" && bugId) {
    return `https://cdn.f5.com/product/bugtracker/ID${bugId}.html`;
  }
  if (a.link) return a.link;
  throw new Error("no f5_bug_id and no link to derive bug URL");
}

function parseBugContent(html: string): Record<string, string> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const container = doc?.querySelector("div.bug-content");
  if (!container) throw new Error("bug-content container not found");

  const sections: Record<string, string> = {};
  let current: string | null = null;
  let buf = "";
  const flush = () => {
    if (current) {
      const text = buf.replace(/\n{3,}/g, "\n\n").trim();
      if (text) sections[current] = text;
    }
    buf = "";
  };

  for (const node of Array.from(container.childNodes)) {
    if (isElement(node) && isHidden(node)) continue; // hidden Behavior Change etc.
    if (isElement(node) && node.tagName.toLowerCase() === "h4") {
      flush();
      current = (node.textContent ?? "").trim();
      continue;
    }
    buf += nodeToMarkdown(node);
  }
  flush();
  return sections;
}

const enrichBugTracker: Enricher = (article, nowIso) => {
  const url = bugTrackerUrl(article);
  return fetchText(url).then((html) => {
    const sections = parseBugContent(html);
    if (Object.keys(sections).length === 0) {
      throw new Error("no body sections extracted");
    }
    const body_text = Object.entries(sections)
      .map(([title, text]) => `## ${title}\n\n${text}`)
      .join("\n\n");
    return { sections, body_text, bodySource: url, fetchedAt: nowIso };
  });
};

// ---------------------------------------------------------------------------
// Registry: type key (dump subdir name) -> enricher
// ---------------------------------------------------------------------------
const TYPE_ENRICHERS: Record<string, Enricher> = {
  Bug_Tracker: enrichBugTracker,
  // TODO (see TODO.txt): Manual, Release_Note, Supplemental_Document (HTML
  // scrape via host->selector map) and F5_GitHub (GitHub REST API).
};

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------
function hasBody(content: Record<string, unknown> | undefined): boolean {
  if (!content) return false;
  const bt = content["body_text"];
  return (typeof bt === "string" && bt.trim().length > 0) ||
    typeof content["bodyError"] === "string";
}

async function listArticleFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".json")) continue;
    if (entry.name.startsWith("_")) continue; // _catalogue.json, _index.json
    files.push(`${dir}/${entry.name}`);
  }
  files.sort();
  return files;
}

// Run async tasks with a fixed concurrency, returning when all are done.
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i]);
    }
  });
  await Promise.all(runners);
}

async function enrichType(typeKey: string, args: Args) {
  const enricher = TYPE_ENRICHERS[typeKey];
  const dir = `${args.dump}/${typeKey}`;
  let files: string[];
  try {
    files = await listArticleFiles(dir);
  } catch {
    console.log(`  [${typeKey}] no directory ${dir} — skipping`);
    return;
  }
  if (args.limit) files = files.slice(0, args.limit);

  let done = 0, skipped = 0, ok = 0, failed = 0;
  const nowIso = new Date().toISOString();

  await runPool(files, args.concurrency, async (file) => {
    const article: Article = JSON.parse(await Deno.readFile(file).then((b) =>
      new TextDecoder().decode(b)
    ));
    if (!args.refetch && hasBody(article.content)) {
      skipped++;
      return;
    }
    let result: EnrichResult;
    try {
      result = await enricher(article, nowIso);
      ok++;
    } catch (e) {
      result = {
        bodySource: (() => {
          try { return bugTrackerUrl(article); } catch { return article.link ?? ""; }
        })(),
        fetchedAt: nowIso,
        bodyError: (e as Error).message,
      };
      failed++;
    }
    article.content = { ...(article.content ?? {}), ...result };
    await Deno.writeTextFile(file, JSON.stringify(article, null, 2) + "\n");
    done++;
    if ((done + skipped) % 25 === 0) {
      console.log(
        `  [${typeKey}] ${done + skipped}/${files.length} (ok=${ok} fail=${failed} skip=${skipped})`,
      );
    }
    if (args.delayMs) await sleep(args.delayMs);
  });

  console.log(
    `  [${typeKey}] DONE: ${files.length} files — enriched=${ok} failed=${failed} skipped=${skipped}`,
  );
}

async function main() {
  const args = parseArgs();
  const requested = args.types ?? Object.keys(TYPE_ENRICHERS);
  const toRun = requested.filter((t) => {
    if (!TYPE_ENRICHERS[t]) {
      console.error(`  [${t}] no enricher implemented — skipping`);
      return false;
    }
    return true;
  });
  if (toRun.length === 0) {
    console.error("Nothing to do. Implemented types: " + Object.keys(TYPE_ENRICHERS).join(", "));
    Deno.exit(1);
  }
  console.log(`Enriching bodies in ${args.dump} for: ${toRun.join(", ")}`);
  console.log(`(concurrency=${args.concurrency}, delay=${args.delayMs}ms, refetch=${args.refetch})`);
  for (const t of toRun) await enrichType(t, args);
  console.log("All done.");
}

if (import.meta.main) await main();
