import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MockAgent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import type { PoliteCrawler } from "./open.ts";
import { defaultUserAgent, durationMs, openCrawler } from "./open.ts";
import { fakeClock, removeDir, tempDir } from "./test-helpers.ts";

const HTML = `<!doctype html><html lang="en"><head><title>Forno Esempio</title>
<script type="application/ld+json">{"@type":"Restaurant","name":"Forno Esempio"}</script></head>
<body><h1>Forno Esempio</h1><p>${"Wood-fired bread, baked every morning before dawn. ".repeat(6)}</p>
<h2>Hours</h2><p>Tuesday to Sunday 7am–3pm</p></body></html>`;

let dir: string | undefined;
let crawler: PoliteCrawler | undefined;

afterEach(async () => {
  await crawler?.close();
  crawler = undefined;
  if (dir !== undefined) await removeDir(dir);
  dir = undefined;
});

const setup = async (robots = "User-agent: *\nAllow: /\n") => {
  dir = await tempDir("open");
  const agent = new MockAgent();
  agent.disableNetConnect();
  const site = agent.get("https://bakery.example");
  site.intercept({ path: "/robots.txt" }).reply(200, robots).persist();
  site
    .intercept({ path: "/" })
    .reply(200, HTML, { headers: { "content-type": "text/html; charset=utf-8" } })
    .persist();
  // a clock of the test: the pace of robots.txt and the page passes with no real wait
  const clock = fakeClock();
  crawler = openCrawler({ dir, renderer: false, dispatcher: agent, clock });
  return crawler;
};

describe("openCrawler", () => {
  it("fetches a page once, then finds, reads and verifies it from the store", async () => {
    const polite = await setup();
    const page = await polite.fetch("https://bakery.example/");
    expect(page).toMatchObject({ outcome: "ok", status: 200, title: "Forno Esempio" });
    expect(page.structured).toContain("Restaurant");
    const again = await polite.fetch("https://bakery.example/");
    expect(again.captures).toEqual(page.captures);

    const [hit] = await polite.find("wood fired bread");
    expect(hit?.doc).toBe(page.doc);
    const read = await polite.read(page.doc!, { length: 200 });
    expect(read.text).toContain("Forno Esempio");
    expect(read.held_back).toBe(false);
    expect((await polite.verify(page.doc!, "Tuesday to Sunday 7am–3pm")).found).toBe(true);
    expect((await polite.verify(page.doc!, "Monday")).found).toBe(false);

    const rebuilt = await polite.reindex();
    expect(rebuilt).toMatchObject({ docs: 1 });
    expect((await polite.find("dawn"))[0]?.doc).toBe(page.doc);
  });

  it("obeys robots.txt, and says so", async () => {
    const polite = await setup("User-agent: *\nDisallow: /\n");
    const page = await polite.fetch("https://bakery.example/");
    expect(page.outcome).toBe("skipped");
    expect(page.note).toBe("robots.txt disallows it for PoliteCrawler");
  });

  it("names itself and its page in the User-Agent", () => {
    expect(defaultUserAgent()).toMatch(
      /^PoliteCrawler\/\d+\.\d+\.\d+ \(\+https:\/\/mark1russell7\.github\.io\/crawler\/bot\/\)$/,
    );
    expect(defaultUserAgent("ops@example.com")).toContain("; ops@example.com)");
  });

  it("reads durations", () => {
    expect(durationMs("24h")).toBe(86_400_000);
    expect(durationMs("30m")).toBe(1_800_000);
    expect(durationMs(" 7d ")).toBe(604_800_000);
    expect(durationMs(5000)).toBe(5000);
    expect(durationMs("0")).toBe(0);
    expect(durationMs("0s")).toBe(0);
    expect(durationMs("2H")).toBe(7_200_000);
    expect(() => durationMs("soon")).toThrow(/not a duration/);
    // a month is not a unit: M is an error, not minutes
    expect(() => durationMs("1M")).toThrow(/m is minutes/);
  });

  it("never throws before its promise, closes once, and refuses work after the close", async () => {
    const polite = await setup();
    const bad = polite.fetch("https://bakery.example/", { maxAge: "1mo" });
    await expect(bad).rejects.toThrow(/not a duration/);
    const page = await polite.fetch("https://bakery.example/");
    await expect(polite.read(page.doc!, { from: -10 })).rejects.toThrow(RangeError);
    await expect(polite.read(page.doc!, { length: Number.NaN })).rejects.toThrow(RangeError);
    const end = await polite.read(page.doc!, { from: 1_000_000 });
    expect(end).toMatchObject({ text: "" });
    expect(end.from).toBe(end.total);
    await polite.close();
    await polite.close();
    await expect(polite.fetch("https://bakery.example/")).rejects.toThrow(/closed/);
    await expect(polite.read(page.doc!)).rejects.toThrow(/closed/);
    await expect(polite.find("bread")).rejects.toThrow(/closed/);
    await expect(polite.verify(page.doc!, "bread")).rejects.toThrow(/closed/);
  });

  it("rebuilds an index of an earlier version when it opens", async () => {
    const polite = await setup();
    const page = await polite.fetch("https://bakery.example/");
    await polite.close();
    crawler = undefined;
    // the file as version 0.1 left it: other tables, and no schema version
    const path = join(dir!, "index.sqlite");
    for (const suffix of ["-wal", "-shm"]) await removeDir(`${path}${suffix}`);
    await removeDir(path);
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE docs (doc TEXT PRIMARY KEY, text TEXT)");
    old.close();
    crawler = openCrawler({ dir: dir!, renderer: false, clock: fakeClock() });
    const read = await crawler.read(page.doc!);
    expect(read.text).toContain("Forno Esempio");
  });

  it.skipIf(process.platform === "win32")("refuses a part of the store that is a symbolic link", async () => {
    const root = await tempDir("open");
    dir = root;
    const elsewhere = join(root, "elsewhere");
    await mkdir(join(root, "store"), { recursive: true });
    await mkdir(elsewhere);
    await symlink(elsewhere, join(root, "store", "blobs"));
    expect(() => openCrawler({ dir: join(root, "store"), renderer: false })).toThrow(/symbolic link/);
  });
});
