import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CrawlSummary } from "./frontier.ts";
import { realClock } from "./politeness.ts";
import { removeDir, runCli, tempDir } from "./test-surfaces.ts";
import type { Reply } from "./test-site.ts";
import { htmlPage, pagesOf, testSite, urlset } from "./test-site.ts";

// The command line of discover and crawl. It runs in a child process on the real clock, so its tests
// fetch few pages. polite-crawler-mcp tests the MCP tools.

const SLOW = 60_000;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const site = async (
  route: (path: string, origin: string) => Reply | undefined,
  clock = realClock,
  robots?: string,
) => {
  const made = await testSite(route, clock, robots);
  cleanups.push(() => made.close());
  return made;
};

const store = async (): Promise<string> => {
  const dir = await tempDir("crawl-cli");
  cleanups.push(() => removeDir(dir));
  return dir;
};

describe("the command line: discover and crawl", () => {
  it(
    "lists the URLs of the sitemaps, and gives 1 when it finds none",
    async () => {
      const local = await site((path, origin) => {
        if (path === "/robots.txt")
          return {
            type: "text/plain",
            body: `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`,
          };
        if (path === "/sitemap.xml")
          return {
            type: "application/xml",
            body: urlset([[`${origin}/a`, "2026-10-01"], [`${origin}/b`]]),
          };
        return undefined;
      });
      const dir = await store();
      const found = await runCli([
        "discover",
        local.origin,
        "--dir",
        dir,
        "--allow-private",
        "--no-browser",
      ]);
      expect(found.stderr).toBe("");
      expect(found.code).toBe(0);
      expect(found.stdout.trim().split("\n")).toEqual([
        `${local.origin}/a  2026-10-01`,
        `${local.origin}/b`,
        "2 URLs from 1 of 1 files (done)",
      ]);

      const closed = await site(() => undefined, realClock, "User-agent: *\nDisallow: /\n");
      const none = await runCli([
        "discover",
        closed.origin,
        "--dir",
        dir,
        "--allow-private",
        "--json",
      ]);
      expect(none.code).toBe(1);
      expect(JSON.parse(none.stdout)).toMatchObject({ urls: [], stopped: "done" });
      expect(pagesOf(closed)).toEqual([]);
    },
    SLOW,
  );

  it(
    "crawls with its limits, prints the summary, and gives 1 when it gets no page",
    async () => {
      const local = await site((path) =>
        path === "/" ? { type: "text/html", body: htmlPage("Home", ["/a", "/b"]) } : undefined,
      );
      const dir = await store();
      const crawled = await runCli([
        "crawl",
        `${local.origin}/`,
        "--max-depth",
        "0",
        "--budget",
        "1m",
        "--dir",
        dir,
        "--allow-private",
        "--no-browser",
        "--json",
      ]);
      expect(crawled.code).toBe(0);
      const out = JSON.parse(crawled.stdout) as { pages: unknown[]; summary: CrawlSummary };
      expect(out.pages).toHaveLength(1);
      expect(out.summary).toMatchObject({
        pages: 1,
        fetched: 1,
        stopped: "done",
        skips: { depth: 2 },
      });
      expect(pagesOf(local)).toEqual(["/"]);

      const closed = await site(() => undefined, realClock, "User-agent: *\nDisallow: /\n");
      const refused = await runCli(["crawl", `${closed.origin}/`, "--dir", dir, "--allow-private"]);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toContain("robots.txt disallows it for PoliteCrawler");
      expect(refused.stdout).toContain("0 fetched");
    },
    SLOW,
  );

  it(
    "gives 2 for a wrong command line, and opens no store",
    async () => {
      const dir = await store();
      for (const [args, message] of [
        [["crawl", "https://example.com/", "--budget", "soon"], "--budget: not a duration"],
        [
          ["discover", "https://example.com/", "--max-pages", "3"],
          "--max-pages is an option of crawl",
        ],
        [
          ["fetch", "https://example.com/", "--allow-host", "a.example"],
          "--allow-host is an option of crawl or discover",
        ],
        [["discover", "https://a.example/", "https://b.example/"], "discover wants one site URL"],
      ] as const) {
        const ran = await runCli([...args, "--dir", join(dir, "never")]);
        expect(ran.code).toBe(2);
        expect(ran.stderr).toContain(message);
      }
      expect(existsSync(join(dir, "never"))).toBe(false);
    },
    SLOW,
  );
});
