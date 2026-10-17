import { MockAgent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import type { DocInput, ReadingIndex } from "./docs.ts";
import { DocIndex } from "./docs.ts";
import { openCrawler } from "./open.ts";
import type { CrawlRuntime } from "./runtime.ts";
import { versionAtTime } from "./runtime.ts";
import { fakeClock, removeDir, tempDir } from "./test-helpers.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const DOC = "url:https://forno.example/";

const version = (
  capture: string,
  at: string,
  text: string,
  extra: Partial<DocInput> = {},
): DocInput => ({
  doc: DOC,
  kind: "page",
  title: "Forno",
  text,
  url: "https://forno.example/",
  meta: {},
  captures: [capture],
  capture,
  fetched_at: at,
  recipe: "page",
  ...extra,
});

const memory = (): DocIndex => {
  const index = new DocIndex(":memory:");
  cleanups.push(() => index.close());
  return index;
};

const later = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();

describe("the version at a time", () => {
  // renders, a plain body that changes under a render, a second recipe and a no for AI input
  const history: DocInput[] = [
    version("fetch.p1", "2026-10-01T00:00:00.000Z", "shell", { blob: "b1" }),
    version("fetch.r1", "2026-10-01T01:00:00.000Z", "Menu with the soup of the day", {
      rendered: true,
      blob: "r1",
    }),
    version("fetch.p2", "2026-10-02T00:00:00.000Z", "shell", { blob: "b1" }),
    version("fetch.p3", "2026-10-03T00:00:00.000Z", "a new shell", { blob: "b3" }),
    version("api.a1", "2026-10-04T00:00:00.000Z", "A much longer text from the API of the place", {
      recipe: "api",
    }),
    version("fetch.p4", "2026-10-05T00:00:00.000Z", "a shell that refuses", {
      blob: "b4",
      ai_input: "no",
    }),
    version("fetch.p5", "2026-10-06T00:00:00.000Z", "the shell again", { blob: "b5" }),
  ];

  it("is the version that was current then, with the rules of the index, in any order of upserts", () => {
    // the index that grows in time order gives the current version after each capture
    const growing = memory();
    const snapshots = history.map((input) => {
      const doc = growing.upsert(input, input.fetched_at!);
      return { at: input.fetched_at!, capture: doc.capture, held: doc.ai_input === "no" };
    });
    expect(snapshots.map((one) => one.capture)).toEqual([
      "fetch.p1",
      "fetch.r1",
      "fetch.r1",
      "fetch.p3",
      "api.a1",
      "api.a1",
      "api.a1",
    ]);
    // a full index that got the captures out of order gives each of those versions at its time
    const full = memory();
    for (const input of [...history].reverse()) full.upsert(input, "2026-10-07T00:00:00.000Z");
    for (const [at, snapshot] of snapshots.entries()) {
      const next = snapshots[at + 1]?.at ?? "2026-12-01T00:00:00.000Z";
      for (const time of [snapshot.at, later(snapshot.at, 1), later(next, -1)]) {
        const found = full.versionAt(DOC, time);
        expect(found.first).toBe("2026-10-01T00:00:00.000Z");
        expect(found.version?.capture).toBe(snapshot.capture);
        expect(found.version?.ai_input === "no").toBe(snapshot.held);
      }
    }
    expect(full.versionAt(DOC, "2026-09-30T23:59:59.999Z")).toEqual({
      version: undefined,
      first: "2026-10-01T00:00:00.000Z",
    });
    expect(full.versionAt("url:https://none.example/", "2026-10-02T00:00:00.000Z")).toEqual({
      version: undefined,
      first: undefined,
    });
  });

  it("is the newest version at or before the time, for an index with no versionAt", () => {
    const index = memory();
    for (const input of history.slice(0, 4)) index.upsert(input, input.fetched_at!);
    const plain: ReadingIndex = {
      get stale() {
        return false;
      },
      get: (doc) => index.get(doc),
      upsert: (input, now) => index.upsert(input, now),
      versions: (doc, options) => index.versions(doc, options),
      versionText: (doc, capture) => index.versionText(doc, capture),
      earlierTexts: (doc, options) => index.earlierTexts(doc, options),
      docsOfCapture: (capture) => index.docsOfCapture(capture),
      hasVersion: (capture) => index.hasVersion(capture),
      find: (q, options) => index.find(q, options),
      rankWithin: (q, docs, options) => index.rankWithin(q, docs, options),
      latest: (url, variant) => index.latest(url, variant),
      setLatest: (entry) => index.setLatest(entry),
      newestFetch: () => index.newestFetch(),
      counts: () => index.counts(),
      beginRebuild: (options) => index.beginRebuild(options),
    };
    const runtime = { index: plain } as unknown as CrawlRuntime;
    expect(versionAtTime(runtime, DOC, "2026-10-02T12:00:00.000Z").version?.capture).toBe(
      "fetch.p2",
    );
    expect(versionAtTime(runtime, DOC, "2026-09-01T00:00:00.000Z")).toEqual({
      version: undefined,
      first: "2026-10-01T00:00:00.000Z",
    });
    // the index with versionAt applies the render rule: the render stays current over the same body
    expect(
      versionAtTime({ index } as unknown as CrawlRuntime, DOC, "2026-10-02T12:00:00.000Z").version
        ?.capture,
    ).toBe("fetch.r1");
  });
});

// ── read and verify at a time, over a crawler ──

const html = (body: string): string =>
  `<!doctype html><html><head><title>Forno</title></head><body>${body}</body></html>`;
const PARAGRAPH = `<p>${"Wood-fired bread every morning. ".repeat(10)}</p>`;

/** This function opens a crawler on a mock site whose page the test changes. */
const open = async () => {
  const dir = await tempDir("timetravel");
  const agent = new MockAgent();
  agent.disableNetConnect();
  const clock = fakeClock();
  const crawler = openCrawler({
    dir,
    renderer: false,
    dispatcher: agent,
    clock,
    random: () => 0.5,
  });
  cleanups.push(() => removeDir(dir));
  cleanups.push(() => crawler.close());
  const page = {
    body: html(PARAGRAPH),
    headers: { "content-type": "text/html" } as Record<string, string>,
  };
  agent
    .get("https://forno.example")
    .intercept({ path: () => true, method: "GET" })
    .reply((options) =>
      options.path === "/robots.txt"
        ? { statusCode: 200, data: "User-agent: *\nAllow: /\n" }
        : { statusCode: 200, data: page.body, responseOptions: { headers: page.headers } },
    )
    .persist();
  return { crawler, clock, page };
};

describe("read and verify with at", () => {
  it("use the version that was current at the time, before, between and after the captures", async () => {
    const { crawler, clock, page } = await open();
    page.body = html(`${PARAGRAPH}<p>We also cater weddings.</p>`);
    const first = await crawler.fetch("https://forno.example/");
    clock.advance(86_400_000);
    page.body = html(`${PARAGRAPH}<p>CLOSED PERMANENTLY</p>`);
    const second = await crawler.fetch("https://forno.example/", { maxAge: "0s" });
    const doc = second.doc!;
    const t1 = first.fetched_at!;
    const t2 = second.fetched_at!;

    const before = await crawler.read(doc, { at: later(t1, -60_000) });
    expect(before).toMatchObject({
      before_first: true,
      at: later(t1, -60_000),
      text: "",
      capture: "",
      held_back: false,
    });
    expect(before.note).toBe(
      `the document ${doc} has no version at ${later(t1, -60_000)} or before: its first capture is from ${t1}`,
    );
    const between = await crawler.read(doc, {
      at: new Date(Date.parse(t1) + 3_600_000),
      length: 20_000,
    });
    expect(between).toMatchObject({ before_first: false, capture: first.capture, fetched_at: t1 });
    expect(between.text).toContain("We also cater weddings");
    const after = await crawler.read(doc, { at: later(t2, 1), length: 20_000 });
    expect(after).toMatchObject({ capture: second.capture, fetched_at: t2 });
    expect(after.text).toContain("CLOSED PERMANENTLY");
    // a date with no time is the start of the day in UTC
    expect((await crawler.read(doc, { at: "2026-10-07" })).before_first).toBe(true);
    // a read with no at has no fields of a time
    expect(await crawler.read(doc)).not.toHaveProperty("before_first");

    const quote = "We also cater weddings";
    expect(await crawler.verify(doc, quote, { at: later(t1, 1) })).toMatchObject({
      found: true,
      stale: false,
      capture: first.capture,
      at: later(t1, 1),
      before_first: false,
    });
    // at examines one version only: the earlier text does not answer for a later time
    expect(await crawler.verify(doc, quote, { at: t2 })).toMatchObject({
      found: false,
      capture: second.capture,
      stale: false,
    });
    expect(await crawler.verify(doc, quote, { at: "2026-10-01" })).toMatchObject({
      found: false,
      before_first: true,
      capture: null,
    });

    await expect(crawler.read(doc, { at: t2, capture: first.capture! })).rejects.toThrow(
      /give capture or at, not the two/,
    );
    await expect(crawler.verify(doc, quote, { at: "tomorrow" })).rejects.toThrow(RangeError);
    await expect(crawler.read("url:https://none.example/", { at: t2 })).rejects.toThrow(
      /no stored document/,
    );
  });

  it("hold back a version that was held back at the time, and each version of a document held back now", async () => {
    const { crawler, clock, page } = await open();
    page.body = html(`${PARAGRAPH}<p>BODY-ONLY the access code is 7319.</p>`);
    page.headers = { "content-type": "text/html", "content-signal": "ai-input=no" };
    const first = await crawler.fetch("https://forno.example/");
    clock.advance(86_400_000);
    page.body = html(`${PARAGRAPH}<p>An open page.</p>`);
    page.headers = { "content-type": "text/html" };
    const second = await crawler.fetch("https://forno.example/", { maxAge: "0s" });
    expect(second.held_back).toBe(false);
    const doc = second.doc!;

    const then = await crawler.read(doc, { at: later(first.fetched_at!, 1) });
    expect(then).toMatchObject({ held_back: true, text: "", title: "", capture: first.capture });
    expect(
      await crawler.verify(doc, "the access code is 7319", { at: later(first.fetched_at!, 1) }),
    ).toMatchObject({ found: false, held_back: true, start: null });
    const now = await crawler.read(doc, { at: second.fetched_at!, length: 20_000 });
    expect(now).toMatchObject({ held_back: false, capture: second.capture });

    // the page refuses again: each earlier version is held back too, as a read of its capture is
    clock.advance(86_400_000);
    page.headers = { "content-type": "text/html", "content-signal": "ai-input=no" };
    await crawler.fetch("https://forno.example/", { maxAge: "0s" });
    expect(await crawler.read(doc, { at: second.fetched_at! })).toMatchObject({
      held_back: true,
      text: "",
    });
    const unlocked = await crawler.read(doc, {
      at: later(first.fetched_at!, 1),
      userProvided: true,
      length: 20_000,
    });
    expect(unlocked.text).toContain("BODY-ONLY");
  });
});
