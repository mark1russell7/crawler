/**
 * The measurement of the eval "tokens per verified claim" (part A). It replays a WACZ file into a
 * new store, with no network, and counts the text that an agent reads to verify each claim:
 *
 * - The polite-crawler path: the MCP tools `crawl_fetch`, `crawl_find`, `crawl_read` (a fixed
 *   window around the quote) and `crawl_verify`. The count is the text of the `content` blocks of
 *   each tool result: the JSON block and the `<untrusted-web-content>` block.
 * - The WebFetch proxy: the whole page as Markdown (turndown), the text that a WebFetch-style tool
 *   gives to a model. The visible text of the page (the reader of polite-crawler, not cut) is a
 *   second proxy.
 *
 * The same WACZ file gives the same numbers at each run:
 *
 * - The replay fetches the URLs one at a time, in the order of the claims, on a clock that starts
 *   at the first capture of the archive and moves only when the crawler waits.
 * - During the tool calls, `Date.now` gives the time of that clock, so the age of each copy is
 *   the same at each run.
 * - Each tool result has a random envelope id. The count replaces it with an id of the same
 *   length from a hash of the claim and the tool.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { countTokens } from "gpt-tokenizer/encoding/cl100k_base";
import TurndownService from "turndown";
import { MockAgent } from "undici";
import type { Clock, PageResult } from "../src/index.ts";
import { decodeBody, extractPage, locate, openCrawler } from "../src/index.ts";
import { createMcpServer } from "../src/mcp.ts";
import type { Archive, ArchivedResponse } from "./archive.mts";
import { readWacz, replayKey } from "./archive.mts";

/** One claim of the question set: a page, a question about it and the quote that proves the answer. */
export interface Claim {
  readonly id: string;
  /** This value names the kind of source, for example `rfc`, `wikipedia` or `mdn`. */
  readonly source: string;
  readonly url: string;
  readonly question: string;
  readonly quote: string;
}

/** A count of text: characters (Unicode code points) and tokens of the tokenizer proxy. */
export interface Count {
  readonly chars: number;
  readonly tokens: number;
}

/**
 * This value tells where the read window of a claim is:
 *
 * - `quote`: the window holds the quote.
 * - `past-cut`: the quote is only in the whole text, past the cut of the reader (50,000
 *   characters). `crawl_read` cannot reach it, so the path has no read. The excerpt of
 *   `crawl_verify` shows the text around the quote.
 * - `no-quote`: the quote is not in the text, and the window starts at character 0.
 */
export type ReadWindow = "quote" | "past-cut" | "no-quote";

/** The result of one claim. */
export interface ClaimResult {
  readonly id: string;
  readonly source: string;
  readonly url: string;
  /** This id is the document of the page in the replay store, or null when the replay got no page. */
  readonly doc: string | null;
  /** This value is true when `crawl_verify` found the quote (`found: true`). */
  readonly verified: boolean;
  /** This text tells why the claim is not verified, or null. */
  readonly failure: string | null;
  /** This value is the place of the document of the claim in the results of `crawl_find` (1 is the first), or null. */
  readonly find_rank: number | null;
  readonly find_hits: number;
  readonly read_window: ReadWindow;
  /** These counts are the text of each tool result of the polite-crawler path, and their sum. */
  readonly polite: {
    readonly fetch: Count;
    readonly find: Count;
    readonly read: Count;
    readonly verify: Count;
    readonly total: Count;
  };
  /** This count is the same path, with reads from character 0 in ranges of `pageLength` until a range holds the quote. */
  readonly paged: Count & { readonly reads: number };
  /** These counts are the two proxies of the WebFetch way. `quote_found` tells if the quote is in the Markdown. */
  readonly webfetch: {
    readonly markdown: Count & { readonly quote_found: boolean };
    readonly text: Count;
  };
}

/** The statistics of one path over the verified claims. */
export interface PathSummary {
  readonly median: Count;
  readonly total: Count;
}

