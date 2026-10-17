#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { durationMs } from "./duration.ts";
import type { DiffResult, VersionChoice } from "./diff.ts";
import type { CrawlPage, CrawlSummary } from "./frontier.ts";
import type { OpenOptions, OpenedCrawler, PoliteCrawler } from "./open.ts";
import type { PageResult } from "./runtime.ts";
import { VERSION } from "./version.ts";
import type { WatchEntry, WatchEvent, WatchSummary } from "./watch.ts";

// This file imports only Node.js, the version and the duration parser at start. A command loads
// the crawler, and only `mcp` loads the MCP server, so `--version` and `--help` answer at once.

// node:sqlite of Node.js 22 writes "SQLite is an experimental feature" to the standard error at
// each start. The command removes only that warning, before the store loads node:sqlite.
const emitWarning = process.emitWarning.bind(process) as (
  warning: string | Error,
  ...rest: unknown[]
) => void;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
  const first: unknown = rest[0];
  const kind =
    typeof first === "string"
      ? first
      : typeof first === "object" && first !== null && "type" in first
        ? first.type
        : warning instanceof Error
          ? warning.name
          : undefined;
  const text = typeof warning === "string" ? warning : warning.message;
  if (kind === "ExperimentalWarning" && text.startsWith("SQLite is an experimental feature"))
    return;
  emitWarning(warning, ...rest);
}) as typeof process.emitWarning;

const HELP = `polite-crawler ${VERSION}: fetch a source once, keep it, read it many times.

Usage:
  polite-crawler fetch <url...>        fetch pages into the store (robots.txt obeyed)
  polite-crawler find <query>          search the stored pages, with no request
  polite-crawler read <doc>            print a range of a stored document
  polite-crawler verify <doc> <quote>  check that a quote is in a stored document
  polite-crawler reindex               rebuild the search index from the capture log
  polite-crawler mcp                   serve the tools over MCP (standard input and output)
  polite-crawler export --out <file>   write the stored captures as a WARC or WACZ archive
  polite-crawler discover <site>       list the pages of a site from its sitemaps and feeds
  polite-crawler crawl <url...>        fetch a site and follow its links, within a budget
  polite-crawler diff <doc>            show what changed between two versions of a document
  polite-crawler watch add <url...>    check these pages again on a schedule
  polite-crawler watch remove <url...> stop the watch of these pages
  polite-crawler watch list            print the watch list
  polite-crawler watch run             check the pages that are due, within a budget
  polite-crawler key-directory         print the key directory (JWKS) of --sign-key, to host
  polite-crawler extract <doc> --field name=value[:kind]...
                                       check proposed field values against a stored page

Options:
  --dir <path>       the store (default $POLITE_CRAWLER_DIR, or ~/.polite-crawler)
  --contact <text>   an email (From and User-Agent) or a URL (User-Agent only)
                     ($POLITE_CRAWLER_CONTACT)
  --allow-private    fetch loopback and private addresses too ($POLITE_CRAWLER_ALLOW_PRIVATE=1)
  --no-browser       never open the headless browser
  --sign-key <file>  sign each request (Web Bot Auth) with this Ed25519 key: PKCS#8 PEM or JWK
                     ($POLITE_CRAWLER_SIGN_KEY)
  --signature-agent <url>  the https origin of your key directory, or the URL of a
                     JSON Web Key Set on a path, for --sign-key ($POLITE_CRAWLER_SIGNATURE_AGENT)
  --json             print JSON
  -v, --version      print the version
  -h, --help         print this help

  fetch    --render <mode>   auto (default), never or always
           --max-age <age>   reuse a stored copy this young: 30m, 24h (default), 7d; 0 fetches again
           --archive-fallback  when the site refuses or is down, give a copy from the Wayback
                             Machine or Common Crawl, marked archived (not a fresh fetch)
           --archive-despite-robots  with --archive-fallback: also when the robots.txt of the
                             site disallows the page now
  find     --limit <n>       how many results (default 10)
           --kind <kind>     only this kind of document, such as page or pdf
           --rank <mode>     exact (default): BM25 over each match; fast: leave common words
                             out of the one-word part, faster for a long question
  read     --from <n>        where the range starts (default 0)
           --length <n>      how many characters (default 4000)
           --user-provided   you gave this URL yourself: read a page that refuses AI input (logged)
  read, verify, extract  --at <time>  use the version that was current then, such as
                             2026-10-01T12:00Z
  reindex                    rebuild; the documents of recipes that this command cannot read stay
  mcp      --allow-user-provided   let user_provided work when the client cannot ask you
                                   ($POLITE_CRAWLER_ALLOW_USER_PROVIDED=1)
  export   --out <file>      the archive to write: a name that ends in .warc.gz or .wacz
           --format <f>      warc or wacz (default: from the name of the file)
           --since <time>    only the captures from this time on, such as 2026-10-01
           --until <time>    only the captures before this time
           --host <host>     only the captures of this host and its subdomains
           --prefix <url>    only the captures whose URL starts with this text
           --id <capture>    only this capture; give --id again for more captures
           --include-refusals  a metadata record for each capture with no body too
           --overwrite       replace the file when it exists
  discover --max-urls <n>    how many URLs (default 1000)
           --feed <url>      read this RSS or Atom feed too (repeat it)
           --max-age <age>   as for fetch
  crawl    --max-pages <n>   how many pages (default 100)
           --max-depth <n>   how many links from a seed (default 3; 0 fetches the seeds only)
           --budget <time>   the longest time: 30s, 2m, 10m (default); no request starts after it
           --include <pattern>  follow only the URLs that match, for example /blog/* (repeat it)
           --exclude <pattern>  follow no URL that matches, for example *.pdf$ (repeat it)
           --sitemaps        add the pages of the sitemaps of the site
           --render, --max-age   as for fetch
  discover, crawl  --allow-host <host>   keep the URLs on this host too (repeat it)
  diff     --from <version>  the old version: a capture id or a time (default: the one before --to)
           --to <version>    the new version: a capture id or a time (default: the newest)
  watch add  --every <time>  the time between two checks: 1h or more (default 24h)
             --confirm <n>   2 (default): a change counts when two checks see it; 1: at once
             --scope <text>, --label <name=value>   marks for the captures (repeat --label)
             --render <mode> as for fetch
  watch run  --budget <time>  the longest time (default 10m); no request starts after it
             --max-pages <n>  how many pages to check (default 100)
  extract  --field <name=value[:kind]>  a value to check, never made up by the crawler (repeat it);
                             kind: text (default), number, money, date, url, email, phone,
                             or json-ld:<path> such as json-ld:Product.offers.price
           --capture <id>    check the text of this capture, not the current text
           --user-provided   as for read

Exit codes:
  0  done
  1  not done: a page not fetched, no match, a quote not found, a document unknown or
     held back, a watch check that failed or that is still due, a field value that extract
     did not find or that is not clear, or an error
     (fetch: a page with an archived copy counts as done)
  2  the command line is wrong
`;

