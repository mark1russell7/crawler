/**
 * The Laya arm of the decision eval (step 2). It reads the labels of part C (`labels.jsonl`) and has
 * three commands:
 *
 *   pnpm exec tsx packages/polite-crawler/eval/decisions/laya-run.mts rows --labels labels.jsonl \
 *     --out laya-train.jsonl --trial laya-trial.jsonl --trial-rows 64
 *   pnpm exec tsx packages/polite-crawler/eval/decisions/laya-run.mts plan --rows laya-train.jsonl \
 *     --trial-rows 64 --full-seconds 300 --head-seconds 120 --epochs 4 --budget 120 --out laya-plan.json
 *   LAYA_API_KEY=... pnpm exec tsx packages/polite-crawler/eval/decisions/laya-run.mts score \
 *     --labels labels.jsonl --server http://127.0.0.1:8765 --model untrained --arm untrained \
 *     --out laya-untrained.json
 *
 * - `rows` writes the training rows of the train half (the JSONL format of `laya-train`), and the
 *   first rows again as a small trial file.
 * - `plan` chooses the mode of the training from the seconds of a timed trial of each mode
 *   (`trainingPlan`). With --output (for example $GITHUB_OUTPUT), it appends `mode=<mode>` to it.
 * - `score` waits for the server (GET /health), asks it about each candidate link and each reading
 *   of each venue (POST /v1/systemone/batch), and scores the arm (`scoreArm`). The key of the server
 *   is in the environment variable LAYA_API_KEY. Options: --markdown and --summary as in
 *   `replay.mts`, --wait (the seconds to wait for the server, default 900), --laya (the version of
 *   the package) and --revision (the revision of the weights), which go into the result.
 *
 * The server is a local process of the job, not a site of others, so the requests do not go through
 * the polite transport. The rows and the result hold data of OpenStreetMap (© OpenStreetMap
 * contributors, ODbL) and URLs of other sites. They are artifacts of CI only.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { VERSION } from "../../src/index.ts";
import type { VenueLabel } from "./label.mts";
import {
  type Item,
  batchesOf,
  byVenue,
  itemsOf,
  layaMarkdownOf,
  probabilitiesOf,
  scoreArm,
  trainingPlan,
  trainingRows,
} from "./laya.mts";
import { ATTRIBUTION } from "./venues.mts";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      labels: { type: "string", default: "labels.jsonl" },
      out: { type: "string" },
      trial: { type: "string" },
      "trial-rows": { type: "string", default: "64" },
      rows: { type: "string" },
      "full-seconds": { type: "string" },
      "head-seconds": { type: "string" },
      epochs: { type: "string", default: "4" },
      budget: { type: "string", default: "120" },
      output: { type: "string" },
      server: { type: "string", default: "http://127.0.0.1:8765" },
      model: { type: "string" },
      arm: { type: "string" },
      wait: { type: "string", default: "900" },
      laya: { type: "string" },
      revision: { type: "string" },
      markdown: { type: "string" },
      summary: { type: "string" },
    },
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
const { values: args, positionals } = parsed;

/** This function reads a whole number of 0 or more from an option. */
const whole = (name: string, value: string | undefined): number => {
  const number = Number(value);
  if (value === undefined || !Number.isInteger(number) || number < 0) {
    return fail(`--${name} needs a whole number of 0 or more`);
  }
  return number;
};

const readLabels = (file: string): VenueLabel[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as VenueLabel);

const jsonl = (rows: readonly unknown[]): string =>
  rows.map((row) => `${JSON.stringify(row)}\n`).join("");

const command = positionals[0];

