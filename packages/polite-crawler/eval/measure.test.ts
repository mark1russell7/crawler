import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import type { Clock } from "../src/index.ts";
import { exportWacz, openCrawler } from "../src/index.ts";
import { readWacz } from "./archive.mts";
import type { Claim } from "./measure.mts";
import { measure, readClaims } from "./measure.mts";

// The offline mode of the eval on a small WACZ file that the test makes. No request goes to the network.

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

const tempDir = async (tag: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), `polite-crawler-eval-${tag}-`));
  dirs.push(dir);
  return dir;
};

const QUOTE = "The harbor bell rings twelve times at noon";
const words = (n: number): string =>
  Array.from({ length: n }, (_, at) => `word${String(at % 97)}`).join(" ");
const nav = Array.from(
  { length: 40 },
  (_, at) => `<li><a href="/n/${String(at)}">Menu ${String(at)}</a></li>`,
).join("");
const LONG = `<!doctype html><html lang="en"><head><title>The harbor</title>
<style>.x{color:red}</style><script>var tracking = "${"x".repeat(2000)}";</script></head>
<body><nav><ul>${nav}</ul></nav><main><h1>The harbor</h1>
${Array.from({ length: 30 }, (_, at) => `<p>Paragraph ${String(at)}: ${words(60)}.</p>`).join("\n")}
<p>${QUOTE}, and the boats answer.</p>
${Array.from({ length: 30 }, (_, at) => `<p>Later paragraph ${String(at)}: ${words(60)}.</p>`).join("\n")}
</main></body></html>`;
// The reader cuts the text at 50,000 characters, so the quote of this page is only in the whole text.
const HUGE = `<!doctype html><html lang="en"><head><title>The long harbor</title></head><body><main>
${Array.from({ length: 150 }, (_, at) => `<p>Paragraph ${String(at)}: ${words(60)}.</p>`).join("\n")}
<p>${QUOTE}, far down the page.</p>
${Array.from({ length: 50 }, (_, at) => `<p>Later paragraph ${String(at)}: ${words(60)}.</p>`).join("\n")}
</main></body></html>`;
const SHORT = `<!doctype html><html lang="en"><head><title>A note</title></head><body><p>A short note about the harbor.</p></body></html>`;

const startClock = (): Clock => {
  let now = Date.parse("2026-10-17T12:00:00Z");
  return {
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
  };
};

/** This function makes a WACZ file of a store with two pages and a redirect, from a mock site. */
const makeWacz = async (): Promise<string> => {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent
    .get("https://docs.example")
    .intercept({ path: () => true, method: "GET" })
    .reply((request) => {
      if (request.path === "/robots.txt") {
        return { statusCode: 200, data: "User-agent: *\nAllow: /\n" };
      }
      if (request.path === "/old") {
        return { statusCode: 301, data: "", responseOptions: { headers: { location: "/long" } } };
      }
      const body = { "/long": LONG, "/short": SHORT, "/huge": HUGE }[request.path];
      if (body === undefined) return { statusCode: 404, data: "no such page" };
      return {
        statusCode: 200,
        data: body,
        responseOptions: { headers: { "content-type": "text/html; charset=utf-8" } },
      };
    })
    .persist();
  const dir = await tempDir("store");
  const crawler = openCrawler({ dir, renderer: false, dispatcher: agent, clock: startClock() });
  const out = join(await tempDir("wacz"), "eval.wacz");
  try {
    for (const path of ["/long", "/short", "/old", "/huge"]) {
      const page = await crawler.fetch(`https://docs.example${path}`);
      expect(page.outcome).toBe("ok");
    }
    await exportWacz(crawler.runtime, { out, includeRefusals: true });
  } finally {
    await crawler.close();
    await agent.close();
  }
  return out;
};