/** A usage error is a wrong command line. It exits with code 2. */
class UsageError extends Error {}

// ---- The command `export`: the options, the checks and the work of the WARC and WACZ export ----

/** These options belong to the command `export`. */
const EXPORT_OPTIONS = {
  format: { type: "string" },
  out: { type: "string" },
  since: { type: "string" },
  until: { type: "string" },
  host: { type: "string" },
  prefix: { type: "string" },
  id: { type: "string", multiple: true },
  "include-refusals": { type: "boolean" },
  overwrite: { type: "boolean" },
} as const;

/** These are the values of the command line that the command `export` reads. */
interface ExportValues {
  readonly format?: string | undefined;
  readonly out?: string | undefined;
  readonly since?: string | undefined;
  readonly until?: string | undefined;
  readonly host?: string | undefined;
  readonly prefix?: string | undefined;
  readonly id?: readonly string[] | undefined;
  readonly "include-refusals"?: boolean | undefined;
  readonly overwrite?: boolean | undefined;
  readonly json?: boolean | undefined;
}

/**
 * This function does the command `export`, and gives the exit code. It checks the whole command
 * line first. Then it only reads the store: it makes no store, and it sends no request.
 */
const exportCommand = async (values: ExportValues, dir: string): Promise<number> => {
  const out = values.out;
  if (out === undefined || out.trim() === "") throw new UsageError("export wants --out <file>");
  const format =
    values.format ??
    (/\.wacz$/i.test(out) ? "wacz" : /\.warc\.gz$/i.test(out) ? "warc" : undefined);
  if (format !== "warc" && format !== "wacz") {
    throw new UsageError(
      values.format === undefined
        ? "export wants --format warc or wacz, or a file that ends in .warc.gz or .wacz"
        : `--format is warc or wacz, not "${values.format}"`,
    );
  }
  for (const name of ["since", "until"] as const) {
    const value = values[name];
    if (value !== undefined && !Number.isFinite(Date.parse(value)))
      throw new UsageError(`--${name} wants a time, such as 2026-10-01, not "${value}"`);
  }
  if (values.host !== undefined && (values.host.trim() === "" || /[/:@\s]/.test(values.host)))
    throw new UsageError(`--host wants a host name, such as example.com, not "${values.host}"`);
  const file =
    out === "~" ? homedir() : /^~[\\/]/.test(out) ? resolve(homedir(), out.slice(2)) : resolve(out);
  const options = {
    out: file,
    since: values.since,
    until: values.until,
    host: values.host,
    urlPrefix: values.prefix,
    ids: values.id,
    includeRefusals: values["include-refusals"] === true,
    overwrite: values.overwrite === true,
  };
  const result =
    format === "wacz"
      ? await (await import("./wacz.ts")).exportWacz(dir, options)
      : await (await import("./warc.ts")).exportWarc(dir, options);
  const left = [
    result.bodiless > 0 && !options.includeRefusals
      ? `${String(result.bodiless)} captures with no body (add --include-refusals to keep them as metadata)`
      : null,
    result.missing > 0 ? `${String(result.missing)} captures with no stored body` : null,
    result.damaged > 0 ? `${String(result.damaged)} damaged lines of the log` : null,
  ].filter((line) => line !== null);
  process.stdout.write(
    `${
      values.json === true
        ? JSON.stringify(result, null, 2)
        : [
            `wrote ${result.out} (${String(result.bytes)} bytes)`,
            `  ${String(result.captures)} captures: ${String(result.responses)} responses, ${String(result.revisits)} revisits, ${String(result.conversions)} rendered pages, ${String(result.metadata)} metadata records${result.format === "wacz" ? `, ${String(result.pages)} pages` : ""}`,
            ...(left.length > 0 ? [`  left out: ${left.join(", ")}`] : []),
          ].join("\n")
    }\n`,
  );
  return 0;
};

// ---- The end of the command `export` ----

const OPTIONS = {
  dir: { type: "string" },
  contact: { type: "string" },
  "allow-private": { type: "boolean" },
  "no-browser": { type: "boolean" },
  json: { type: "boolean" },
  version: { type: "boolean", short: "v" },
  help: { type: "boolean", short: "h" },
  render: { type: "string" },
  "max-age": { type: "string" },
  limit: { type: "string" },
  kind: { type: "string" },
  rank: { type: "string" },
  from: { type: "string" },
  length: { type: "string" },
  "user-provided": { type: "boolean" },
  "allow-user-provided": { type: "boolean" },
  ...EXPORT_OPTIONS,
  // ── discover and crawl ──
  "max-urls": { type: "string" },
  feed: { type: "string", multiple: true },
  "max-pages": { type: "string" },
  "max-depth": { type: "string" },
  budget: { type: "string" },
  include: { type: "string", multiple: true },
  exclude: { type: "string", multiple: true },
  sitemaps: { type: "boolean" },
  "allow-host": { type: "string", multiple: true },
  // ── end of discover and crawl ──
  // ── time travel, diff and watch ──
  at: { type: "string" },
  to: { type: "string" },
  every: { type: "string" },
  confirm: { type: "string" },
  scope: { type: "string" },
  label: { type: "string", multiple: true },
  // ── end of time travel, diff and watch ──
  // ── archived fallback and signed requests ──
  "archive-fallback": { type: "boolean" },
  "archive-despite-robots": { type: "boolean" },
  "sign-key": { type: "string" },
  "signature-agent": { type: "string" },
  // ── end of archived fallback and signed requests ──
  // ── extract ──
  field: { type: "string", multiple: true },
  capture: { type: "string" },
  // ── end of extract ──
} as const;

