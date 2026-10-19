/**
 * The numbers of the page "Tokens to prove a claim": eval part A of polite-crawler. The data comes
 * from src/data/eval-a.json, which scripts/eval-data.ts makes from the result of one run of the eval.
 * This file gives the order of the claims and the running totals of a session. It also gives the
 * point from which polite-crawler stays below the WebFetch proxy, and the log scale of the figures.
 */

/** One claim: the tokens of each path, in the count of the tokenizer of the eval. */
export interface EvalClaim {
  readonly id: string;
  readonly source: string;
  readonly url: string;
  /** The short name of the page, for example "RFC 9110". */
  readonly page: string;
  readonly question: string;
  /** The place of the page in the results of `crawl_find`, or null when it is not in the first 10. */
  readonly rank: number | null;
  /** `quote`: a read window at the quote. `past-cut`: the quote is past the cut, so there is no read. */
  readonly window: string;
  readonly fetch: number;
  readonly find: number;
  readonly read: number;
  readonly verify: number;
  /** The polite-crawler path: fetch, find, read and verify. */
  readonly polite: number;
  /** An agent that reads from the start in ranges of 4,000 characters. */
  readonly paged: number;
  /** The WebFetch proxy: the page as Markdown. */
  readonly markdown: number;
  /** The visible text of the page. */
  readonly text: number;
}

/** The median and the total of one path, over the claims. */
export interface EvalTotals {
  readonly median: number;
  readonly total: number;
}

/** The data of one run of eval part A. */
export interface EvalData {
  readonly run: number;
  readonly commit: string;
  readonly date: string;
  readonly package: string;
  readonly tokenizer: string;
  readonly window: number;
  readonly archive: string;
  /** The tokens of the definitions of the tools of the MCP server: one time in each session. */
  readonly toolDefinitions: number;
  readonly summary: {
    readonly claims: number;
    readonly verified: number;
    readonly pastCut: number;
    readonly polite: EvalTotals;
    readonly paged: EvalTotals;
    readonly markdown: EvalTotals;
    readonly text: EvalTotals;
    readonly ratio: {
      readonly markdownTotal: number;
      readonly markdownMedian: number;
      readonly textTotal: number;
    };
  };
  readonly claims: readonly EvalClaim[];
}

/** The steps of the polite-crawler path, in the sequence of an agent. */
export const STEPS = [
  { key: "fetch", tool: "crawl_fetch" },
  { key: "find", tool: "crawl_find" },
  { key: "read", tool: "crawl_read" },
  { key: "verify", tool: "crawl_verify" },
] as const;

/** The orders of the claims in a session. */
export const ORDERS = [
  { id: "run", label: "As the eval ran" },
  { id: "short", label: "Short pages first" },
  { id: "long", label: "Long pages first" },
] as const;

export type Order = (typeof ORDERS)[number]["id"];

/** This function gives the claims in an order. The size of a page is its count as Markdown. */
export function ordered(claims: readonly EvalClaim[], order: Order): EvalClaim[] {
  if (order === "run") return [...claims];
  const sign = order === "short" ? 1 : -1;
  return [...claims].sort(
    (a, b) => sign * (a.markdown - b.markdown) || a.id.localeCompare(b.id, "en"),
  );
}

/** The running totals of a session after `n` claims. */
export interface SessionPoint {
  readonly n: number;
  readonly claim: EvalClaim;
  /** The polite-crawler path, with the tool definitions one time at the start. */
  readonly polite: number;
  readonly markdown: number;
}

/** This function gives the running totals of a session that proves the claims in this sequence. */
export function sessionTotals(
  claims: readonly EvalClaim[],
  toolDefinitions: number,
): SessionPoint[] {
  let polite = toolDefinitions;
  let markdown = 0;
  return claims.map((claim, index) => {
    polite += claim.polite;
    markdown += claim.markdown;
    return { n: index + 1, claim, polite, markdown };
  });
}

/**
 * This function gives the first claim from which the polite-crawler total stays below the WebFetch
 * total until the end, or undefined when it does not.
 */
export function stayAheadFrom(points: readonly SessionPoint[]): number | undefined {
  let from: number | undefined;
  for (let index = points.length - 1; index >= 0; index--) {
    const point = points[index]!;
    if (point.polite >= point.markdown) break;
    from = point.n;
  }
  return from;
}

/** True when the polite-crawler path costs more than the page as Markdown. */
export const costsMore = (claim: EvalClaim): boolean => claim.polite > claim.markdown;

/** The ratio of the page as Markdown to the polite-crawler path. */
export const ratioOf = (claim: EvalClaim): number => claim.markdown / claim.polite;

/** This function writes a ratio as "57 times fewer" or "3.6 times more". */
export function ratioText(claim: EvalClaim): string {
  const ratio = ratioOf(claim);
  const value = ratio >= 1 ? ratio : 1 / ratio;
  const shown = value >= 10 ? Math.round(value).toString() : value.toFixed(1);
  return ratio >= 1 ? `${shown} times fewer` : `${shown} times more`;
}

/** A log scale from `min` to `max`: it gives the place of a value in percent, from 0 to 100. */
export function logScale(min: number, max: number): (value: number) => number {
  const low = Math.log10(min);
  const span = Math.log10(max) - low;
  return (value) => {
    const place = ((Math.log10(Math.max(min, Math.min(max, value))) - low) / span) * 100;
    return Math.round(place * 100) / 100;
  };
}

/** The ticks of a log axis: 1, 2 and 5 of each power of ten from `min` to `max`. */
export function logTicks(min: number, max: number): number[] {
  const ticks: number[] = [];
  for (let power = 10 ** Math.floor(Math.log10(min)); power <= max; power *= 10) {
    for (const step of [1, 2, 5]) {
      const tick = step * power;
      if (tick >= min && tick <= max) ticks.push(tick);
    }
  }
  return ticks;
}

/** This function writes a count of tokens: "161,837". */
export const tokens = (value: number): string => Math.round(value).toLocaleString("en-US");

/** This function writes a tick of an axis: "500", "2k", "100k", "1M". */
export function tickText(value: number): string {
  if (value >= 1_000_000) return `${String(value / 1_000_000)}M`;
  if (value >= 1000) return `${String(value / 1000)}k`;
  return String(value);
}
