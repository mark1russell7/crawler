#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { OpenOptions, PoliteCrawler } from "./open.ts";
import type { PageResult } from "./runtime.ts";
import { VERSION } from "./version.ts";

// This file imports only Node.js and the version at start. A command loads the crawler, and only
// `mcp` loads the MCP server, so `--version` and `--help` answer at once.

const HELP = `polite-crawler ${VERSION}: fetch a source once, keep it, read it many times.

Usage:
  polite-crawler fetch <url...>        fetch pages into the store (robots.txt obeyed)
  polite-crawler find <query>          search the stored pages, with no request
  polite-crawler read <doc>            print a range of a stored document
  polite-crawler verify <doc> <quote>  check that a quote is in a stored document
  polite-crawler reindex               rebuild the search index from the capture log
  polite-crawler mcp                   serve the tools over MCP (standard input and output)

Options:
  --dir <path>       the store (default $POLITE_CRAWLER_DIR, or ~/.polite-crawler)
  --contact <text>   an email or URL for the From header ($POLITE_CRAWLER_CONTACT)
  --allow-private    fetch loopback and private addresses too ($POLITE_CRAWLER_ALLOW_PRIVATE=1)
  --no-browser       never open the headless browser
  --json             print JSON
  -v, --version      print the version
  -h, --help         print this help

  fetch    --render <mode>   auto (default), never or always
           --max-age <age>   reuse a stored copy this young: 30m, 24h (default), 7d; 0 fetches again
  find     --limit <n>       how many results (default 10)
           --kind <kind>     only this kind of document, such as page or pdf
  read     --from <n>        where the range starts (default 0)
           --length <n>      how many characters (default 4000)
           --user-provided   you gave this URL yourself: read a page that refuses AI input (logged)
  reindex                    rebuild; the documents of recipes that this command cannot read stay
  mcp      --allow-user-provided   let user_provided work when the client cannot ask you
                                   ($POLITE_CRAWLER_ALLOW_USER_PROVIDED=1)

Exit codes:
  0  done
  1  not done: a page not fetched, no match, a quote not found, a document unknown or
     held back, or an error
  2  the command line is wrong
`;

/** A usage error is a wrong command line. It exits with code 2. */
class UsageError extends Error {}

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
  from: { type: "string" },
  length: { type: "string" },
  "user-provided": { type: "boolean" },
  "allow-user-provided": { type: "boolean" },
} as const;

/** These options belong to one command. */
const OWNER: Readonly<Record<string, string>> = {
  render: "fetch",
  "max-age": "fetch",
  limit: "find",
  kind: "find",
  from: "read",
  length: "read",
  "user-provided": "read",
  "allow-user-provided": "mcp",
};

