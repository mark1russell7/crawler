/**
 * The parts of part B of the eval (real sessions of Claude Code) that do no input or output: the
 * prompt of a claim, the check of the quote in an answer, the record of a session from the stream
 * of `claude -p`, and the summary of the two arms. `sessions.mts` is the command, and
 * eval/README.md tells the method.
 */
import type { Claim } from "./measure.mts";

/** This value names an arm of the eval: the tools of its sessions. */
export type Arm = "mcp" | "webfetch";
export const ARMS: readonly Arm[] = ["mcp", "webfetch"];

/** The tokens of a session, as the API counts them. */
export interface Usage {
  readonly input: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
  readonly output: number;
}

/**
 * This value tells how an answer agrees with the quote of the claim:
 *
 * - `verified`: a quote of the answer holds the quote of the claim.
 * - `partial`: a quote of the answer (20 characters or more) is a part of the quote of the claim.
 * - `wrong`: the answer has a quote, but the quote of the claim is not in it.
 * - `no-quote`: the answer has no quote between `<quote>` and `</quote>`.
 */
export type Check = "verified" | "partial" | "wrong" | "no-quote";

/** The record of one session of one arm. */
export interface SessionRecord {
  readonly id: string;
  readonly arm: Arm;
  readonly url: string;
  /** `done` when the stream has a result, `failed` when it has none, `skipped` when the budget stopped the arm first. */
  readonly status: "done" | "failed" | "skipped";
  /** The subtype of the result: `success`, or the limit that stopped the session (for example `error_max_turns`). */
  readonly subtype: string | null;
  readonly check: Check;
  readonly answer: string;
  readonly turns: number;
  readonly durationMs: number;
  readonly costUsd: number;
  /** The tokens of all the models of the session (WebFetch gives each page to a small model). */
  readonly usage: Usage;
  /** The tokens and the cost of each model. */
  readonly models: Readonly<Record<string, { readonly usage: Usage; readonly costUsd: number }>>;
  /** The tool calls of the session, by tool name. */
  readonly tools: Readonly<Record<string, number>>;
  /** The tools that the session had. */
  readonly offered: readonly string[];
  readonly denials: number;
  readonly note: string | null;
}

/** This function gives the prompt of a claim. The two arms get the same prompt. */
export const promptOf = (claim: Claim): string =>
  [
    "Find the words on this web page that answer the question, and prove the answer with an exact quote of the page.",
    "",
    `Page: ${claim.url}`,
    `Question: ${claim.question}`,
    "",
    "Copy the words of the page character for character, and put them between <quote> and </quote>.",
    "Give one quote of one or two sentences, and nothing else.",
  ].join("\n");

/** This function removes the differences that a copy of a quote can add: Unicode forms, quote marks, dashes and white space. */
export const normalize = (text: string): string =>
  text
    .normalize("NFKC")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

/** This function gives each quote of an answer: the text between `<quote>` and `</quote>`. */
export const quotesOf = (answer: string): string[] =>
  [...answer.matchAll(/<quote>([\s\S]*?)<\/quote>/g)].map((match) => (match[1] ?? "").trim());

/** This function compares the quotes of an answer with the quote of the claim. */
export const checkAnswer = (answer: string, quote: string): Check => {
  const quotes = quotesOf(answer).map(normalize);
  if (quotes.length === 0) return "no-quote";
  const want = normalize(quote);
  if (quotes.some((found) => found.includes(want))) return "verified";
  if (quotes.some((found) => found.length >= 20 && want.includes(found))) return "partial";
  return "wrong";
};

const ZERO: Usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const add = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  cacheRead: a.cacheRead + b.cacheRead,
  output: a.output + b.output,
});

/** This function gives all the tokens of a usage that the model reads: the input and the two kinds of cache. */
export const readTokens = (usage: Usage): number =>
  usage.input + usage.cacheWrite + usage.cacheRead;

type Event = Record<string, unknown>;
const record = (value: unknown): Event =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Event) : {};

