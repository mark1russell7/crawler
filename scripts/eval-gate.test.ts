// The tests of scripts/eval-gate.ts. The plan is a copy of the artifact "tags" of the Release run 41974842695.
//
//   node --test scripts/eval-gate.test.ts
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { decide, readPlan, readReleases, type PlanEntry } from "./eval-gate.ts";

const PLAN: PlanEntry[] = [
  { name: "polite-crawler", version: "0.5.0", tag: "polite-crawler@0.5.0" },
  { name: "polite-crawler-mcp", version: "0.5.0", tag: "polite-crawler-mcp@0.5.0" },
];
const RELEASES = ["polite-crawler-mcp@0.5.0", "polite-crawler@0.5.0", "polite-crawler@0.4.0"];
const AFTER_RELEASE = { event: "workflow_run", conclusion: "success", runId: "41974842695" };

void describe("decide", () => {
  void it("runs the eval on the tag that the Release run made", () => {
    assert.deepEqual(decide({ ...AFTER_RELEASE, plan: PLAN, releases: RELEASES }), {
      run: true,
      tag: "polite-crawler@0.5.0",
      reason: "Eval runs on polite-crawler@0.5.0, the release of the Release run 41974842695.",
    });
  });

  void it("skips the eval, with a reason, after a Release run that made no tag", () => {
    const decision = decide({ ...AFTER_RELEASE, plan: [], releases: RELEASES });
    assert.equal(decision.run, false);
    assert.equal(
      decision.reason,
      "Eval skipped: the Release run 41974842695 made no release of polite-crawler.",
    );
  });

  void it("skips the eval when the Release run has no plan", () => {
    const decision = decide({ ...AFTER_RELEASE, plan: null, releases: RELEASES });
    assert.equal(decision.run, false);
    assert.equal(decision.reason, "Eval skipped: the Release run 41974842695 has no plan of tags.");
  });

  void it("skips the eval when a release of the MCP server only came", () => {
    const decision = decide({ ...AFTER_RELEASE, plan: PLAN.slice(1), releases: RELEASES });
    assert.equal(decision.run, false);
  });

  void it("skips the eval when the tag of the plan has no GitHub release", () => {
    const decision = decide({ ...AFTER_RELEASE, plan: PLAN, releases: ["polite-crawler@0.4.0"] });
    assert.deepEqual(decision, {
      run: false,
      tag: "",
      reason:
        "Eval skipped: the tag polite-crawler@0.5.0 of the Release run 41974842695 has no GitHub release.",
    });
  });

  void it("skips the eval after a failed Release run", () => {
    const decision = decide({
      ...AFTER_RELEASE,
      conclusion: "failure",
      plan: PLAN,
      releases: RELEASES,
    });
    assert.equal(decision.reason, "Eval skipped: the Release run 41974842695 ended with failure.");
  });

  void it("runs the eval for each other event, on the default ref", () => {
    for (const event of ["schedule", "workflow_dispatch", "release"]) {
      assert.deepEqual(decide({ event, plan: null, releases: [] }), {
        run: true,
        tag: "",
        reason: `Eval runs: the event is ${event}.`,
      });
    }
  });
});

void describe("the files of the gate", () => {
  void it("reads a plan and the release tags, and gives null for a missing plan", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-gate-"));
    try {
      writeFileSync(
        join(dir, "tags.json"),
        JSON.stringify(PLAN.map((entry) => ({ ...entry, prerelease: false, notes: "-" }))),
      );
      writeFileSync(join(dir, "releases.txt"), `${RELEASES.join("\n")}\n`);
      assert.deepEqual(
        readPlan(join(dir, "tags.json"))?.map((entry) => entry.tag),
        PLAN.map((entry) => entry.tag),
      );
      assert.deepEqual(readReleases(join(dir, "releases.txt")), RELEASES);
      assert.equal(readPlan(join(dir, "none.json")), null);
      writeFileSync(join(dir, "bad.json"), JSON.stringify([{ name: "polite-crawler" }]));
      assert.throws(() => readPlan(join(dir, "bad.json")), /is not a plan of tags/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
