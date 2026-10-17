import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env, Line, Parsed } from "./cli-line.ts";
import {
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
  envFlag,
  everyText,
  exportPlan,
  extractCode,
  failedPage,
  fetchedPages,
  fieldsOf,
  keyFile,
  readLine,
  storeDir,
  timeOf,
  versionOf,
  whole,
} from "./cli-line.ts";
import type { DiscoverResult } from "./discover.ts";
import type { Found } from "./docs.ts";
import type { ExtractResult, FieldResult } from "./extract.ts";
import type { Archived } from "./fallback.ts";
import type { CrawlSummary } from "./frontier.ts";
import type { PageResult, ReadResult, VerifyResult } from "./runtime.ts";
import { removeDir, tempDir } from "./test-surfaces.ts";
import type { WatchEntry, WatchEvent, WatchSummary } from "./watch.ts";

// The command line in the test process: the checks of `readLine` and the texts of the results.
// The tests of the surfaces start the command line in a child process, and they prove the work.

const NO_ENV: Env = {};

/** This function reads a command line that must be valid, and gives its command. */
const command = (args: readonly string[], env: Env = NO_ENV): Line => {
  const parsed: Parsed = readLine(args, env);
  if (parsed.kind !== "command") throw new Error(`no command: ${parsed.kind}`);
  return parsed;
};

/** This function gives the message of the usage error of a command line. */
/** This function gives the error that a function throws, or undefined. */
const thrown = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};

/** This function gives the message of the usage error of a function. */
const usageOf = (run: () => unknown): string => {
  const error = thrown(run);
  expect(error).toBeInstanceOf(UsageError);
  return (error as Error).message;
};

const usage = (args: readonly string[], env: Env = NO_ENV): string =>
  usageOf(() => readLine(args, env));

const ARCHIVED: Archived = {
  source: "wayback",
  timestamp: "2024-01-15T09:30:00Z",
  url: "https://web.archive.org/web/20240115093000id_/https://example.com/",
  original: "https://example.com/",
};

const page = (overrides: Partial<PageResult> = {}): PageResult => ({
  ...failedPage("https://example.com/", "no response"),
  ...overrides,
});

