import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MockAgent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "./mcp.ts";
import type { PoliteCrawler } from "./open.ts";
import { defaultUserAgent, durationMs, openCrawler } from "./open.ts";

const HTML = `<!doctype html><html lang="en"><head><title>Forno Esempio</title>
<script type="application/ld+json">{"@type":"Restaurant","name":"Forno Esempio"}</script></head>
<body><h1>Forno Esempio</h1><p>${"Wood-fired bread, baked every morning before dawn. ".repeat(6)}</p>
<h2>Hours</h2><p>Tuesday to Sunday 7am–3pm</p></body></html>`;

let dir: string | undefined;
let crawler: PoliteCrawler | undefined;

afterEach(async () => {
  await crawler?.close();
  crawler = undefined;
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const setup = async (robots = "User-agent: *\nAllow: /\n") => {
  dir = await mkdtemp(join(tmpdir(), "polite-crawler-open-"));
  const agent = new MockAgent();
  agent.disableNetConnect();
  const site = agent.get("https://bakery.example");
  site.intercept({ path: "/robots.txt" }).reply(200, robots).persist();
  site
    .intercept({ path: "/" })
    .reply(200, HTML, { headers: { "content-type": "text/html; charset=utf-8" } })
    .persist();
  crawler = openCrawler({ dir, renderer: false, dispatcher: agent });
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

    const [hit] = polite.find("wood fired bread");
    expect(hit?.doc).toBe(page.doc);
    const read = await polite.read(page.doc!, { length: 200 });
    expect(read.text).toContain("Forno Esempio");
    expect(read.held_back).toBe(false);
    expect(polite.verify(page.doc!, "Tuesday to Sunday 7am–3pm").found).toBe(true);
    expect(polite.verify(page.doc!, "Monday").found).toBe(false);

    const rebuilt = await polite.reindex();
    expect(rebuilt).toMatchObject({ docs: 1 });
    expect(polite.find("dawn")[0]?.doc).toBe(page.doc);
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
    expect(() => durationMs("soon")).toThrow(/not a duration/);
  });
});

describe("the MCP server", () => {
  it("offers four tools, and its fetch and find work over the protocol", async () => {
    const polite = await setup();
    const server = createMcpServer(polite);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "crawl_fetch",
        "crawl_find",
        "crawl_read",
        "crawl_verify",
      ]);
      const fetched = await client.callTool({
        name: "crawl_fetch",
        arguments: { urls: ["https://bakery.example/"] },
      });
      const [page] = JSON.parse((fetched.content as Array<{ text: string }>)[0]!.text) as Array<{
        doc: string;
        outcome: string;
      }>;
      expect(page?.outcome).toBe("ok");
      const found = await client.callTool({ name: "crawl_find", arguments: { q: "bread" } });
      expect((found.content as Array<{ text: string }>)[0]!.text).toContain(page!.doc);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
