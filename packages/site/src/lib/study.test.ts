import { describe, expect, it } from "vitest";
import type { Study } from "./study.ts";
import { agentRows, companies, pack, summarize, unpack } from "./study.ts";
import data from "../data/robots-study.json";

const study: Study = {
  list: { name: "Tranco", id: "TEST", date: "2026-10-11", url: "https://tranco-list.eu/list/TEST/1000", size: 4 },
  fetched: { from: "2026-10-12T16:42:51.894Z", to: "2026-10-12T16:44:14.733Z" },
  userAgent: "PoliteCrawler/0.1.0",
  pagePath: "/a-page",
  agents: [
    { token: "GPTBot", owner: "OpenAI", role: "training" },
    { token: "ChatGPT-User", owner: "OpenAI", role: "user" },
    { token: "PoliteCrawler", owner: "polite-crawler", role: "control" },
  ],
  sites: [
    { rank: 1, domain: "a.example", status: 200, state: "ok", p: "N.." },
    { rank: 2, domain: "b.example", status: 200, state: "ok", p: "SSS", signals: ["content-signal: ai-train=no, search=yes"] },
    { rank: 3, domain: "c.example", status: 404, state: "missing", p: "..." },
    { rank: 4, domain: "d.example", status: 0, state: "unreachable", reason: "no response", p: "UUU" },
  ],
};

describe("the robots.txt study", () => {
  it("counts the refusals over the sites that answered", () => {
    const gpt = agentRows(study).find((row) => row.token === "GPTBot");
    expect(gpt).toMatchObject({ byName: 1, byStar: 1, refused: 2, share: 66.7 });
  });

  it("finds the sites that refuse the training crawler and permit the agent for a person", () => {
    const summary = summarize(study);
    expect(summary.answered).toBe(3);
    expect(summary.unreachable).toBe(1);
    expect(summary.trainingNotUser["OpenAI"]).toBe(1);
    expect(summary.blocksEveryBot).toBe(1);
    expect(summary.signals).toBe(1);
    expect(summary.signalValues).toEqual([
      { key: "search", yes: 1, no: 0 },
      { key: "ai-input", yes: 0, no: 0 },
      { key: "ai-train", yes: 0, no: 1 },
    ]);
  });

  it("packs the sites for the page and unpacks them", () => {
    const sites = unpack(pack(study));
    expect(sites).toHaveLength(4);
    expect(sites[0]).toEqual({ rank: 1, domain: "a.example", state: "o", codes: "N.." });
    expect(sites[3]).toEqual({ rank: 4, domain: "d.example", state: "u", codes: "" });
  });

  it("groups the agents of each company", () => {
    expect(companies(study)[0]).toEqual({
      owner: "OpenAI",
      agents: [
        { token: "GPTBot", role: "training", share: 66.7 },
        { token: "ChatGPT-User", role: "user", share: 33.3 },
      ],
    });
  });

  it("keeps a dataset with one code for each agent and each site", () => {
    const real = data as unknown as Study;
    expect(real.sites).toHaveLength(real.list.size);
    for (const site of real.sites) expect(site.p).toHaveLength(real.agents.length);
  });
});