/** These options belong to one command, or to the commands that the text names. */
const OWNER: Readonly<Record<string, string>> = {
  render: "fetch crawl watch",
  "max-age": "fetch crawl discover",
  limit: "find",
  kind: "find",
  rank: "find",
  from: "read diff",
  length: "read",
  "user-provided": "read extract",
  "allow-user-provided": "mcp",
  ...Object.fromEntries(Object.keys(EXPORT_OPTIONS).map((option) => [option, "export"])),
  // ── discover and crawl ──
  "max-urls": "discover",
  feed: "discover",
  "max-pages": "crawl watch",
  "max-depth": "crawl",
  budget: "crawl watch",
  include: "crawl",
  exclude: "crawl",
  sitemaps: "crawl",
  "allow-host": "crawl discover",
  // ── end of discover and crawl ──
  // ── time travel, diff and watch ──
  at: "read verify extract",
  to: "diff",
  every: "watch",
  confirm: "watch",
  scope: "watch",
  label: "watch",
  // ── end of time travel, diff and watch ──
  // ── archived fallback and signed requests ──
  "archive-fallback": "fetch",
  "archive-despite-robots": "fetch",
  "sign-key": "fetch discover crawl watch mcp key-directory",
  "signature-agent": "fetch discover crawl watch mcp key-directory",
  // ── end of archived fallback and signed requests ──
  // ── extract ──
  field: "extract",
  capture: "extract",
  // ── end of extract ──
};

/** These are the commands, with the smallest and the largest count of arguments. */
const COMMANDS: Readonly<
  Record<string, { readonly min: number; readonly max: number; readonly wants: string }>
> = {
  fetch: { min: 1, max: Infinity, wants: "fetch wants at least one URL" },
  find: { min: 1, max: Infinity, wants: "find wants a query" },
  read: { min: 1, max: 1, wants: "read wants one document id" },
  verify: { min: 2, max: Infinity, wants: "verify wants a document id and a quote" },
  reindex: { min: 0, max: 0, wants: "reindex takes no argument" },
  mcp: { min: 0, max: 0, wants: "mcp takes no argument" },
  export: { min: 0, max: 0, wants: "export takes no argument: give the file with --out" },
  // ── discover and crawl ──
  discover: { min: 1, max: 1, wants: "discover wants one site URL" },
  crawl: { min: 1, max: Infinity, wants: "crawl wants at least one URL" },
  // ── end of discover and crawl ──
  // ── diff and watch ──
  diff: { min: 1, max: 1, wants: "diff wants one document id" },
  watch: { min: 1, max: Infinity, wants: "watch wants add, remove, list or run" },
  // ── end of diff and watch ──
  // ── signed requests ──
  "key-directory": {
    min: 0,
    max: 0,
    wants: "key-directory takes no argument: give the key with --sign-key",
  },
  // ── end of signed requests ──
  // ── extract ──
  extract: { min: 1, max: 1, wants: "extract wants one document id and --field name=value" },
  // ── end of extract ──
};

const parse = (args: readonly string[]) => {
  try {
    return parseArgs({ args: [...args], allowPositionals: true, strict: true, options: OPTIONS });
  } catch (error) {
    // parseArgs gives a TypeError with an ERR_PARSE_ARGS code for a wrong command line
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) {
      throw new UsageError((error as Error).message, { cause: error });
    }
    throw error;
  }
};

const whole = (name: string, text: string | undefined, fallback: number, min: number): number => {
  if (text === undefined) return fallback;
  if (!/^\s*\d+\s*$/.test(text))
    throw new UsageError(`--${name} wants a whole number, not "${text}"`);
  const value = Number(text);
  if (value < min) throw new UsageError(`--${name} wants ${String(min)} or more`);
  return value;
};

/** An environment variable that switches a feature on is 1 or 0 (also true or false, yes or no). */
const envFlag = (name: string): boolean => {
  const raw = process.env[name];
  const value = raw?.trim().toLowerCase() ?? "";
  if (["", "0", "false", "no", "off"].includes(value)) return false;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  throw new UsageError(`${name} is 1 or 0, not "${raw ?? ""}"`);
};

/** The store: a leading `~` is the home folder, and a relative path starts at the working folder. */
const storeDir = (text: string | undefined): string => {
  if (text === undefined) return join(homedir(), ".polite-crawler");
  if (text.trim() === "") throw new UsageError("--dir wants a folder");
  if (text === "~") return homedir();
  if (/^~[\\/]/.test(text)) return resolve(homedir(), text.slice(2));
  return resolve(text);
};

const FS_CODES = new Set(["EEXIST", "ENOENT", "ENOTDIR", "EACCES", "EPERM", "EROFS", "EISDIR"]);

const ok = (page: PageResult): boolean => page.outcome === "ok" || page.outcome === "not-modified";

/** A fetch is done when the page came, or when an archived copy came in its place. */
const done = (page: PageResult): boolean => ok(page) || page.archived !== undefined;

const describePage = (page: PageResult): string => {
  const head = `${ok(page) ? "✓" : page.archived !== undefined ? "~" : "✗"} ${page.url}`;
  const facts = [
    `${page.outcome} ${String(page.status)}`,
    page.doc === null ? null : `doc ${page.doc}`,
    page.chars > 0 ? `${String(page.chars)} chars` : null,
    page.rendered ? "rendered" : null,
    page.structured.length > 0 ? `JSON-LD: ${page.structured.join(", ")}` : null,
  ].filter((fact) => fact !== null);
  // ── archived fallback: an archived copy says so on a line of its own ──
  const archived =
    page.archived === undefined
      ? []
      : [
          `  archived copy (${page.archived.source}, captured ${page.archived.timestamp}): ${page.archived.url}`,
        ];
  return [
    head,
    `  ${facts.join(" · ")}`,
    ...archived,
    ...(page.note === null ? [] : [`  ${page.note}`]),
  ].join("\n");
};

// ── signed requests ──────────────────────────────────────────────────────────

/** This function reads the key file of `--sign-key`. An error names the file, and not the key. */
const keyFile = (path: string): string => {
  const file =
    path === "~"
      ? homedir()
      : /^~[\\/]/.test(path)
        ? resolve(homedir(), path.slice(2))
        : resolve(path);
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new UsageError(
      `--sign-key: the file ${file} does not open (${typeof code === "string" ? code : "error"})`,
      { cause: error },
    );
  }
};

