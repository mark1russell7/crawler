import { appendFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { MockAgent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import type { CaptureRecord } from "./record.ts";
import type { Renderer } from "./render.ts";
import { openCrawler } from "./open.ts";
import { fetchAndIndex, fetchPage, reindex } from "./runtime.ts";
import { fakeClock, removeDir, tempDir } from "./test-helpers.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Hit {
  readonly path: string;
  readonly headers: Record<string, string>;
}
type Answer = { status: number; body?: string; headers?: Record<string, string> };

/** A site on a mock agent: the handler sees each request and answers it. */
const site = (agent: MockAgent, origin: string, handler: (hit: Hit) => Answer): Hit[] => {
  const hits: Hit[] = [];
  agent
    .get(origin)
    .intercept({ path: () => true, method: "GET" })
    .reply((options) => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries((options.headers ?? {}) as Record<string, string>)) {
        headers[name.toLowerCase()] = String(value);
      }
      const hit = { path: options.path, headers };
      hits.push(hit);
      const answer = handler(hit);
      return { statusCode: answer.status, data: answer.body ?? "", responseOptions: { headers: answer.headers ?? {} } };
    })
    .persist();
  return hits;
};

const ROBOTS = "User-agent: *\nAllow: /\n";

const open = async (options: { renderer?: Renderer; extractors?: Parameters<typeof openCrawler>[0]["extractors"] } = {}) => {
  const dir = await tempDir("runtime");
  const agent = new MockAgent();
  agent.disableNetConnect();
  const clock = fakeClock();
  const crawler = openCrawler({
    dir,
    renderer: options.renderer ?? false,
    dispatcher: agent,
    clock,
    random: () => 0.5,
    ...(options.extractors !== undefined ? { extractors: options.extractors } : {}),
  });
  cleanups.push(() => removeDir(dir));
  cleanups.push(() => crawler.close());
  const records = async (): Promise<CaptureRecord[]> => {
    const rows: CaptureRecord[] = [];
    for await (const row of crawler.runtime.captures.scan({ source: "fetch" })) rows.push(row);
    return rows;
  };
  return { dir, agent, clock, crawler, records };
};

const html = (body: string, head = ""): string => `<!doctype html><html><head><title>Forno</title>${head}</head><body>${body}</body></html>`;
const PARAGRAPH = `<p>${"Wood-fired bread every morning. ".repeat(10)}</p>`;

describe("a page that changes", () => {
  it("shows its new text, and verify tells which capture holds a quote", async () => {
    const { agent, crawler } = await open();
    let version = 1;
    site(agent, "https://forno.example", (hit) => {
      if (hit.path === "/robots.txt") return { status: 200, body: ROBOTS };
      const body =
        version === 1
          ? html(`${PARAGRAPH}<p>Hours: Tuesday to Sunday.</p><p>We also cater weddings and large events.</p>`)
          : html(`${PARAGRAPH}<p>CLOSED PERMANENTLY</p>`);
      return { status: 200, body, headers: { "content-type": "text/html" } };
    });
    const first = await crawler.fetch("https://forno.example/");
    version = 2;
    const second = await crawler.fetch("https://forno.example/", { maxAge: "0s" });
    expect(second.captures).toHaveLength(1);
    expect(second).toMatchObject({ capture_count: 2, from_cache: false });
    const read = await crawler.read(second.doc!, { length: 20_000 });
    expect(read.text).toContain("CLOSED PERMANENTLY");
    expect(read.text).not.toContain("Tuesday to Sunday");
    expect(read.capture).toBe(second.captures[0]);
    expect(await crawler.find("permanently")).toHaveLength(1);
    // the removed sentence is only in the earlier capture
    const stale = await crawler.verify(second.doc!, "We also cater weddings");
    expect(stale).toMatchObject({ found: true, stale: true, capture: first.captures[0] });
    // a citation of the first capture stays true after the new fetch
    const pinned = await crawler.verify(second.doc!, "We also cater weddings", { capture: first.captures[0] });
    expect(pinned).toMatchObject({ found: true, stale: false, capture: first.captures[0] });
    expect(pinned.blob).toMatch(/^[0-9a-f]{64}$/);
    expect((await crawler.verify(second.doc!, "We also cater weddings", { capture: second.captures[0] })).found).toBe(false);
    expect(second.capture).toBe(second.captures[0]);
    const old = await crawler.read(second.doc!, { capture: first.captures[0], length: 20_000 });
    expect(old.text).toContain("Tuesday to Sunday");
    expect((await crawler.versions(second.doc!)).map((row) => row.capture)).toEqual([
      second.captures[0],
      first.captures[0],
    ]);
  });
});

