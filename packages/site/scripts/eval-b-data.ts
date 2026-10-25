// The data of the page "Real Claude Code sessions" (src/data/eval-b.json). The script reads the result
// of each run of eval part B (eval-b-result.json, in the artifact `eval-b` of the workflow
// eval-sessions.yml) and the result of each dry run. It takes the page names, the questions and the
// size of each page from the data of part A (src/data/eval-a.json), and it writes only what the page
// shows.
//
// Each `--version` starts the options of one version of polite-crawler-mcp: its day, its Claude Code,
// its dry run and the result of each model. Give the versions the earliest first. To refresh the page
// after a new run of part B, add a version, or replace the options of a version:
//
//   gh run download <summary run id> -R mark1russell7/crawler -n eval-b -D <dir>
//   pnpm exec tsx packages/site/scripts/eval-b-data.ts \
//     --version <mcp version> --date <YYYY-MM-DD> --claude-code <version> \
//       --dry <dry run dir>/eval-b-result.json --dry-run <dry run id> \
//       --result <sonnet dir>/eval-b-result.json --run <sessions run id> --summary <summary run id> \
//       --result <opus dir>/eval-b-result.json --run <sessions run id> --summary <summary run id> \
//     --version <next mcp version> ...
//
// The data came from these runs, with Claude Code 2.1.296:
//
// - polite-crawler-mcp 0.2.1, 2026-10-25: Sonnet 40153411428 (summary 40155103977), Opus 40154501047
//   (summary 40155110580) and the dry run 40152547898.
// - polite-crawler-mcp 0.2.3, 2026-10-25: Sonnet 40163619030 (the arms mcp and mcp-quote, with its
//   own summary) and the dry run 40163467327.
//
// A run with no WebFetch arm gets the WebFetch arm of the run of the same model with an earlier
// version (`webfetchFrom`). The script fails when a session failed or was skipped, when a claim of
// part A has no sessions, when a summary does not agree with its sessions, or when the prices do not
// give the cost of a session.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  Arm,
  ArmSummary,
  ByKind,
  Check,
  EvalBData,
  Run,
  Session,
  SessionClaim,
  Version,
} from "../src/lib/eval-b.ts";
import { ARMS, median } from "../src/lib/eval-b.ts";

interface ResultRecord {
  readonly id: string;
  readonly arm: Arm;
  readonly rep: number;
  readonly url: string;
  readonly status: string;
  readonly subtype: string;
  readonly check: Check;
  readonly onPage: boolean | null;
  readonly turns: number;
  readonly costUsd: number;
  readonly usage: ByKind;
  readonly models: Record<string, { readonly usage: ByKind; readonly costUsd: number }>;
}

interface ResultArm {
  readonly arm: Arm;
  readonly sessions: number;
  readonly failed: number;
  readonly skipped: number;
  readonly checks: Record<Check, number>;
  readonly onPage: number;
  readonly costUsd: number;
  readonly medianCostUsd: number;
  readonly costPerVerifiedUsd: number;
  readonly costPerOnPageUsd: number;
  readonly medianReadTokens: number;
  readonly medianOutputTokens: number;
  readonly medianTurns: number;
  readonly toolCalls: number;
}

interface Result {
  readonly commit: string;
  readonly model: string;
  readonly claims: number;
  readonly costUsd: number;
  readonly arms: readonly ResultArm[];
  readonly records: readonly ResultRecord[];
}

interface PartA {
  readonly claims: ReadonlyArray<{
    readonly id: string;
    readonly url: string;
    readonly page: string;
    readonly question: string;
    readonly markdown: number;
  }>;
}

/**
 * The prices that Claude Code used for the cost of each session, in USD for one million tokens. The
 * script checks the cost of each model of each session against them. A kind of token with no price
 * must have no tokens.
 */