/**
 * This function gives the type of the URL of `--signature-agent`. An origin names a key directory at
 * the well-known path. A URL with a path names a JSON Web Key Set (`jwks_uri`), for a host that cannot
 * serve the well-known path, for example a project site of GitHub Pages.
 */
const agentTypeOf = (url: string): "directory" | "jwks_uri" => {
  try {
    const parsed = new URL(url);
    return parsed.pathname === "/" && parsed.search === "" ? "directory" : "jwks_uri";
  } catch {
    // the signer gives the error of a URL that does not parse
    return "directory";
  }
};

/** This function prints the key directory of a key file, and tells where to host it. */
const keyDirectoryCommand = async (key: string, agent: string | undefined): Promise<number> => {
  const { KEY_DIRECTORY_PATH, KEY_DIRECTORY_TYPE, keyDirectory } = await import("./webbotauth.ts");
  let directory;
  try {
    directory = keyDirectory([key]);
  } catch (error) {
    throw new UsageError(`--sign-key: ${(error as Error).message}`, { cause: error });
  }
  process.stdout.write(`${JSON.stringify(directory, null, 2)}\n`);
  const where =
    agent !== undefined && agentTypeOf(agent) === "jwks_uri"
      ? `${agent} (a JSON Web Key Set, the type jwks_uri)`
      : `${agent === undefined ? "https://<your origin>" : agent.replace(/\/$/, "")}${KEY_DIRECTORY_PATH} with Content-Type: ${KEY_DIRECTORY_TYPE}`;
  process.stderr.write(`polite-crawler: serve this JSON at ${where}\n`);
  return 0;
};

// ── end of signed requests ───────────────────────────────────────────────────

/** This is the result of a URL that the crawler did not fetch. */
const failedPage = (url: string, note: string): PageResult => ({
  url,
  doc: null,
  outcome: "error",
  status: 0,
  title: null,
  chars: 0,
  rendered: false,
  structured: [],
  links: 0,
  captures: [],
  capture: null,
  capture_count: 0,
  fetched_at: null,
  from_cache: false,
  held_back: false,
  note,
});

// ── discover and crawl ──────────────────────────────────────────────────────

/** The options of `discover` and `crawl`, read from the command line before the store opens. */
interface CrawlLimits {
  readonly maxUrls: number;
  readonly feeds: readonly string[];
  readonly maxPages: number;
  readonly maxDepth: number;
  readonly budgetMs: number;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly sitemaps: boolean;
  readonly allowHosts: readonly string[] | undefined;
}

const crawlOptionsOf = (values: ReturnType<typeof parse>["values"]): CrawlLimits => {
  let budgetMs = 600_000;
  if (values.budget !== undefined) {
    try {
      budgetMs = durationMs(values.budget);
    } catch (error) {
      throw new UsageError(`--budget: ${(error as Error).message}`, { cause: error });
    }
  }
  return {
    maxUrls: whole("max-urls", values["max-urls"], 1000, 1),
    feeds: values.feed ?? [],
    maxPages: whole("max-pages", values["max-pages"], 100, 1),
    maxDepth: whole("max-depth", values["max-depth"], 3, 0),
    budgetMs,
    include: values.include ?? [],
    exclude: values.exclude ?? [],
    sitemaps: values.sitemaps === true,
    allowHosts: values["allow-host"],
  };
};

/** This function lists the pages of a site. The exit code is 0 when it found a URL. */
const runDiscover = async (
  crawler: OpenedCrawler,
  site: string,
  limits: CrawlLimits,
  maxAge: number,
  json: boolean,
  out: (text: string) => void,
): Promise<number> => {
  const found = await crawler.discover(site, {
    maxUrls: limits.maxUrls,
    feeds: limits.feeds,
    maxAge,
    ...(limits.allowHosts === undefined ? {} : { allowHosts: limits.allowHosts }),
  });
  if (json) out(JSON.stringify(found, null, 2));
  else {
    for (const url of found.urls)
      out(url.lastmod === null ? url.url : `${url.url}  ${url.lastmod.slice(0, 10)}`);
    const read = found.sources.filter((source) => source.kind !== null).length;
    out(
      `${String(found.urls.length)} URLs from ${String(read)} of ${String(found.sources.length)} files (${found.stopped}${found.note === null ? "" : `: ${found.note}`})`,
    );
  }
  return found.urls.length > 0 ? 0 : 1;
};

const describeSummary = (summary: CrawlSummary): string =>
  `${String(summary.pages)} pages: ${String(summary.fetched)} fetched (${String(summary.from_cache)} from the store), ${String(summary.refused)} refused, ${String(summary.failed)} failed. ${String(summary.skipped)} links not followed, ${String(summary.queued)} URLs waiting. Stopped (${summary.stopped}): ${summary.reason}.`;

/** This function crawls from the seeds. It prints each page when it ends. The exit code is 0 when the crawl got a page. */
const runCrawl = async (
  crawler: OpenedCrawler,
  seeds: readonly string[],
  limits: CrawlLimits,
  page: { readonly render: "auto" | "never" | "always"; readonly maxAge: number },
  json: boolean,
  out: (text: string) => void,
): Promise<number> => {
  // the first Ctrl+C stops the crawl cleanly: the fetches in progress end, and the summary prints
  const controller = new AbortController();
  const stop = (): void => controller.abort(new Error("interrupted"));
  process.once("SIGINT", stop);
  try {
    const run = crawler.crawl([...new Set(seeds)], {
      maxPages: limits.maxPages,
      maxDepth: limits.maxDepth,
      budgetMs: limits.budgetMs,
      include: limits.include,
      exclude: limits.exclude,
      useSitemaps: limits.sitemaps,
      render: page.render,
      maxAge: page.maxAge,
      signal: controller.signal,
      ...(limits.allowHosts === undefined ? {} : { allowHosts: limits.allowHosts }),
    });
    const pages: CrawlPage[] = [];
    for await (const result of run) {
      pages.push(result);
      if (!json) out(`${describePage(result)}\n  depth ${String(result.depth)}, ${result.source}`);
    }
    const summary = await run.summary;
    out(json ? JSON.stringify({ pages, summary }, null, 2) : describeSummary(summary));
    return summary.fetched > 0 ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", stop);
  }
};

