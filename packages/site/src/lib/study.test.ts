import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Study } from "./study.ts";
import {
  agentRows,
  answerOf,
  companies,
  formatDay,
  niceMax,
  pack,
  summarize,
  ticks,
  toCsv,
  unpack,
  verdictOf,
  wallOf,
} from "./study.ts";
import data from "../data/robots-study.json";

const study: Study = {
  list: { name: "Tranco", id: "TEST", date: "2026-10-11", url: "https://tranco-list.eu/list/TEST/1000", size: 6 },
  fetched: { from: "2026-10-12T16:42:51.894Z", to: "2026-10-12T16:44:14.733Z" },
  userAgent: "PoliteCrawler/0.1.0",
  pagePath: "/a-page",
  license: "CC-BY-4.0",
  agents: [
    { token: "GPTBot", owner: "OpenAI", role: "training" },
    { token: "ChatGPT-User", owner: "OpenAI", role: "user" },
    { token: "PoliteCrawler", owner: "polite-crawler", role: "control" },
  ],
  sites: [
    { rank: 1, domain: "a.example", status: 200, state: "file", p: "N.." },
    {
      rank: 2,
      domain: "b.example",
      status: 200,
      state: "file",
      p: "SSS",
      signals: ["content-signal: ai-train=no, search=yes", "content-signal: ai-train=yes"],
    },
    { rank: 3, domain: "c.example", status: 404, state: "none", p: "..." },
    { rank: 4, domain: "d.example", status: 0, state: "unreachable", reason: "no response", p: "UUU" },
    { rank: 5, domain: "e.example", status: 403, state: "blocked", reason: "status 403", p: "BBB" },
    { rank: 6, domain: "f.example", status: 200, state: "none", html: true, p: "..." },
  ],
};

describe("the answer of a domain", () => {
  const ok = (text: string, contentType = "text/plain") => answerOf({ status: 200, outcome: "ok", contentType, text });

  it("reads a robots.txt file", () => {
    expect(ok("User-agent: *\nDisallow: /private\n")).toEqual({ state: "file", html: false });
  });

  it("reads a 404 and a 410 as no file, and an HTML page in place of the file as no file", () => {
    expect(answerOf({ status: 404, outcome: "not-found" }).state).toBe("none");
    expect(answerOf({ status: 410, outcome: "error" }).state).toBe("none");
    expect(ok("<!doctype html><title>Welcome</title><p>Home</p>", "text/html")).toEqual({ state: "none", html: true });
  });

  it("puts each other 4xx, each 5xx and a challenge at the edge, not with the sites that permit", () => {
    for (const status of [400, 401, 403, 418, 429, 498, 500, 503, 522])
      expect(answerOf({ status, outcome: "error" })).toMatchObject({ state: "blocked", reason: `status ${String(status)}` });
    expect(answerOf({ status: 202, outcome: "challenge", note: "AWS WAF challenge" })).toMatchObject({
      state: "blocked",
      reason: "AWS WAF challenge, status 202",
    });
  });

  it("finds a bot wall that a server gives with a 200", () => {
    const recaptcha = `<html><head><title>Checking your browser - reCAPTCHA</title></head><body><div class="g-recaptcha"></div></body></html>`;
    expect(ok(recaptcha, "text/html")).toMatchObject({ state: "blocked", reason: "a CAPTCHA page in place of the file, status 200" });
    expect(wallOf(`<html><head><title>Access Denied</title></head><body>Reference #18</body></html>`)).toBe("an Akamai block");
    expect(wallOf(`<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>`)).toBe("a Cloudflare challenge");
    expect(wallOf(`<script>var k = get_jhash(code); document.cookie = "__js_p_"</script>`)).toBe("a JavaScript challenge");
  });

  it("does not take a normal page with a form CAPTCHA for a bot wall", () => {
    const home = `<html><head><title>Example Shop: shoes and bags</title></head><body><form><div class="g-recaptcha"></div></form></body></html>`;
    expect(ok(home, "text/html")).toEqual({ state: "none", html: true });
  });

  it("keeps the stored copy for a 304, and does not count it as no answer", () => {
    expect(answerOf({ status: 304, outcome: "not-modified", contentType: undefined, text: "User-agent: *\nDisallow:\n" })).toEqual({
      state: "file",
      html: false,
    });
  });

  it("puts a redirect loop, no response and a body that the crawler cannot decode with no answer", () => {
    expect(answerOf({ status: 302, outcome: "redirect", note: "location https://a.example/" })).toMatchObject({
      state: "unreachable",
      reason: "more than 5 redirects",
    });
    expect(answerOf({ status: 0, outcome: "error", note: "no response: getaddrinfo ENOTFOUND x.example" }).state).toBe("unreachable");
    expect(answerOf({ status: 200, outcome: "ok", contentType: "text/plain", note: "undecodable body" }).state).toBe("unreachable");
    expect(answerOf({ status: 200, outcome: "ok", contentType: "text/html", note: "undecodable body" })).toEqual({ state: "none", html: true });
  });
});