describe("the cache after a rebuild", () => {
  it("answers a revalidated page with no request, with the status and the validators of the body", async () => {
    const { agent, crawler } = await open();
    const hits = site(agent, "https://bakery.example", (hit) => {
      if (hit.path === "/robots.txt") return { status: 200, body: ROBOTS };
      if (hit.headers["if-none-match"] === '"v1"') return { status: 304 };
      return { status: 200, body: html(PARAGRAPH), headers: { etag: '"v1"', "content-type": "text/html; charset=utf-8" } };
    });
    const pages = (): number => hits.filter((hit) => hit.path === "/").length;
    await crawler.fetch("https://bakery.example/");
    const revisit = await crawler.fetch("https://bakery.example/", { maxAge: "0s" });
    expect(revisit.outcome).toBe("not-modified");
    expect(pages()).toBe(2);
    const rebuilt = await crawler.reindex();
    expect(rebuilt).toMatchObject({ captures: 3, docs: 1, failed: 0, damaged: 0 });
    expect(crawler.runtime.index.latest("https://bakery.example/")).toMatchObject({
      status: 200,
      etag: '"v1"',
      content_type: "text/html; charset=utf-8",
    });
    const cached = await crawler.fetch("https://bakery.example/");
    expect(cached).toMatchObject({ from_cache: true, outcome: "ok" });
    expect(pages()).toBe(2);
  });

  it("keeps the content type of a plain text file through a 304, so it never becomes a page", async () => {
    const { agent, crawler } = await open();
    site(agent, "https://s.example", (hit) => {
      if (hit.path === "/robots.txt") return { status: 200, body: ROBOTS };
      if (hit.headers["if-none-match"] === '"t"') return { status: 304 };
      return { status: 200, body: "<b>notes</b>", headers: { etag: '"t"', "content-type": "text/plain" } };
    });
    expect((await crawler.fetch("https://s.example/notes.txt")).doc).toBeNull();
    const again = await crawler.fetch("https://s.example/notes.txt", { maxAge: "0s" });
    expect(again).toMatchObject({ outcome: "not-modified", doc: null });
    await crawler.reindex();
    expect(crawler.runtime.index.counts().docs).toBe(0);
  });
});

describe("an extractor that throws", () => {
  it("gives an error and no document, and a rebuild counts it and goes on", async () => {
    const { agent, crawler } = await open({
      extractors: {
        papers: (body) => {
          const parsed = JSON.parse(new TextDecoder().decode(body)) as { title: string };
          return [{ doc: "doi:1", kind: "paper", title: parsed.title, text: parsed.title, url: null, meta: {} }];
        },
      },
    });
    let maintenance = true;
    site(agent, "https://api.example", () =>
      maintenance
        ? { status: 200, body: "<html>maintenance</html>", headers: { "content-type": "text/html" } }
        : { status: 200, body: '{"title":"Bread"}', headers: { "content-type": "application/json" } },
    );
    const request = { url: "https://api.example/search?q=bread", mode: "api", recipe: "papers", minIntervalMs: 0 } as const;
    const broken = await fetchAndIndex(crawler.runtime, request);
    expect(broken.fetched.outcome).toBe("ok");
    expect(broken.docs).toEqual([]);
    expect(broken.error).toMatch(/^extract failed \(papers\): /);
    maintenance = false;
    const good = await fetchAndIndex(crawler.runtime, { ...request, url: "https://api.example/search?q=rye" });
    expect(good.docs.map((doc) => doc.doc)).toEqual(["doi:1"]);
    const rebuilt = await crawler.reindex();
    expect(rebuilt).toMatchObject({ failed: 1, docs: 1 });
    expect(rebuilt.errors[0]?.error).toMatch(/JSON|Unexpected/);
  });
});