// ── end of discover and crawl ───────────────────────────────────────────────

// ── time travel, diff and watch ─────────────────────────────────────────────

/** A text that starts with a date is a time. A different text is a capture id. */
const DATE_START = /^\d{4}-\d{2}-\d{2}/;

/** This function reads a time of the command line. A text that is not a time is a usage error. */
const timeOf = (name: string, text: string | undefined): string | undefined => {
  if (text === undefined) return undefined;
  if (!DATE_START.test(text) || !Number.isFinite(Date.parse(text)))
    throw new UsageError(`--${name} wants a time, such as 2026-10-01T12:00:00Z, not "${text}"`);
  return text;
};

/** This function reads a version of `diff`: a time, or a capture id. */
const versionOf = (name: string, text: string | undefined): VersionChoice | undefined => {
  if (text === undefined) return undefined;
  if (text.trim() === "") throw new UsageError(`--${name} wants a capture id or a time`);
  return DATE_START.test(text) ? { at: timeOf(name, text)! } : text;
};

/** These are the options of `watch`, read from the command line before the store opens. */
interface WatchLine {
  readonly action: "add" | "remove" | "list" | "run";
  readonly urls: readonly string[];
  readonly every: string | undefined;
  readonly confirm: 1 | 2 | undefined;
  readonly labels: Readonly<Record<string, string>> | undefined;
}

const ACTIONS: Readonly<Record<string, readonly [number, number]>> = {
  add: [1, Infinity],
  remove: [1, Infinity],
  list: [0, 0],
  run: [0, 0],
};

/** These options belong to one action of `watch`. */
const WATCH_OWNER: Readonly<Record<string, string>> = {
  every: "add",
  confirm: "add",
  scope: "add",
  label: "add",
  render: "add",
  budget: "run",
  "max-pages": "run",
  "sign-key": "run",
  "signature-agent": "run",
};

