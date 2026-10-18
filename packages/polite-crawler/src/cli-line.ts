/*
 * The command line of polite-crawler without its work: the options, the checks of the whole command
 * line, and the text of each result. `cli.ts` does the work. This file imports only Node.js, the
 * duration parser and the loopback check, so `--help` and `--version` answer at once. The tests use it in their own
 * process, so the checks and the texts count in the coverage of the package.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { VersionChoice } from "./diff.ts";
import type { DiscoverResult } from "./discover.ts";
import type { Found } from "./docs.ts";
import type { DaemonState } from "./daemon.ts";
import { durationMs } from "./duration.ts";
import type { ExtractResult } from "./extract.ts";
import type { CrawlSummary } from "./frontier.ts";
import type { Day, HoursComparison, Interval, Week } from "./hours.ts";
import type { EmbedResult } from "./hybrid.ts";
import { isLoopbackHost } from "./loopback.ts";
import type { Money, ProductResult } from "./recipe-product.ts";
import type { VenuePage, VenueReading, VenueResult } from "./recipe-venue.ts";
import type { PageResult, ReadResult, ReindexResult, VerifyResult } from "./runtime.ts";
import type { WaczResult } from "./wacz.ts";
import type { WarcResult } from "./warc.ts";
import type { WatchEntry, WatchEvent, WatchSummary } from "./watch.ts";

/** A usage error is a wrong command line. It exits with code 2. */
export class UsageError extends Error {}

/** These options belong to the command `export`. */
export const EXPORT_OPTIONS = {
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
export interface ExportValues {
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

/** These options belong to each command, or to the commands that `OWNER` names. */
const COMMAND_OPTIONS = {
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
  // ── daemon ──
  tick: { type: "string" },
  jitter: { type: "string" },
  "tick-budget": { type: "string" },
  "tick-pages": { type: "string" },
  grace: { type: "string" },
  events: { type: "string" },
  "on-change": { type: "string" },
  "mcp-http": { type: "boolean" },
  "mcp-port": { type: "string" },
  "mcp-host": { type: "string" },
  "mcp-token-file": { type: "string" },
  "allow-remote": { type: "boolean" },
  // ── end of daemon ──
  // ── extract ──
  field: { type: "string", multiple: true },
  capture: { type: "string" },
  // ── end of extract ──
  // ── hybrid search ──
  embedder: { type: "string" },
  "embed-model": { type: "string" },
  "ollama-url": { type: "string" },
  "allow-remote-ollama": { type: "boolean" },
  "max-docs": { type: "string" },
  // ── end of hybrid search ──
  // ── recipes ──
  name: { type: "string" },
  "require-name": { type: "boolean" },
  address: { type: "string" },
  lat: { type: "string" },
  lon: { type: "string" },
  osm: { type: "string" },
  pages: { type: "string" },
  compare: { type: "string" },
  "on-behalf-of": { type: "string", multiple: true },
  // ── end of recipes ──
} as const;

/** These are the options of the command line: the options of the commands and of `export`. */
const OPTIONS: typeof COMMAND_OPTIONS & typeof EXPORT_OPTIONS = {
  ...COMMAND_OPTIONS,
  ...EXPORT_OPTIONS,
};

/** This is the configuration of `parseArgs` for the command line. */
interface ParseConfig {
  args: string[];
  allowPositionals: true;
  strict: true;
  options: typeof OPTIONS;
}

/** This is the result of `parseArgs` for the command line. */
type ParsedArgs = ReturnType<typeof parseArgs<ParseConfig>>;

/** These options belong to `daemon`, and not to `daemon status`. */
export const DAEMON_RUN_OPTIONS: readonly string[] = [
  "tick",
  "jitter",
  "tick-budget",
  "tick-pages",
  "grace",
  "events",
  "on-change",
  "mcp-http",
  "mcp-port",
  "mcp-host",
  "mcp-token-file",
  "allow-remote",
];

/** These options belong to `venue` only. */
export const VENUE_OPTIONS: readonly string[] = [
  "name",
  "require-name",
  "address",
  "lat",
  "lon",
  "osm",
  "pages",
  "compare",
];

/** These options belong to one command, or to the commands that the text names. */
export const OWNER: Readonly<Record<string, string>> = {
  render: "fetch crawl watch venue product",
  "max-age": "fetch crawl discover venue product",
  limit: "find",
  kind: "find embed",
  rank: "find",
  from: "read diff",
  length: "read",
  "user-provided": "read extract venue product",
  "allow-user-provided": "mcp daemon",
  ...Object.fromEntries(Object.keys(EXPORT_OPTIONS).map((option) => [option, "export"])),
  // ── discover and crawl ──
  "max-urls": "discover",
  feed: "discover",
  "max-pages": "crawl watch",
  "max-depth": "crawl",
  budget: "crawl watch embed venue product",
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
  "archive-fallback": "fetch venue product",
  "archive-despite-robots": "fetch venue product",
  "sign-key": "fetch discover crawl watch mcp key-directory daemon venue product",
  "signature-agent": "fetch discover crawl watch mcp key-directory daemon venue product",
  // ── end of archived fallback and signed requests ──
  // ── daemon ──
  ...Object.fromEntries(DAEMON_RUN_OPTIONS.map((option) => [option, "daemon"])),
  // ── end of daemon ──
  // ── extract ──
  field: "extract",
  capture: "extract",
  // ── end of extract ──
  // ── hybrid search ──
  embedder: "find embed mcp",
  "embed-model": "find embed mcp",
  "ollama-url": "find embed mcp",
  "allow-remote-ollama": "find embed mcp",
  "max-docs": "embed",
  // ── end of hybrid search ──
  // ── recipes ──
  ...Object.fromEntries(VENUE_OPTIONS.map((option) => [option, "venue"])),
  "on-behalf-of": "venue product",
  // ── end of recipes ──
};

/** These are the commands, with the smallest and the largest count of arguments. */
export const COMMANDS: Readonly<
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
  // ── daemon ──
  daemon: { min: 0, max: 1, wants: "daemon takes no argument, or status" },
  // ── end of daemon ──
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
  // ── hybrid search ──
  embed: { min: 0, max: 0, wants: "embed takes no argument: give the model with --embedder" },
  // ── end of hybrid search ──
  // ── recipes ──
  venue: { min: 1, max: 1, wants: "venue wants the URL of the site of one venue" },
  product: { min: 1, max: 1, wants: "product wants the URL of one product page" },
  // ── end of recipes ──
};

const parse = (args: readonly string[]): ParsedArgs => {
  try {
    return parseArgs<ParseConfig>({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: OPTIONS,
    });
  } catch (error) {
    // parseArgs gives a TypeError with an ERR_PARSE_ARGS code for a wrong command line
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) {
      throw new UsageError((error as Error).message, { cause: error });
    }
    throw error;
  }
};

