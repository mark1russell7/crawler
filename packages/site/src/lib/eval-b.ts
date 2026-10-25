/**
 * The numbers of the page "Real Claude Code sessions": eval part B of polite-crawler. The data comes
 * from src/data/eval-b.json, which scripts/eval-b-data.ts makes from the results of the runs. This
 * file gives the median cost of each claim and the claims on which polite-crawler costs less. It also
 * gives the order of the claims and the linear scale of the figure.
 */

/** The two arms of part B. Each arm gives the same prompt to the same model. */
export const ARMS = [
  { id: "mcp", label: "polite-crawler", tools: "the MCP tools of polite-crawler-mcp" },
  { id: "webfetch", label: "WebFetch", tools: "the built-in tool WebFetch" },
] as const;

export type Arm = (typeof ARMS)[number]["id"];

/** The check of the answer of a session against the quote of the claim. */
export type Check = "verified" | "partial" | "wrong" | "no-quote";

/** One session of Claude Code. */
export interface Session {
  /** The cost in USD, with each model of the session. */
  readonly usd: number;
  readonly turns: number;
  readonly check: Check;
  /** True when each quote of the answer is on the page, word for word. Null when the answer has no quote. */
  readonly onPage: boolean | null;
}

/** The summary of one arm with one model. */
export interface ArmSummary {
  readonly sessions: number;
  readonly verified: number;
  readonly partial: number;
  readonly wrong: number;
  readonly noQuote: number;
  /** The sessions with each quote of the answer on the page. */
  readonly onPage: number;
  /** The sessions that the limit of turns stopped. */
  readonly turnLimit: number;
  readonly costUsd: number;
  /** The part of the cost that the main model used. */
  readonly mainUsd: number;
  /** The part of the cost that the small model of WebFetch used. */
  readonly helperUsd: number;
  readonly medianCostUsd: number;
  readonly costPerVerifiedUsd: number;
  readonly costPerOnPageUsd: number;
  /** The median of the tokens that the models read: the input and the two kinds of cache. */
  readonly medianReadTokens: number;
  readonly medianOutputTokens: number;
  readonly medianTurns: number;
  readonly toolCalls: number;
}

/** The sessions of one model: one run of the workflow, and the run that made its summary. */
export interface ModelRun {
  /** A short id, for example "sonnet". */
  readonly id: string;
  readonly model: string;
  /** The name on the page, for example "Sonnet". */
  readonly name: string;
  /** The sessions of each claim in each arm. */
  readonly repeat: number;
  readonly run: number;
  readonly summary: number;
  readonly costUsd: number;
  readonly arms: Record<Arm, ArmSummary>;
}

/** One claim, with its sessions for each model and each arm. */
export interface SessionClaim {
  readonly id: string;
  readonly url: string;
  /** The short name of the page, for example "RFC 9110". */
  readonly page: string;
  readonly question: string;
  /** The tokens of the page as Markdown, in the count of part A. The figure uses it for the order. */
  readonly markdown: number;
  /** The sessions, by the id of the model and by the arm. */
  readonly sessions: Readonly<Record<string, Record<Arm, readonly Session[]>>>;
}

/** The data of eval part B. */
export interface EvalBData {
  /** The day of the sessions, in UTC. */
  readonly date: string;
  /** The commit of the code that made the summaries. */
  readonly commit: string;
  readonly claudeCode: string;
  readonly mcp: string;
  /** The small model that reads each page for WebFetch. */
  readonly helper: string;
  /** The cost of the whole eval: the dry run and each model. */
  readonly costUsd: number;
  readonly dryRun: { readonly run: number; readonly sessions: number; readonly costUsd: number };
  readonly models: readonly ModelRun[];
  readonly claims: readonly SessionClaim[];
}

/** This function gives the median of the values, or NaN when there is no value. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** This function gives the sessions of a claim for a model and an arm. */
export const sessionsOf = (claim: SessionClaim, model: string, arm: Arm): readonly Session[] =>
  claim.sessions[model]?.[arm] ?? [];

/** This function gives the median cost of a session of a claim, for a model and an arm. */
export const claimCost = (claim: SessionClaim, model: string, arm: Arm): number =>
  median(sessionsOf(claim, model, arm).map((session) => session.usd));

/** The median cost of polite-crawler divided by the median cost of WebFetch, for a claim. */
export const costRatio = (claim: SessionClaim, model: string): number =>
  claimCost(claim, model, "mcp") / claimCost(claim, model, "webfetch");

/** True when the median session of polite-crawler costs less than the median session of WebFetch. */
export const costsLess = (claim: SessionClaim, model: string): boolean =>
  costRatio(claim, model) < 1;

/** This function gives the claims, the shortest page first. The size of a page is its count of part A. */
export function bySize(claims: readonly SessionClaim[]): SessionClaim[] {
  return [...claims].sort((a, b) => a.markdown - b.markdown || a.id.localeCompare(b.id, "en"));
}

/** This function gives the count of the sessions with each quote of the answer on the page. */
export const onPageOf = (sessions: readonly Session[]): number =>
  sessions.filter((session) => session.onPage === true).length;

/** This function writes a ratio of costs as "2.0× more" or "1.4× less", for polite-crawler. */
export function ratioText(ratio: number): string {
  const value = ratio >= 1 ? ratio : 1 / ratio;
  return `${value.toFixed(1)}× ${ratio >= 1 ? "more" : "less"}`;
}

/** This function writes an amount of USD: "$0.0177". */
export const usd = (value: number, digits = 4): string => `$${value.toFixed(digits)}`;

/** This function writes a count of tokens: "35,628". */
export const tokens = (value: number): string => Math.round(value).toLocaleString("en-US");

/** A linear scale from 0 to `max`: it gives the place of a value in percent, from 0 to 100. */
export function linearScale(max: number): (value: number) => number {
  return (value) => {
    const place = (Math.max(0, Math.min(max, value)) / max) * 100;
    return Math.round(place * 100) / 100;
  };
}

/** The ticks of a linear axis: 0, `step`, 2 × `step` and on, to `max` or less. */
export function linearTicks(max: number, step: number): number[] {
  const ticks: number[] = [];
  for (let index = 0; index * step <= max + 1e-9; index++)
    ticks.push(Math.round(index * step * 1e6) / 1e6);
  return ticks;
}

/**
 * This function gives the next selection in a list of `count` items after a key, or undefined when
 * the key does not move the selection.
 */
export function nextIndex(key: string, now: number, count: number): number | undefined {
  const last = count - 1;
  const next: Record<string, number> = {
    ArrowUp: Math.max(0, now - 1),
    ArrowLeft: Math.max(0, now - 1),
    ArrowDown: Math.min(last, now + 1),
    ArrowRight: Math.min(last, now + 1),
    Home: 0,
    End: last,
  };
  return next[key];
}