describe("readLine: the whole command line before the store opens", () => {
  it("gives the version and the help", () => {
    expect(readLine(["--version"], NO_ENV)).toEqual({ kind: "version" });
    expect(readLine(["-v", "fetch"], NO_ENV)).toEqual({ kind: "version" });
    expect(readLine([], NO_ENV)).toEqual({ kind: "help" });
    expect(readLine(["fetch", "--help"], NO_ENV)).toEqual({ kind: "help" });
  });

  it("gives the defaults of a command", () => {
    const line = command(["find", "fresh", "bread"]);
    expect(line).toMatchObject({
      command: "find",
      rest: ["fresh", "bread"],
      render: "auto",
      rank: "exact",
      limit: 10,
      from: 0,
      length: 4000,
      maxAge: 86_400_000,
      at: undefined,
      diffFrom: undefined,
      diffTo: undefined,
      watchLine: undefined,
      extractFields: undefined,
      exportPlan: undefined,
      dir: join(homedir(), ".polite-crawler"),
      contact: undefined,
      allowPrivate: false,
      allowUserProvided: false,
      signKey: undefined,
      signatureAgent: undefined,
    });
    expect(line.crawlLimits).toEqual({
      maxUrls: 1000,
      feeds: [],
      maxPages: 100,
      maxDepth: 3,
      budgetMs: 600_000,
      include: [],
      exclude: [],
      sitemaps: false,
      allowHosts: undefined,
    });
  });

  it("reads the options of each command", () => {
    expect(command(["find", "x", "--limit", "5", "--kind", "pdf", "--rank", "fast"])).toMatchObject(
      { limit: 5, rank: "fast" },
    );
    expect(command(["read", "url:x", "--from", "12", "--length", "30"])).toMatchObject({
      from: 12,
      length: 30,
    });
    expect(
      command(["fetch", "https://a.example/", "--render", "never", "--max-age", "0"]),
    ).toMatchObject({ render: "never", maxAge: 0 });
    const crawl = command([
      "crawl",
      "https://a.example/",
      "--max-pages",
      "7",
      "--max-depth",
      "0",
      "--budget",
      "2m",
      "--include",
      "/blog/*",
      "--exclude",
      "*.pdf$",
      "--sitemaps",
      "--allow-host",
      "b.example",
    ]);
    expect(crawl.crawlLimits).toMatchObject({
      maxPages: 7,
      maxDepth: 0,
      budgetMs: 120_000,
      include: ["/blog/*"],
      exclude: ["*.pdf$"],
      sitemaps: true,
      allowHosts: ["b.example"],
    });
    expect(
      command([
        "discover",
        "https://a.example/",
        "--max-urls",
        "20",
        "--feed",
        "https://a.example/f",
      ]).crawlLimits,
    ).toMatchObject({ maxUrls: 20, feeds: ["https://a.example/f"] });
    expect(command(["verify", "url:x", "a", "quote", "--at", "2026-10-01"]).at).toBe("2026-10-01");
    expect(
      command(["extract", "url:x", "--field", "price=12:money", "--at", "2026-10-01"]),
    ).toMatchObject({
      at: "2026-10-01",
      extractFields: { price: { value: "12", kind: "money" } },
    });
  });

  it("reads the versions of diff: a capture id or a time", () => {
    expect(
      command(["diff", "url:x", "--from", "fetch.1", "--to", "2026-10-02T00:00Z"]),
    ).toMatchObject({
      from: 0,
      diffFrom: "fetch.1",
      diffTo: { at: "2026-10-02T00:00Z" },
    });
    expect(usage(["diff", "url:x", "--from", " "])).toBe("--from wants a capture id or a time");
    expect(usage(["diff", "url:x", "--to", "2026-13-45"])).toContain("--to wants a time");
    expect(usage(["read", "url:x", "--at", "yesterday"])).toContain("--at wants a time");
  });

  it("refuses a wrong command, a wrong count of arguments and an option of a different command", () => {
    expect(usage(["fly"])).toBe('no command "fly"');
    expect(usage(["read"])).toBe("read wants one document id");
    expect(usage(["read", "a", "b"])).toBe("read wants one document id");
    expect(usage(["fetch", "--bogus"])).toMatch(/Unknown option '--bogus'/);
    expect(usage(["read", "url:x", "--limit", "5"])).toBe("--limit is an option of find");
    expect(usage(["fetch", "https://a.example/", "--at", "2026-10-01"])).toBe(
      "--at is an option of read or verify or extract",
    );
    expect(usage(["find", "x", "--field", "a=b"])).toBe("--field is an option of extract");
    expect(usage(["fetch", "x", "--render", "sometimes"])).toBe(
      '--render is auto, never or always, not "sometimes"',
    );
    expect(usage(["find", "x", "--rank", "best"])).toBe('--rank is exact or fast, not "best"');
    expect(usage(["find", "x", "--limit", "many"])).toBe(
      '--limit wants a whole number, not "many"',
    );
    expect(usage(["find", "x", "--limit", "0"])).toBe("--limit wants 1 or more");
    expect(usage(["crawl", "x", "--budget", "soon"])).toMatch(/^--budget: /);
    expect(usage(["fetch", "x", "--max-age", "soon"])).toMatch(/^--max-age: /);
  });

  it("reads the store, the contact and the switches of the environment", () => {
    expect(command(["reindex", "--dir", "~"]).dir).toBe(homedir());
    expect(command(["reindex", "--dir", "~/crawl"]).dir).toBe(resolve(homedir(), "crawl"));
    expect(command(["reindex", "--dir", "crawl"]).dir).toBe(resolve("crawl"));
    expect(command(["reindex"], { POLITE_CRAWLER_DIR: "store" }).dir).toBe(resolve("store"));
    expect(usage(["reindex", "--dir", " "])).toBe("--dir wants a folder");
    expect(command(["reindex"], { POLITE_CRAWLER_CONTACT: "ops@example.com" }).contact).toBe(
      "ops@example.com",
    );
    expect(command(["reindex", "--contact", "https://example.com/bot"]).contact).toBe(
      "https://example.com/bot",
    );
    expect(command(["reindex"], { POLITE_CRAWLER_ALLOW_PRIVATE: "yes" }).allowPrivate).toBe(true);
    expect(command(["reindex", "--allow-private"]).allowPrivate).toBe(true);
    expect(usage(["reindex"], { POLITE_CRAWLER_ALLOW_PRIVATE: "maybe" })).toBe(
      'POLITE_CRAWLER_ALLOW_PRIVATE is 1 or 0, not "maybe"',
    );
    // the switch of user_provided is a switch of the MCP server only
    const flag = { POLITE_CRAWLER_ALLOW_USER_PROVIDED: "1" };
    expect(command(["mcp"], flag).allowUserProvided).toBe(true);
    expect(command(["reindex"], flag).allowUserProvided).toBe(false);
    expect(command(["mcp", "--allow-user-provided"]).allowUserProvided).toBe(true);
  });

  it("checks the archived fallback and the signed requests", () => {
    expect(usage(["fetch", "x", "--archive-despite-robots"])).toBe(
      "--archive-despite-robots works only with --archive-fallback",
    );
    expect(command(["fetch", "x", "--archive-fallback", "--archive-despite-robots"]).command).toBe(
      "fetch",
    );
    expect(usage(["fetch", "x", "--sign-key", "k.pem"])).toMatch(
      /^--sign-key and --signature-agent go together/,
    );
    expect(usage(["key-directory"])).toBe("key-directory wants --sign-key <file>");
    expect(command(["key-directory", "--sign-key", "k.pem"])).toMatchObject({
      signKey: "k.pem",
      signatureAgent: undefined,
    });
    const env = {
      POLITE_CRAWLER_SIGN_KEY: "k.pem",
      POLITE_CRAWLER_SIGNATURE_AGENT: "https://bot.example",
    };
    expect(command(["fetch", "x"], env)).toMatchObject({
      signKey: "k.pem",
      signatureAgent: "https://bot.example",
    });
    // of the actions of watch, only run sends requests, so only run reads the key of the environment
    expect(command(["watch", "run"], env).signKey).toBe("k.pem");
    expect(command(["watch", "list"], env).signKey).toBeUndefined();
    expect(command(["find", "x"], env).signKey).toBeUndefined();
    expect(usage(["watch", "add", "https://a.example/", "--sign-key", "k.pem"])).toBe(
      "--sign-key is an option of watch run",
    );
  });

  it("reads the actions of watch", () => {
    expect(
      command([
        "watch",
        "add",
        "https://a.example/",
        "https://a.example/",
        "--every",
        "2d",
        "--confirm",
        "1",
        "--label",
        "topic=bread",
        "--label",
        "lang=it",
        "--scope",
        "private",
        "--render",
        "never",
      ]).watchLine,
    ).toEqual({
      action: "add",
      urls: ["https://a.example/"],
      every: "2d",
      confirm: 1,
      labels: { topic: "bread", lang: "it" },
    });
    expect(
      command(["watch", "add", "https://a.example/", "--confirm", "2"]).watchLine?.confirm,
    ).toBe(2);
    expect(command(["watch", "run", "--budget", "1m", "--max-pages", "3"]).watchLine).toEqual({
      action: "run",
      urls: [],
      every: undefined,
      confirm: undefined,
      labels: undefined,
    });
    expect(usage(["watch", "fly"])).toBe('watch wants add, remove, list or run, not "fly"');
    expect(usage(["watch", "add"])).toBe("watch add wants at least one URL");
    expect(usage(["watch", "list", "https://a.example/"])).toBe("watch list takes no URL");
    expect(usage(["watch", "list", "--every", "2h"])).toBe("--every is an option of watch add");
    expect(usage(["watch", "add", "ftp://a.example/"])).toBe(
      'watch add wants http or https URLs, not "ftp://a.example/"',
    );
    expect(usage(["watch", "add", "https://a.example/", "--every", "10m"])).toBe(
      "--every wants 1h or more, so a watch cannot hammer a site",
    );
    expect(usage(["watch", "add", "https://a.example/", "--every", "often"])).toMatch(/^--every: /);
    expect(usage(["watch", "add", "https://a.example/", "--confirm", "3"])).toBe(
      '--confirm is 1 or 2, not "3"',
    );
    expect(usage(["watch", "add", "https://a.example/", "--label", "=x"])).toBe(
      '--label wants name=value, not "=x"',
    );
  });

  it("reads the fields of extract", () => {
    expect(fieldsOf(["price=12,50 EUR:money", "name=Forno", "when=2026-10-01:date"])).toEqual({
      price: { value: "12,50 EUR", kind: "money" },
      name: { value: "Forno" },
      when: { value: "2026-10-01", kind: "date" },
    });
    // a colon in a value stays, unless a kind follows it
    expect(fieldsOf(["link=https://example.com/a"])).toEqual({
      link: { value: "https://example.com/a" },
    });
    expect(fieldsOf(["price=12.50:json-ld:Product.offers.price"])).toEqual({
      price: { value: "12.50", kind: "json-ld:Product.offers.price" },
    });
    const wrong = (given: readonly string[] | undefined): string => usageOf(() => fieldsOf(given));
    expect(wrong(undefined)).toBe("extract wants at least one --field name=value[:kind]");
    expect(wrong(["=12"])).toBe('--field wants name=value[:kind], not "=12"');
    expect(wrong(["price=12:json-ld:"])).toContain("--field price wants a path after json-ld:");
    expect(wrong(["price= :money"])).toBe("--field price wants a value");
    expect(wrong(["a=1", "a=2"])).toBe("--field a is given two times");
    expect(usage(["extract", "url:x"])).toBe(
      "extract wants at least one --field name=value[:kind]",
    );
  });

  it("plans an export, and refuses a wrong one", () => {
    expect(command(["export", "--out", "store.wacz", "--since", "2026-10-01"]).exportPlan).toEqual({
      format: "wacz",
      options: {
        out: resolve("store.wacz"),
        since: "2026-10-01",
        until: undefined,
        host: undefined,
        urlPrefix: undefined,
        ids: undefined,
        includeRefusals: false,
        overwrite: false,
      },
    });
    expect(
      exportPlan({
        out: "~/a.bin",
        format: "warc",
        host: "example.com",
        prefix: "https://example.com/",
        id: ["c1"],
        "include-refusals": true,
        overwrite: true,
      }),
    ).toEqual({
      format: "warc",
      options: {
        out: resolve(homedir(), "a.bin"),
        since: undefined,
        until: undefined,
        host: "example.com",
        urlPrefix: "https://example.com/",
        ids: ["c1"],
        includeRefusals: true,
        overwrite: true,
      },
    });
    expect(exportPlan({ out: "~", format: "wacz" }).options.out).toBe(homedir());
    expect(exportPlan({ out: "x.WARC.GZ" }).format).toBe("warc");
    expect(usage(["export"])).toBe("export wants --out <file>");
    expect(usage(["export", "--out", "x.zip"])).toBe(
      "export wants --format warc or wacz, or a file that ends in .warc.gz or .wacz",
    );
    expect(usage(["export", "--out", "x", "--format", "zip"])).toBe(
      '--format is warc or wacz, not "zip"',
    );
    expect(usage(["export", "--out", "x.wacz", "--until", "later"])).toBe(
      '--until wants a time, such as 2026-10-01, not "later"',
    );
    expect(usage(["export", "--out", "x.wacz", "--host", "a.example/b"])).toBe(
      '--host wants a host name, such as example.com, not "a.example/b"',
    );
  });
});