export const whole = (
  name: string,
  text: string | undefined,
  fallback: number,
  min: number,
): number => {
  if (text === undefined) return fallback;
  if (!/^\s*\d+\s*$/.test(text))
    throw new UsageError(`--${name} wants a whole number, not "${text}"`);
  const value = Number(text);
  if (value < min) throw new UsageError(`--${name} wants ${String(min)} or more`);
  return value;
};

/** An environment variable that switches a feature on is 1 or 0 (also true or false, yes or no). */
export const envFlag = (
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): boolean => {
  const raw = env[name];
  const value = raw?.trim().toLowerCase() ?? "";
  if (["", "0", "false", "no", "off"].includes(value)) return false;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  throw new UsageError(`${name} is 1 or 0, not "${raw ?? ""}"`);
};

/** The store: a leading `~` is the home folder, and a relative path starts at the working folder. */
export const storeDir = (text: string | undefined): string => {
  if (text === undefined) return join(homedir(), ".polite-crawler");
  if (text.trim() === "") throw new UsageError("--dir wants a folder");
  if (text === "~") return homedir();
  if (/^~[\\/]/.test(text)) return resolve(homedir(), text.slice(2));
  return resolve(text);
};

export const FS_CODES: ReadonlySet<string> = new Set([
  "EEXIST",
  "ENOENT",
  "ENOTDIR",
  "EACCES",
  "EPERM",
  "EROFS",
  "EISDIR",
]);

export const ok = (page: PageResult): boolean =>
  page.outcome === "ok" || page.outcome === "not-modified";

/** A fetch is done when the page came, or when an archived copy came in its place. */
export const done = (page: PageResult): boolean => ok(page) || page.archived !== undefined;