/** The summary of a run. Each value is over the verified claims only. */
export interface Summary {
  readonly claims: number;
  readonly verified: number;
  readonly failed: number;
  /** This value is the count of verified claims whose quote is past the cut of the reader (`past-cut`). */
  readonly past_cut: number;
  readonly polite: PathSummary;
  readonly paged: PathSummary;
  readonly markdown: PathSummary;
  readonly text: PathSummary;
  /** Each ratio divides the tokens of a WebFetch proxy by the tokens of a polite-crawler path. */
  readonly ratio: {
    /** The total tokens of the Markdown proxy, divided by the total tokens of the polite-crawler path. */
    readonly markdown_total: number | null;
    /** The median of the ratio of each claim (Markdown proxy over polite-crawler path). */
    readonly markdown_median: number | null;
    /** The total tokens of the visible-text proxy, divided by the total tokens of the polite-crawler path. */
    readonly text_total: number | null;
    /** The total tokens of the Markdown proxy, divided by the total tokens of the paged path. */
    readonly markdown_over_paged_total: number | null;
  };
}

/** The result of a measurement. A run writes it as JSON. */
export interface Measurement {
  readonly tokenizer: string;
  readonly window: number;
  readonly page_length: number;
  readonly archive: {
    readonly sha256: string;
    readonly software: string | null;
    readonly responses: number;
    readonly redirects: number;
    readonly start: string;
  };
  /** This count is the tool list and the instructions of the MCP server: a cost of one time in each session. */
  readonly tool_definitions: Count;
  /** These are the outcomes of the replay fetch of each URL. */
  readonly replay: ReadonlyArray<{
    readonly url: string;
    readonly outcome: string;
    readonly status: number;
    readonly doc: string | null;
    readonly note: string | null;
  }>;
  readonly claims: readonly ClaimResult[];
  readonly summary: Summary;
}

/** These options control a measurement. */
export interface MeasureOptions {
  /** This file is the WACZ file to replay. */
  readonly wacz: string;
  readonly claims: readonly Claim[];
  /** This value is the length of the read window around the quote, in characters. The default is 2000. */
  readonly window?: number | undefined;
  /** This value is the length of one range of the paged path. The default is 4000, the default of `crawl_read`. */
  readonly pageLength?: number | undefined;
}

/** This text names the tokenizer proxy. */
export const TOKENIZER = "cl100k_base (gpt-tokenizer): a proxy, not the tokenizer of Claude";

/** These product tokens get their robots.txt rules applied, as the MCP server applies them. */
const ON_BEHALF_OF = ["Claude-User"];

const SURROGATE_PAIR = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
const NO_SPECIAL = { disallowedSpecial: new Set<string>() };

/** This function counts the characters (code points) and the tokens of a text. */
export const countText = (text: string): Count => ({
  chars: text.length - (text.match(SURROGATE_PAIR)?.length ?? 0),
  tokens: countTokens(text, NO_SPECIAL),
});

const ZERO: Count = { chars: 0, tokens: 0 };
const plus = (...counts: readonly Count[]): Count => ({
  chars: counts.reduce((sum, count) => sum + count.chars, 0),
  tokens: counts.reduce((sum, count) => sum + count.tokens, 0),
});

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const pathOf = (counts: readonly Count[]): PathSummary => ({
  median: {
    chars: median(counts.map((count) => count.chars)),
    tokens: median(counts.map((count) => count.tokens)),
  },
  total: plus(...counts),
});

const ratioOf = (over: number, under: number): number | null =>
  under === 0 ? null : Math.round((over / under) * 100) / 100;

/** This function reads and checks a question set: the claims must have unique ids, an http URL, a question and a quote. */
export const readClaims = (json: string): Claim[] => {
  const parsed = JSON.parse(json) as { claims?: unknown };
  if (!Array.isArray(parsed.claims) || parsed.claims.length === 0) {
    throw new Error("the question set has no claims: give an object with a list claims");
  }
  const seen = new Set<string>();
  return parsed.claims.map((item: unknown, at) => {
    const claim = item as Partial<Record<keyof Claim, unknown>>;
    const where = `claim ${String(at + 1)}`;
    for (const field of ["id", "source", "url", "question", "quote"] as const) {
      if (typeof claim[field] !== "string" || claim[field].trim() === "") {
        throw new Error(`${where} has no ${field}`);
      }
    }
    const id = claim.id as string;
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`${where}: the id ${id} is not lowercase-kebab`);
    if (seen.has(id)) throw new Error(`${where}: the id ${id} is not unique`);
    seen.add(id);
    if (!/^https?:\/\//.test(claim.url as string)) throw new Error(`${where}: the URL is not http`);
    if ((claim.quote as string).trim().length < 3) throw new Error(`${where}: the quote is short`);
    return {
      id,
      source: claim.source as string,
      url: claim.url as string,
      question: claim.question as string,
      quote: claim.quote as string,
    };
  });
};