/**
 * This function makes the record of a session from the stream of `claude -p --output-format
 * stream-json --verbose`: one JSON event on each line. A line that is not JSON is ignored.
 */
export const recordOf = (
  claim: Claim,
  arm: Arm,
  stream: string,
  note: string | null = null,
): SessionRecord => {
  const events: Event[] = [];
  for (const line of stream.split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(record(JSON.parse(line)));
    } catch {
      // the stream holds only JSON lines, and a part line can stay at the end of a stopped session
    }
  }
  const init = events.find((event) => event["type"] === "system" && event["subtype"] === "init");
  const result = events.findLast((event) => event["type"] === "result");
  const tools: Record<string, number> = {};
  for (const event of events) {
    if (event["type"] !== "assistant") continue;
    const content = record(event["message"])["content"];
    if (!Array.isArray(content)) continue;
    for (const block of content.map(record)) {
      if (block["type"] !== "tool_use" || typeof block["name"] !== "string") continue;
      tools[block["name"]] = (tools[block["name"]] ?? 0) + 1;
    }
  }
  const models: Record<string, { usage: Usage; costUsd: number }> = {};
  for (const [model, value] of Object.entries(record(result?.["modelUsage"]))) {
    const entry = record(value);
    models[model] = {
      usage: {
        input: num(entry["inputTokens"]),
        cacheWrite: num(entry["cacheCreationInputTokens"]),
        cacheRead: num(entry["cacheReadInputTokens"]),
        output: num(entry["outputTokens"]),
      },
      costUsd: num(entry["costUSD"]),
    };
  }
  const main = record(result?.["usage"]);
  const usage =
    Object.keys(models).length > 0
      ? Object.values(models).reduce((sum, entry) => add(sum, entry.usage), ZERO)
      : {
          input: num(main["input_tokens"]),
          cacheWrite: num(main["cache_creation_input_tokens"]),
          cacheRead: num(main["cache_read_input_tokens"]),
          output: num(main["output_tokens"]),
        };
  const answer = typeof result?.["result"] === "string" ? result["result"] : "";
  const offered = Array.isArray(init?.["tools"])
    ? init["tools"].filter((tool) => typeof tool === "string")
    : [];
  return {
    id: claim.id,
    arm,
    url: claim.url,
    status: result === undefined ? "failed" : "done",
    subtype: typeof result?.["subtype"] === "string" ? result["subtype"] : null,
    check: checkAnswer(answer, claim.quote),
    answer,
    turns: num(result?.["num_turns"]),
    durationMs: num(result?.["duration_ms"]),
    costUsd: num(result?.["total_cost_usd"]),
    usage,
    models,
    tools,
    offered,
    denials: Array.isArray(result?.["permission_denials"])
      ? result["permission_denials"].length
      : 0,
    note,
  };
};

/** This function gives the record of a claim that the budget stopped before its session. */
export const skippedRecord = (claim: Claim, arm: Arm, note: string): SessionRecord => ({
  id: claim.id,
  arm,
  url: claim.url,
  status: "skipped",
  subtype: null,
  check: "no-quote",
  answer: "",
  turns: 0,
  durationMs: 0,
  costUsd: 0,
  usage: ZERO,
  models: {},
  tools: {},
  offered: [],
  denials: 0,
  note,
});

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

/** The summary of one arm. Each number counts only the sessions with a result. */
export interface ArmSummary {
  readonly arm: Arm;
  readonly sessions: number;
  readonly failed: number;
  readonly skipped: number;
  readonly checks: Readonly<Record<Check, number>>;
  readonly costUsd: number;
  readonly medianCostUsd: number | null;
  /** The cost of the arm, divided by its verified claims. */
  readonly costPerVerifiedUsd: number | null;
  readonly usage: Usage;
  /** The median of the tokens that the model reads in a session (input and cache). */
  readonly medianReadTokens: number | null;
  readonly medianOutputTokens: number | null;
  readonly medianTurns: number | null;
  readonly toolCalls: number;
  /** The cost of the question set (`claims` sessions) at the mean cost of a session. */
  readonly projectedUsd: number | null;
}

