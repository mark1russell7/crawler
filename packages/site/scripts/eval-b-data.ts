// The data of the page "Real Claude Code sessions" (src/data/eval-b.json). The script reads the result
// of each model of eval part B (eval-b-result.json, in the artifact `eval-b` of the workflow
// eval-sessions.yml) and the result of the dry run. It takes the page names, the questions and the
// size of each page from the data of part A (src/data/eval-a.json), and it writes only what the page
// shows.
//
// To refresh the page after a new run of part B:
//
//   gh run download <summary run id> -R mark1russell7/crawler -n eval-b -D <dir>
//   pnpm exec tsx packages/site/scripts/eval-b-data.ts \
//     --result <sonnet dir>/eval-b-result.json --run <sessions run id> --summary <summary run id> \
//     --result <opus dir>/eval-b-result.json --run <sessions run id> --summary <summary run id> \
//     --dry <dry run dir>/eval-b-result.json --dry-run <dry run id> \
//     --date <YYYY-MM-DD> --claude-code <version> --mcp <version>
//
// The data of 2026-10-25 came from these runs: Sonnet 40153411428 (summary 40155103977), Opus
// 40154501047 (summary 40155110580) and the dry run 40152547898, with Claude Code 2.1.296 and
// polite-crawler-mcp 0.2.1.
//
// The script fails when a session failed or was skipped, when a claim of part A has no sessions, or
// when a summary does not agree with its sessions.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  Arm,
  ArmSummary,
  Check,
  EvalBData,
  ModelRun,
  Session,
  SessionClaim,
} from "../src/lib/eval-b.ts";
import { ARMS } from "../src/lib/eval-b.ts";

interface Usage {
  readonly input: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
  readonly output: number;
}

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
  readonly usage: Usage;
  readonly models: Record<string, { readonly usage: Usage; readonly costUsd: number }>;
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

const usage =
  "usage: tsx packages/site/scripts/eval-b-data.ts (--result <eval-b-result.json> --run <id> --summary <id>)... --dry <eval-b-result.json> --dry-run <id> --date <YYYY-MM-DD> --claude-code <version> --mcp <version> [--out <file>]";

/** Each value of an option, in the sequence of the command line. */
const options = (name: string): string[] =>
  process.argv.flatMap((arg, at) => (arg === name ? [process.argv[at + 1] ?? ""] : []));
const option = (name: string): string | undefined => options(name)[0];
const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};
const runId = (value: string | undefined): number =>
  value !== undefined && /^\d+$/.test(value) ? Number(value) : fail(usage);

const results = options("--result");
const runs = options("--run").map(runId);
const summaries = options("--summary").map(runId);
const dryFile = option("--dry") ?? fail(usage);
const dryRun = runId(option("--dry-run"));
const date = option("--date") ?? fail(usage);
const claudeCode = option("--claude-code") ?? fail(usage);
const mcp = option("--mcp") ?? fail(usage);
const out = option("--out") ?? fileURLToPath(new URL("../src/data/eval-b.json", import.meta.url));
if (results.length === 0 || runs.length !== results.length || summaries.length !== results.length)
  fail(usage);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(usage);

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
  for (const record of records) {
    if (record.status !== "done") throw new Error(`${where} ${record.id}: ${record.status}`);
    for (const [model, part] of Object.entries(record.models)) {
      if (model === result.model) mainUsd += part.costUsd;
      else {
        helpers.add(model);
        helperUsd += part.costUsd;
      }
    }
  }
  if (Math.abs(mainUsd + helperUsd - arm.costUsd) > 1e-6)
    throw new Error(`${where}: the models do not add up to the cost of the arm`);
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
    medianCostUsd: micro(arm.medianCostUsd),
    costPerVerifiedUsd: micro(arm.costPerVerifiedUsd),
    costPerOnPageUsd: micro(arm.costPerOnPageUsd),
    medianReadTokens: Math.round(arm.medianReadTokens),
    medianOutputTokens: Math.round(arm.medianOutputTokens),
    medianTurns: arm.medianTurns,
    toolCalls: arm.toolCalls,
  };
};

const loaded = results.map(read);
const commits = new Set(loaded.map((result) => result.commit));
if (commits.size !== 1)
  throw new Error(`the summaries come from different commits: ${[...commits].join(", ")}`);

const models: ModelRun[] = loaded.map((result, index) => {
  if (result.claims !== partA.claims.length)
    throw new Error(
      `${result.model}: ${String(result.claims)} claims, not ${String(partA.claims.length)}`,
    );
  const byArm = (id: Arm): ArmSummary => {
    const arm = result.arms.find((one) => one.arm === id);
    if (arm === undefined) throw new Error(`${result.model}: no arm ${id}`);
    return armOf(result, arm);
  };
  const repeat = Math.max(...result.records.map((record) => record.rep));
  return {
    ...nameOf(result.model),
    model: result.model,
    repeat,
    run: runs[index]!,
    summary: summaries[index]!,
    costUsd: micro(result.costUsd),
    arms: { mcp: byArm("mcp"), webfetch: byArm("webfetch") },
  };
});
if (new Set(models.map((model) => model.id)).size !== models.length)
  throw new Error("two results have the same model");
if (helpers.size !== 1)
  throw new Error(
    `expected one small model for WebFetch, not ${[...helpers].join(", ") || "none"}`,
  );

const claims: SessionClaim[] = partA.claims.map((claim) => {
  const sessions: Record<string, Record<Arm, Session[]>> = {};
  loaded.forEach((result, index) => {
    const model = models[index]!;
    const byArm = { mcp: [], webfetch: [] } as Record<Arm, Session[]>;
    for (const { id: arm } of ARMS) {
      const records = result.records
        .filter((record) => record.id === claim.id && record.arm === arm)
        .sort((a, b) => a.rep - b.rep);
      if (records.length !== model.repeat)
        throw new Error(
          `${claim.id} ${model.id} ${arm}: ${String(records.length)} sessions, not ${String(model.repeat)}`,
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
    sessions[model.id] = byArm;
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

const dry = read(dryFile);
const dryCost = dry.costUsd;
const drySessions = dry.arms.reduce((total, arm) => total + arm.sessions, 0);

const data: EvalBData = {
  date,
  commit: [...commits][0]!.slice(0, 7),
  claudeCode,
  mcp,
  helper: [...helpers][0]!,
  costUsd: micro(dryCost + loaded.reduce((total, result) => total + result.costUsd, 0)),
  dryRun: { run: dryRun, sessions: drySessions, costUsd: micro(dryCost) },
  models,
  claims,
};

writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`);
console.log(
  `${out}: ${String(claims.length)} claims, ${models.map((model) => `${model.name} (${String(model.repeat)} each)`).join(" and ")}, ${data.costUsd.toFixed(4)} USD`,
);