/** These are the commands, with the smallest and the largest count of arguments. */
const COMMANDS: Readonly<Record<string, { readonly min: number; readonly max: number; readonly wants: string }>> = {
  fetch: { min: 1, max: Infinity, wants: "fetch wants at least one URL" },
  find: { min: 1, max: Infinity, wants: "find wants a query" },
  read: { min: 1, max: 1, wants: "read wants one document id" },
  verify: { min: 2, max: Infinity, wants: "verify wants a document id and a quote" },
  reindex: { min: 0, max: 0, wants: "reindex takes no argument" },
  mcp: { min: 0, max: 0, wants: "mcp takes no argument" },
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
  if (!/^\s*\d+\s*$/.test(text)) throw new UsageError(`--${name} wants a whole number, not "${text}"`);
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

const describePage = (page: PageResult): string => {
  const head = `${ok(page) ? "✓" : "✗"} ${page.url}`;
  const facts = [
    `${page.outcome} ${String(page.status)}`,
    page.doc === null ? null : `doc ${page.doc}`,
    page.chars > 0 ? `${String(page.chars)} chars` : null,
    page.rendered ? "rendered" : null,
    page.structured.length > 0 ? `JSON-LD: ${page.structured.join(", ")}` : null,
  ].filter((fact) => fact !== null);
  return [head, `  ${facts.join(" · ")}`, ...(page.note === null ? [] : [`  ${page.note}`])].join("\n");
};

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
    if (values[option as keyof typeof values] !== undefined && owner !== command)
      throw new UsageError(`--${option} is an option of ${owner}`);
  }
  const render = values.render ?? "auto";
  if (render !== "auto" && render !== "never" && render !== "always")
    throw new UsageError(`--render is auto, never or always, not "${render}"`);
  const limit = whole("limit", values.limit, 10, 1);
  const from = whole("from", values.from, 0, 0);
  const length = whole("length", values.length, 4000, 1);
  const dir = storeDir(values.dir ?? (process.env["POLITE_CRAWLER_DIR"] || undefined));
  const allowPrivate = values["allow-private"] === true || envFlag("POLITE_CRAWLER_ALLOW_PRIVATE");
  const allowUserProvided =
    values["allow-user-provided"] === true ||
    (command === "mcp" && envFlag("POLITE_CRAWLER_ALLOW_USER_PROVIDED"));
  const options: OpenOptions = {
    dir,
    contact: values.contact ?? (process.env["POLITE_CRAWLER_CONTACT"] || undefined),
    ...(values["no-browser"] === true ? { renderer: false as const } : {}),
    ...(allowPrivate ? { egress: { allowPrivate: true } } : {}),
  };

  if (command === "mcp") {
    const { startMcpServer } = await import("./mcp.ts");
    await startMcpServer({ ...options, allowUserProvided });
    return 0;
  }

  const { durationMs, openCrawler } = await import("./open.ts");
  let maxAge: number;
  try {
    maxAge = durationMs(values["max-age"] ?? "24h");
  } catch (error) {
    throw new UsageError(`--max-age: ${(error as Error).message}`, { cause: error });
  }
  // only fetch renders; a missing browser turns rendering off one time, before the first page
  let renderOff: string | undefined;
  let renderer = options.renderer;
  if (command !== "fetch" || render === "never") renderer = false;
  else if (renderer === undefined) {
    const { browserMissing } = await import("./browser.ts");
    renderOff = await browserMissing();
    if (renderOff !== undefined) renderer = false;
  }

  let crawler: PoliteCrawler;
  try {
    crawler = openCrawler({ ...options, renderer });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && FS_CODES.has(code)) {
      throw new Error(`the store ${dir} does not open: it is not a folder that polite-crawler can write (${code})`, {
        cause: error,
      });
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
        const settled = await Promise.allSettled(urls.map((url) => crawler.fetch(url, { render, maxAge })));
        const pages = settled.map((result, at) => {
          const url = urls[at]!;
          if (result.status === "rejected") {
            const reason: unknown = result.reason;
            return failedPage(url, `${url}: ${reason instanceof Error ? reason.message : String(reason)}`);
          }
          const page = result.value;
          return renderOff !== undefined && page.note !== null && /no browser/i.test(page.note)
            ? { ...page, note: `this page needs JavaScript, and rendering is off: ${renderOff}` }
            : page;
        });
        print(pages, () => pages.map(describePage).join("\n"));
        return pages.every(ok) ? 0 : 1;
      }
      case "find": {
        const found = await crawler.find(rest.join(" "), { limit, kind: values.kind ?? null });
        print(found, () =>
          found.length === 0
            ? "nothing stored matches"
            : found.map((hit) => `${hit.doc}  ${hit.title}\n  ${hit.snippet.replace(/\s+/g, " ")}`).join("\n"),
        );
        return found.length === 0 ? 1 : 0;
      }
      case "read": {
        const userProvided = values["user-provided"] === true;
        const read = await crawler.read(rest[0]!, { from, length, userProvided });
        print(read, () =>
          read.held_back
            ? `${read.note ?? ""}\nAdd --user-provided if you gave this URL yourself. The crawler logs that read.`
            : `${read.title}\n${read.url ?? ""}\n[${String(read.from)}–${String(read.to)} of ${String(read.total)}]\n\n${read.text}`,
        );
        return read.held_back ? 1 : 0;
      }
      case "verify": {
        const [doc, ...quote] = rest;
        const verified = await crawler.verify(doc!, quote.join(" "));
        print(verified, () =>
          verified.found
            ? `found at ${String(verified.start)}–${String(verified.end)} in ${verified.capture ?? ""}${verified.stale ? " (an earlier capture)" : ""}: ${verified.excerpt ?? ""}`
            : verified.held_back
              ? (verified.note ?? "held back")
              : "not found",
        );
        return verified.found ? 0 : 1;
      }
      default: {
        // the documents of a recipe that this command cannot read stay, from the old index
        const counts = await crawler.reindex();
        print(counts, () =>
          [
            `${String(counts.captures)} captures replayed, ${String(counts.docs)} documents, ${String(counts.urls)} URLs`,
            ...(counts.carried > 0
              ? [`${String(counts.carried)} documents of other recipes kept: ${counts.unknown_recipes.join(", ")}`]
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
    process.stderr.write(`polite-crawler: ${message}${usage ? " (polite-crawler --help lists the commands)" : ""}\n`);
    process.exitCode = usage ? 2 : 1;
  },
);