/** This function gives a clock that starts at a time and moves only when the crawler waits. */
const replayClock = (start: number): Clock => {
  let now = start;
  return {
    now: () => now,
    sleep: (ms) => {
      now += Math.max(0, ms);
      return Promise.resolve();
    },
  };
};

const DROPPED_HEADERS: ReadonlySet<string> = new Set([
  "content-encoding",
  "transfer-encoding",
  "connection",
]);

/** This function gives a mock agent that answers each request from the archive, and refuses the network. */
const replayAgent = (archive: Archive, urls: readonly string[]): MockAgent => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const origins = new Set<string>();
  for (const url of [
    ...urls,
    ...[...archive.responses.values()].map((page) => page.url),
    ...[...archive.redirects.values()].map((redirect) => redirect.url),
  ]) {
    origins.add(new URL(url).origin);
  }
  for (const origin of origins) {
    agent
      .get(origin)
      .intercept({ path: () => true, method: "GET" })
      .reply((request) => {
        const key = replayKey(`${origin}${request.path}`);
        const page = archive.responses.get(key);
        if (page !== undefined) {
          const headers: Record<string, string | string[]> = {};
          for (const [name, value] of page.headers) {
            const lower = name.toLowerCase();
            if (DROPPED_HEADERS.has(lower)) continue;
            const earlier = headers[lower];
            headers[lower] =
              earlier === undefined
                ? value
                : [...(Array.isArray(earlier) ? earlier : [earlier]), value];
          }
          return { statusCode: page.status, data: page.body, responseOptions: { headers } };
        }
        const redirect = archive.redirects.get(key);
        if (redirect !== undefined) {
          return {
            statusCode: redirect.status,
            data: "",
            responseOptions: { headers: { location: redirect.location } },
          };
        }
        return {
          statusCode: 404,
          data: "This URL is not in the archive.",
          responseOptions: { headers: { "content-type": "text/plain; charset=utf-8" } },
        };
      })
      .persist();
  }
  return agent;
};

/** This function follows the redirects of the archive from a URL, and gives the response at the end. */
const finalResponse = (archive: Archive, url: string): ArchivedResponse | undefined => {
  let current = url;
  for (let hops = 0; hops < 10; hops += 1) {
    const key = replayKey(current);
    const page = archive.responses.get(key);
    if (page !== undefined) return page;
    const redirect = archive.redirects.get(key);
    if (redirect === undefined) return undefined;
    current = new URL(redirect.location, current).href;
  }
  return undefined;
};

const headerOf = (page: ArchivedResponse, name: string): string | null =>
  page.headers.find(([field]) => field.toLowerCase() === name)?.[1] ?? null;

/** The Markdown converter of the WebFetch proxy: turndown with its defaults, with no script, style, noscript or template. */
const markdownOf = (html: string): string => {
  const service = new TurndownService();
  service.remove(["script", "style", "noscript", "template"]);
  return service.turndown(html);
};

const ENVELOPE_ID = /<\/untrusted-web-content id="([0-9a-f]{8})">/;

/** This function replaces the random envelope id of a tool result with an id from a hash of a seed. */
const steady = (text: string, seed: string): string => {
  const match = ENVELOPE_ID.exec(text);
  if (match?.[1] === undefined) return text;
  const id = createHash("sha256").update(seed).digest("hex").slice(0, 8);
  return text.replaceAll(match[1], id);
};

interface Called {
  readonly count: Count;
  readonly structured: Record<string, unknown>;
  readonly error: boolean;
}