export const describePage = (page: PageResult): string => {
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

/** This function reads the key file of `--sign-key`. An error names the file, and not the key. */
export const keyFile = (path: string): string => {
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
export const agentTypeOf = (url: string): "directory" | "jwks_uri" => {
  try {
    const parsed = new URL(url);
    return parsed.pathname === "/" && parsed.search === "" ? "directory" : "jwks_uri";
  } catch {
    // the signer gives the error of a URL that does not parse
    return "directory";
  }
};

/** This is the result of a URL that the crawler did not fetch. */
export const failedPage = (url: string, note: string): PageResult => ({
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

/** The options of `discover` and `crawl`, read from the command line before the store opens. */
export interface CrawlLimits {
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

export const crawlOptionsOf = (values: Values): CrawlLimits => {
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

export const describeSummary = (summary: CrawlSummary): string =>
  `${String(summary.pages)} pages: ${String(summary.fetched)} fetched (${String(summary.from_cache)} from the store), ${String(summary.refused)} refused, ${String(summary.failed)} failed. ${String(summary.skipped)} links not followed, ${String(summary.queued)} URLs waiting. Stopped (${summary.stopped}): ${summary.reason}.`;

/** A text that starts with a date is a time. A different text is a capture id. */
export const DATE_START: RegExp = /^\d{4}-\d{2}-\d{2}/;

/** This function reads a time of the command line. A text that is not a time is a usage error. */
export const timeOf = (name: string, text: string | undefined): string | undefined => {
  if (text === undefined) return undefined;
  if (!DATE_START.test(text) || !Number.isFinite(Date.parse(text)))
    throw new UsageError(`--${name} wants a time, such as 2026-10-01T12:00:00Z, not "${text}"`);
  return text;
};

/** This function reads a version of `diff`: a time, or a capture id. */
export const versionOf = (name: string, text: string | undefined): VersionChoice | undefined => {
  if (text === undefined) return undefined;
  if (text.trim() === "") throw new UsageError(`--${name} wants a capture id or a time`);
  return DATE_START.test(text) ? { at: timeOf(name, text)! } : text;
};

/** These are the options of `watch`, read from the command line before the store opens. */
export interface WatchLine {
  readonly action: "add" | "remove" | "list" | "run";
  readonly urls: readonly string[];
  readonly every: string | undefined;
  readonly confirm: 1 | 2 | undefined;
  readonly labels: Readonly<Record<string, string>> | undefined;
}

export const ACTIONS: Readonly<Record<string, readonly [number, number]>> = {
  add: [1, Infinity],
  remove: [1, Infinity],
  list: [0, 0],
  run: [0, 0],
};

/** These options belong to one action of `watch`. */
export const WATCH_OWNER: Readonly<Record<string, string>> = {
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

export const watchLineOf = (values: Values, rest: readonly string[]): WatchLine => {
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

export const everyText = (ms: number): string =>
  ms % 86_400_000 === 0
    ? `${String(ms / 86_400_000)}d`
    : ms % 3_600_000 === 0
      ? `${String(ms / 3_600_000)}h`
      : `${String(Math.round(ms / 60_000))}m`;

export const describeEntry = (entry: WatchEntry): string => {
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

export const describeEvent = (event: WatchEvent): string => {
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

export const describeWatchSummary = (summary: WatchSummary): string =>
  `${String(summary.checked)} checked: ${String(summary.new)} new, ${String(summary.changed)} changed, ${String(summary.unchanged)} unchanged, ${String(summary.gone)} gone, ${String(summary.refused)} refused, ${String(summary.error)} errors. ${String(summary.suspected)} suspected, ${String(summary.confirmed)} confirmed, ${String(summary.due)} still due. Stopped (${summary.stopped}): ${summary.reason}.`;

// ── daemon ──────────────────────────────────────────────────────────────────

/** These are the options of `daemon`, read from the command line before the store opens. */
export interface DaemonLine {
  /** This value is `run` (the daemon itself) or `status`. */
  readonly action: "run" | "status";
  readonly tickMs: number | undefined;
  readonly jitterMs: number | undefined;
  readonly budgetMs: number | undefined;
  readonly maxPages: number | undefined;
  readonly graceMs: number | undefined;
  /** This file gets the change events. Without it, they go to the standard output. */
  readonly events: string | undefined;
  /** This command of the operator gets each change event on its standard input. */
  readonly onChange: string | undefined;
  /** These options serve MCP over HTTP, or undefined without `--mcp-http`. */
  readonly mcp:
    | {
        readonly port: number;
        readonly host: string;
        readonly allowRemote: boolean;
        readonly tokenFile: string | undefined;
      }
    | undefined;
}

/** This function reads a file name of the command line: a leading `~` is the home folder. */
const fileOf = (text: string): string =>
  text === "~"
    ? homedir()
    : /^~[\\/]/.test(text)
      ? resolve(homedir(), text.slice(2))
      : resolve(text);

/** This function reads a duration of `daemon`, with a floor in milliseconds. */
const daemonDuration = (
  name: string,
  text: string | undefined,
  floor: number,
): number | undefined => {
  if (text === undefined) return undefined;
  let ms: number;
  try {
    ms = durationMs(text);
  } catch (error) {
    throw new UsageError(`--${name}: ${(error as Error).message}`, { cause: error });
  }
  if (ms < floor) {
    throw new UsageError(
      floor === 0
        ? `--${name} wants 0 or more`
        : `--${name} wants ${String(floor / 1000)}s or more`,
    );
  }
  return ms;
};

/** These options of `daemon` belong to its MCP server, so they need `--mcp-http`. */
const MCP_OPTIONS = ["mcp-port", "mcp-host", "mcp-token-file", "allow-remote"] as const;

/** This function checks the options of `daemon` and of `daemon status`. */
export const daemonLineOf = (values: Values, rest: readonly string[]): DaemonLine => {
  const [action] = rest;
  if (action !== undefined && action !== "status")
    throw new UsageError(`daemon takes no argument, or status, not "${action}"`);
  if (action === "status") {
    const run = [...DAEMON_RUN_OPTIONS, "allow-user-provided", "sign-key", "signature-agent"];
    for (const option of run) {
      if (values[option as keyof Values] !== undefined)
        throw new UsageError(`--${option} is an option of daemon, not of daemon status`);
    }
  }
  if (values["mcp-http"] !== true) {
    for (const option of MCP_OPTIONS) {
      if (values[option] !== undefined) throw new UsageError(`--${option} goes with --mcp-http`);
    }
  }
  const host = (values["mcp-host"] ?? "127.0.0.1").trim();
  if (host === "") throw new UsageError("--mcp-host wants a host");
  const allowRemote = values["allow-remote"] === true;
  if (values["mcp-http"] === true && !isLoopbackHost(host) && !allowRemote) {
    throw new UsageError(
      `--mcp-host ${host} is not a loopback address: add --allow-remote to serve other computers, after you read the warning in the README`,
    );
  }
  const port = whole("mcp-port", values["mcp-port"], 9307, 0);
  if (port > 65_535) throw new UsageError("--mcp-port wants a port from 0 to 65535");
  const onChange = values["on-change"];
  if (onChange !== undefined && onChange.trim() === "")
    throw new UsageError("--on-change wants a command");
  const events = values.events;
  if (events !== undefined && events.trim() === "") throw new UsageError("--events wants a file");
  const tokenFile = values["mcp-token-file"];
  if (tokenFile !== undefined && tokenFile.trim() === "")
    throw new UsageError("--mcp-token-file wants a file");
  return {
    action: action === "status" ? "status" : "run",
    tickMs: daemonDuration("tick", values.tick, 1000),
    jitterMs: daemonDuration("jitter", values.jitter, 0),
    budgetMs: daemonDuration("tick-budget", values["tick-budget"], 1000),
    maxPages:
      values["tick-pages"] === undefined
        ? undefined
        : whole("tick-pages", values["tick-pages"], 1, 1),
    graceMs: daemonDuration("grace", values.grace, 0),
    events: events === undefined ? undefined : fileOf(events),
    onChange,
    mcp:
      values["mcp-http"] === true
        ? {
            port,
            host,
            allowRemote,
            tokenFile: tokenFile === undefined ? undefined : fileOf(tokenFile),
          }
        : undefined,
  };
};

/** This function gives the first line of `daemon status`: the daemon runs, stopped, or stopped with no clean stop. */
const daemonHead = (state: DaemonState): string =>
  state.alive
    ? `the daemon runs (process ${String(state.pid)}) since ${state.started_at}, on the store ${state.store}`
    : state.running
      ? `the daemon of process ${String(state.pid)} does not run: it stopped with no clean stop. Its state is of ${state.updated_at}`
      : `the daemon stopped at ${state.stopped_at ?? state.updated_at}`;

/** This function gives the line of the last tick of `daemon status`. */
const lastTick = (state: DaemonState): string => {
  const tick = state.last_tick;
  if (tick === null) return "last tick: none yet";
  if (tick.summary === null) return `last tick: ${tick.ended_at}, failed: ${tick.error ?? "error"}`;
  const summary = tick.summary;
  return `last tick: ${tick.ended_at}, ${String(summary.checked)} checked, ${String(summary.confirmed)} changes, ${String(summary.refused)} refused, ${String(summary.error)} errors (${summary.stopped})`;
};

/** This function gives the text of `daemon status`. */
export const describeDaemonStatus = (state: DaemonState | undefined, dir: string): string => {
  if (state === undefined) return `no daemon has run on the store ${dir}`;
  const lines = [daemonHead(state), lastTick(state)];
  if (state.alive && state.next_tick_at !== null) lines.push(`next tick: ${state.next_tick_at}`);
  lines.push(
    `${String(state.ticks)} ticks, ${String(state.checked)} checks, ${String(state.changes)} changes`,
  );
  if (state.next_due.length === 0) lines.push("next due: no watch");
  else {
    lines.push("next due:");
    for (const due of state.next_due) {
      lines.push(
        `  ${due.next_at}  ${due.url}  (every ${everyText(due.every_ms)}, last ${due.last_kind ?? "none"})`,
      );
    }
  }
  if (state.mcp !== null) {
    const where = state.mcp.token_file === null ? "" : ` (the token is in ${state.mcp.token_file})`;
    lines.push(`MCP: ${state.mcp.url}${where}`);
    lines.push(
      state.tasks.length === 0
        ? "tasks: none running"
        : `tasks: ${String(state.tasks.length)} running`,
    );
    for (const task of state.tasks) {
      lines.push(
        `  ${task.id}  ${task.tool}  ${task.status}${task.message === null ? "" : `: ${task.message}`}`,
      );
    }
  }
  lines.push(
    state.last_error === null
      ? "last error: none"
      : `last error: ${state.last_error.at}: ${state.last_error.message}`,
  );
  return lines.join("\n");
};

// ── end of daemon ───────────────────────────────────────────────────────────

/** These are the kinds of a field (`FIELD_KINDS` of `extract.ts`). The command line knows them before it loads the crawler. */
export const KINDS: readonly string[] = [
  "text",
  "number",
  "money",
  "date",
  "url",
  "email",
  "phone",
];

export interface CliField {
  readonly value: string;
  readonly kind?: string;
}

/** This function reads the fields of the command line: `name=value`, with `:kind` at the end. The name and the value cannot be empty. */
export const fieldsOf = (given: readonly string[] | undefined): Record<string, CliField> => {
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

// ── hybrid search ───────────────────────────────────────────────────────────

/** This is the embedder of the command line: its adapter, its model and the URL of Ollama. */
export interface EmbedderChoice {
  readonly kind: "transformers" | "ollama";
  readonly model: string | undefined;
  readonly url: string | undefined;
  readonly allowRemote: boolean;
}

/**
 * This function reads the embedder of the command line, or of the environment for the commands
 * that use one. `--embed-model` and `--ollama-url` need `--embedder`.
 */
export const embedderOf = (
  values: Values,
  env: Readonly<Record<string, string | undefined>>,
  command: string,
): EmbedderChoice | undefined => {
  const uses = OWNER["embedder"]!.split(" ").includes(command);
  const fromEnv = (name: string): string | undefined => (uses ? env[name] || undefined : undefined);
  const name = values.embedder ?? fromEnv("POLITE_CRAWLER_EMBEDDER");
  const model = values["embed-model"] ?? fromEnv("POLITE_CRAWLER_EMBED_MODEL");
  const url = values["ollama-url"] ?? fromEnv("POLITE_CRAWLER_OLLAMA_URL");
  const allowRemote =
    values["allow-remote-ollama"] === true ||
    (uses && envFlag(env, "POLITE_CRAWLER_ALLOW_REMOTE_OLLAMA"));
  if (name === undefined) {
    if (values["embed-model"] !== undefined || values["ollama-url"] !== undefined)
      throw new UsageError(
        "--embed-model and --ollama-url go with --embedder transformers or ollama",
      );
    return undefined;
  }
  if (name !== "transformers" && name !== "ollama")
    throw new UsageError(`--embedder is transformers or ollama, not "${name}"`);
  if (model !== undefined && model.trim() === "")
    throw new UsageError("--embed-model wants a model");
  if (values["ollama-url"] !== undefined && name !== "ollama")
    throw new UsageError("--ollama-url goes with --embedder ollama");
  return {
    kind: name,
    model,
    url: name === "ollama" ? url : undefined,
    allowRemote,
  };
};

/** This function gives the text of `embed`: the counts and the reason of the stop. */
export const describeEmbed = (result: EmbedResult): string =>
  [
    `${String(result.embedded)} texts got vectors (${String(result.chunks)} chunks); ${String(result.reused)} documents had vectors; ${String(result.held_back)} held back, so not sent to the model`,
    `${String(result.docs)} documents examined in ${String(result.ms)} ms with ${result.embedder}. Stopped (${result.stopped})${result.stopped === "done" ? "" : ": start embed again for the rest"}.`,
  ].join("\n");

// ── the texts of the results ────────────────────────────────────────────────

/** This function gives the pages of `fetch`: a rejected fetch is an error of its URL only. A page that needs a browser names the reason when rendering is off. */
export const fetchedPages = (
  urls: readonly string[],
  settled: ReadonlyArray<PromiseSettledResult<PageResult>>,
  renderOff: string | undefined,
): PageResult[] =>
  settled.map((result, at) => {
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

/** This function gives the text of the results of `find`. An archived copy says so. */
export const describeFound = (found: readonly Found[]): string =>
  found.length === 0
    ? "nothing stored matches"
    : found
        .map(
          (hit) =>
            `${hit.doc}  ${hit.title}${hit.archived === undefined ? "" : `  [archived copy, captured ${hit.archived.timestamp}]`}${hit.passage === undefined ? "" : `  [passage ${String(hit.passage.start)}–${String(hit.passage.end)}]`}\n  ${hit.snippet.replace(/\s+/g, " ")}`,
        )
        .join("\n");

/** This function gives the text of `read`. With `--at`, the head names the capture and its fetch time. */
export const describeRead = (read: ReadResult, at: string | undefined): string => {
  const version = at === undefined ? "" : ` ${read.capture} (${read.fetched_at})`;
  return read.before_first === true
    ? (read.note ?? "")
    : read.held_back
      ? `${read.note ?? ""}\nAdd --user-provided if you gave this URL yourself. The crawler logs that read.`
      : `${read.title}\n${read.url ?? ""}\n${read.archived === undefined ? "" : `${read.note ?? ""}\n`}[${String(read.from)}–${String(read.to)} of ${String(read.total)}]${version}\n\n${read.text}`;
};

/** This function gives the text of `verify`. An archived copy and an earlier capture say so. */
export const describeVerify = (verified: VerifyResult): string =>
  verified.found
    ? `found at ${String(verified.start)}–${String(verified.end)} in ${verified.capture ?? ""}${verified.stale ? " (an earlier capture)" : ""}${verified.archived === undefined ? "" : ` (an archived copy from ${verified.archived.source}, captured ${verified.archived.timestamp})`}: ${verified.excerpt ?? ""}`
    : verified.held_back || verified.before_first === true
      ? (verified.note ?? "held back")
      : "not found";

/** This function gives the lines of `discover`: each URL with its date, then the count of the files. */
export const describeDiscover = (found: DiscoverResult): string[] => {
  const read = found.sources.filter((source) => source.kind !== null).length;
  return [
    ...found.urls.map((url) =>
      url.lastmod === null ? url.url : `${url.url}  ${url.lastmod.slice(0, 10)}`,
    ),
    `${String(found.urls.length)} URLs from ${String(read)} of ${String(found.sources.length)} files (${found.stopped}${found.note === null ? "" : `: ${found.note}`})`,
  ];
};

/** This function gives the text of `reindex`: the counts, the documents that stay, and the captures that it skipped. */
export const describeReindex = (counts: ReindexResult): string =>
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
  ].join("\n");

/** This function gives the lines of `extract`: a line for each field, its candidates and its note, then the counts. */
export const describeExtract = (result: ExtractResult): string[] => {
  const lines: string[] = [];
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
    lines.push(`${mark} ${name}: ${field.status}${how}${place}${stored}`);
    for (const candidate of field.candidates) {
      const at =
        candidate.span !== null
          ? `${String(candidate.span.start)}–${String(candidate.span.end)}`
          : (candidate.path ?? "");
      lines.push(
        `    ${at}: ${JSON.stringify(candidate.raw)} can be ${candidate.readings.join(" or ")}`,
      );
    }
    if (field.note !== null && field.status !== "held-back") lines.push(`    ${field.note}`);
  }
  const summary = result.summary;
  lines.push(
    result.held_back
      ? `${result.note ?? "held back"}\nAdd --user-provided if you gave this URL yourself. The crawler logs that check.`
      : `${String(summary.fields)} fields: ${String(summary.verified)} verified, ${String(summary.normalized)} normalized, ${String(summary.ambiguous)} ambiguous, ${String(summary.not_found)} not found, ${String(summary.invalid)} not valid, in ${result.capture ?? "no capture"}${result.note === null ? "" : `. ${result.note}`}`,
  );
  return lines;
};

/** This function gives the exit code of `extract`: 0 when each field is verified or normalized. */
export const extractCode = (result: ExtractResult): number => {
  const done = result.summary.verified + result.summary.normalized;
  return done === result.summary.fields && done > 0 ? 0 : 1;
};

// ── recipes ─────────────────────────────────────────────────────────────────

/** This value is the most pages of `venue` after the home page. It is `VENUE_LIMITS.maxPages` of `recipe-venue.ts`. */
export const VENUE_MAX_PAGES = 8;

/** This exit code of `venue` and `product` tells that the command read nothing. */
export const NOTHING_READ = 3;

/** This exit code of `venue` and `product` tells that the site refused the crawler (a wall). */
export const WALL = 4;

/** The place of a venue, as `VenueLocation` of `recipe-venue.ts` gives it. */
export interface CliLocation {
  readonly address?: string | undefined;
  readonly lat?: number | undefined;
  readonly lon?: number | undefined;
}

/** These are the options of `venue` and `product`, read from the command line before the store opens. */
export interface RecipeLine {
  readonly recipe: "venue" | "product";
  readonly url: string;
  readonly render: "auto" | "never" | "always";
  /** This value is `--max-age` in milliseconds. */
  readonly maxAge: number;
  /** This value is `--budget` in milliseconds, or undefined with no `--budget`. */
  readonly budget: number | undefined;
  /** These tokens name the agents of `--on-behalf-of`. Their robots.txt rules apply too. */
  readonly onBehalfOf: readonly string[] | undefined;
  readonly userProvided: boolean;
  readonly fallback: "archive" | undefined;
  readonly archiveDespiteRobots: boolean;
  /** This text is `--name` of `venue`. */
  readonly name: string | undefined;
  readonly requireName: boolean;
  /** This value is the place of `--address`, `--lat` and `--lon`. */
  readonly location: CliLocation | undefined;
  /** This text is the OpenStreetMap value of `--osm`. */
  readonly osm: string | undefined;
  readonly pages: number | undefined;
  /** This text is the file of `--compare`. The command reads it before the store opens. */
  readonly compare: string | undefined;
}

/** This function reads a latitude or a longitude of the command line. */
const coordinateOf = (name: "lat" | "lon", text: string, limit: number): number => {
  const value = /^\s*-?\d+(?:\.\d+)?\s*$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isFinite(value) || Math.abs(value) > limit) {
    throw new UsageError(
      `--${name} wants a number from -${String(limit)} to ${String(limit)}, not "${text}"`,
    );
  }
  return value;
};

/** This function checks the options of `venue` and `product`, and gives the options of the recipe. */
export const recipeLineOf = (
  recipe: "venue" | "product",
  values: Values,
  rest: readonly string[],
  page: {
    readonly render: "auto" | "never" | "always";
    readonly maxAge: number;
    readonly budget: number | undefined;
  },
): RecipeLine => {
  const url = rest[0] ?? "";
  if (!/^https?:\/\//i.test(url) || !URL.canParse(url))
    throw new UsageError(`${recipe} wants an http or https URL, not "${url}"`);
  for (const agent of values["on-behalf-of"] ?? []) {
    if (!/^[A-Za-z0-9_-]+$/.test(agent)) {
      throw new UsageError(
        `--on-behalf-of wants the robots.txt token of an agent, such as Claude-User, not "${agent}"`,
      );
    }
  }
  const name = values.name;
  if (name !== undefined && name.trim() === "")
    throw new UsageError("--name wants the name of the venue");
  if (values["require-name"] === true && name === undefined)
    throw new UsageError("--require-name goes with --name");
  const address = values.address;
  if (address !== undefined && address.trim() === "")
    throw new UsageError("--address wants a street address");
  if ((values.lat === undefined) !== (values.lon === undefined))
    throw new UsageError("--lat and --lon go together");
  const lat = values.lat === undefined ? undefined : coordinateOf("lat", values.lat, 90);
  const lon = values.lon === undefined ? undefined : coordinateOf("lon", values.lon, 180);
  const osm = values.osm;
  if (osm !== undefined && osm.trim() === "")
    throw new UsageError('--osm wants an opening_hours value, such as "Mo-Fr 08:00-18:00"');
  const pages = values.pages === undefined ? undefined : whole("pages", values.pages, 0, 0);
  if (pages !== undefined && pages > VENUE_MAX_PAGES)
    throw new UsageError(`--pages wants a whole number from 0 to ${String(VENUE_MAX_PAGES)}`);
  const compare = values.compare;
  if (compare !== undefined && compare.trim() === "")
    throw new UsageError("--compare wants a file");
  return {
    recipe,
    url,
    render: page.render,
    maxAge: page.maxAge,
    budget: page.budget,
    onBehalfOf: values["on-behalf-of"],
    userProvided: values["user-provided"] === true,
    fallback: values["archive-fallback"] === true ? "archive" : undefined,
    archiveDespiteRobots: values["archive-despite-robots"] === true,
    name,
    requireName: values["require-name"] === true,
    location:
      address === undefined && lat === undefined
        ? undefined
        : {
            ...(address === undefined ? {} : { address }),
            ...(lat === undefined ? {} : { lat, lon }),
          },
    osm,
    pages,
    compare,
  };
};

/** The days of a week in their order, as `DAYS` of `hours.ts`. */
const WEEK_DAYS: readonly Day[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const DAY_LABELS: Readonly<Record<Day, string>> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** This function tells if a value is a time of a kept week: `HH:MM` or `H:MM`, to `24:00`. */
const isClock = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  return match !== null && Number(match[1]) <= 24 && Number(match[2]) < 60;
};

const intervalOf = (value: unknown): Interval | undefined =>
  Array.isArray(value) && value.length === 2 && isClock(value[0]) && isClock(value[1])
    ? [value[0], value[1]]
    : undefined;

/** The kept week of `--compare`, and the file that it came from. */
export interface KeptWeek {
  readonly file: string;
  readonly week: Week;
}

/**
 * This function reads the kept week of `--compare`, a JSON file. The file is a week, or an object
 * with the field `week` (a reading of `venue --json`) or `hours_week`. Each day gives a list of
 * intervals (`[]` for closed), one interval, or null for closed. An error names the file.
 */
export const keptWeekOf = (path: string): KeptWeek => {
  const file = fileOf(path);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new UsageError(
      `--compare: the file ${file} does not open (${typeof code === "string" ? code : "error"})`,
      { cause: error },
    );
  }
  let data: unknown;
  try {
    // a byte order mark at the start is not JSON, and some editors of Windows write one
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    throw new UsageError(`--compare: the file ${file} is not JSON`, { cause: error });
  }
  if (isRecord(data) && (isRecord(data["week"]) || isRecord(data["hours_week"])))
    data = isRecord(data["week"]) ? data["week"] : data["hours_week"];
  const wants = `--compare: the file ${file} is not a week. Write a list of intervals, one interval or null for each day, such as {"mon": [["09:00", "17:00"]], "sun": []}`;
  if (!isRecord(data)) throw new UsageError(wants);
  const week: Partial<Record<Day, readonly Interval[]>> = {};
  for (const [key, value] of Object.entries(data)) {
    const day = WEEK_DAYS.find((one) => one === key);
    if (day === undefined) {
      throw new UsageError(
        `--compare: the file ${file} names "${key}", not a day: use mon, tue, wed, thu, fri, sat or sun`,
      );
    }
    const one = intervalOf(value);
    const intervals =
      value === null
        ? []
        : one !== undefined
          ? [one]
          : Array.isArray(value)
            ? value.map(intervalOf)
            : [undefined];
    if (intervals.some((interval) => interval === undefined))
      throw new UsageError(`${wants} (the value of ${key} is not)`);
    week[day] = intervals as Interval[];
  }
  return { file, week };
};

/** This function writes the intervals of one day, as `describeWeek` of `hours.ts` does. */
export const dayText = (intervals: readonly Interval[] | undefined): string =>
  intervals === undefined
    ? "not stated"
    : intervals.length === 0
      ? "closed"
      : intervals
          .map(([open, close]) =>
            open === "00:00" && close === "00:00" ? "open 24 hours" : `${open}–${close}`,
          )
          .join(", ");

/** The result of `--compare`: the kept week and its comparison with the week of the site. */
export interface VenueCompare {
  readonly file: string;
  readonly kept: Week;
  /** This value is null when the result has no reading of the site with no guess (`from_site`). */
  readonly comparison: HoursComparison | null;
}

/** One day of `--compare`. */
export interface CompareDay {
  readonly day: Day;
  /** The value `not read` tells that only the kept week states the day. */
  readonly status: "same" | "changed" | "new" | "skipped" | "not read";
  readonly kept: readonly Interval[] | undefined;
  readonly read: readonly Interval[] | undefined;
}

/** This function gives the days of a comparison in their order. A day that no week states is not there. */
export const compareDays = (kept: Week, read: Week, comparison: HoursComparison): CompareDay[] => {
  const days: CompareDay[] = [];
  for (const day of WEEK_DAYS) {
    const one = { day, kept: kept[day], read: read[day] };
    if (one.kept === undefined && one.read === undefined) continue;
    const status: CompareDay["status"] =
      comparison.status === "new" || comparison.added.includes(day)
        ? "new"
        : comparison.days.includes(day)
          ? "changed"
          : comparison.skipped.includes(day)
            ? "skipped"
            : one.read === undefined
              ? "not read"
              : "same";
    if (comparison.status === "new" && one.read === undefined) continue;
    days.push({ ...one, status });
  }
  return days;
};

const QUOTE_CHARS = 200;

const shortText = (text: string): string =>
  text.length > QUOTE_CHARS ? `${text.slice(0, QUOTE_CHARS)}…` : text;

/** This function gives the lines of one reading: its rank, its source, its week and its quote. */
const readingLines = (one: VenueReading): string[] => {
  const marks = [
    one.schedule === "other" ? "not the opening hours" : null,
    one.inferred ? "am or pm guessed" : null,
    one.partial ? "a rule left out" : null,
    one.season === null ? null : `season ${one.season}`,
  ].filter((mark) => mark !== null);
  const where = [
    one.url,
    one.path,
    one.capture === null ? null : `capture ${one.capture}`,
    one.archived === undefined
      ? null
      : `archived copy (${one.archived.source}, captured ${one.archived.timestamp})`,
  ].filter((part) => part !== null);
  return [
    `  rank ${String(one.rank)}  ${one.from}${one.label === null ? "" : ` "${one.label}"`}  ${one.hours === "" ? "no day" : one.hours}${marks.length > 0 ? ` (${marks.join(", ")})` : ""}`,
    ...(where.length > 0 ? [`    ${where.join(" · ")}`] : []),
    one.from === "text"
      ? `    quote: ${JSON.stringify(shortText(one.raw))}`
      : `    value: ${shortText(one.raw.replace(/\s+/g, " "))}`,
  ];
};

const pageLine = (page: VenuePage): string => {
  const facts = [
    `${page.outcome} ${String(page.status)}`,
    page.from_cache ? "from the store" : null,
    page.rendered ? "rendered" : null,
    page.held_back ? "held back" : null,
    page.archived === undefined ? null : `archived copy (${page.archived.source})`,
  ].filter((fact) => fact !== null);
  const read = page.outcome === "ok" || page.outcome === "not-modified";
  return `  ${read || page.archived !== undefined ? "✓" : "✗"} ${page.url}  ${facts.join(" · ")}`;
};

const WALL_OUTCOMES: ReadonlySet<string> = new Set(["blocked", "challenge", "payment-required"]);

/**
 * This function tells if a site refused the crawler, with the rule of `wall` of `readProduct`. The
 * causes are a 401, a 402 or a 403, a challenge, a bot check, robots.txt or a stop of the host.
 */
export const refusedPage = (page: {
  readonly outcome: string;
  readonly doc: string | null;
  readonly note: string | null;
}): boolean =>
  WALL_OUTCOMES.has(page.outcome) ||
  (page.outcome === "skipped" && /^(?:robots\.txt disallows|host stopped)/.test(page.note ?? "")) ||
  (page.doc === null && /\bbot check\b/.test(page.note ?? ""));

/**
 * This function gives the exit code of `venue`. It is 0 when the site gave a reading of the opening
 * hours. It is `WALL` when the home page refused the crawler, and `NOTHING_READ` for a different
 * result. An OpenStreetMap value alone does not count.
 */
export const venueCode = (result: VenueResult): number => {
  if (result.readings.some((one) => one.from !== "osm" && one.schedule === "opening")) return 0;
  const home = result.pages[0];
  return home !== undefined && refusedPage(home) ? WALL : NOTHING_READ;
};

/** This function gives the exit code of `product`: 0 for Product data, `WALL` for a refusal, else `NOTHING_READ`. */
export const productCode = (result: ProductResult): number =>
  result.found ? 0 : result.wall ? WALL : NOTHING_READ;

/** This line tells how to read a held-back page. */
const HELD_BACK_LINE =
  "Add --user-provided if you gave this URL yourself. The crawler logs that read.";

/** This function gives the line of a page that needs a browser, when rendering is off. */
const renderLine = (
  notes: ReadonlyArray<string | null>,
  renderOff: string | undefined,
): string[] =>
  renderOff !== undefined && notes.some((note) => note !== null && /no browser/i.test(note))
    ? [`rendering is off: ${renderOff}`]
    : [];

/**
 * This function gives the lines of `venue`: the week of the site, and each reading with its source.
 * Then come the days where the readings disagree, the menus, the phone, the pages and the notes.
 * With `--compare`, the lines give each day of the comparison.
 */
export const describeVenue = (
  result: VenueResult,
  compare?: VenueCompare,
  renderOff?: string,
): string[] => {
  const code = venueCode(result);
  const lines = [`${code === 0 ? "✓" : "✗"} ${result.home ?? result.url}`];
  const site = result.from_site;
  const home = result.pages[0];
  if (site !== null) {
    const source = [
      `${site.from}, rank ${String(site.rank)}`,
      site.url,
      site.capture === null ? null : `capture ${site.capture}`,
    ].filter((part) => part !== null);
    lines.push(`  the site: ${site.hours}`, `  from ${source.join(", ")}`);
  } else if (result.best !== null) {
    lines.push(
      `  no reading of the site with no guess. The best reading (${result.best.from}, rank ${String(result.best.rank)}): ${result.best.hours}`,
    );
  } else if (code === WALL && home !== undefined) {
    lines.push(
      `  wall: the site refused the crawler (${home.outcome} ${String(home.status)}). The crawler does not try a different identity.`,
    );
  } else lines.push("  no opening hours found");
  if (result.readings.length > 0) {
    lines.push("readings, the best first:");
    for (const one of result.readings) lines.push(...readingLines(one));
  }
  for (const day of result.disagree) {
    const said = result.readings
      .filter((one) => one.rank <= 2 && one.week[day] !== undefined)
      .map((one) => `${dayText(one.week[day])} (rank ${String(one.rank)} ${one.from})`);
    lines.push(`the readings disagree on ${DAY_LABELS[day]}: ${said.join(" · ")}`);
  }
  if (result.menus.length > 0) {
    lines.push(
      "menus:",
      ...result.menus.map((menu) => `  ${menu.url}${menu.text === "" ? "" : `  ${menu.text}`}`),
    );
  }
  if (result.phone !== null) lines.push(`phone: ${result.phone}`);
  if (result.moved !== null) lines.push(`moved: the site now goes to ${result.moved}`);
  if (result.names_venue !== null) {
    lines.push(
      result.names_venue
        ? "names the venue: yes"
        : "names the venue: no. The domain can belong to a different business now.",
    );
  }
  if (result.held_back) {
    lines.push(
      `held back: a page asked not to be AI input, so the recipe read nothing from it. ${HELD_BACK_LINE}`,
    );
  }
  if (result.pages.length > 0)
    lines.push(`pages (${String(result.pages.length)}):`, ...result.pages.map(pageLine));
  if (compare !== undefined) {
    const comparison = compare.comparison;
    if (comparison === null || site === null) {
      lines.push(
        `compare with ${compare.file}: no reading of the site with no guess, so nothing to compare`,
      );
    } else {
      const changed =
        comparison.days.length > 0
          ? ` (${comparison.days.map((day) => DAY_LABELS[day]).join(", ")})`
          : "";
      lines.push(`compare with ${compare.file}: ${comparison.status}${changed}`);
      for (const one of compareDays(compare.kept, site.week, comparison)) {
        const text =
          one.status === "changed" || one.status === "skipped"
            ? `${dayText(one.kept)} → ${dayText(one.read)}`
            : one.status === "not read"
              ? `kept ${dayText(one.kept)}`
              : dayText(one.read);
        lines.push(`  ${DAY_LABELS[one.day]}  ${one.status.padEnd(8)}  ${text}`);
      }
    }
  }
  if (result.note !== null) lines.push(`note: ${result.note}`);
  lines.push(...renderLine([result.note], renderOff));
  return lines;
};

/** This function gives the number of digits after the decimal point of a currency: 2 for EUR, 0 for JPY. */
const fractionOf = (currency: string): number => {
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
};

/** This function writes an amount of money with its ISO 4217 code: `1,299.00 EUR`, `980 JPY`. */
export const moneyText = (money: Money): string => {
  const digits = fractionOf(money.currency);
  const amount = new Intl.NumberFormat("en", {
    minimumFractionDigits: digits,
    maximumFractionDigits: Math.max(digits, 4),
  }).format(money.amount);
  return `${amount} ${money.currency}`;
};

/**
 * This function gives the lines of `product`. They are the name, the brand and the codes, the price
 * as money, the availability, the variant, the seller, the page and the notes. A wall and a
 * held-back page say so.
 */
export const describeProduct = (result: ProductResult, renderOff?: string): string[] => {
  const code = productCode(result);
  const lines = [`${code === 0 ? "✓" : "✗"} ${result.name ?? result.url}`];
  if (result.name !== null) lines.push(`  ${result.url}`);
  if (code === WALL) {
    lines.push(
      `  wall: the shop refused the crawler (${result.outcome} ${String(result.status)}). The crawler does not try a different identity.`,
    );
  }
  if (result.held_back)
    lines.push(`  held back: the page asked not to be AI input. ${HELD_BACK_LINE}`);
  const codes = [
    result.brand === null ? null : `brand ${result.brand}`,
    result.sku === null ? null : `sku ${result.sku}`,
    result.gtin === null ? null : `gtin ${result.gtin}`,
  ].filter((part) => part !== null);
  if (codes.length > 0) lines.push(`  ${codes.join(" · ")}`);
  if (result.price !== null) {
    lines.push(
      result.price_to === null
        ? `  price ${moneyText(result.price)}`
        : `  price ${moneyText(result.price)} to ${moneyText(result.price_to)}, the range of the offers`,
    );
  }
  if (result.availability !== null) {
    lines.push(
      `  availability ${result.availability}${result.availabilities.length > 1 ? ` (the offers: ${result.availabilities.join(", ")})` : ""}`,
    );
  }
  const variant = result.variant;
  if (variant !== null) {
    const parts = [
      variant.name,
      variant.sku === null ? null : `sku ${variant.sku}`,
      variant.price === null ? null : moneyText(variant.price),
      variant.availability,
    ].filter((part) => part !== null);
    lines.push(`  variant ${parts.length > 0 ? parts.join(" · ") : "with no data"}`);
  }
  if (result.seller !== null) lines.push(`  seller ${result.seller}`);
  if (result.image !== null) lines.push(`  image ${result.image}`);
  if (result.archived !== undefined) {
    lines.push(
      `  archived copy (${result.archived.source}, captured ${result.archived.timestamp}): ${result.archived.url}`,
    );
  }
  const facts = [
    `${result.outcome} ${String(result.status)}`,
    result.doc === null ? null : `doc ${result.doc}`,
    result.capture === null ? null : `capture ${result.capture}`,
    result.rendered ? "rendered" : null,
    result.from_cache ? "from the store" : null,
  ].filter((fact) => fact !== null);
  lines.push(`  ${facts.join(" · ")}`);
  if (result.note !== null) lines.push(`  note: ${result.note}`);
  lines.push(...renderLine([result.note], renderOff).map((line) => `  ${line}`));
  return lines;
};

// ── the command `export` ────────────────────────────────────────────────────

/** These are the format and the options of an export, read from the command line before the export starts. */
export interface ExportPlan {
  readonly format: "warc" | "wacz";
  readonly options: {
    readonly out: string;
    readonly since: string | undefined;
    readonly until: string | undefined;
    readonly host: string | undefined;
    readonly urlPrefix: string | undefined;
    readonly ids: readonly string[] | undefined;
    readonly includeRefusals: boolean;
    readonly overwrite: boolean;
  };
}

/** This function checks the options of `export`, and gives its format and its options. */
export const exportPlan = (values: ExportValues): ExportPlan => {
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
  return {
    format,
    options: {
      out: file,
      since: values.since,
      until: values.until,
      host: values.host,
      urlPrefix: values.prefix,
      ids: values.id,
      includeRefusals: values["include-refusals"] === true,
      overwrite: values.overwrite === true,
    },
  };
};

/** This function gives the text of an export: the file, the counts, and what the archive left out. */
export const describeExport = (
  result: WarcResult | WaczResult,
  includeRefusals: boolean,
): string => {
  const left = [
    result.bodiless > 0 && !includeRefusals
      ? `${String(result.bodiless)} captures with no body (add --include-refusals to keep them as metadata)`
      : null,
    result.missing > 0 ? `${String(result.missing)} captures with no stored body` : null,
    result.damaged > 0 ? `${String(result.damaged)} damaged lines of the log` : null,
  ].filter((line) => line !== null);
  return [
    `wrote ${result.out} (${String(result.bytes)} bytes)`,
    `  ${String(result.captures)} captures: ${String(result.responses)} responses, ${String(result.revisits)} revisits, ${String(result.conversions)} rendered pages, ${String(result.metadata)} metadata records${result.format === "wacz" ? `, ${String(result.pages)} pages` : ""}`,
    ...(left.length > 0 ? [`  left out: ${left.join(", ")}`] : []),
  ].join("\n");
};

// ── the whole command line ──────────────────────────────────────────────────

/** These are the values of the command line, as `parseArgs` gives them. */
export type Values = ParsedArgs["values"];

/** The environment variables that the command line reads. */
export type Env = Readonly<Record<string, string | undefined>>;

/** This is a command line that is valid, read before the store opens. */
export interface Line {
  readonly command: string;
  readonly rest: readonly string[];
  readonly values: Values;
  readonly render: "auto" | "never" | "always";
  readonly rank: "exact" | "fast" | "hybrid";
  readonly limit: number;
  /** This value is the start of `read`. `diff` reads `--from` as a version (`diffFrom`). */
  readonly from: number;
  readonly length: number;
  readonly maxAge: number;
  readonly crawlLimits: CrawlLimits;
  readonly at: string | undefined;
  readonly diffFrom: VersionChoice | undefined;
  readonly diffTo: VersionChoice | undefined;
  readonly watchLine: WatchLine | undefined;
  /** These are the options of `daemon`, or undefined for a different command. */
  readonly daemonLine: DaemonLine | undefined;
  readonly extractFields: Record<string, CliField> | undefined;
  readonly exportPlan: ExportPlan | undefined;
  readonly dir: string;
  readonly contact: string | undefined;
  readonly allowPrivate: boolean;
  readonly allowUserProvided: boolean;
  /** This file is the key of `--sign-key` or `POLITE_CRAWLER_SIGN_KEY`. The command reads it after the checks. */
  readonly signKey: string | undefined;
  readonly signatureAgent: string | undefined;
  /** This value is the embedder of hybrid search, from `--embedder` or `POLITE_CRAWLER_EMBEDDER`. */
  readonly embedder: EmbedderChoice | undefined;
  /** This value is `--max-docs` of `embed`. */
  readonly maxDocs: number | undefined;
  /** These are the options of `venue` and `product`, or undefined for a different command. */
  readonly recipeLine: RecipeLine | undefined;
}

/** This is the result of `readLine`: the version, the help, or a command to do. */
export type Parsed =
  { readonly kind: "version" } | { readonly kind: "help" } | ({ readonly kind: "command" } & Line);

/**
 * This function reads the whole command line before anything opens the store. A wrong command line
 * throws a `UsageError`, so the command exits with code 2 and makes no store.
 */
export const readLine = (args: readonly string[], env: Env): Parsed => {
  const { values, positionals } = parse(args);
  if (values.version === true) return { kind: "version" };
  const [command, ...rest] = positionals;
  if (values.help === true || command === undefined) return { kind: "help" };
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
  if (rank !== "exact" && rank !== "fast" && rank !== "hybrid")
    throw new UsageError(`--rank is exact, fast or hybrid, not "${rank}"`);
  const embedder = embedderOf(values, env, command);
  if (rank === "hybrid" && embedder === undefined)
    throw new UsageError("--rank hybrid wants --embedder transformers or ollama");
  if (command === "embed" && embedder === undefined)
    throw new UsageError("embed wants --embedder transformers or ollama");
  const maxDocs =
    values["max-docs"] === undefined ? undefined : whole("max-docs", values["max-docs"], 1, 1);
  const limit = whole("limit", values.limit, 10, 1);
  // diff reads --from as a version, and read as a position
  const from = command === "read" ? whole("from", values.from, 0, 0) : 0;
  const length = whole("length", values.length, 4000, 1);
  const crawlLimits = crawlOptionsOf(values);
  const at = timeOf("at", values.at);
  const diffFrom = command === "diff" ? versionOf("from", values.from) : undefined;
  const diffTo = versionOf("to", values.to);
  const watchLine = command === "watch" ? watchLineOf(values, rest) : undefined;
  const extractFields = command === "extract" ? fieldsOf(values.field) : undefined;
  const daemonLine = command === "daemon" ? daemonLineOf(values, rest) : undefined;
  const dir = storeDir(values.dir ?? (env["POLITE_CRAWLER_DIR"] || undefined));
  const allowPrivate =
    values["allow-private"] === true || envFlag(env, "POLITE_CRAWLER_ALLOW_PRIVATE");
  const allowUserProvided =
    values["allow-user-provided"] === true ||
    ((command === "mcp" || daemonLine?.action === "run") &&
      envFlag(env, "POLITE_CRAWLER_ALLOW_USER_PROVIDED"));
  if (values["archive-despite-robots"] === true && values["archive-fallback"] !== true)
    throw new UsageError("--archive-despite-robots works only with --archive-fallback");
  // of the actions of watch, only run sends requests, so only run signs
  const signs =
    OWNER["sign-key"]!.split(" ").includes(command) &&
    (watchLine === undefined || watchLine.action === "run") &&
    (daemonLine === undefined || daemonLine.action === "run");
  const signKey =
    values["sign-key"] ?? (signs ? env["POLITE_CRAWLER_SIGN_KEY"] || undefined : undefined);
  const signatureAgent =
    values["signature-agent"] ??
    (signs ? env["POLITE_CRAWLER_SIGNATURE_AGENT"] || undefined : undefined);
  if (command === "key-directory") {
    if (signKey === undefined) throw new UsageError("key-directory wants --sign-key <file>");
  } else if ((signKey === undefined) !== (signatureAgent === undefined)) {
    throw new UsageError(
      "--sign-key and --signature-agent go together: the key signs, and the agent tells a site where its public key is",
    );
  }
  let maxAge: number;
  try {
    maxAge = durationMs(values["max-age"] ?? "24h");
  } catch (error) {
    throw new UsageError(`--max-age: ${(error as Error).message}`, { cause: error });
  }
  const recipeLine =
    command === "venue" || command === "product"
      ? recipeLineOf(command, values, rest, {
          render,
          maxAge,
          budget: values.budget === undefined ? undefined : crawlLimits.budgetMs,
        })
      : undefined;
  return {
    kind: "command",
    command,
    rest,
    values,
    render,
    rank,
    limit,
    from,
    length,
    maxAge,
    crawlLimits,
    at,
    diffFrom,
    diffTo,
    watchLine,
    daemonLine,
    extractFields,
    exportPlan: command === "export" ? exportPlan(values) : undefined,
    dir,
    contact: values.contact ?? (env["POLITE_CRAWLER_CONTACT"] || undefined),
    allowPrivate,
    allowUserProvided,
    signKey,
    signatureAgent,
    embedder,
    maxDocs,
    recipeLine,
  };
};