const watchLineOf = (
  values: ReturnType<typeof parse>["values"],
  rest: readonly string[],
): WatchLine => {
  const [action, ...urls] = rest;
  const counts = action === undefined ? undefined : ACTIONS[action];
  if (counts === undefined)
    throw new UsageError(`watch wants add, remove, list or run, not "${action ?? ""}"`);
  if (urls.length < counts[0] || urls.length > counts[1]) {
    throw new UsageError(
      counts[0] > 0 ? `watch ${action!} wants at least one URL` : `watch ${action!} takes no URL`,
    );
  }
  for (const [option, owner] of Object.entries(WATCH_OWNER)) {
    if (values[option as keyof typeof values] !== undefined && owner !== action)
      throw new UsageError(`--${option} is an option of watch ${owner}`);
  }
  if (values.every !== undefined) {
    let ms: number;
    try {
      ms = durationMs(values.every);
    } catch (error) {
      throw new UsageError(`--every: ${(error as Error).message}`, { cause: error });
    }
    if (ms < 3_600_000)
      throw new UsageError("--every wants 1h or more, so a watch cannot hammer a site");
  }
  if (values.confirm !== undefined && values.confirm !== "1" && values.confirm !== "2")
    throw new UsageError(`--confirm is 1 or 2, not "${values.confirm}"`);
  let labels: Record<string, string> | undefined;
  for (const label of values.label ?? []) {
    const at = label.indexOf("=");
    if (at < 1) throw new UsageError(`--label wants name=value, not "${label}"`);
    labels = { ...labels, [label.slice(0, at)]: label.slice(at + 1) };
  }
  for (const url of urls) {
    if (!/^https?:\/\//i.test(url) || !URL.canParse(url))
      throw new UsageError(`watch ${action!} wants http or https URLs, not "${url}"`);
  }
  return {
    action: action as WatchLine["action"],
    urls: [...new Set(urls)],
    every: values.every,
    confirm: values.confirm === undefined ? undefined : values.confirm === "1" ? 1 : 2,
    labels,
  };
};

const everyText = (ms: number): string =>
  ms % 86_400_000 === 0
    ? `${String(ms / 86_400_000)}d`
    : ms % 3_600_000 === 0
      ? `${String(ms / 3_600_000)}h`
      : `${String(Math.round(ms / 60_000))}m`;

const describeEntry = (entry: WatchEntry): string => {
  const facts = [
    `every ${everyText(entry.every_ms)}`,
    `next ${entry.next_at}`,
    entry.checked_at === null
      ? "not checked yet"
      : `last ${entry.last_kind ?? "check"} at ${entry.checked_at}`,
    `${String(entry.checks)} checks, ${String(entry.changes)} changes`,
  ];
  return [
    entry.url,
    `  ${facts.join(" · ")}`,
    ...(entry.pending === null
      ? []
      : [`  suspected: ${entry.pending.kind} since ${entry.pending.since}`]),
  ].join("\n");
};

const describeEvent = (event: WatchEvent): string => {
  const state = event.suspected ? " (suspected)" : event.confirmed ? " (confirmed)" : "";
  const facts = [
    `${event.outcome} ${String(event.status)}`,
    event.capture === null ? null : `capture ${event.capture}`,
    event.previous === null || event.previous === event.capture ? null : `from ${event.previous}`,
    event.diff === null
      ? null
      : `+${String(event.diff.lines_added)} −${String(event.diff.lines_removed)} lines, ${String(event.diff.meta_changes)} metadata changes`,
    event.held_back ? "held back" : null,
  ].filter((fact) => fact !== null);
  return [
    `${event.kind}${state} ${event.url}`,
    `  ${facts.join(" · ")}`,
    ...(event.note === null ? [] : [`  ${event.note}`]),
  ].join("\n");
};

const describeWatchSummary = (summary: WatchSummary): string =>
  `${String(summary.checked)} checked: ${String(summary.new)} new, ${String(summary.changed)} changed, ${String(summary.unchanged)} unchanged, ${String(summary.gone)} gone, ${String(summary.refused)} refused, ${String(summary.error)} errors. ${String(summary.suspected)} suspected, ${String(summary.confirmed)} confirmed, ${String(summary.due)} still due. Stopped (${summary.stopped}): ${summary.reason}.`;

/** This function does the command `watch`, and gives the exit code. */
const runWatchCommand = async (
  crawler: OpenedCrawler,
  line: WatchLine,
  values: ReturnType<typeof parse>["values"],
  limits: CrawlLimits,
  json: boolean,
  out: (text: string) => void,
): Promise<number> => {
  const print = (value: unknown, text: () => string): void =>
    out(json ? JSON.stringify(value, null, 2) : text());
  switch (line.action) {
    case "add": {
      const added: WatchEntry[] = [];
      for (const url of line.urls) {
        added.push(
          await crawler.watch.add(url, {
            ...(line.every === undefined ? {} : { every: line.every }),
            ...(line.confirm === undefined ? {} : { confirm: line.confirm }),
            ...(values.scope === undefined ? {} : { scope: values.scope }),
            ...(line.labels === undefined ? {} : { labels: line.labels }),
            ...(values.render === undefined
              ? {}
              : { render: values.render as "auto" | "never" | "always" }),
          }),
        );
      }
      print(added, () => added.map(describeEntry).join("\n"));
      return 0;
    }
    case "remove": {
      const removed: Array<{ readonly url: string; readonly removed: boolean }> = [];
      for (const url of line.urls) removed.push({ url, removed: await crawler.watch.remove(url) });
      print(removed, () =>
        removed
          .map((one) => `${one.removed ? "removed" : "not on the list"} ${one.url}`)
          .join("\n"),
      );
      return removed.every((one) => one.removed) ? 0 : 1;
    }
    case "list": {
      const entries = await crawler.watch.list();
      print(entries, () =>
        entries.length === 0 ? "the watch list is empty" : entries.map(describeEntry).join("\n"),
      );
      return 0;
    }
    default: {
      // the first Ctrl+C stops the run cleanly: the checks in progress end, and the summary prints
      const controller = new AbortController();
      const stop = (): void => controller.abort(new Error("interrupted"));
      process.once("SIGINT", stop);
      try {
        const run = crawler.watch.run({
          budgetMs: values.budget === undefined ? undefined : limits.budgetMs,
          maxPages: values["max-pages"] === undefined ? undefined : limits.maxPages,
          signal: controller.signal,
        });
        const events: WatchEvent[] = [];
        for await (const event of run) {
          events.push(event);
          if (!json) out(describeEvent(event));
        }
        const summary = await run.summary;
        out(json ? JSON.stringify({ events, summary }, null, 2) : describeWatchSummary(summary));
        return summary.refused + summary.error === 0 && summary.due === 0 ? 0 : 1;
      } finally {
        process.removeListener("SIGINT", stop);
      }
    }
  }
};

/** This function gives the text of a diff for a person: the two captures, then the text of `formatDiff`. */
const describeDiff = async (diff: DiffResult): Promise<string> => {
  const { formatDiff } = await import("./diff.ts");
  return [
    `${diff.doc}  ${diff.from.capture} (${diff.from.fetched_at}) -> ${diff.to.capture} (${diff.to.fetched_at})`,
    formatDiff(diff),
    ...(diff.same === true ? ["the two versions are the same"] : []),
    ...(diff.note === null ? [] : [diff.note]),
  ].join("\n");
};

// ── end of time travel, diff and watch ──────────────────────────────────────
// ── extract ─────────────────────────────────────────────────────────────────

/** These are the kinds of a field (`FIELD_KINDS` of `extract.ts`). The command line knows them before it loads the crawler. */
const KINDS: readonly string[] = ["text", "number", "money", "date", "url", "email", "phone"];

interface CliField {
  readonly value: string;
  readonly kind?: string;
}

/** This function reads the fields of the command line: `name=value`, with `:kind` at the end. The name and the value cannot be empty. */
const fieldsOf = (given: readonly string[] | undefined): Record<string, CliField> => {
  if (given === undefined || given.length === 0)
    throw new UsageError("extract wants at least one --field name=value[:kind]");
  const fields: Record<string, CliField> = {};
  for (const text of given) {
    const equals = text.indexOf("=");
    if (equals <= 0) throw new UsageError(`--field wants name=value[:kind], not "${text}"`);
    const name = text.slice(0, equals);
    let value = text.slice(equals + 1);
    let kind: string | undefined;
    const jsonLd = value.lastIndexOf(":json-ld:");
    const colon = value.lastIndexOf(":");
    if (jsonLd !== -1) {
      kind = value.slice(jsonLd + 1);
      value = value.slice(0, jsonLd);
      if (kind === "json-ld:" || /\s/.test(kind))
        throw new UsageError(
          `--field ${name} wants a path after json-ld:, such as json-ld:Product.offers.price`,
        );
    } else if (colon !== -1 && KINDS.includes(value.slice(colon + 1))) {
      kind = value.slice(colon + 1);
      value = value.slice(0, colon);
    }
    if (value.trim() === "") throw new UsageError(`--field ${name} wants a value`);
    if (fields[name] !== undefined) throw new UsageError(`--field ${name} is given two times`);
    fields[name] = kind === undefined ? { value } : { value, kind };
  }
  return fields;
};

/** This function checks the fields against a stored document, and prints a line for each field. The exit code is 0 when each field is verified or normalized. */
const runExtract = async (
  crawler: PoliteCrawler,
  doc: string,
  fields: Record<string, CliField>,
  options: {
    readonly capture: string | undefined;
    readonly userProvided: boolean;
    readonly at: string | undefined;
  },
  json: boolean,
  out: (text: string) => void,
): Promise<number> => {
  const { extractDocument } = await import("./extract.ts");
  const claims = fields as Parameters<typeof extractDocument>[2];
  const result =
    crawler.extract === undefined
      ? await extractDocument(crawler.runtime, doc, claims, options)
      : await crawler.extract(doc, claims, options);
  if (json) out(JSON.stringify(result, null, 2));
  else {
    for (const [name, field] of Object.entries(result.fields)) {
      const mark = field.status === "verified" || field.status === "normalized" ? "✓" : "✗";
      const place =
        field.span !== null
          ? ` at ${String(field.span.start)}–${String(field.span.end)}${field.span.in === "full_text" ? " of the whole text" : ""}`
          : field.path !== null
            ? ` at ${field.path}`
            : "";
      const how = field.normalization === null ? "" : ` (${field.normalization})`;
      const stored = field.raw === null ? "" : `: ${JSON.stringify(field.raw)}`;
      out(`${mark} ${name}: ${field.status}${how}${place}${stored}`);
      for (const candidate of field.candidates) {
        const at =
          candidate.span !== null
            ? `${String(candidate.span.start)}–${String(candidate.span.end)}`
            : (candidate.path ?? "");
        out(
          `    ${at}: ${JSON.stringify(candidate.raw)} can be ${candidate.readings.join(" or ")}`,
        );
      }
      if (field.note !== null && field.status !== "held-back") out(`    ${field.note}`);
    }
    const summary = result.summary;
    out(
      result.held_back
        ? `${result.note ?? "held back"}\nAdd --user-provided if you gave this URL yourself. The crawler logs that check.`
        : `${String(summary.fields)} fields: ${String(summary.verified)} verified, ${String(summary.normalized)} normalized, ${String(summary.ambiguous)} ambiguous, ${String(summary.not_found)} not found, ${String(summary.invalid)} not valid, in ${result.capture ?? "no capture"}${result.note === null ? "" : `. ${result.note}`}`,
    );
  }
  const done = result.summary.verified + result.summary.normalized;
  return done === result.summary.fields && done > 0 ? 0 : 1;
};

// ── end of extract ──────────────────────────────────────────────────────────

/** This function does the command of the command line, and gives the exit code. */
const main = async (args: readonly string[]): Promise<number> => {
  const { values, positionals } = parse(args);
  const out = (text: string): void => void process.stdout.write(`${text}\n`);
  if (values.version === true) {
    out(VERSION);
    return 0;
  }
  const [command, ...rest] = positionals;
  if (values.help === true || command === undefined) {
    process.stdout.write(HELP);
    return 0;
  }

  // the whole command line is valid before anything opens the store
  const spec = COMMANDS[command];
  if (spec === undefined) throw new UsageError(`no command "${command}"`);
  if (rest.length < spec.min || rest.length > spec.max) throw new UsageError(spec.wants);
  for (const [option, owner] of Object.entries(OWNER)) {
    const owners = owner.split(" ");
    if (values[option as keyof typeof values] !== undefined && !owners.includes(command))
      throw new UsageError(`--${option} is an option of ${owners.join(" or ")}`);
  }
  const render = values.render ?? "auto";
  if (render !== "auto" && render !== "never" && render !== "always")
    throw new UsageError(`--render is auto, never or always, not "${render}"`);
  const rank = values.rank ?? "exact";
  if (rank !== "exact" && rank !== "fast")
    throw new UsageError(`--rank is exact or fast, not "${rank}"`);
  const limit = whole("limit", values.limit, 10, 1);
  // diff reads --from as a version, and read as a position
  const from = command === "read" ? whole("from", values.from, 0, 0) : 0;
  const length = whole("length", values.length, 4000, 1);
  const crawlLimits = crawlOptionsOf(values);
  const at = timeOf("at", values.at);
  const diffFrom = command === "diff" ? versionOf("from", values.from) : undefined;
  const diffTo = versionOf("to", values.to);
  const watchLine = command === "watch" ? watchLineOf(values, rest) : undefined;
  // ── extract ──
  const extractFields = command === "extract" ? fieldsOf(values.field) : undefined;
  // ── end of extract ──
  const dir = storeDir(values.dir ?? (process.env["POLITE_CRAWLER_DIR"] || undefined));
  const allowPrivate = values["allow-private"] === true || envFlag("POLITE_CRAWLER_ALLOW_PRIVATE");
  const allowUserProvided =
    values["allow-user-provided"] === true ||
    (command === "mcp" && envFlag("POLITE_CRAWLER_ALLOW_USER_PROVIDED"));
  // ── archived fallback and signed requests: the whole command line is valid before the store opens ──
  if (values["archive-despite-robots"] === true && values["archive-fallback"] !== true)
    throw new UsageError("--archive-despite-robots works only with --archive-fallback");
  // of the actions of watch, only run sends requests, so only run signs
  const signs =
    OWNER["sign-key"]!.split(" ").includes(command) &&
    (watchLine === undefined || watchLine.action === "run");
  const signKey =
    values["sign-key"] ?? (signs ? process.env["POLITE_CRAWLER_SIGN_KEY"] || undefined : undefined);
  const signatureAgent =
    values["signature-agent"] ??
    (signs ? process.env["POLITE_CRAWLER_SIGNATURE_AGENT"] || undefined : undefined);
  if (command === "key-directory") {
    if (signKey === undefined) throw new UsageError("key-directory wants --sign-key <file>");
    return keyDirectoryCommand(keyFile(signKey), signatureAgent);
  }
  if ((signKey === undefined) !== (signatureAgent === undefined))
    throw new UsageError(
      "--sign-key and --signature-agent go together: the key signs, and the agent tells a site where its public key is",
    );
  let signer;
  if (signKey !== undefined && signatureAgent !== undefined) {
    const { createWebBotAuthSigner } = await import("./webbotauth.ts");
    const privateKey = keyFile(signKey);
    try {
      signer = createWebBotAuthSigner({
        privateKey,
        signatureAgent,
        agentType: agentTypeOf(signatureAgent),
      });
    } catch (error) {
      throw new UsageError(`--sign-key: ${(error as Error).message}`, { cause: error });
    }
  }
  // ── end of archived fallback and signed requests ──
  const options: OpenOptions = {
    dir,
    contact: values.contact ?? (process.env["POLITE_CRAWLER_CONTACT"] || undefined),
    ...(values["no-browser"] === true ? { renderer: false as const } : {}),
    ...(allowPrivate ? { egress: { allowPrivate: true } } : {}),
    ...(signer === undefined ? {} : { signer }),
  };

  if (command === "mcp") {
    const { startMcpServer } = await import("./mcp.ts");
    await startMcpServer({ ...options, allowUserProvided });
    return 0;
  }

  // the export only reads the store, so it opens no crawler and no index
  if (command === "export") return exportCommand(values, dir);

  const { durationMs, openCrawler } = await import("./open.ts");
  let maxAge: number;
  try {
    maxAge = durationMs(values["max-age"] ?? "24h");
  } catch (error) {
    throw new UsageError(`--max-age: ${(error as Error).message}`, { cause: error });
  }
  // only fetch, crawl and watch run render; a missing browser turns rendering off one time, before the first page
  let renderOff: string | undefined;
  let renderer = options.renderer;
  const renders = command === "fetch" || command === "crawl" || watchLine?.action === "run";
  if (!renders || render === "never") renderer = false;
  else if (renderer === undefined) {
    const { browserMissing } = await import("./browser.ts");
    renderOff = await browserMissing();
    if (renderOff !== undefined) renderer = false;
  }

  let crawler: OpenedCrawler;
  try {
    crawler = openCrawler({ ...options, renderer });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && FS_CODES.has(code)) {
      throw new Error(
        `the store ${dir} does not open: it is not a folder that polite-crawler can write (${code})`,
        {
          cause: error,
        },
      );
    }
    throw error;
  }
  const print = (value: unknown, text: () => string): void =>
    out(values.json === true ? JSON.stringify(value, null, 2) : text());
  try {
    switch (command) {
      case "fetch": {
        // the same URL twice is one fetch; one bad URL is an error of that URL only
        const urls = [...new Set(rest)];
        const fallback = values["archive-fallback"] === true ? ("archive" as const) : undefined;
        const archiveDespiteRobots = values["archive-despite-robots"] === true;
        const settled = await Promise.allSettled(
          urls.map((url) => crawler.fetch(url, { render, maxAge, fallback, archiveDespiteRobots })),
        );
        const pages = settled.map((result, at) => {
          const url = urls[at]!;
          if (result.status === "rejected") {
            const reason: unknown = result.reason;
            return failedPage(
              url,
              `${url}: ${reason instanceof Error ? reason.message : String(reason)}`,
            );
          }
          const page = result.value;
          return renderOff !== undefined && page.note !== null && /no browser/i.test(page.note)
            ? { ...page, note: `this page needs JavaScript, and rendering is off: ${renderOff}` }
            : page;
        });
        print(pages, () => pages.map(describePage).join("\n"));
        return pages.every(done) ? 0 : 1;
      }
      case "find": {
        const found = await crawler.find(rest.join(" "), {
          limit,
          kind: values.kind ?? null,
          rank,
        });
        print(found, () =>
          found.length === 0
            ? "nothing stored matches"
            : found
                .map(
                  (hit) =>
                    `${hit.doc}  ${hit.title}${hit.archived === undefined ? "" : `  [archived copy, captured ${hit.archived.timestamp}]`}\n  ${hit.snippet.replace(/\s+/g, " ")}`,
                )
                .join("\n"),
        );
        return found.length === 0 ? 1 : 0;
      }
      case "read": {
        const userProvided = values["user-provided"] === true;
        const read = await crawler.read(rest[0]!, { from, length, userProvided, at });
        // with --at, the head names the capture and its fetch time
        const version = at === undefined ? "" : ` ${read.capture} (${read.fetched_at})`;
        print(read, () =>
          read.before_first === true
            ? (read.note ?? "")
            : read.held_back
              ? `${read.note ?? ""}\nAdd --user-provided if you gave this URL yourself. The crawler logs that read.`
              : `${read.title}\n${read.url ?? ""}\n${read.archived === undefined ? "" : `${read.note ?? ""}\n`}[${String(read.from)}–${String(read.to)} of ${String(read.total)}]${version}\n\n${read.text}`,
        );
        return read.held_back || read.before_first === true ? 1 : 0;
      }
      case "verify": {
        const [doc, ...quote] = rest;
        const verified = await crawler.verify(doc!, quote.join(" "), { at });
        print(verified, () =>
          verified.found
            ? `found at ${String(verified.start)}–${String(verified.end)} in ${verified.capture ?? ""}${verified.stale ? " (an earlier capture)" : ""}${verified.archived === undefined ? "" : ` (an archived copy from ${verified.archived.source}, captured ${verified.archived.timestamp})`}: ${verified.excerpt ?? ""}`
            : verified.held_back || verified.before_first === true
              ? (verified.note ?? "held back")
              : "not found",
        );
        return verified.found ? 0 : 1;
      }
      // ── discover and crawl ──
      case "discover":
        return await runDiscover(crawler, rest[0]!, crawlLimits, maxAge, values.json === true, out);
      case "crawl":
        return await runCrawl(
          crawler,
          rest,
          crawlLimits,
          { render, maxAge },
          values.json === true,
          out,
        );
      // ── end of discover and crawl ──
      // ── diff and watch ──
      case "diff": {
        const diff = await crawler.diff(rest[0]!, {
          ...(diffFrom === undefined ? {} : { from: diffFrom }),
          ...(diffTo === undefined ? {} : { to: diffTo }),
        });
        const text = values.json === true ? "" : await describeDiff(diff);
        print(diff, () => text);
        return diff.held_back ? 1 : 0;
      }
      case "watch":
        return await runWatchCommand(
          crawler,
          watchLine!,
          values,
          crawlLimits,
          values.json === true,
          out,
        );
      // ── end of diff and watch ──
      // ── extract ──
      case "extract":
        return await runExtract(
          crawler,
          rest[0]!,
          extractFields!,
          { capture: values.capture, userProvided: values["user-provided"] === true, at },
          values.json === true,
          out,
        );
      // ── end of extract ──
      default: {
        // the documents of a recipe that this command cannot read stay, from the old index
        const counts = await crawler.reindex();
        print(counts, () =>
          [
            `${String(counts.captures)} captures replayed, ${String(counts.docs)} documents, ${String(counts.urls)} URLs`,
            ...(counts.carried > 0
              ? [
                  `${String(counts.carried)} documents of other recipes kept: ${counts.unknown_recipes.join(", ")}`,
                ]
              : []),
            ...(counts.failed + counts.missing + counts.damaged > 0
              ? [
                  `skipped: ${String(counts.failed)} captures whose reader failed, ${String(counts.missing)} with no stored body, ${String(counts.damaged)} damaged lines of the log`,
                ]
              : []),
          ].join("\n"),
        );
        return 0;
      }
    }
  } finally {
    await crawler.close();
  }
};

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const usage = error instanceof UsageError;
    process.stderr.write(
      `polite-crawler: ${message}${usage ? " (polite-crawler --help lists the commands)" : ""}\n`,
    );
    process.exitCode = usage ? 2 : 1;
  },
);