/**
 * This function replays a WACZ file into a new store and measures each claim. It sends no request
 * to the network: the mock agent answers each request from the archive, and refuses each other request.
 */
export const measure = async (options: MeasureOptions): Promise<Measurement> => {
  const window = options.window ?? 2000;
  const pageLength = options.pageLength ?? 4000;
  if (!Number.isInteger(window) || window < 100 || window > 20_000) {
    throw new RangeError("the window is a whole number of characters from 100 to 20000");
  }
  if (!Number.isInteger(pageLength) || pageLength < 100 || pageLength > 20_000) {
    throw new RangeError("the page length is a whole number of characters from 100 to 20000");
  }
  const bytes = await readFile(options.wacz);
  const archive = await readWacz(options.wacz);
  const urls = [...new Set(options.claims.map((claim) => claim.url))];
  const agent = replayAgent(archive, urls);
  const clock = replayClock(archive.start);
  const dir = await mkdtemp(join(tmpdir(), "polite-crawler-eval-replay-"));
  const crawler = openCrawler({
    dir,
    renderer: false,
    dispatcher: agent,
    clock,
    random: () => 0.5,
  });
  const realNow = Date.now;
  try {
    // the replay: one URL at a time, so the clock and the capture ids are the same at each run
    const pages = new Map<string, PageResult>();
    for (const url of urls) {
      pages.set(url, await crawler.fetch(url, { onBehalfOf: ON_BEHALF_OF, render: "never" }));
    }

    const server = createMcpServer(crawler, { onBehalfOf: ON_BEHALF_OF });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "polite-crawler-eval", version: "1" });
    await client.connect(clientSide);
    // the age of a copy in a tool result comes from Date.now: the replay clock makes it the same at each run
    Date.now = () => clock.now();
    try {
      const listed = await client.listTools();
      const tool_definitions = countText(
        `${client.getInstructions() ?? ""}\n${JSON.stringify(listed.tools)}`,
      );

      const call = async (
        name: string,
        args: Record<string, unknown>,
        seed: string,
      ): Promise<Called> => {
        const result = await client.callTool({ name, arguments: args });
        const blocks = (result.content as Array<{ type: string; text?: string }>)
          .filter((block) => block.type === "text")
          .map((block) => block.text ?? "");
        return {
          count: countText(steady(blocks.join("\n"), `${seed}/${name}`)),
          structured: (result.structuredContent ?? {}) as Record<string, unknown>,
          error: result.isError === true,
        };
      };

      // the claims run one at a time, and each claim reads the store only
      const measureClaim = async (claim: Claim): Promise<ClaimResult> => {
        const page = pages.get(claim.url)!;
        const archived = finalResponse(archive, claim.url);
        let markdown: Count & { quote_found: boolean } = { ...ZERO, quote_found: false };
        let text = ZERO;
        if (archived !== undefined) {
          const html = decodeBody(archived.body, headerOf(archived, "content-type"));
          const converted = markdownOf(html);
          const extracted = extractPage(html, archived.url);
          markdown = { ...countText(converted), quote_found: locate(converted, claim.quote).found };
          text = countText(extracted.fullText ?? extracted.text);
        }
        const empty = {
          id: claim.id,
          source: claim.source,
          url: claim.url,
          doc: page.doc,
          find_rank: null,
          find_hits: 0,
          read_window: "no-quote" as const,
          polite: { fetch: ZERO, find: ZERO, read: ZERO, verify: ZERO, total: ZERO },
          paged: { ...ZERO, reads: 0 },
          webfetch: { markdown, text },
        };
        if (page.doc === null) {
          const why = [page.outcome, page.status === 0 ? "" : String(page.status), page.note ?? ""];
          return {
            ...empty,
            verified: false,
            failure: `no page: ${why.filter((part) => part !== "").join(", ")}`,
          };
        }
        const doc = page.doc;
        // the library check gives the span of the quote, to place the read window. It is not counted.
        const span = await crawler.verify(doc, claim.quote);

        const fetched = await call("crawl_fetch", { urls: [claim.url] }, claim.id);
        const found = await call("crawl_find", { q: claim.question }, claim.id);
        const hits = Array.isArray(found.structured["hits"])
          ? (found.structured["hits"] as Array<{ doc?: unknown }>)
          : [];
        const rank = hits.findIndex((hit) => hit.doc === doc);

        // crawl_read reads the text of the index, and the reader cuts that text at 50,000 characters.
        // crawl_verify also examines the whole text: a quote past the cut is verified, but not readable.
        const readWindow: ReadWindow = !span.found
          ? "no-quote"
          : span.in_full_text
            ? "past-cut"
            : "quote";
        let read = ZERO;
        if (readWindow !== "past-cut") {
          const total = (await crawler.read(doc, { length: 1 })).total;
          let from = 0;
          let length = window;
          if (span.start !== null && span.end !== null) {
            length = Math.min(20_000, Math.max(window, span.end - span.start + 200));
            from = Math.max(0, span.start - Math.floor((length - (span.end - span.start)) / 2));
            if (from + length > total) from = Math.max(0, total - length);
          }
          read = (await call("crawl_read", { doc, from, length }, claim.id)).count;
        }

        // the paged path reads from the start until a range holds the end of the quote, or to the end
        const ranges: Count[] = [];
        const end =
          readWindow === "quote" && span.end !== null ? span.end : Number.POSITIVE_INFINITY;
        for (let at = 0; ; at += pageLength) {
          const part = await call(
            "crawl_read",
            { doc, from: at, length: pageLength },
            `${claim.id}/${String(at)}`,
          );
          ranges.push(part.count);
          const next = part.structured["next_from"];
          if (at + pageLength >= end || typeof next !== "number") break;
        }

        const verified = await call("crawl_verify", { doc, quote: claim.quote }, claim.id);
        const ok = verified.structured["found"] === true;
        const failure = ok
          ? null
          : verified.error
            ? "crawl_verify gave an error"
            : `the quote is not in the stored text${span.held_back ? " (the page is held back)" : ""}`;
        const polite = {
          fetch: fetched.count,
          find: found.count,
          read,
          verify: verified.count,
          total: plus(fetched.count, found.count, read, verified.count),
        };
        return {
          ...empty,
          doc,
          verified: ok,
          failure,
          find_rank: rank === -1 ? null : rank + 1,
          find_hits: hits.length,
          read_window: readWindow,
          polite,
          paged: {
            ...plus(fetched.count, found.count, ...ranges, verified.count),
            reads: ranges.length,
          },
        };
      };

      const claims: ClaimResult[] = [];
      for (const claim of options.claims) claims.push(await measureClaim(claim));

      const good = claims.filter((claim) => claim.verified);
      const politeCounts = good.map((claim) => claim.polite.total);
      const markdownCounts = good.map((claim) => claim.webfetch.markdown);
      const polite = pathOf(politeCounts);
      const paged = pathOf(good.map((claim) => claim.paged));
      const markdown = pathOf(markdownCounts.map(({ chars, tokens }) => ({ chars, tokens })));
      const text = pathOf(good.map((claim) => claim.webfetch.text));
      const summary: Summary = {
        claims: claims.length,
        verified: good.length,
        failed: claims.length - good.length,
        past_cut: good.filter((claim) => claim.read_window === "past-cut").length,
        polite,
        paged,
        markdown,
        text,
        ratio: {
          markdown_total: ratioOf(markdown.total.tokens, polite.total.tokens),
          markdown_median:
            good.length === 0
              ? null
              : ratioOf(
                  median(
                    good.map(
                      (claim) =>
                        claim.webfetch.markdown.tokens / Math.max(1, claim.polite.total.tokens),
                    ),
                  ),
                  1,
                ),
          text_total: ratioOf(text.total.tokens, polite.total.tokens),
          markdown_over_paged_total: ratioOf(markdown.total.tokens, paged.total.tokens),
        },
      };
      await client.close();
      await server.close();
      return {
        tokenizer: TOKENIZER,
        window,
        page_length: pageLength,
        archive: {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          software: archive.software,
          responses: archive.responses.size,
          redirects: archive.redirects.size,
          start: new Date(archive.start).toISOString(),
        },
        tool_definitions,
        replay: urls.map((url) => {
          const page = pages.get(url)!;
          return {
            url,
            outcome: page.outcome,
            status: page.status,
            doc: page.doc,
            note: page.note,
          };
        }),
        claims,
        summary,
      };
    } finally {
      Date.now = realNow;
    }
  } finally {
    await crawler.close();
    await agent.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
};

