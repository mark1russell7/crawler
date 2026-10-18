#!/usr/bin/env node
import type { CliField, CrawlLimits, ExportPlan, Values, WatchLine } from "./cli-line.ts";
import {
  FS_CODES,
  UsageError,
  agentTypeOf,
  describeDiscover,
  describeEntry,
  describeEvent,
  describeExport,
  describeExtract,
  describeFound,
  describePage,
  describeRead,
  describeReindex,
  describeSummary,
  describeVerify,
  describeWatchSummary,
  done,
  extractCode,
  fetchedPages,
  keyFile,
  readLine,
} from "./cli-line.ts";
import type { DiffResult } from "./diff.ts";
import type { CrawlPage } from "./frontier.ts";
import type { OpenOptions, OpenedCrawler, PoliteCrawler } from "./open.ts";
import { VERSION } from "./version.ts";
import type { WatchEntry, WatchEvent } from "./watch.ts";

// This file imports only Node.js, the version and `cli-line.ts` at start. A command loads the
// crawler, and only `mcp` and `daemon --mcp-http` load the MCP server, so `--version` and `--help`
// answer at once.

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
  polite-crawler daemon                check the watch list on a schedule, until SIGINT or SIGTERM;
                                       with --mcp-http, serve the MCP tools over local HTTP too
  polite-crawler daemon status         print the state of the daemon of the store
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
  daemon   --tick <time>     the longest wait between two ticks: 1s or more (default 1m)
           --jitter <time>   a random wait from 0 to this after each tick (default 10s)
           --tick-budget <time>  the longest time of the checks of one tick (default 10m)
           --tick-pages <n>  how many pages one tick checks at most (default 100)
           --grace <time>    at a stop, the checks in progress get this time to end (default 10s)
           --events <file>   write each change as one JSON line to this file (default: the
                             standard output)
           --on-change <command>  start this command of yours for each change: it gets the
                             event as one JSON line on its standard input
           --mcp-http        serve the MCP tools over HTTP; each request needs the bearer token
           --mcp-port <n>    the port (default 9307)
           --mcp-host <host> the host to bind (default 127.0.0.1)
           --mcp-token-file <file>  read the token from this file (default: a new token at each
                             start, in <store>/daemon/mcp-token)
           --allow-remote    permit a --mcp-host that is not loopback: read the README first
           --allow-user-provided  as for mcp
  daemon status              exit code 0 when a daemon runs on the store, 1 when none runs
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

// ---- The command `export`: the options, the checks and the work of the WARC and WACZ export ----

/**
 * This function does the command `export`, and gives the exit code. `readLine` checked the whole
 * command line first. The export only reads the store: it makes no store, and it sends no request.
 */
const exportCommand = async (plan: ExportPlan, dir: string, json: boolean): Promise<number> => {
  const result =
    plan.format === "wacz"
      ? await (await import("./wacz.ts")).exportWacz(dir, plan.options)
      : await (await import("./warc.ts")).exportWarc(dir, plan.options);
  process.stdout.write(
    `${json ? JSON.stringify(result, null, 2) : describeExport(result, plan.options.includeRefusals)}\n`,
  );
  return 0;
};

// ---- The end of the command `export` ----

// ── signed requests ──────────────────────────────────────────────────────────

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

// ── discover and crawl ──────────────────────────────────────────────────────

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
  else for (const line of describeDiscover(found)) out(line);
  return found.urls.length > 0 ? 0 : 1;
};

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

/** This function does the command `watch`, and gives the exit code. */
const runWatchCommand = async (
  crawler: OpenedCrawler,
  line: WatchLine,
  values: Values,
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
  else for (const line of describeExtract(result)) out(line);
  return extractCode(result);
};

// ── end of extract ──────────────────────────────────────────────────────────

/** This function does the command of the command line, and gives the exit code. */
const main = async (args: readonly string[]): Promise<number> => {
  const out = (text: string): void => void process.stdout.write(`${text}\n`);
  // the whole command line is valid before anything opens the store
  const line = readLine(args, process.env);
  if (line.kind === "version") {
    out(VERSION);
    return 0;
  }
  if (line.kind === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  const {
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
    extractFields,
    dir,
    signKey,
    signatureAgent,
  } = line;
  // ── signed requests: the key file opens after the checks of the command line ──
  if (command === "key-directory") return keyDirectoryCommand(keyFile(signKey!), signatureAgent);
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
  // ── end of signed requests ──
  const options: OpenOptions = {
    dir,
    contact: line.contact,
    ...(values["no-browser"] === true ? { renderer: false as const } : {}),
    ...(line.allowPrivate ? { egress: { allowPrivate: true } } : {}),
    ...(signer === undefined ? {} : { signer }),
  };

  if (command === "mcp") {
    const { startMcpServer } = await import("./mcp.ts");
    await startMcpServer({ ...options, allowUserProvided: line.allowUserProvided });
    return 0;
  }

  // ── daemon: the command loads the daemon, and the daemon loads MCP only for --mcp-http ──
  if (command === "daemon") {
    const { daemonCommand } = await import("./cli-daemon.ts");
    return daemonCommand(line.daemonLine!, options, {
      allowUserProvided: line.allowUserProvided,
      json: values.json === true,
      out,
    });
  }
  // ── end of daemon ──

  // the export only reads the store, so it opens no crawler and no index
  if (line.exportPlan !== undefined)
    return exportCommand(line.exportPlan, dir, values.json === true);

  const { openCrawler } = await import("./open.ts");
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
        const pages = fetchedPages(urls, settled, renderOff);
        print(pages, () => pages.map(describePage).join("\n"));
        return pages.every(done) ? 0 : 1;
      }
      case "find": {
        const found = await crawler.find(rest.join(" "), {
          limit,
          kind: values.kind ?? null,
          rank,
        });
        print(found, () => describeFound(found));
        return found.length === 0 ? 1 : 0;
      }
      case "read": {
        const userProvided = values["user-provided"] === true;
        const read = await crawler.read(rest[0]!, { from, length, userProvided, at });
        print(read, () => describeRead(read, at));
        return read.held_back || read.before_first === true ? 1 : 0;
      }
      case "verify": {
        const [doc, ...quote] = rest;
        const verified = await crawler.verify(doc!, quote.join(" "), { at });
        print(verified, () => describeVerify(verified));
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
        print(counts, () => describeReindex(counts));
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
