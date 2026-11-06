#!/usr/bin/env node
// The gate of the eval "tokens per verified claim" (.github/workflows/eval.yml).
//
//   EVENT=workflow_run CONCLUSION=success RUN_ID=<id> PLAN_FILE=tags/tags.json RELEASES_FILE=releases.txt \
//     node scripts/eval-gate.ts
//
// After a Release run, the eval runs only on a release of polite-crawler that this Release run made. The Release
// run uploads its plan of tags as the artifact "tags" (tags.json). The gate reads that plan, and it compares no
// times. A tag of the plan counts only when its GitHub release exists. For each other event, the eval runs.
//
// The script writes "run" and "tag" to GITHUB_OUTPUT. It writes the reason to the job summary, so a skip
// is visible in a green run.
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The package that the eval measures. */
export const EVAL_PACKAGE = "polite-crawler";

/** One entry of the plan of tags of a Release run. */
export interface PlanEntry {
  readonly name: string;
  readonly version: string;
  readonly tag: string;
}

/** The facts that the gate reads. */
export interface GateInput {
  /** The event that started the eval workflow. */
  readonly event: string;
  /** The conclusion of the Release run, after the event workflow_run. */
  readonly conclusion?: string | undefined;
  /** The id of the Release run, after the event workflow_run. */
  readonly runId?: string | undefined;
  /** The plan of tags of the Release run. The value null tells that the run has no plan. */
  readonly plan: readonly PlanEntry[] | null;
  /** The tags of the GitHub releases of the repository. */
  readonly releases: readonly string[];
}

/** The decision of the gate. */
export interface GateDecision {
  /** True when the eval runs. */
  readonly run: boolean;
  /** The tag that the eval checks out. The empty value gives the default ref of the event. */
  readonly tag: string;
  /** The reason, as one line for the job summary. */
  readonly reason: string;
}

/** This function gives the decision of the gate. It reads only its input. */
export function decide(input: GateInput): GateDecision {
  if (input.event !== "workflow_run")
    return { run: true, tag: "", reason: `Eval runs: the event is ${input.event}.` };
  const run = `the Release run ${input.runId ?? "(no id)"}`;
  const skip = (why: string): GateDecision => ({
    run: false,
    tag: "",
    reason: `Eval skipped: ${why}.`,
  });
  if (input.conclusion !== "success")
    return skip(`${run} ended with ${input.conclusion ?? "no conclusion"}`);
  if (input.plan === null) return skip(`${run} has no plan of tags`);
  const entry = input.plan.find((item) => item.name === EVAL_PACKAGE);
  if (entry === undefined) return skip(`${run} made no release of ${EVAL_PACKAGE}`);
  if (!input.releases.includes(entry.tag))
    return skip(`the tag ${entry.tag} of ${run} has no GitHub release`);
  return { run: true, tag: entry.tag, reason: `Eval runs on ${entry.tag}, the release of ${run}.` };
}

/** This function reads a plan of tags. A missing file gives null, and a file that is not a plan throws. */
export function readPlan(file: string | undefined): PlanEntry[] | null {
  if (file === undefined || file === "" || !existsSync(file)) return null;
  const plan: unknown = JSON.parse(readFileSync(file, "utf8"));
  const entry = (item: unknown): item is PlanEntry =>
    typeof item === "object" &&
    item !== null &&
    ["name", "version", "tag"].every(
      (key) => typeof (item as Record<string, unknown>)[key] === "string",
    );
  if (!Array.isArray(plan) || !plan.every(entry)) throw new Error(`${file} is not a plan of tags.`);
  return plan;
}

/** This function reads a file with one tag on each line. A missing file gives no tags. */
export function readReleases(file: string | undefined): string[] {
  if (file === undefined || file === "" || !existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

// engines.node allows Node 23, which has no import.meta.main, so the check compares the real paths.
if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const env = process.env;
  const decision = decide({
    event: env["EVENT"] ?? "",
    conclusion: env["CONCLUSION"],
    runId: env["RUN_ID"],
    plan: readPlan(env["PLAN_FILE"]),
    releases: readReleases(env["RELEASES_FILE"]),
  });
  console.log(decision.reason);
  if (env["GITHUB_OUTPUT"])
    appendFileSync(env["GITHUB_OUTPUT"], `run=${decision.run}\ntag=${decision.tag}\n`);
  if (env["GITHUB_STEP_SUMMARY"])
    appendFileSync(env["GITHUB_STEP_SUMMARY"], `${decision.reason}\n`);
}