describe("the numbers of the study", () => {
  it("counts the refusals over the sites that answered, and over the sites with a file", () => {
    const gpt = agentRows(study).find((row) => row.token === "GPTBot");
    // 4 sites answered (2 files, 2 with no file); the blocked and the unreachable site do not count
    expect(gpt).toMatchObject({ byName: 1, byStar: 1, refused: 2, share: 50, fileShare: 100 });
  });

  it("counts each state, and the pairs of a training crawler and an agent for a person", () => {
    const summary = summarize(study);
    expect(summary).toMatchObject({ listSize: 6, answered: 4, withFile: 2, noFile: 2, html: 1, blocked: 1, unreachable: 1 });
    expect(summary.blockedStatuses).toEqual([{ status: 403, sites: 1 }]);
    expect(summary.trainingNotUser["OpenAI"]).toBe(1);
    expect(summary.blocksEveryBot).toBe(1);
    expect(summary.signals).toBe(1);
  });

  it("counts a site whose content signals disagree as mixed, not by its first line", () => {
    expect(summarize(study).signalValues).toEqual([
      { key: "search", yes: 1, no: 0, mixed: 0 },
      { key: "ai-input", yes: 0, no: 0, mixed: 0 },
      { key: "ai-train", yes: 0, no: 0, mixed: 1 },
    ]);
  });

  it("groups the agents of each company", () => {
    expect(companies(study)[0]).toEqual({
      owner: "OpenAI",
      agents: [
        { token: "GPTBot", role: "training", share: 50 },
        { token: "ChatGPT-User", role: "user", share: 25 },
      ],
    });
  });

  it("gives an axis that holds the largest value", () => {
    expect(niceMax(19)).toBe(20);
    expect(niceMax(22)).toBe(25);
    expect(niceMax(25)).toBe(25);
    expect(niceMax(0)).toBe(5);
    expect(ticks(25)).toEqual([0, 5, 10, 15, 20, 25]);
  });

  it("writes the date in one format", () => {
    expect(formatDay("2026-10-12T16:42:51.894Z")).toBe("12 October 2026");
  });
});

describe("the data for the browser and the CSV", () => {
  it("packs the sites for the page and unpacks them", () => {
    const sites = unpack(pack(study));
    expect(sites).toHaveLength(6);
    expect(sites[0]).toEqual({ rank: 1, domain: "a.example", state: "f", codes: "N.." });
    expect(sites[3]).toEqual({ rank: 4, domain: "d.example", state: "u", codes: "" });
    expect(sites[5]).toEqual({ rank: 6, domain: "f.example", state: "h", codes: "..." });
    expect(verdictOf(sites[4]!, 0)).toBe("B");
    expect(verdictOf(sites[3]!, 0)).toBe("U");
  });

  it("writes one row for each domain, with a verdict only for the sites that answered", () => {
    const lines = toCsv(study).trimEnd().split("\n");
    expect(lines[0]).toBe(
      "rank,domain,host,state,status,html,reason,bytes,groups,crawl_delay_s,content_signals,GPTBot,ChatGPT-User,PoliteCrawler",
    );
    expect(lines[1]).toBe("1,a.example,a.example,file,200,,,,,,,refused-named,permitted,permitted");
    expect(lines[2]).toContain(`"content-signal: ai-train=no, search=yes | content-signal: ai-train=yes"`);
    expect(lines[5]).toBe("5,e.example,e.example,blocked,403,,status 403,,,,,,,");
  });
});

describe("the dataset in the repository", () => {
  const real = data as unknown as Study;

  it("has one code for each agent and each site, and one of the four states", () => {
    expect(real.sites).toHaveLength(real.list.size);
    for (const site of real.sites) {
      expect(site.p).toHaveLength(real.agents.length);
      expect(["file", "none", "blocked", "unreachable"]).toContain(site.state);
    }
  });

  it("counts no 304 and no blocked site as a site that answered", () => {
    for (const site of real.sites) {
      if (site.status === 304) expect(site.state).toBe("file");
      if (site.state === "blocked") expect(site.p).toMatch(/^B+$/);
    }
  });

  it("has a CSV download that agrees with the JSON", () => {
    const csv = readFileSync(new URL("../../public/data/robots-study.csv", import.meta.url), "utf8");
    expect(csv).toBe(toCsv(real));
  });
});
