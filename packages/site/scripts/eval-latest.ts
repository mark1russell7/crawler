// The build of the site starts this script before `astro build`. It finds the newest green run of the workflow
// eval.yml on main that has the artifact `eval`, downloads that artifact, and writes src/data/eval-a.json from its
// eval-result.json. A green run can have no artifact: after a Release run that made no release of polite-crawler,
// the gate of eval.yml skips the eval and the run ends green. The script passes over such a run.
// The page "Tokens to prove a claim" then shows the numbers of that run, with its version, run id and date.
//
// The script uses the GitHub CLI with the token in GH_TOKEN or GITHUB_TOKEN. The token needs the permission
// `actions: read`. When no green run has a readable result, the script fails, so the build fails. The build has
// no fallback to an older copy of the data.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeEvalPage, type Result } from "./eval-data.ts";

/** The repository of the workflow eval.yml. */
export const EVAL_REPOSITORY = "mark1russell7/crawler";

/** One run of `gh run list`, with the fields that this script asks for. */
export interface ListedRun {
  readonly databaseId: number;
  readonly createdAt: string;
  readonly headSha: string;
}

/** The number of the newest green runs that the script examines for the artifact `eval`. */
export const RUN_LIMIT = 20;

/** The runner of the GitHub CLI. A test gives a fake. */
export type Gh = (args: readonly string[]) => string;

const realGh: Gh = (args) =>
  execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

/** This function tells if the run has the artifact `eval`, and the artifact is not expired. */
export function hasEvalArtifact(run: ListedRun, gh: Gh = realGh): boolean {
  const count = gh([
    "api",
    `repos/${EVAL_REPOSITORY}/actions/runs/${String(run.databaseId)}/artifacts?name=eval`,
    "--jq",
    "[.artifacts[] | select(.expired | not)] | length",
  ]);
  return Number(count.trim()) > 0;
}

/**
 * This function gives the newest green run of eval.yml on main that has the artifact `eval`. It examines the
 * newest RUN_LIMIT green runs, and fails when none of them has the artifact.
 */
export function newestGreenRun(gh: Gh = realGh): ListedRun {
  const listed = JSON.parse(
    gh([
      "run",
      "list",
      "-R",
      EVAL_REPOSITORY,
      "--workflow",
      "eval.yml",
      "--branch",
      "main",
      "--status",
      "success",
      "--limit",
      String(RUN_LIMIT),
      "--json",
      "databaseId,createdAt,headSha",
    ]),
  ) as ListedRun[];
  const run = listed.find((item) => hasEvalArtifact(item, gh));
  if (run === undefined) {
    throw new Error(
      `${EVAL_REPOSITORY}: no green run of eval.yml on main has the artifact eval (${String(listed.length)} runs examined). The build stops.`,
    );
  }
  return run;
}

/**
 * This function writes the data of the page from the newest green run, and gives that run. It fails when the run has
 * no readable result, or when the result names another commit than the run.
 */
export function writeNewestEval(gh: Gh = realGh, out?: string): ListedRun {
  const run = newestGreenRun(gh);
  const dir = mkdtempSync(join(tmpdir(), "eval-a-"));
  try {
    gh(["run", "download", String(run.databaseId), "-R", EVAL_REPOSITORY, "-n", "eval", "-D", dir]);
    const file = join(dir, "eval-result.json");
    let result: Result;
    try {
      result = JSON.parse(readFileSync(file, "utf8")) as Result;
    } catch (error) {
      throw new Error(
        `The run ${String(run.databaseId)} has no readable eval-result.json. The build stops.`,
        { cause: error },
      );
    }
    if (result.commit !== run.headSha) {
      throw new Error(
        `The run ${String(run.databaseId)} is at ${run.headSha}, but its result names ${result.commit}.`,
      );
    }
    writeEvalPage(file, { id: run.databaseId, started: run.createdAt }, out);
    return run;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// engines.node allows Node 23, which has no import.meta.main, so the check compares the real paths.
if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const run = writeNewestEval();
  console.log(`eval A: run ${String(run.databaseId)} of ${run.createdAt}, at ${run.headSha}.`);
}