/** This function makes the summary of each arm from the records. `claims` is the size of the whole question set. */
export const summarize = (records: readonly SessionRecord[], claims: number): ArmSummary[] =>
  ARMS.flatMap((arm) => {
    const all = records.filter((entry) => entry.arm === arm);
    if (all.length === 0) return [];
    const done = all.filter((entry) => entry.status === "done");
    const checks: Record<Check, number> = { verified: 0, partial: 0, wrong: 0, "no-quote": 0 };
    for (const entry of done) checks[entry.check] += 1;
    const costUsd = done.reduce((sum, entry) => sum + entry.costUsd, 0);
    return [
      {
        arm,
        sessions: done.length,
        failed: all.filter((entry) => entry.status === "failed").length,
        skipped: all.filter((entry) => entry.status === "skipped").length,
        checks,
        costUsd,
        medianCostUsd: median(done.map((entry) => entry.costUsd)),
        costPerVerifiedUsd: checks.verified === 0 ? null : costUsd / checks.verified,
        usage: done.reduce((sum, entry) => add(sum, entry.usage), ZERO),
        medianReadTokens: median(done.map((entry) => readTokens(entry.usage))),
        medianOutputTokens: median(done.map((entry) => entry.usage.output)),
        medianTurns: median(done.map((entry) => entry.turns)),
        toolCalls: done.reduce(
          (sum, entry) => sum + Object.values(entry.tools).reduce((a, b) => a + b, 0),
          0,
        ),
        projectedUsd: done.length === 0 ? null : (costUsd / done.length) * claims,
      },
    ];
  });

const usd = (value: number | null): string => (value === null ? "—" : `$${value.toFixed(4)}`);
const int = (value: number | null): string =>
  value === null ? "—" : Math.round(value).toLocaleString("en-US");

/** This function gives the tables of the summary in Markdown. */
export const markdownOf = (
  arms: readonly ArmSummary[],
  records: readonly SessionRecord[],
  model: string,
): string => {
  const lines = [
    "## Eval part B: real sessions of Claude Code",
    "",
    `Model: \`${model}\`. The tokens and the cost come from the usage that Claude Code reports.`,
    "",
    "| Arm | Sessions | Verified | Partial | Wrong | No quote | Failed | Skipped | Cost | Median cost | Cost per verified | Median read tokens | Median output tokens | Median turns | Projected for the set |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...arms.map(
      (arm) =>
        `| ${arm.arm} | ${String(arm.sessions)} | ${String(arm.checks.verified)} | ${String(arm.checks.partial)} | ${String(arm.checks.wrong)} | ${String(arm.checks["no-quote"])} | ${String(arm.failed)} | ${String(arm.skipped)} | ${usd(arm.costUsd)} | ${usd(arm.medianCostUsd)} | ${usd(arm.costPerVerifiedUsd)} | ${int(arm.medianReadTokens)} | ${int(arm.medianOutputTokens)} | ${int(arm.medianTurns)} | ${usd(arm.projectedUsd)} |`,
    ),
    "",
    `Total cost of this run: ${usd(arms.reduce((sum, arm) => sum + arm.costUsd, 0))}.`,
    "",
    "### Each session",
    "",
    "| Claim | Arm | Status | Check | Turns | Tool calls | Read tokens | Output tokens | Cost |",
    "| --- | --- | --- | --- | ---: | --- | ---: | ---: | ---: |",
    ...records.map((entry) => {
      const calls = Object.entries(entry.tools)
        .map(([name, count]) => `${name.replace(/^mcp__[^_]+__/, "")} ${String(count)}`)
        .join(", ");
      const status =
        entry.subtype !== null && entry.subtype !== "success"
          ? `${entry.status} (${entry.subtype})`
          : entry.status;
      return `| ${entry.id} | ${entry.arm} | ${status} | ${entry.check} | ${String(entry.turns)} | ${calls || "none"} | ${int(readTokens(entry.usage))} | ${int(entry.usage.output)} | ${usd(entry.costUsd)} |`;
    }),
  ];
  return `${lines.join("\n")}\n`;
};
