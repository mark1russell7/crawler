import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { Study, StudySite } from "./study.ts";
import { AGENTS, PAGE_PATH, changedSites, siteOf, sitesOf, studyText } from "./study-derive.ts";
import type { KeptAnswer, RawRun } from "./study-raw.ts";
import { rawFile, readRawFile, sha256 } from "./study-raw.ts";

// No test sends a request: the raw file of the newest run is in the repository.

const pageText = readFileSync(new URL("../data/robots-study.json", import.meta.url), "utf8");
const page = JSON.parse(pageText) as Study;
const rawBytes = new Uint8Array(
  readFileSync(new URL("../data/robots-study.raw.ndjson.gz", import.meta.url)),
);
const raw = readRawFile(rawBytes);
const encoder = new TextEncoder();

const answer = (rank: number, text: string): KeptAnswer => {
  const body = encoder.encode(text);
  return {
    rank,
    domain: `site${String(rank)}.example`,
    url: `https://site${String(rank)}.example/robots.txt`,
    status: 200,
    outcome: "ok",
    contentType: "text/plain",
    blob: sha256(body),
    bytes: body.length,
    body,
  };
};

describe("the raw file of the newest run", () => {
  it("is the run of the page copy, with one answer for each domain of the list", () => {
    expect(raw.run.list).toEqual(page.list);
    expect(raw.run.fetched).toEqual(page.fetched);
    expect(raw.run.userAgent).toBe(page.userAgent);
    expect(raw.answers.map((entry) => [entry.rank, entry.domain])).toEqual(
      page.sites.map((entry) => [entry.rank, entry.domain]),
    );
  });

  it("keeps each body with the SHA-256 of its blob", () => {
    const bodies = raw.answers.filter((entry) => entry.blob !== undefined);
    expect(bodies.length).toBeGreaterThan(0);
    for (const entry of bodies) {
      expect(entry.body, entry.domain).toBeDefined();
      expect(sha256(entry.body ?? new Uint8Array()), entry.domain).toBe(entry.blob);
      expect(entry.body?.length, entry.domain).toBe(entry.bytes);
    }
  });

  it("gives the numbers of the pages again with the parser of the workspace", () => {
    const sites = sitesOf(raw.answers);
    const text = studyText(raw.run, sites, page.recounted);
    const changed = changedSites(page.sites, sites);
    expect(
      changed,
      `The parser of the workspace gives other entries for ${String(changed.length)} sites. ` +
        "Run `pnpm exec tsx packages/site/scripts/robots-study.ts recount` and commit the page copy.",
    ).toEqual([]);
    expect(text).toBe(pageText);
  });
});

describe("the raw file format", () => {
  it("gives back each byte of each body, also a body that is not UTF-8", () => {
    const latin = new Uint8Array([0x55, 0x73, 0x65, 0x72, 0x2d, 0xe9, 0x0a]);
    const run: RawRun = {
      run: raw.run,
      answers: [
        answer(2, "\uFEFFUser-agent: *\r\nDisallow: /x\r\n"),
        { ...answer(1, ""), body: latin, blob: sha256(latin), bytes: latin.length },
        {
          rank: 3,
          domain: "site3.example",
          url: "https://site3.example/robots.txt",
          status: 404,
          outcome: "not-found",
        },
      ],
    };
    const back = readRawFile(rawFile(run));
    expect(back.run).toEqual(run.run);
    expect(back.answers.map((entry) => entry.rank)).toEqual([1, 2, 3]);
    expect(back.answers[0]?.body).toEqual(latin);
    expect(back.answers[1]?.body).toEqual(run.answers[0]?.body);
    expect(back.answers[2]?.body).toBeUndefined();
    const lines = gunzipSync(rawFile(run)).toString("utf8");
    expect(lines).toContain('"body":"');
    expect(lines).toContain('"text":"');
  });

  it("stops for a body that does not have the SHA-256 of its blob", () => {
    const bad = { ...answer(1, "User-agent: *\n"), blob: "0".repeat(64) };
    expect(() => readRawFile(rawFile({ run: raw.run, answers: [bad] }))).toThrow(/SHA-256/);
  });
});

describe("a recount", () => {
  const sites = sitesOf([
    answer(1, "User-agent: GPTBot\nDisallow: /\n"),
    answer(2, "User-agent: *\nDisallow:\n"),
  ]);

  it("gives a code for each agent, and the line of each rule that decided", () => {
    expect(sites[0]?.p).toBe(`N${".".repeat(AGENTS.length - 1)}`);
    expect(sites[0]?.lines).toEqual({ "1": "User-agent: GPTBot", "2": "Disallow: /" });
    expect(sites[1]?.p).toBe(".".repeat(AGENTS.length));
    expect(siteOf(answer(3, "User-agent: *\nDisallow: /polite-crawler-study/\n")).p).toBe(
      "S".repeat(AGENTS.length),
    );
    expect(PAGE_PATH.startsWith("/polite-crawler-study/")).toBe(true);
  });

  it("names the domains with another entry", () => {
    const other: StudySite[] = [{ ...sites[0]!, p: "S".repeat(AGENTS.length) }, sites[1]!];
    expect(changedSites(sites, sites)).toEqual([]);
    expect(changedSites(sites, other)).toEqual(["site1.example"]);
  });

  it("names the version of the parser and the count of the changed sites in the head", () => {
    const study = JSON.parse(studyText(raw.run, sites, { engine: "9.9.9", sites: 1 })) as Study;
    expect(study.recounted).toEqual({ engine: "9.9.9", sites: 1 });
    expect(study.sites).toEqual(sites);
    expect((JSON.parse(studyText(raw.run, sites)) as Study).recounted).toBeUndefined();
  });
});