describe("a rebuild", () => {
  it("leaves the index as it was when the log fails in the middle", async () => {
    const { agent, crawler } = await open();
    site(agent, "https://a.example", (hit) =>
      hit.path === "/robots.txt" ? { status: 200, body: ROBOTS } : { status: 200, body: html(PARAGRAPH), headers: { "content-type": "text/html" } },
    );
    await crawler.fetch("https://a.example/");
    const before = crawler.runtime.index.counts();
    const failing = {
      ...crawler.runtime,
      captures: {
        async *scan() {
          yield* crawler.runtime.captures.scan({ source: "fetch" });
          throw new Error("disk error");
        },
      },
    };
    await expect(reindex(failing)).rejects.toThrow("disk error");
    expect(crawler.runtime.index.counts()).toEqual(before);
    expect(await crawler.find("bread")).toHaveLength(1);
  });

  it("skips and counts a damaged line, and reads a month of 130,000 records", async () => {
    const { agent, crawler, dir } = await open();
    site(agent, "https://a.example", (hit) =>
      hit.path === "/robots.txt" ? { status: 200, body: ROBOTS } : { status: 200, body: html(PARAGRAPH), headers: { "content-type": "text/html" } },
    );
    await crawler.fetch("https://a.example/");
    await crawler.runtime.log.close();
    const shard = join(dir, "captures", "fetch", "2026");
    const [file] = await readdir(shard);
    const line = `${JSON.stringify({ id: "fetch.x", source: "fetch", kind: "skipped", received_at: "2026-10-07T12:00:00.000Z", payload: { url: "https://b.example/" } })}\n`;
    await appendFile(join(shard, file!), `{"torn":\n${line.repeat(130_000)}`);
    const rebuilt = await crawler.reindex();
    expect(rebuilt).toMatchObject({ captures: 2, docs: 1, damaged: 1 });
  }, 60_000);

  it("keeps the documents of a recipe that this runtime cannot read", async () => {
    const { crawler } = await open();
    crawler.runtime.index.upsert(
      { doc: "menu:rye", kind: "menu", title: "Rye", text: "rye bread", url: null, meta: {}, captures: ["app.1"], recipe: "menu" },
      "2026-10-07T12:00:00.000Z",
    );
    const rebuilt = await crawler.reindex();
    expect(rebuilt.carried).toBe(1);
    expect((await crawler.find("rye"))[0]?.doc).toBe("menu:rye");
  });
});

describe("a page that is a bot check", () => {
  it("is not a version of the document, and it stops the host as a challenge does", async () => {
    const { agent, crawler } = await open();
    let challenge = false;
    site(agent, "https://shop.example", (hit) => {
      if (hit.path === "/robots.txt") return { status: 200, body: ROBOTS };
      const body = challenge
        ? `<html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script></body></html>`
        : html(PARAGRAPH);
      return { status: 200, body, headers: { "content-type": "text/html" } };
    });
    const good = await crawler.fetch("https://shop.example/a");
    challenge = true;
    const blocked = await crawler.fetch("https://shop.example/a", { maxAge: "0s", render: "always" });
    expect(blocked).toMatchObject({ doc: null, rendered: false });
    expect(blocked.note).toContain("bot check (Cloudflare)");
    expect(blocked.note).toContain("the crawler does not render a bot check");
    // the earlier text stays
    expect((await crawler.read(good.doc!)).text).toContain("Wood-fired bread");
    const next = await crawler.fetch("https://shop.example/b");
    expect(next).toMatchObject({ outcome: "skipped" });
    expect(next.note).toMatch(/^host stopped until .*: challenge \(Cloudflare\)$/);
  });
});