const PRICES: Readonly<Record<string, Partial<ByKind>>> = {
  "claude-sonnet-5-5": { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 },
  "claude-opus-5-5": { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};
const KINDS = ["input", "cacheWrite", "cacheRead", "output"] as const;

const usage =
  "usage: tsx packages/site/scripts/eval-b-data.ts (--version <mcp version> --date <YYYY-MM-DD> --claude-code <version> --dry <eval-b-result.json> --dry-run <id> (--result <eval-b-result.json> --run <id> --summary <id>)...)... [--out <file>]";

const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};
const runId = (value: string | undefined): number =>
  value !== undefined && /^\d+$/.test(value) ? Number(value) : fail(usage);

/** Each value of an option in a part of the command line, in sequence. */
const optionsIn = (args: readonly string[], name: string): string[] =>
  args.flatMap((arg, at) => (arg === name ? [args[at + 1] ?? ""] : []));

const argv = process.argv.slice(2);
const out =
  optionsIn(argv, "--out")[0] ?? fileURLToPath(new URL("../src/data/eval-b.json", import.meta.url));

/** The parts of the command line: each part starts at a `--version`. */
const groups: string[][] = [];
for (const arg of argv) {
  if (arg === "--version") groups.push([]);
  groups.at(-1)?.push(arg);
}
if (groups.length === 0) fail(usage);

const partAFile = fileURLToPath(new URL("../src/data/eval-a.json", import.meta.url));
const partA = JSON.parse(readFileSync(partAFile, "utf8")) as PartA;
const read = (file: string): Result => JSON.parse(readFileSync(file, "utf8")) as Result;

/** Money to the micro-dollar, so that the file stays short. The page shows four places. */
const micro = (value: number): number => Math.round(value * 1e6) / 1e6;

/** This function gives the short id and the name of a model: "claude-sonnet-5-5" gives "sonnet". */
const nameOf = (model: string): { id: string; name: string } => {
  const match = /^claude-([a-z]+)-/.exec(model);
  if (match === null) throw new Error(`${model}: not a name of a Claude model`);
  const id = match[1]!;
  return { id, name: `${id.charAt(0).toUpperCase()}${id.slice(1)}` };
};