describe("the small readers of the command line", () => {
  it("read whole numbers, times, versions, folders and switches", () => {
    expect(whole("limit", undefined, 10, 1)).toBe(10);
    expect(whole("limit", " 7 ", 10, 1)).toBe(7);
    expect(timeOf("at", undefined)).toBeUndefined();
    expect(versionOf("from", undefined)).toBeUndefined();
    expect(storeDir(undefined)).toBe(join(homedir(), ".polite-crawler"));
    expect(envFlag({ X: " TRUE " }, "X")).toBe(true);
    expect(envFlag({ X: "off" }, "X")).toBe(false);
    expect(envFlag({}, "X")).toBe(false);
    expect(() => envFlag({ X: "2" }, "X")).toThrow('X is 1 or 0, not "2"');
  });

  it("names the type of a signature agent", () => {
    expect(agentTypeOf("https://bot.example")).toBe("directory");
    expect(agentTypeOf("https://bot.example/")).toBe("directory");
    expect(agentTypeOf("https://example.github.io/crawler/jwks.json")).toBe("jwks_uri");
    expect(agentTypeOf("https://bot.example/?v=1")).toBe("jwks_uri");
    expect(agentTypeOf("not a url")).toBe("directory");
  });

  let work: string;
  beforeAll(async () => {
    work = await tempDir("cli-line");
    await writeFile(join(work, "key.pem"), "THE KEY");
  });
  afterAll(() => removeDir(work));

  it("reads a key file, and an error names the file and not the key", () => {
    expect(keyFile(join(work, "key.pem"))).toBe("THE KEY");
    const missing = join(work, "none.pem");
    expect(() => keyFile(missing)).toThrow(
      `--sign-key: the file ${missing} does not open (ENOENT)`,
    );
    expect(() => keyFile("~/no-such-polite-crawler-key.pem")).toThrow(
      resolve(homedir(), "no-such-polite-crawler-key.pem"),
    );
    expect(() => keyFile("~")).toThrow(UsageError);
  });

  it("gives the time between two checks in its largest whole unit", () => {
    expect(everyText(2 * 86_400_000)).toBe("2d");
    expect(everyText(5 * 3_600_000)).toBe("5h");
    expect(everyText(90 * 60_000)).toBe("90m");
  });
});