describe("the render rules of a page", () => {
  const browser = (): Renderer & { asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      render: (url) => {
        asked.push(url);
        return Promise.resolve({ html: html("<p>shown</p>"), finalUrl: url, status: 200, headers: {} });
      },
      close: () => Promise.resolve(),
    };
  };

  it("never renders a PDF, and follows a meta refresh with a plain fetch", async () => {
    const renderer = browser();
    const { agent, crawler } = await open({ renderer });
    site(agent, "https://docs.example", (hit) => {
      if (hit.path === "/robots.txt") return { status: 200, body: ROBOTS };
      if (hit.path === "/old") {
        return { status: 200, body: html("", '<meta http-equiv="refresh" content="0; url=/new">'), headers: { "content-type": "text/html" } };
      }
      if (hit.path === "/file.pdf") return { status: 200, body: "%PDF-1.4 broken", headers: { "content-type": "application/pdf" } };
      return { status: 200, body: html(PARAGRAPH), headers: { "content-type": "text/html" } };
    });
    const pdf = await fetchPage(crawler.runtime, "https://docs.example/file.pdf", { render: "always" });
    expect(pdf.rendered).toBe(false);
    expect(pdf.note).toContain("renders only an HTML page");
    const moved = await crawler.fetch("https://docs.example/old", { render: "never" });
    expect(moved.doc).toBe("url:https://docs.example/new");
    expect(moved.note).toContain("the page sends the reader on to https://docs.example/new");
    expect(renderer.asked).toEqual([]);
  });
});

describe("a page that asked not to be AI input", () => {
  const PAGE = html(
    `<p>BODY-ONLY: the access code is 7319 and the vault opens at noon.</p><p><a href="/memo">LINKTEXT-LEAK memo</a></p>`,
    `<meta name="description" content="DESCRIPTION-LEAK"><script type="application/ld+json">{"@type":"Article","articleBody":"JSONLD-LEAK"}</script>`,
  );

  it("is held back in the fetch, the read, the search and the verification, unless a person gave its URL", async () => {
    const { agent, crawler, records } = await open();
    site(agent, "https://news.example", (hit) =>
      hit.path === "/robots.txt"
        ? { status: 200, body: ROBOTS }
        : { status: 200, body: PAGE, headers: { "content-type": "text/html", "content-signal": "ai-input=no" } },
    );
    const page = await crawler.fetch("https://news.example/a");
    expect(page).toMatchObject({ held_back: true, title: null });
    const read = await crawler.read(page.doc!);
    expect(read).toMatchObject({ held_back: true, text: "", title: "" });
    expect(JSON.stringify(read.meta)).not.toMatch(/LEAK/);
    expect(read.meta["jsonld_types"]).toEqual(["Article"]);
    expect(await crawler.find("vault")).toEqual([]);
    expect(crawler.runtime.index.rankWithin("vault", [page.doc!])).toEqual([]);
    expect(await crawler.verify(page.doc!, "the access code is 7319")).toMatchObject({ found: false, held_back: true, start: null });
    expect(await crawler.verify(page.doc!, "the access code is 0000")).toMatchObject({ found: false, held_back: true, start: null });
    const unlocked = await crawler.read(page.doc!, { userProvided: true });
    expect(unlocked.text).toContain("BODY-ONLY");
    expect(unlocked.meta["description"]).toBe("DESCRIPTION-LEAK");
    expect((await crawler.verify(page.doc!, "the access code is 7319", { userProvided: true })).found).toBe(true);
    await crawler.runtime.log.flush();
    const overrides = (await records()).filter((row) => row.kind === "override");
    expect(overrides.length).toBeGreaterThanOrEqual(1);
  });
});

describe("the freshness of a result", () => {
  it("says when the text was fetched and if the store answered", async () => {
    const { agent, crawler } = await open();
    site(agent, "https://a.example", (hit) =>
      hit.path === "/robots.txt" ? { status: 200, body: ROBOTS } : { status: 200, body: html(PARAGRAPH), headers: { "content-type": "text/html" } },
    );
    const first = await crawler.fetch("https://a.example/?utm_source=mail");
    expect(first).toMatchObject({ from_cache: false, fetched_at: "2026-10-07T12:00:01.000Z" });
    // the tracking parameter is not part of the cache key
    const second = await crawler.fetch("https://a.example/");
    expect(second).toMatchObject({ from_cache: true, fetched_at: first.fetched_at, doc: first.doc });
    const read = await crawler.read(first.doc!);
    expect(read.fetched_at).toBe(first.fetched_at);
  });
});