/** This function compares two versions "x.y.z". */
const compareVersions = (a: string, b: string): number => {
  const parts = (value: string): number[] => value.split(".").map(Number);
  const [left, right] = [parts(a), parts(b)];
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

const ZERO: ByKind = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
const kindsOf = (make: (kind: (typeof KINDS)[number]) => number): ByKind => ({
  input: make("input"),
  cacheWrite: make("cacheWrite"),
  cacheRead: make("cacheRead"),
  output: make("output"),
});

/** This function gives the cost of the tokens of a model for each kind, and checks the sum against the cost. */
const costByKind = (model: string, part: { usage: ByKind; costUsd: number }, where: string) => {
  const prices = PRICES[model] ?? fail(`${where}: no price for ${model}`);
  const cost = kindsOf((kind) => {
    const price = prices[kind];
    if (price === undefined) {
      if (part.usage[kind] !== 0) fail(`${where}: ${model} has ${kind} tokens and no price`);
      return 0;
    }
    return (part.usage[kind] * price) / 1e6;
  });
  const total = KINDS.reduce((sum, kind) => sum + cost[kind], 0);
  if (Math.abs(total - part.costUsd) > 1e-9)
    fail(`${where}: the prices of ${model} give ${String(total)} USD, not ${String(part.costUsd)}`);
  return cost;
};

const helpers = new Set<string>();

/** This function gives the summary of one arm, and checks it against the records of its sessions. */
const armOf = (result: Result, arm: ResultArm): ArmSummary => {
  const where = `${result.model} ${arm.arm}`;
  if (arm.failed > 0 || arm.skipped > 0)
    throw new Error(`${where}: ${String(arm.failed)} failed, ${String(arm.skipped)} skipped`);
  const records = result.records.filter((record) => record.arm === arm.arm);
  if (records.length !== arm.sessions)
    throw new Error(`${where}: ${String(records.length)} records, not ${String(arm.sessions)}`);
  const onPage = records.filter((record) => record.onPage === true).length;
  if (onPage !== arm.onPage)
    throw new Error(`${where}: ${String(onPage)} on the page, not ${String(arm.onPage)}`);
  let mainUsd = 0;
  let helperUsd = 0;
  let mainKinds = ZERO;
  const mains: ByKind[] = [];
  const smalls: ByKind[] = [];
  for (const record of records) {
    if (record.status !== "done") throw new Error(`${where} ${record.id}: ${record.status}`);
    let small = ZERO;
    for (const [model, part] of Object.entries(record.models)) {
      const cost = costByKind(model, part, `${where} ${record.id} ${String(record.rep)}`);
      if (model === result.model) {
        mainUsd += part.costUsd;
        mainKinds = kindsOf((kind) => mainKinds[kind] + cost[kind]);
        mains.push(part.usage);
      } else {
        helpers.add(model);
        helperUsd += part.costUsd;
        small = kindsOf((kind) => small[kind] + part.usage[kind]);
      }
    }
    smalls.push(small);
  }
  if (mains.length !== records.length) throw new Error(`${where}: a session has no main model`);
  if (Math.abs(mainUsd + helperUsd - arm.costUsd) > 1e-6)
    throw new Error(`${where}: the models do not add up to the cost of the arm`);
  const medians = (list: readonly ByKind[]): ByKind =>
    kindsOf((kind) => median(list.map((one) => one[kind])));
  return {
    sessions: arm.sessions,
    verified: arm.checks.verified,
    partial: arm.checks.partial,
    wrong: arm.checks.wrong,
    noQuote: arm.checks["no-quote"],
    onPage: arm.onPage,
    turnLimit: records.filter((record) => record.subtype === "error_max_turns").length,
    costUsd: micro(arm.costUsd),
    mainUsd: micro(mainUsd),
    helperUsd: micro(helperUsd),
    mainKindsUsd: kindsOf((kind) => micro(mainKinds[kind])),
    mainTokens: medians(mains),
    helperTokens: medians(smalls),
    medianCostUsd: micro(arm.medianCostUsd),
    costPerVerifiedUsd: micro(arm.costPerVerifiedUsd),
    costPerOnPageUsd: micro(arm.costPerOnPageUsd),
    medianReadTokens: Math.round(arm.medianReadTokens),
    medianOutputTokens: Math.round(arm.medianOutputTokens),
    medianTurns: arm.medianTurns,
    toolCalls: arm.toolCalls,
  };
};

interface Loaded {
  readonly result: Result;
  readonly run: Run;
}

const versions: Version[] = [];
const loaded: Loaded[] = [];
for (const args of groups) {
  const option = (name: string): string | undefined => optionsIn(args, name)[0];
  const mcp = option("--version") ?? fail(usage);
  const date = option("--date") ?? fail(usage);
  const claudeCode = option("--claude-code") ?? fail(usage);
  const dryFile = option("--dry") ?? fail(usage);
  const dryRun = runId(option("--dry-run"));
  const results = optionsIn(args, "--result");
  const runs = optionsIn(args, "--run").map(runId);
  const summaries = optionsIn(args, "--summary").map(runId);
  if (!/^\d+\.\d+\.\d+$/.test(mcp) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(usage);
  if (results.length === 0 || runs.length !== results.length || summaries.length !== results.length)
    fail(usage);
  const previous = versions.at(-1);
  if (previous !== undefined && compareVersions(previous.mcp, mcp) >= 0)
    fail(`the versions are not the earliest first: ${previous.mcp}, then ${mcp}`);

  const mine = results.map(read);
  const commits = new Set(mine.map((result) => result.commit));
  if (commits.size !== 1)
    throw new Error(
      `${mcp}: the summaries come from different commits: ${[...commits].join(", ")}`,
    );
  mine.forEach((result, index) => {
    if (result.claims !== partA.claims.length)
      throw new Error(
        `${mcp} ${result.model}: ${String(result.claims)} claims, not ${String(partA.claims.length)}`,
      );
    const arms: Partial<Record<Arm, ArmSummary>> = {};
    for (const arm of result.arms) {
      if (!ARMS.some((one) => one.id === arm.arm))
        throw new Error(`${mcp} ${result.model}: the arm ${arm.arm} is not in ARMS`);
      arms[arm.arm] = armOf(result, arm);
    }
    if (arms.mcp === undefined) throw new Error(`${mcp} ${result.model}: no arm mcp`);
    const { id, name } = nameOf(result.model);
    loaded.push({
      result,
      run: {
        id: `${id}-${mcp}`,
        model: result.model,
        name,
        mcp,
        repeat: Math.max(...result.records.map((record) => record.rep)),
        run: runs[index]!,
        summary: summaries[index]!,
        costUsd: micro(result.costUsd),
        arms,
        webfetchFrom: null,
      },
    });
  });
  if (new Set(mine.map((result) => result.model)).size !== mine.length)
    throw new Error(`${mcp}: two results have the same model`);

  const dry = read(dryFile);
  versions.push({
    mcp,
    date,
    commit: [...commits][0]!.slice(0, 7),
    claudeCode,
    costUsd: micro(dry.costUsd + mine.reduce((total, result) => total + result.costUsd, 0)),
    dryRun: {
      run: dryRun,
      sessions: dry.arms.reduce((total, arm) => total + arm.sessions, 0),
      costUsd: micro(dry.costUsd),
    },
  });
}
if (helpers.size !== 1)
  throw new Error(
    `expected one small model for WebFetch, not ${[...helpers].join(", ") || "none"}`,
  );

/** A run with no WebFetch arm gets the WebFetch arm of the latest earlier run of the same model. */
const runs: Run[] = loaded.map(({ run }, index) => {
  if (run.arms.webfetch !== undefined) return run;
  const earlier = loaded
    .slice(0, index)
    .findLast((one) => one.run.model === run.model && one.run.arms.webfetch !== undefined);
  if (earlier === undefined) throw new Error(`${run.id}: no WebFetch arm, and no earlier run`);
  return { ...run, webfetchFrom: earlier.run.id };
});

const claims: SessionClaim[] = partA.claims.map((claim) => {
  const sessions: Record<string, Partial<Record<Arm, Session[]>>> = {};
  loaded.forEach(({ result, run }) => {
    const byArm: Partial<Record<Arm, Session[]>> = {};
    for (const { id: arm } of ARMS) {
      if (run.arms[arm] === undefined) continue;
      const records = result.records
        .filter((record) => record.id === claim.id && record.arm === arm)
        .sort((a, b) => a.rep - b.rep);
      if (records.length !== run.repeat)
        throw new Error(
          `${claim.id} ${run.id} ${arm}: ${String(records.length)} sessions, not ${String(run.repeat)}`,
        );
      if (records.some((record) => record.url !== claim.url))
        throw new Error(`${claim.id}: the URL of a session is not the URL of part A`);
      byArm[arm] = records.map((record) => ({
        usd: micro(record.costUsd),
        turns: record.turns,
        check: record.check,
        onPage: record.onPage,
      }));
    }
    sessions[run.id] = byArm;
  });
  return {
    id: claim.id,
    url: claim.url,
    page: claim.page,
    question: claim.question,
    markdown: claim.markdown,
    sessions,
  };
});

const used = new Set(loaded.flatMap(({ result }) => [result.model, ...helpers]));
const data: EvalBData = {
  helper: [...helpers][0]!,
  prices: Object.fromEntries(Object.entries(PRICES).filter(([model]) => used.has(model))),
  costUsd: micro(versions.reduce((total, version) => total + version.costUsd, 0)),
  versions,
  runs,
  claims,
};

writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`);
console.log(
  `${out}: ${String(claims.length)} claims, ${runs.map((run) => `${run.name} ${run.mcp} (${String(run.repeat)} each)`).join(", ")}, ${data.costUsd.toFixed(4)} USD`,
);
