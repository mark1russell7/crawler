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
import type { EmbedResult } from "./hybrid.ts";
import { isLoopbackHost } from "./loopback.ts";
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

/** These options belong to one command, or to the commands that the text names. */
export const OWNER: Readonly<Record<string, string>> = {
  render: "fetch crawl watch",
  "max-age": "fetch crawl discover",
  limit: "find",
  kind: "find embed",
  rank: "find",
  from: "read diff",
  length: "read",
  "user-provided": "read extract",
  "allow-user-provided": "mcp daemon",
  ...Object.fromEntries(Object.keys(EXPORT_OPTIONS).map((option) => [option, "export"])),
  // ── discover and crawl ──
  "max-urls": "discover",
  feed: "discover",
  "max-pages": "crawl watch",
  "max-depth": "crawl",
  budget: "crawl watch embed",
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
  "sign-key": "fetch discover crawl watch mcp key-directory daemon",
  "signature-agent": "fetch discover crawl watch mcp key-directory daemon",
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
  };
};