const number = (value: number): string => Math.round(value).toLocaleString("en-US");
const times = (value: number | null): string => (value === null ? "n/a" : `${value.toFixed(2)}`);

/** This function writes the summary of a measurement as Markdown, for the page of a run. */
export const markdownSummary = (
  result: Measurement,
  context: { readonly mode: string; readonly commit: string | null; readonly wacz: string },
): string => {
  const { summary } = result;
  const row = (label: string, path: PathSummary): string =>
    `| ${label} | ${number(path.median.tokens)} | ${number(path.total.tokens)} | ${number(path.median.chars)} | ${number(path.total.chars)} |`;
  const lines = [
    "## Tokens per verified claim",
    "",
    `${String(summary.verified)} of ${String(summary.claims)} claims are verified (\`crawl_verify\` found the quote). The numbers below are over the verified claims.`,
    "",
    "| Path | Median tokens | Total tokens | Median characters | Total characters |",
    "| --- | ---: | ---: | ---: | ---: |",
    row(
      `polite-crawler: fetch, find, read of ${number(result.window)} characters, verify`,
      summary.polite,
    ),
    row(
      `polite-crawler, reads from the start in ranges of ${number(result.page_length)}`,
      summary.paged,
    ),
    row("WebFetch proxy: the page as Markdown (turndown)", summary.markdown),
    row("The page as visible text (the reader of polite-crawler)", summary.text),
    "",
    `- The Markdown proxy has ${times(summary.ratio.markdown_total)} times the tokens of the polite-crawler path (the ratio of the totals). The median ratio of one claim is ${times(summary.ratio.markdown_median)}.`,
    `- The visible text has ${times(summary.ratio.text_total)} times the tokens of the polite-crawler path. The Markdown proxy has ${times(summary.ratio.markdown_over_paged_total)} times the tokens of the path that reads from the start.`,
    `- ${String(summary.past_cut)} verified claims have the quote past the cut of the reader (50,000 characters). \`crawl_read\` cannot reach such a quote, so their path has no read: the excerpt of \`crawl_verify\` shows the text around it.`,
    `- The tool definitions of the MCP server are ${number(result.tool_definitions.tokens)} tokens, one time in each session. The table does not include them.`,
    `- Tokenizer: ${result.tokenizer}. Mode: ${context.mode}. Commit: ${context.commit ?? "unknown"}.`,
    `- Archive: \`${context.wacz}\`, SHA-256 \`${result.archive.sha256.slice(0, 16)}\`, ${String(result.archive.responses)} responses, first capture ${result.archive.start}.`,
    "",
  ];
  const failed = result.claims.filter((claim) => !claim.verified);
  if (failed.length > 0) {
    lines.push(
      "### Claims that are not verified",
      "",
      "| Claim | URL | Reason |",
      "| --- | --- | --- |",
      ...failed.map((claim) => `| \`${claim.id}\` | ${claim.url} | ${claim.failure ?? ""} |`),
      "",
    );
  }
  lines.push(
    "### Each claim",
    "",
    "| Claim | Source | Verified | polite-crawler tokens | Markdown tokens | Ratio | Rank in find | Read window |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | --- |",
    ...result.claims.map(
      (claim) =>
        `| \`${claim.id}\` | ${claim.source} | ${claim.verified ? "yes" : "no"} | ${number(claim.polite.total.tokens)} | ${number(claim.webfetch.markdown.tokens)} | ${claim.polite.total.tokens === 0 ? "n/a" : times(claim.webfetch.markdown.tokens / claim.polite.total.tokens)} | ${claim.find_rank === null ? "none" : String(claim.find_rank)} | ${claim.read_window} |`,
    ),
    "",
  );
  return lines.join("\n");
};