const CLAIMS: Claim[] = [
  {
    id: "long-bell",
    source: "test",
    url: "https://docs.example/long",
    question: "When does the harbor bell ring?",
    quote: QUOTE,
  },
  {
    id: "old-bell",
    source: "test",
    url: "https://docs.example/old",
    question: "harbor bell noon",
    quote: QUOTE,
  },
  {
    id: "short-missing",
    source: "test",
    url: "https://docs.example/short",
    question: "What does the note say?",
    quote: "a sentence that the note does not hold",
  },
  {
    id: "other-site",
    source: "test",
    url: "https://other.example/page",
    question: "What is on the other site?",
    quote: "anything at all",
  },
  {
    id: "huge-bell",
    source: "test",
    url: "https://docs.example/huge",
    question: "harbor bell",
    quote: QUOTE,
  },
];

describe("the eval, offline", () => {
  it("reads the responses and the redirect of a WACZ file", async () => {
    const archive = await readWacz(await makeWacz());
    expect([...archive.responses.keys()].sort()).toEqual([
      "https://docs.example/huge",
      "https://docs.example/long",
      "https://docs.example/robots.txt",
      "https://docs.example/short",
    ]);
    expect(archive.redirects.get("https://docs.example/old")).toMatchObject({
      status: 301,
      location: "https://docs.example/long",
    });
    expect(archive.responses.get("https://docs.example/long")?.body.toString("utf8")).toBe(LONG);
  });

  it("measures the claims, reports the failures and gives the same numbers again", async () => {
    const wacz = await makeWacz();
    const first = await measure({ wacz, claims: CLAIMS, window: 500 });
    const second = await measure({ wacz, claims: CLAIMS, window: 500 });
    expect(second).toEqual(first);

    const [long, old, short, other, huge] = first.claims;
    expect(long).toMatchObject({ verified: true, failure: null, read_window: "quote" });
    expect(long!.find_rank).not.toBeNull();
    expect(old).toMatchObject({ verified: true, doc: long!.doc });
    expect(short).toMatchObject({ verified: false });
    expect(short!.failure).toMatch(/not in the stored text/);
    expect(other).toMatchObject({ verified: false, doc: null });
    expect(other!.failure).toMatch(/^no page/);

    // the agent reads the tool results; the proxy reads the whole page, without its scripts and styles
    expect(long!.polite.total.tokens).toBe(
      long!.polite.fetch.tokens +
        long!.polite.find.tokens +
        long!.polite.read.tokens +
        long!.polite.verify.tokens,
    );
    expect(long!.polite.read.chars).toBeGreaterThan(500);
    expect(long!.polite.read.chars).toBeLessThan(2500);
    expect(long!.webfetch.markdown.quote_found).toBe(true);
    expect(long!.webfetch.markdown.chars).toBeGreaterThan(20_000);
    expect(long!.paged.reads).toBeGreaterThan(1);
    expect(long!.paged.tokens).toBeGreaterThan(long!.polite.total.tokens);

    // crawl_read cannot reach a quote past the cut, and crawl_verify still finds it
    expect(huge).toMatchObject({ verified: true, read_window: "past-cut" });
    expect(huge!.polite.read).toEqual({ chars: 0, tokens: 0 });
    expect(huge!.paged.reads).toBe(13);

    expect(first.summary).toMatchObject({ claims: 5, verified: 3, failed: 2, past_cut: 1 });
    expect(first.summary.ratio.markdown_total).toBeGreaterThan(1);
    expect(first.tool_definitions.tokens).toBeGreaterThan(0);
    // the other site is not in the archive: the replay answers 404, and sends no request
    expect(first.replay.map((page) => page.outcome)).toEqual(["ok", "ok", "ok", "not-found", "ok"]);
  });

  it("refuses a question set that is not valid", () => {
    expect(() => readClaims(JSON.stringify({ claims: [] }))).toThrow(/no claims/);
    expect(() =>
      readClaims(
        JSON.stringify({
          claims: [
            { id: "a", source: "s", url: "https://a.example/", question: "q", quote: "quote" },
            { id: "a", source: "s", url: "https://a.example/", question: "q", quote: "quote" },
          ],
        }),
      ),
    ).toThrow(/not unique/);
    expect(() =>
      readClaims(
        JSON.stringify({
          claims: [{ id: "a", source: "s", url: "ftp://a.example/", question: "q", quote: "quo" }],
        }),
      ),
    ).toThrow(/not http/);
  });
});