describe("the texts of the results", () => {
  it("describes the pages of fetch: a page, an archived copy, a failure and a page that needs a browser", () => {
    const fine = page({
      outcome: "ok",
      status: 200,
      doc: "url:https://example.com/",
      chars: 120,
      rendered: true,
      structured: ["Bakery"],
      note: null,
    });
    expect(describePage(fine)).toBe(
      "✓ https://example.com/\n  ok 200 · doc url:https://example.com/ · 120 chars · rendered · JSON-LD: Bakery",
    );
    const copy = page({ outcome: "refused", status: 403, archived: ARCHIVED, note: "refused" });
    expect(describePage(copy)).toBe(
      `~ https://example.com/\n  refused 403\n  archived copy (wayback, captured 2024-01-15T09:30:00Z): ${ARCHIVED.url}\n  refused`,
    );
    expect(describePage(page())).toBe("✗ https://example.com/\n  error 0\n  no response");
    expect([fine, copy, page()].map(done)).toEqual([true, true, false]);
    expect(done(page({ outcome: "not-modified" }))).toBe(true);

    const settled: Array<PromiseSettledResult<PageResult>> = [
      {
        status: "fulfilled",
        value: page({ outcome: "ok", note: "this page has no browser to render it" }),
      },
      { status: "rejected", reason: new Error("bad URL") },
      { status: "rejected", reason: "gone" },
      { status: "fulfilled", value: fine },
    ];
    const urls = [
      "https://a.example/",
      "https://b.example/",
      "https://c.example/",
      "https://d.example/",
    ];
    const pages = fetchedPages(urls, settled, "playwright-core is not installed");
    expect(pages.map((one) => one.note)).toEqual([
      "this page needs JavaScript, and rendering is off: playwright-core is not installed",
      "https://b.example/: bad URL",
      "https://c.example/: gone",
      null,
    ]);
    expect(fetchedPages(urls.slice(0, 1), settled.slice(0, 1), undefined)[0]!.note).toBe(
      "this page has no browser to render it",
    );
  });

  it("describes the results of find, read and verify", () => {
    const hit: Found = {
      doc: "url:https://example.com/",
      kind: "page",
      title: "Example",
      url: "https://example.com/",
      snippet: "fresh\n  bread",
      score: 1,
      ai_input: "unset",
      fetched_at: "2026-10-01T00:00:00.000Z",
      capture: "c1",
    };
    expect(describeFound([])).toBe("nothing stored matches");
    expect(describeFound([hit, { ...hit, doc: "archive:x", archived: ARCHIVED }])).toBe(
      "url:https://example.com/  Example\n  fresh bread\narchive:x  Example  [archived copy, captured 2024-01-15T09:30:00Z]\n  fresh bread",
    );

    const read: ReadResult = {
      doc: "url:https://example.com/",
      kind: "page",
      title: "Example",
      url: "https://example.com/",
      meta: {},
      from: 0,
      to: 5,
      total: 12,
      text: "Fresh",
      captures: ["c1"],
      capture: "c1",
      fetched_at: "2026-10-01T00:00:00.000Z",
      ai_input: "unset",
      held_back: false,
      note: null,
    };
    expect(describeRead(read, undefined)).toBe(
      "Example\nhttps://example.com/\n[0–5 of 12]\n\nFresh",
    );
    expect(describeRead({ ...read, url: null }, "2026-10-02")).toBe(
      "Example\n\n[0–5 of 12] c1 (2026-10-01T00:00:00.000Z)\n\nFresh",
    );
    expect(describeRead({ ...read, archived: ARCHIVED, note: "an archived copy" }, undefined)).toBe(
      "Example\nhttps://example.com/\nan archived copy\n[0–5 of 12]\n\nFresh",
    );
    expect(describeRead({ ...read, archived: ARCHIVED }, undefined)).toContain("\n\n[0–5");
    expect(describeRead({ ...read, held_back: true, note: "held back" }, undefined)).toBe(
      "held back\nAdd --user-provided if you gave this URL yourself. The crawler logs that read.",
    );
    expect(describeRead({ ...read, held_back: true }, undefined)).toMatch(/^\nAdd --user-provided/);
    expect(describeRead({ ...read, before_first: true, note: "no version" }, "2020-01-01")).toBe(
      "no version",
    );
    expect(describeRead({ ...read, before_first: true }, "2020-01-01")).toBe("");

    const verified: VerifyResult = {
      doc: "url:https://example.com/",
      found: true,
      start: 3,
      end: 8,
      excerpt: "Fresh",
      url: "https://example.com/",
      captures: ["c1"],
      capture: "c1",
      blob: "b1",
      fetched_at: "2026-10-01T00:00:00.000Z",
      stale: false,
      in_full_text: false,
      complete: true,
      count: 1,
      held_back: false,
      note: null,
    };
    expect(describeVerify(verified)).toBe("found at 3–8 in c1: Fresh");
    expect(
      describeVerify({
        ...verified,
        stale: true,
        archived: ARCHIVED,
        capture: null,
        excerpt: null,
      }),
    ).toBe(
      "found at 3–8 in  (an earlier capture) (an archived copy from wayback, captured 2024-01-15T09:30:00Z): ",
    );
    expect(describeVerify({ ...verified, found: false })).toBe("not found");
    expect(describeVerify({ ...verified, found: false, held_back: true })).toBe("held back");
    expect(
      describeVerify({ ...verified, found: false, before_first: true, note: "no version" }),
    ).toBe("no version");
  });

  it("describes discover, the summary of a crawl, and reindex", () => {
    const found: DiscoverResult = {
      site: "https://example.com/",
      urls: [
        {
          url: "https://example.com/a",
          lastmod: "2026-10-01T12:00:00Z",
          changefreq: null,
          via: "sitemap",
          source: "s",
        },
        { url: "https://example.com/b", lastmod: null, changefreq: null, via: "feed", source: "f" },
      ],
      sources: [
        {
          url: "https://example.com/sitemap.xml",
          via: "sitemap",
          from: "robots.txt",
          kind: "urlset",
          outcome: "ok",
          status: 200,
          capture: "c1",
          fetched_at: null,
          from_cache: false,
          entries: 1,
          urls: 1,
          truncated: false,
          note: null,
        },
        {
          url: "https://example.com/feed",
          via: "feed",
          from: "page",
          kind: null,
          outcome: "error",
          status: 500,
          capture: null,
          fetched_at: null,
          from_cache: false,
          entries: 0,
          urls: 0,
          truncated: false,
          note: "status 500",
        },
      ],
      dropped: { scope: 0, robots: 0, duplicate: 0, invalid: 0, limit: 0 },
      stopped: "done",
      note: null,
    };
    expect(describeDiscover(found)).toEqual([
      "https://example.com/a  2026-10-01",
      "https://example.com/b",
      "2 URLs from 1 of 2 files (done)",
    ]);
    expect(
      describeDiscover({ ...found, urls: [], stopped: "budget", note: "the budget ended" }),
    ).toEqual(["0 URLs from 1 of 2 files (budget: the budget ended)"]);

    const summary: CrawlSummary = {
      pages: 3,
      fetched: 2,
      from_cache: 1,
      refused: 1,
      failed: 0,
      skipped: 4,
      skips: { scope: 1, pattern: 1, depth: 1, held_back: 0, limit: 1, duplicate: 0 },
      queued: 5,
      sitemap_urls: 0,
      stopped: "max-pages",
      reason: "3 pages",
      elapsed_ms: 10,
    };
    expect(describeSummary(summary)).toBe(
      "3 pages: 2 fetched (1 from the store), 1 refused, 0 failed. 4 links not followed, 5 URLs waiting. Stopped (max-pages): 3 pages.",
    );

    const counts = {
      captures: 4,
      docs: 2,
      urls: 3,
      failed: 0,
      missing: 0,
      damaged: 0,
      carried: 0,
      unknown_recipes: [],
      errors: [],
    };
    expect(describeReindex(counts)).toBe("4 captures replayed, 2 documents, 3 URLs");
    expect(
      describeReindex({
        ...counts,
        carried: 2,
        unknown_recipes: ["menu"],
        failed: 1,
        missing: 2,
        damaged: 3,
      }),
    ).toBe(
      "4 captures replayed, 2 documents, 3 URLs\n2 documents of other recipes kept: menu\nskipped: 1 captures whose reader failed, 2 with no stored body, 3 damaged lines of the log",
    );
  });

  it("describes the watch list, its events and its summary", () => {
    const entry: WatchEntry = {
      url: "https://example.com/",
      every_ms: 86_400_000,
      render: "auto",
      confirm: 2,
      scope: null,
      labels: null,
      on_behalf_of: [],
      added_at: "2026-10-01T00:00:00.000Z",
      next_at: "2026-10-02T00:00:00.000Z",
      checked_at: null,
      last_kind: null,
      last_note: null,
      checks: 0,
      changes: 0,
      doc: null,
      capture: null,
      fetched_at: null,
      gone: false,
      pending: null,
      leased_until: null,
    };
    expect(describeEntry(entry)).toBe(
      "https://example.com/\n  every 1d · next 2026-10-02T00:00:00.000Z · not checked yet · 0 checks, 0 changes",
    );
    expect(
      describeEntry({
        ...entry,
        checked_at: "2026-10-01T12:00:00.000Z",
        checks: 1,
        pending: { kind: "changed", capture: "c2", since: "2026-10-01T12:00:00.000Z" },
      }),
    ).toBe(
      "https://example.com/\n  every 1d · next 2026-10-02T00:00:00.000Z · last check at 2026-10-01T12:00:00.000Z · 1 checks, 0 changes\n  suspected: changed since 2026-10-01T12:00:00.000Z",
    );
    expect(describeEntry({ ...entry, checked_at: "t", last_kind: "unchanged" })).toContain(
      "last unchanged at t",
    );

    const event: WatchEvent = {
      url: "https://example.com/",
      doc: "url:https://example.com/",
      kind: "changed",
      suspected: true,
      confirmed: false,
      capture: "c2",
      fetched_at: "2026-10-01T12:00:00.000Z",
      previous: "c1",
      previous_fetched_at: "2026-10-01T00:00:00.000Z",
      outcome: "ok",
      status: 200,
      diff: {
        lines_added: 2,
        lines_removed: 1,
        lines_changed: 1,
        words_added: 3,
        words_removed: 1,
        meta_changes: 0,
      },
      held_back: true,
      next_at: "2026-10-02T12:00:00.000Z",
      note: "a note",
    };
    expect(describeEvent(event)).toBe(
      "changed (suspected) https://example.com/\n  ok 200 · capture c2 · from c1 · +2 −1 lines, 0 metadata changes · held back\n  a note",
    );
    expect(
      describeEvent({
        ...event,
        kind: "unchanged",
        suspected: false,
        confirmed: true,
        previous: "c2",
        diff: null,
        held_back: false,
        note: null,
      }),
    ).toBe("unchanged (confirmed) https://example.com/\n  ok 200 · capture c2");
    expect(describeEvent({ ...event, suspected: false, capture: null, previous: null })).toMatch(
      /^changed https:\/\/example\.com\/\n {2}ok 200 · \+2/,
    );

    const summary: WatchSummary = {
      checked: 3,
      new: 1,
      changed: 1,
      unchanged: 1,
      gone: 0,
      refused: 0,
      error: 0,
      suspected: 1,
      confirmed: 0,
      due: 2,
      stopped: "max-pages",
      reason: "3 pages",
      elapsed_ms: 5,
    };
    expect(describeWatchSummary(summary)).toBe(
      "3 checked: 1 new, 1 changed, 1 unchanged, 0 gone, 0 refused, 0 errors. 1 suspected, 0 confirmed, 2 still due. Stopped (max-pages): 3 pages.",
    );
  });

  it("describes a check of fields, and gives its exit code", () => {
    const field = (overrides: Partial<FieldResult>): FieldResult => ({
      status: "verified",
      kind: "text",
      span: null,
      path: null,
      raw: null,
      excerpt: null,
      normalization: null,
      reading: null,
      count: 1,
      candidates: [],
      note: null,
      capture: "c1",
      fetched_at: "2026-10-01T00:00:00.000Z",
      ...overrides,
    });
    const result: ExtractResult = {
      doc: "url:https://example.com/",
      url: "https://example.com/",
      captures: ["c1"],
      capture: "c1",
      blob: "b1",
      fetched_at: "2026-10-01T00:00:00.000Z",
      held_back: false,
      fields: {
        name: field({ span: { start: 0, end: 5, in: "text" }, raw: "Forno" }),
        price: field({
          status: "normalized",
          kind: "money",
          span: { start: 10, end: 15, in: "full_text" },
          raw: "12,50",
          normalization: "decimal-comma",
        }),
        offer: field({
          kind: "json-ld:Product.offers.price",
          path: "jsonld[0].offers.price",
          raw: 12.5,
        }),
        when: field({
          status: "ambiguous",
          kind: "date",
          count: 2,
          candidates: [
            {
              span: { start: 20, end: 30, in: "text" },
              path: null,
              raw: "03/04/2026",
              excerpt: "e",
              readings: ["2026-03-04", "2026-04-03"],
            },
            {
              span: null,
              path: "jsonld[0].date",
              raw: "x",
              excerpt: "e",
              readings: ["2026-03-04"],
            },
            { span: null, path: null, raw: true, excerpt: "e", readings: [] },
          ],
          note: "the date has two meanings",
        }),
        gone: field({ status: "not-found", count: 0, note: "the value is not in the page" }),
      },
      summary: {
        fields: 5,
        verified: 2,
        normalized: 1,
        ambiguous: 1,
        not_found: 1,
        held_back: 0,
        invalid: 0,
      },
      note: "a note",
    };
    expect(describeExtract(result)).toEqual([
      '✓ name: verified at 0–5: "Forno"',
      '✓ price: normalized (decimal-comma) at 10–15 of the whole text: "12,50"',
      "✓ offer: verified at jsonld[0].offers.price: 12.5",
      "✗ when: ambiguous",
      '    20–30: "03/04/2026" can be 2026-03-04 or 2026-04-03',
      '    jsonld[0].date: "x" can be 2026-03-04',
      "    : true can be ",
      "    the date has two meanings",
      "✗ gone: not-found",
      "    the value is not in the page",
      "5 fields: 2 verified, 1 normalized, 1 ambiguous, 1 not found, 0 not valid, in c1. a note",
    ]);
    expect(extractCode(result)).toBe(1);
    const fine = {
      ...result,
      capture: null,
      note: null,
      fields: { name: field({}) },
      summary: { ...result.summary, fields: 1, verified: 1, normalized: 0 },
    };
    expect(describeExtract(fine)).toEqual([
      "✓ name: verified",
      "1 fields: 1 verified, 0 normalized, 1 ambiguous, 1 not found, 0 not valid, in no capture",
    ]);
    expect(extractCode(fine)).toBe(0);
    expect(extractCode({ ...fine, summary: { ...fine.summary, fields: 0, verified: 0 } })).toBe(1);
    const held = {
      ...result,
      held_back: true,
      note: null,
      fields: { name: field({ status: "held-back", note: "held back" }) },
    };
    expect(describeExtract(held)).toEqual([
      "✗ name: held-back",
      "held back\nAdd --user-provided if you gave this URL yourself. The crawler logs that check.",
    ]);
    expect(describeExtract({ ...held, note: "the page asked" }).at(-1)).toMatch(
      /^the page asked\n/,
    );
  });

  it("describes an export, with what the archive left out", () => {
    const counts = {
      captures: 5,
      responses: 3,
      revisits: 1,
      conversions: 1,
      metadata: 5,
      bodiless: 0,
      missing: 0,
      damaged: 0,
    };
    expect(
      describeExport({ ...counts, format: "warc", out: "/x.warc.gz", bytes: 100 }, false),
    ).toBe(
      "wrote /x.warc.gz (100 bytes)\n  5 captures: 3 responses, 1 revisits, 1 rendered pages, 5 metadata records",
    );
    const left = { ...counts, bodiless: 2, missing: 1, damaged: 1 };
    expect(
      describeExport({ ...left, format: "wacz", out: "/x.wacz", bytes: 9, pages: 3 }, false),
    ).toBe(
      "wrote /x.wacz (9 bytes)\n  5 captures: 3 responses, 1 revisits, 1 rendered pages, 5 metadata records, 3 pages\n  left out: 2 captures with no body (add --include-refusals to keep them as metadata), 1 captures with no stored body, 1 damaged lines of the log",
    );
    expect(describeExport({ ...left, format: "warc", out: "/x", bytes: 1 }, true)).not.toContain(
      "include-refusals",
    );
  });
});