if (command === "rows") {
  const rows = trainingRows(readLabels(args.labels));
  writeFileSync(args.out ?? "laya-train.jsonl", jsonl(rows));
  if (args.trial !== undefined) {
    writeFileSync(args.trial, jsonl(rows.slice(0, whole("trial-rows", args["trial-rows"]))));
  }
  process.stdout.write(`${String(rows.length)} training rows\n`);
} else if (command === "plan") {
  if (args.rows === undefined) fail("plan needs --rows");
  const rows = readFileSync(args.rows, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "").length;
  const plan = trainingPlan(
    {
      rows: whole("trial-rows", args["trial-rows"]),
      full_seconds: whole("full-seconds", args["full-seconds"]),
      head_seconds: whole("head-seconds", args["head-seconds"]),
    },
    rows,
    whole("epochs", args.epochs),
    whole("budget", args.budget),
  );
  const record = { rows, epochs: whole("epochs", args.epochs), ...plan };
  if (args.out !== undefined) writeFileSync(args.out, `${JSON.stringify(record, null, 2)}\n`);
  if (args.output !== undefined) appendFileSync(args.output, `mode=${plan.mode}\n`);
  process.stdout.write(`${JSON.stringify(record)}\n`);
} else if (command === "score") {
  const key = process.env["LAYA_API_KEY"];
  if (key === undefined || key === "") fail("score needs the key of the server in LAYA_API_KEY");
  if (args.model === undefined || args.arm === undefined) fail("score needs --model and --arm");
  const model = args.model;
  const server = args.server.replace(/\/$/, "");
  const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };

  // the server loads the weights at its start, so the first answer of /health can take minutes
  const deadline = Date.now() + whole("wait", args.wait) * 1000;
  for (;;) {
    const ok = await fetch(`${server}/health`, { headers, signal: AbortSignal.timeout(10_000) })
      .then((response) => response.ok)
      .catch(() => false);
    if (ok) break;
    if (Date.now() > deadline) fail(`the server at ${server} did not answer /health in time`);
    await sleep(5000);
  }

  const labels = readLabels(args.labels);
  const items = itemsOf(labels);
  const p: number[] = Array.from({ length: items.length }, () => Number.NaN);
  const started = performance.now();
  let requests = 0;
  for (const kind of ["link", "reading"] as const) {
    const indexes = items.flatMap((item: Item, at) => (item.kind === kind ? [at] : []));
    const states = indexes.map((at) => (items[at] as Item).state);
    let offset = 0;
    for (const batch of batchesOf(model, kind, states)) {
      // a lazy load of a checkpoint happens in the first request, so the time limit is long
      const response = await fetch(`${server}/v1/systemone/batch`, {
        method: "POST",
        headers,
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(900_000),
      });
      if (!response.ok) {
        fail(
          `the server answered ${String(response.status)}: ${(await response.text()).slice(0, 500)}`,
        );
      }
      const values = probabilitiesOf(await response.json(), kind, batch.states.length);
      for (const [at, value] of values.entries()) p[indexes[offset + at] as number] = value;
      offset += batch.states.length;
      requests += 1;
      if (requests % 20 === 0) process.stderr.write(`${String(requests)} requests\n`);
    }
  }
  const seconds = (performance.now() - started) / 1000;
  const probabilities = byVenue(labels, items, p);
  const score = scoreArm(labels, probabilities);
  const commit = process.env["GITHUB_SHA"] ?? null;
  const result = {
    eval: "the decisions of the venue recipe: Laya against the rule, step 2",
    attribution: ATTRIBUTION,
    package: `polite-crawler ${VERSION}`,
    commit,
    arm: args.arm,
    model,
    laya: args.laya ?? null,
    revision: args.revision ?? null,
    states: {
      link: items.filter((item) => item.kind === "link").length,
      reading: items.filter((item) => item.kind === "reading").length,
    },
    requests,
    seconds: Math.round(seconds),
    score,
    venues: labels.map((label) => ({
      osm: label.osm,
      half: label.half,
      ...probabilities.get(label.osm),
    })),
  };
  writeFileSync(args.out ?? `laya-${args.arm}.json`, `${JSON.stringify(result, null, 2)}\n`);
  const markdown = layaMarkdownOf(score, {
    arm: args.arm,
    model,
    commit,
    attribution: ATTRIBUTION,
  });
  if (args.markdown !== undefined) writeFileSync(args.markdown, markdown);
  if (args.summary !== undefined) appendFileSync(args.summary, `${markdown}\n`);
  process.stdout.write(markdown);
} else {
  fail("the command is rows, plan or score");
}
