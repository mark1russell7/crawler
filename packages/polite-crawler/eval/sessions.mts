/**
 * The command of part B of the eval "tokens per verified claim": real sessions of Claude Code.
 * eval/README.md tells the method. Each session fetches pages and costs money on the API, so run it
 * in CI only (`.github/workflows/eval-sessions.yml`), not on a shared computer.
 *
 *   pnpm exec tsx packages/polite-crawler/eval/sessions.mts run --arm mcp --model <model> \
 *     --mcp-command <path of polite-crawler-mcp> --out sessions
 *   pnpm exec tsx packages/polite-crawler/eval/sessions.mts summary --out sessions --fetch \
 *     --markdown eval-b-summary.md --summary "$GITHUB_STEP_SUMMARY"
 *
 * `run` starts one session of `claude -p` for each claim, one after the other, --repeat times. Each
 * session starts in a new empty folder. The arm `mcp` has the tools of polite-crawler-mcp (with a
 * new store) and no built-in tool. The arm `webfetch` has the built-in tool WebFetch and no MCP
 * server. The command writes <out>/<arm>/<claim>.<repeat>.ndjson (the stream of each session) and
 * <out>/<arm>/sessions.json (the records). Before each session, it stops when the cost of the arm
 * is at --budget.
 *
 * Options of `run`: --arm, --model, --claims (the question set, default eval/claims.json), --only
 * (claim ids, comma separated), --limit (the first N claims), --repeat (default 1), --max-turns
 * (default 12), --max-budget-usd (the limit of one session, default 1), --budget (the limit of the
 * arm in USD, default 20), --claude (the command of Claude Code, default `claude`), --mcp-command
 * (the command of polite-crawler-mcp, for the arm mcp) and --out.
 *
 * `summary` reads the records of the two arms and writes <out>/eval-b-result.json. With --fetch, it
 * fetches each page one time with the crawler (robots.txt, the pace of each site) and checks that
 * each quote of each answer is on the page, as it is or with its inline Markdown removed. --markdown and --summary get the tables.
 *
 * The exit code of `run` is 0 when each session gives a result, and 1 when a session gives no result
 * or the budget stops the arm. A wrong command line gives 2.
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { openCrawler } from "../src/index.ts";
import { readClaims } from "./measure.mts";
import type { Arm, SessionRecord } from "./session-result.mts";
import {
  ARMS,
  markdownOf,
  plainOf,
  promptOf,
  quotesOf,
  recordOf,
  skippedRecord,
  summarize,
} from "./session-result.mts";

const here = dirname(fileURLToPath(import.meta.url));

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      arm: { type: "string" },
      model: { type: "string" },
      claims: { type: "string", default: join(here, "claims.json") },
      only: { type: "string", default: "" },
      limit: { type: "string", default: "" },
      repeat: { type: "string", default: "1" },
      "max-turns": { type: "string", default: "12" },
      "max-budget-usd": { type: "string", default: "1" },
      budget: { type: "string", default: "20" },
      claude: { type: "string", default: "claude" },
      "mcp-command": { type: "string" },
      out: { type: "string", default: "sessions" },
      fetch: { type: "boolean", default: false },
      markdown: { type: "string" },
      summary: { type: "string" },
    },
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
const { values: args, positionals } = parsed;
const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};

const claims = readClaims(readFileSync(args.claims, "utf8"));
const command = positionals[0];

if (command === "run") run();
else if (command === "summary") await summary();
else fail("give a command: run or summary");

function run(): void {
  const arm = args.arm as Arm;
  if (!ARMS.includes(arm)) fail(`--arm is ${ARMS.join(" or ")}`);
  const model = args.model ?? fail("give --model, so that each record names its model");
  const mcpCommand = args["mcp-command"];
  if (arm === "mcp" && mcpCommand === undefined) fail("the arm mcp needs --mcp-command");
  const budget = Number(args.budget);
  if (!(budget > 0)) fail("--budget is a number of USD above 0");
  const repeat = Number(args.repeat || "1");
  if (!Number.isInteger(repeat) || repeat < 1) fail("--repeat is a whole number of 1 or more");
  const only = new Set(
    args.only
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
  for (const id of only)
    if (!claims.some((claim) => claim.id === id)) fail(`no claim has the id ${id}`);
  let chosen = only.size > 0 ? claims.filter((claim) => only.has(claim.id)) : claims;
  if (args.limit !== "") chosen = chosen.slice(0, Number(args.limit));

  const dir = join(args.out, arm);
  mkdirSync(dir, { recursive: true });
  const records: SessionRecord[] = [];
  let spent = 0;
  let missing = 0;
  let stopped: string | null = null;
  // Each repeat goes through the whole set, so a stop of the budget leaves whole repeats.
  for (let rep = 1; rep <= repeat; rep += 1) {
    for (const claim of chosen) {
      if (stopped === null && spent >= budget) {
        stopped = `the arm spent ${spent.toFixed(4)} USD of its budget of ${String(budget)} USD`;
      }
      if (stopped !== null) {
        records.push(skippedRecord(claim, arm, stopped, rep));
        continue;
      }
      const work = mkdtempSync(join(tmpdir(), `eval-b-${claim.id}-`));
      const tools =
        arm === "mcp"
          ? [
              "--tools",
              "",
              "--mcp-config",
              JSON.stringify({
                mcpServers: {
                  crawler: {
                    type: "stdio",
                    command: mcpCommand,
                    args: ["--dir", join(work, ".store"), "--no-browser"],
                  },
                },
              }),
              "--allowedTools",
              "mcp__crawler",
            ]
          : ["--tools", "WebFetch", "--allowedTools", "WebFetch"];
      const started = Date.now();
      const session = spawnSync(
        args.claude,
        [
          "-p",
          promptOf(claim),
          "--output-format",
          "stream-json",
          "--verbose",
          "--model",
          model,
          "--max-turns",
          args["max-turns"],
          "--max-budget-usd",
          args["max-budget-usd"],
          "--no-session-persistence",
          "--strict-mcp-config",
          ...tools,
        ],
        {
          cwd: work,
          encoding: "utf8",
          timeout: 15 * 60_000,
          maxBuffer: 256 * 1024 * 1024,
          env: process.env,
        },
      );
      rmSync(work, { recursive: true, force: true });
      const stream = session.stdout ?? "";
      writeFileSync(join(dir, `${claim.id}.${String(rep)}.ndjson`), stream);
      const problem =
        session.error !== undefined
          ? session.error.message
          : session.status !== 0
            ? `exit ${String(session.status)}: ${(session.stderr ?? "").trim().slice(-400)}`
            : null;
      const entry = recordOf(claim, arm, stream, problem, rep);
      records.push(entry);
      spent += entry.costUsd;
      console.log(
        `${arm} ${claim.id} #${String(rep)}: ${entry.status} ${entry.check}, ${String(entry.turns)} turns, ${entry.costUsd.toFixed(4)} USD, ${String(Math.round((Date.now() - started) / 1000))} s${problem === null ? "" : ` (${problem})`}`,
      );
      // Two sessions in a row with no result: Claude Code cannot start (a key or an install fault).
      missing = entry.status === "failed" ? missing + 1 : 0;
      if (missing >= 2) stopped = "two sessions in a row gave no result";
    }
  }
  writeFileSync(
    join(dir, "sessions.json"),
    `${JSON.stringify({ arm, model, budget, repeat, spent, stopped, records }, null, 2)}\n`,
  );
  console.log(
    `${arm}: ${String(records.length)} sessions, ${spent.toFixed(4)} USD${stopped === null ? "" : `, stopped: ${stopped}`}`,
  );
  process.exit(stopped !== null || records.some((entry) => entry.status === "failed") ? 1 : 0);
}

/** This function fetches each page of the answers one time, and checks each quote on the page. */
async function checkOnPage(records: SessionRecord[]): Promise<SessionRecord[]> {
  const urls = [
    ...new Set(
      records.filter((entry) => quotesOf(entry.answer).length > 0).map((entry) => entry.url),
    ),
  ];
  const dir = mkdtempSync(join(tmpdir(), "eval-b-pages-"));
  const crawler = openCrawler({ dir, renderer: false });
  try {
    const docs = new Map<string, string | null>();
    await Promise.all(
      urls.map(async (url) => {
        try {
          const page = await crawler.fetch(url, { onBehalfOf: ["Claude-User"], render: "never" });
          docs.set(url, page.doc);
          console.log(`${page.outcome} ${String(page.status)} ${url}`);
        } catch (error) {
          docs.set(url, null);
          console.log(`error ${url}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    );
    const checked: SessionRecord[] = [];
    for (const entry of records) {
      const quotes = quotesOf(entry.answer);
      const doc = docs.get(entry.url) ?? null;
      if (quotes.length === 0 || doc === null) {
        checked.push(entry);
        continue;
      }
      // a quote is on the page as it is, or with its Markdown markup removed
      const found = await Promise.all(
        quotes.map(
          async (quote) =>
            (await crawler.verify(doc, quote)).found ||
            (await crawler.verify(doc, plainOf(quote))).found,
        ),
      );
      checked.push({ ...entry, onPage: found.every(Boolean) });
    }
    return checked;
  } finally {
    await crawler.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function summary(): Promise<void> {
  let records: SessionRecord[] = [];
  const models = new Set<string>();
  for (const arm of ARMS) {
    const file = join(args.out, arm, "sessions.json");
    if (!existsSync(file)) continue;
    const saved = JSON.parse(readFileSync(file, "utf8")) as {
      model: string;
      records: SessionRecord[];
    };
    models.add(saved.model);
    // A record of the first runs has no repeat and no check on the page.
    records.push(
      ...saved.records.map((entry) => ({
        ...entry,
        rep: entry.rep ?? 1,
        onPage: entry.onPage ?? null,
      })),
    );
  }
  if (records.length === 0) fail(`no records in ${args.out}`);
  if (args.fetch) records = await checkOnPage(records);
  const model = [...models].join(", ");
  const arms = summarize(records, claims.length);
  const result = {
    commit: process.env["GITHUB_SHA"] ?? null,
    model,
    claims: claims.length,
    costUsd: arms.reduce((sum, arm) => sum + arm.costUsd, 0),
    arms,
    records,
  };
  writeFileSync(join(args.out, "eval-b-result.json"), `${JSON.stringify(result, null, 2)}\n`);
  const markdown = markdownOf(arms, records, model);
  if (args.markdown !== undefined) writeFileSync(args.markdown, markdown);
  if (args.summary !== undefined) appendFileSync(args.summary, markdown);
  console.log(markdown);
}
