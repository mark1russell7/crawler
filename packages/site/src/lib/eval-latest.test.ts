import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Result } from "../../scripts/eval-data.ts";
import { type Gh, type ListedRun, writeNewestEval } from "../../scripts/eval-latest.ts";
import evalA from "../data/eval-a.json";

const SHA = "39972dc4a08c94c321b76081b4d6646e7a9417a0";
const RUN: ListedRun = { databaseId: 42129722604, createdAt: "2026-11-05T23:29:27Z", headSha: SHA };

const count = (tokens: number) => ({ chars: tokens * 4, tokens });
const totals = (median: number, total: number) => ({ median: count(median), total: count(total) });

/** This function gives a result of one claim, from the first claim of the data file. */
function result(commit = SHA, verified = true): Result {
  const claim = evalA.claims[0];
  if (claim === undefined) throw new Error("eval-a.json has no claim");
  return {
    package: "polite-crawler 0.5.0",
    commit,
    tokenizer: "cl100k_base (tiktoken)",
    window: 2000,
    tool_definitions: count(5993),
    archive: { start: "2026-11-06T00:17:33.551Z", sha256: "658afc776b0cbbab0000" },
    claims: [
      {
        id: claim.id,
        source: claim.source,
        url: claim.url,
        find_rank: 1,
        read_window: "quote",
        polite: {
          fetch: count(1),
          find: count(2),
          read: count(3),
          verify: count(4),
          total: count(10),
        },
        paged: { chars: 80, tokens: 20, reads: 1 },
        webfetch: { markdown: count(30), text: count(25) },
        verified,
      },
    ],
    summary: {
      claims: 1,
      verified: verified ? 1 : 0,
      past_cut: 0,
      polite: totals(10, 10),
      paged: totals(20, 20),
      markdown: totals(30, 30),
      text: totals(25, 25),
      ratio: { markdown_total: 3, markdown_median: 3, text_total: 2.5 },
    },
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** This function gives a fake GitHub CLI: a list of runs, and a download that writes `file` when it is a string. */
function fakeGh(
  runs: readonly ListedRun[],
  file: string | undefined,
): { gh: Gh; calls: string[][] } {
  const calls: string[][] = [];
  const gh: Gh = (args) => {
    calls.push([...args]);
    if (args[1] === "list") return JSON.stringify(runs);
    const dir = args[args.indexOf("-D") + 1];
    if (dir !== undefined && file !== undefined) writeFileSync(join(dir, "eval-result.json"), file);
    return "";
  };
  return { gh, calls };
}

const out = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "eval-latest-test-"));
  dirs.push(dir);
  return join(dir, "eval-a.json");
};

describe("writeNewestEval", () => {
  it("writes the data of the newest green run on main, with its id, start and full commit", () => {
    const { gh, calls } = fakeGh([RUN], JSON.stringify(result()));
    const file = out();
    expect(writeNewestEval(gh, file)).toEqual(RUN);
    const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(data).toMatchObject({
      run: RUN.databaseId,
      started: RUN.createdAt,
      commitSha: SHA,
      commit: SHA.slice(0, 7),
    });
    expect(calls[0]).toEqual(
      expect.arrayContaining(["--workflow", "eval.yml", "--branch", "main", "--status", "success"]),
    );
    expect(calls[1]?.slice(0, 3)).toEqual(["run", "download", String(RUN.databaseId)]);
  });

  it("fails when main has no green run", () => {
    const { gh } = fakeGh([], JSON.stringify(result()));
    expect(() => writeNewestEval(gh, out())).toThrow(/no green run/);
  });

  it("fails when the run has no readable result, and writes no file", () => {
    for (const file of [undefined, "{ not json"]) {
      const { gh } = fakeGh([RUN], file);
      const target = out();
      expect(() => writeNewestEval(gh, target)).toThrow(/no readable eval-result\.json/);
      expect(() => readFileSync(target)).toThrow(/ENOENT/);
    }
  });

  it("fails when the result names another commit than the run", () => {
    const { gh } = fakeGh([RUN], JSON.stringify(result("0".repeat(40))));
    expect(() => writeNewestEval(gh, out())).toThrow(/its result names/);
  });

  it("fails on a claim that is not verified", () => {
    const { gh } = fakeGh([RUN], JSON.stringify(result(SHA, false)));
    expect(() => writeNewestEval(gh, out())).toThrow(/not verified/);
  });
});
