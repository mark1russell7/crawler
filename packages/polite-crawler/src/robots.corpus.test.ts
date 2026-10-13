import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { RobotsDecision } from "./robots.ts";
import { decide, parseRobots, robotsFromResponse } from "./robots.ts";

// The golden corpus: 38 robots.txt files as the sites served them on 2026-10-12, and the verdicts
// of the robots.txt study for each AI agent (test/corpus/robots/README.md gives the format).

interface Decisions {
  readonly pagePath: string;
  readonly agents: readonly string[];
  readonly sites: Readonly<
    Record<
      string,
      {
        readonly url: string;
        readonly sha256: string;
        readonly page: string;
        readonly home?: string;
      }
    >
  >;
}

const corpus = new URL("../test/corpus/robots/", import.meta.url);
const decisions = JSON.parse(
  await readFile(new URL("decisions.json", corpus), "utf8"),
) as Decisions;

/** The character of one verdict, as the study writes it. */
const code = (decision: RobotsDecision, token: string): string => {
  const tokenOf = (agent: string): string => /^[a-z_-]+/.exec(agent.trim())?.[0] ?? "";
  const named = (decision.groups ?? []).some((group) =>
    group.agents.some((agent) => agent !== "*" && tokenOf(agent) === token.toLowerCase()),
  );
  if (!decision.allowed) return named ? "N" : "S";
  return named ? "n" : ".";
};

describe("the golden robots.txt corpus", () => {
  it("has a file for each site, with the hash that the study recorded", async () => {
    expect(Object.keys(decisions.sites)).toHaveLength(38);
    for (const [domain, site] of Object.entries(decisions.sites)) {
      const bytes = await readFile(new URL(`${domain}.txt`, corpus));
      expect(createHash("sha256").update(bytes).digest("hex"), domain).toBe(site.sha256);
    }
  });

  it("gives the verdicts of the study for each agent, on a page and on the home page", async () => {
    for (const [domain, site] of Object.entries(decisions.sites)) {
      const bytes = await readFile(new URL(`${domain}.txt`, corpus));
      const robots = parseRobots(new TextDecoder("utf-8").decode(bytes));
      // the reader of the crawler reads each file of the corpus as a file, not as a web page
      expect(robotsFromResponse(200, "text/plain", bytes).unreachable, domain).toBeUndefined();
      const page = decisions.agents
        .map((token) => code(decide(robots, [token], decisions.pagePath), token))
        .join("");
      const home = decisions.agents
        .map((token) => code(decide(robots, [token], "/"), token))
        .join("");
      expect(page, `${domain} page`).toBe(site.page);
      expect(home, `${domain} home`).toBe(site.home ?? site.page);
    }
  });
});
