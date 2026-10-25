import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MockAgent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import type { DocInput, ReadingIndex } from "./docs.ts";
import { DocIndex, NO_EMBEDDER } from "./docs.ts";
import type { Embedder } from "./embed.ts";
import type { HybridSearch } from "./hybrid.ts";
import { createHybridSearch } from "./hybrid.ts";
import { createRuntime, openCrawler } from "./open.ts";
import { makeRecord } from "./record.ts";
import type { FakeEmbedder } from "./test-embedder.ts";
import { fakeEmbedder } from "./test-embedder.ts";
import { fakeClock, removeDir, tempDir } from "./test-helpers.ts";
import { VectorStore } from "./vectors.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const TEXTS = {
  bakery: "Fresh bread every morning. Our bakery sells rye and focaccia.",
  flour: "Bread flour costs more this year.",
  sourdough: "A sourdough loaf with a dark crust and a slow dough.",
  ferry: "The ferry leaves the harbor at noon. Each ship has a sail.",
  engine: "The engine of the car needs a new wheel.",
  members: "The secret bread of the members.",
} as const;

/** An index of 0.1.1 has no `digests`: hybrid search then reads each document with `get`. */
const withoutDigests = (inner: DocIndex): ReadingIndex => ({
  get stale() {
    return inner.stale;
  },
  get: (doc) => inner.get(doc),
  upsert: (input, now) => inner.upsert(input, now),
  versions: (doc, options) => inner.versions(doc, options),
  versionText: (doc, capture) => inner.versionText(doc, capture),
  earlierTexts: (doc, options) => inner.earlierTexts(doc, options),
  docsOfCapture: (capture) => inner.docsOfCapture(capture),
  hasVersion: (capture) => inner.hasVersion(capture),
  find: (q, options) => inner.find(q, options),
  rankWithin: (q, docs, options) => inner.rankWithin(q, docs, options),
  latest: (url, variant) => inner.latest(url, variant),
  setLatest: (entry) => inner.setLatest(entry),
  newestFetch: () => inner.newestFetch(),
  counts: () => inner.counts(),
  beginRebuild: (options) => inner.beginRebuild(options),
});

interface Opened {
  readonly dir: string;
  readonly store: VectorStore;
  readonly search: HybridSearch;
  readonly embedder: FakeEmbedder;
  readonly index: ReadingIndex;
  /** This function adds a version of a document, with a record of its capture in the log. */
  readonly put: (doc: string, text: string, extra?: Partial<DocInput>) => Promise<void>;
  readonly seed: () => Promise<void>;
}

/** This function makes a runtime with no site, a vector store and a hybrid search over them. */
const open = async (
  options: { readonly embedder?: Embedder; readonly digests?: boolean } = {},
): Promise<Opened> => {
  const dir = await tempDir("hybrid");
  const embedder = (options.embedder ?? fakeEmbedder()) as FakeEmbedder;
  const inner = new DocIndex(join(dir, "index.sqlite"));
  const index = options.digests === false ? withoutDigests(inner) : inner;
  const runtime = createRuntime({ dir, index, renderer: false });
  const store = new VectorStore(join(dir, "vectors.sqlite"));
  const search = createHybridSearch(runtime, { embedder, store });
  cleanups.push(async () => {
    store.close();
    await runtime.close();
    inner.close();
    await removeDir(dir);
  });
  let n = 0;
  const put = async (doc: string, text: string, extra: Partial<DocInput> = {}): Promise<void> => {
    n += 1;
    const at = new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString();
    const record = makeRecord({
      source: "fetch",
      kind: "note",
      payload: { doc, n },
      received_at: at,
      external_id: doc,
    });
    await runtime.log.append(record);
    index.upsert(
      {
        doc,
        kind: "page",
        title: `The ${doc}`,
        text,
        url: `https://example.com/${doc}`,
        meta: {},
        captures: [record.id],
        fetched_at: at,
        ...extra,
      },
      at,
    );
  };
  const seed = async (): Promise<void> => {
    for (const [doc, text] of Object.entries(TEXTS)) {
      await put(
        doc,
        text,
        doc === "flour" ? { kind: "pdf" } : doc === "members" ? { ai_input: "no" } : {},
      );
    }
  };
  return { dir, store, search, embedder, index, put, seed };
};

describe("hybrid search over a runtime", () => {
  it("gives vectors only to the BM25 candidates of a search, one time", async () => {
    const { search, embedder, seed } = await open();
    await seed();
    const found = await search.find("bread");
    expect(found.map((hit) => hit.doc).sort()).toEqual(["bakery", "flour"]);
    expect(embedder.documents().sort()).toEqual([TEXTS.flour, TEXTS.bakery].sort());
    expect(embedder.calls.filter((call) => call.purpose === "query")).toEqual([
      { texts: ["bread"], purpose: "query" },
    ]);
    for (const hit of found) {
      expect(hit.passage).toBeDefined();
      expect(hit.snippet).toMatch(/\[bread\]/i);
      expect(hit.score).toBeGreaterThan(0);
      expect(hit.capture).toMatch(/^fetch\./);
    }
    // the same question again: the vectors and the vector of the question are in the store
    const calls = embedder.calls.length;
    expect((await search.find("bread")).map((hit) => hit.doc)).toEqual(found.map((hit) => hit.doc));
    expect(embedder.calls.length).toBe(calls);
  });

  it("finds a document by its meaning after embed, and fuses the two lists", async () => {
    const { search, embedder, seed } = await open();
    await seed();
    const result = await search.embed();
    expect(result).toMatchObject({
      embedder: "fake:concepts-1",
      docs: 6,
      embedded: 5,
      reused: 0,
      held_back: 1,
      chunks: 5,
      stopped: "done",
    });
    expect(embedder.documents().some((text) => text.includes("secret"))).toBe(false);
    const found = await search.find("bread", { limit: 4 });
    // the two BM25 matches are in each list; sourdough has the meaning and not the word
    expect(
      found
        .slice(0, 2)
        .map((hit) => hit.doc)
        .sort(),
    ).toEqual(["bakery", "flour"]);
    expect(found[2]!.doc).toBe("sourdough");
    expect(found[2]!.passage!.similarity).toBeGreaterThan(0.9);
    expect(found[0]!.score).toBeGreaterThan(found[2]!.score);
    expect(found.map((hit) => hit.doc)).not.toContain("members");
    // a second embed reuses each vector
    expect(await search.embed()).toMatchObject({ embedded: 0, reused: 5, held_back: 1 });
  });

  it("does not send a held-back version to the embedder, and does not give it", async () => {
    const { search, embedder, seed, put, store } = await open();
    await seed();
    await search.embed();
    expect(store.pointed("fake:concepts-1", "sourdough")).toBe(sha(TEXTS.sourdough));
    // a later capture of sourdough asks not to be AI input, with a new text
    await put("sourdough", "A secret sourdough loaf with a crust.", { ai_input: "no" });
    const found = await search.find("loaf bread", { limit: 10 });
    expect(found.map((hit) => hit.doc)).not.toContain("sourdough");
    expect(found.map((hit) => hit.doc)).not.toContain("members");
    expect(await search.embed()).toMatchObject({ embedded: 0, held_back: 2 });
    expect(store.pointed("fake:concepts-1", "sourdough")).toBeUndefined();
    expect(embedder.documents().some((text) => text.includes("secret"))).toBe(false);
    expect(await search.rankWithin("loaf", ["sourdough", "members", "ferry"])).toEqual([
      expect.objectContaining({ doc: "ferry" }),
    ]);
  });

  it("points the passage at the best chunk of a long text", async () => {
    const { search, put, index } = await open();
    const cars = Array.from(
      { length: 20 },
      (_, at) => `The car has an engine and a wheel, number ${String(at)}.`,
    );
    const gardens = Array.from(
      { length: 20 },
      (_, at) => `The garden has a rose and a tree, number ${String(at)}.`,
    );
    const boats = "The ferry leaves the harbor at noon. Each ship has a sail and a dock.";
    await put("guide", [...cars, boats, ...gardens].join("\n"));
    const [hit] = await search.find("harbor ship");
    expect(hit!.doc).toBe("guide");
    const text = index.get("guide")!.text;
    const passage = text.slice(hit!.passage!.start, hit!.passage!.end);
    expect(passage).toContain(boats);
    expect(passage.length).toBeLessThan(text.length / 2);
    expect(hit!.snippet).toMatch(/\[(harbor|ship)\]/);
  });

  it("gives new vectors to a new text, and keeps the vectors of the old text", async () => {
    const { search, embedder, seed, put, store } = await open();
    await seed();
    await search.find("bread");
    await put("bakery", "Fresh bread and buns each day.");
    const before = embedder.documents().length;
    const found = await search.find("bread");
    expect(found.map((hit) => hit.doc)).toContain("bakery");
    expect(embedder.documents().slice(before)).toEqual(["Fresh bread and buns each day."]);
    expect(store.plan("fake:concepts-1", sha(TEXTS.bakery))).toBeDefined();
    expect(store.pointed("fake:concepts-1", "bakery")).toBe(sha("Fresh bread and buns each day."));
  });

  it("keeps a kind, and ranks a set of documents", async () => {
    const { search, seed } = await open();
    await seed();
    await search.embed();
    expect((await search.find("bread", { kind: "pdf" })).map((hit) => hit.doc)).toEqual(["flour"]);
    const ranked = await search.rankWithin("bread", ["sourdough", "ferry", "members", "unknown"]);
    expect(ranked.map((one) => one.doc)).toEqual(["sourdough", "ferry"]);
    expect(ranked[0]!.passage).toEqual({
      start: 0,
      end: TEXTS.sourdough.length,
      similarity: expect.any(Number),
    });
    expect(await search.rankWithin("bread", ["sourdough", "ferry"], { neighbors: 1 })).toEqual([
      expect.objectContaining({ doc: "sourdough" }),
    ]);
    const mixed = await search.rankWithin("bread", ["bakery", "sourdough"]);
    expect(mixed.map((one) => one.doc)).toEqual(["bakery", "sourdough"]);
    expect(await search.rankWithin("bread", [])).toEqual([]);
    expect(await search.rankWithin("  ", ["bakery"])).toEqual([]);
    expect(await search.find("***")).toEqual([]);
  });

  it("takes the fusion parameters, and checks them", async () => {
    const { search, seed } = await open();
    await seed();
    await search.embed();
    const few = await search.find("bread", { candidates: 1, neighbors: 1 });
    expect(few.length).toBeGreaterThanOrEqual(1);
    expect(few.length).toBeLessThanOrEqual(2);
    expect((await search.find("bread", { limit: 1 })).length).toBe(1);
    // a limit that is not a number reads as 10, as in the other modes
    expect((await search.find("bread", { limit: Number.NaN })).length).toBe(5);
    expect((await search.find("bread", { fusionK: 0 })).length).toBeGreaterThan(0);
    await expect(search.find("bread", { candidates: 0 })).rejects.toThrow(RangeError);
    await expect(search.find("bread", { neighbors: Number.NaN })).rejects.toThrow(RangeError);
    await expect(search.find("bread", { fusionK: -1 })).rejects.toThrow(/fusionK/);
    await expect(search.rankWithin("bread", ["bakery"], { fusionK: Infinity })).rejects.toThrow(
      RangeError,
    );
    await expect(search.embed({ maxDocs: 0 })).rejects.toThrow(RangeError);
  });

  it("stops embed at the budget, at maxDocs and at the signal", async () => {
    const { search, seed } = await open();
    await seed();
    expect(await search.embed({ budget: 0 })).toMatchObject({ docs: 0, stopped: "budget" });
    const aborted = new AbortController();
    aborted.abort(new Error("stop"));
    expect(await search.embed({ signal: aborted.signal })).toMatchObject({
      docs: 0,
      stopped: "signal",
    });
    expect(await search.embed({ maxDocs: 2 })).toMatchObject({ embedded: 2, stopped: "max-docs" });
    expect(await search.embed({ kind: "pdf" })).toMatchObject({ docs: 1, stopped: "done" });
    expect(await search.embed()).toMatchObject({ embedded: 2, reused: 3, stopped: "done" });
  });

  it("stops an embedding in progress at the end of the budget", async () => {
    const { search, seed } = await open({ embedder: fakeEmbedder({ delayMs: 2000 }) });
    await seed();
    const started = Date.now();
    expect(await search.embed({ budget: 50 })).toMatchObject({ embedded: 0, stopped: "budget" });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("works over an index with no digests", async () => {
    const { search, seed, embedder } = await open({ digests: false });
    await seed();
    expect(await search.embed()).toMatchObject({ docs: 6, embedded: 5, held_back: 1 });
    expect(embedder.documents().some((text) => text.includes("secret"))).toBe(false);
    const found = await search.find("bread", { limit: 3 });
    expect(found[2]!.doc).toBe("sourdough");
    expect((await search.rankWithin("bread", ["sourdough"]))[0]!.doc).toBe("sourdough");
  });

  it("rejects with the error of the embedder, and checks its answer", async () => {
    const failing: Embedder = {
      id: "fake:broken",
      dimensions: 4,
      embed: () => Promise.reject(new Error("the model is not there")),
    };
    const bad = async (embedder: Embedder): Promise<unknown> => {
      const opened = await open({ embedder });
      await opened.seed();
      return opened.search.find("bread").then(
        () => undefined,
        (error: unknown) => error,
      );
    };
    expect(await bad(failing)).toMatchObject({ message: "the model is not there" });
    expect(await bad(fakeEmbedder({ answer: () => [] }))).toMatchObject({
      message: expect.stringMatching(/gave 0 vectors for 1 texts/),
    });
    expect(
      await bad(
        fakeEmbedder({ answer: (texts) => texts.map(() => new Float32Array([Number.NaN])) }),
      ),
    ).toBeInstanceOf(RangeError);
    expect(
      await bad(
        fakeEmbedder({
          answer: (texts) =>
            texts.map((text) => new Float32Array(text === "bread" ? 16 : 8).fill(1)),
        }),
      ),
    ).toMatchObject({ message: expect.stringMatching(/dimensions/) });
    const one = await open();
    await one.seed();
    const aborted = new AbortController();
    aborted.abort(new Error("cancelled"));
    await expect(one.search.find("bread", { signal: aborted.signal })).rejects.toThrow("cancelled");
  });

  it("gives no unhandled rejection when two embeddings of a shared text fail", async () => {
    const calls: Array<(error: unknown) => void> = [];
    const held: Embedder = {
      id: "fake:held",
      dimensions: 4,
      embed: () =>
        new Promise<Float32Array[]>((_, reject) => {
          calls.push(reject);
        }),
    };
    const until = async (ok: () => boolean): Promise<void> => {
      for (let tries = 0; tries < 400 && !ok(); tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(ok()).toBe(true);
    };
    const { search, seed } = await open({ embedder: held });
    await seed();
    const unhandled: unknown[] = [];
    const listen = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listen);
    try {
      // The first call embeds the PDF. The second call waits for that text, and embeds the others.
      const first = search.embed({ kind: "pdf" }).then(
        () => undefined,
        (error: unknown) => error,
      );
      await until(() => calls.length === 1);
      const second = search.embed().then(
        () => undefined,
        (error: unknown) => error,
      );
      await until(() => calls.length === 2);
      // The second call fails first, before it waits for the shared text. Then the first call fails.
      calls[1]!(new Error("the second call stopped"));
      expect(await second).toMatchObject({ message: "the second call stopped" });
      calls[0]!(new Error("the model is not there"));
      expect(await first).toMatchObject({ message: "the model is not there" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listen);
    }
  });

  it("refuses vectors of new dimensions for the same id of an embedder", async () => {
    const { dir, seed, search, index } = await open();
    await seed();
    await search.find("bread");
    const store = new VectorStore(join(dir, "vectors.sqlite"));
    cleanups.push(() => store.close());
    const runtime = createRuntime({ dir: join(dir, "other"), index, renderer: false });
    cleanups.push(() => runtime.close());
    const wider = createHybridSearch(runtime, { embedder: fakeEmbedder({ extra: 2 }), store });
    await expect(wider.find("bread")).rejects.toThrow(/dimensions/);
    await expect(wider.find("ferry")).rejects.toThrow(/dimensions/);
  });
});

describe("hybrid search of a crawler", () => {
  const PAGES: Record<string, string> = {
    "/bakery": `<html><head><title>Bakery</title></head><body><p>${TEXTS.bakery}</p></body></html>`,
    "/sourdough": `<html><head><title>Sourdough</title></head><body><p>${TEXTS.sourdough}</p></body></html>`,
    "/ferry": `<html><head><title>Ferry</title></head><body><p>${TEXTS.ferry}</p></body></html>`,
    "/members": `<html><head><title>Members</title></head><body><p>${TEXTS.members}</p></body></html>`,
  };

  const site = (): MockAgent => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get("https://site.example")
      .intercept({ path: () => true, method: "GET" })
      .reply((request) => {
        if (request.path === "/robots.txt")
          return { statusCode: 200, data: "User-agent: *\nAllow: /\n" };
        const body = PAGES[request.path];
        if (body === undefined) return { statusCode: 404, data: "" };
        return {
          statusCode: 200,
          data: body,
          responseOptions: {
            headers: {
              "content-type": "text/html",
              ...(request.path === "/members" ? { "content-signal": "ai-input=no" } : {}),
            },
          },
        };
      })
      .persist();
    return agent;
  };

  const crawl = async (embedder?: Embedder) => {
    const dir = await tempDir("hybrid-crawler");
    const agent = site();
    const crawler = openCrawler({
      dir,
      renderer: false,
      dispatcher: agent,
      clock: fakeClock(),
      random: () => 0.5,
      ...(embedder === undefined ? {} : { embedder }),
    });
    cleanups.push(async () => {
      await crawler.close();
      await agent.close();
      await removeDir(dir);
    });
    for (const path of Object.keys(PAGES)) await crawler.fetch(`https://site.example${path}`);
    return { dir, crawler };
  };

  it("keeps each vector through a reindex, and opens vectors.sqlite at its first use", async () => {
    const embedder = fakeEmbedder();
    const { dir, crawler } = await crawl(embedder);
    expect(existsSync(join(dir, "vectors.sqlite"))).toBe(false);
    expect(crawler.hybrid?.embedder).toBe(embedder);
    expect(await crawler.embed()).toMatchObject({ embedded: 3, held_back: 1, stopped: "done" });
    expect(existsSync(join(dir, "vectors.sqlite"))).toBe(true);
    const sent = embedder.documents().length;
    expect(await crawler.reindex()).toMatchObject({ docs: 4 });
    expect(await crawler.embed()).toMatchObject({ embedded: 0, reused: 3, held_back: 1 });
    const found = await crawler.find("bread", { rank: "hybrid", limit: 2 });
    expect(found.map((hit) => hit.doc)).toEqual([
      "url:https://site.example/bakery",
      "url:https://site.example/sourdough",
    ]);
    expect(found[1]!.passage).toBeDefined();
    expect(embedder.documents().length).toBe(sent);
    expect(embedder.documents().join(" ")).not.toContain("secret");
    // the other modes do not use the embedder
    const exact = await crawler.find("bread");
    expect(exact.map((hit) => hit.doc)).toEqual(["url:https://site.example/bakery"]);
    expect(exact[0]!.passage).toBeUndefined();
    const ranked = await crawler.rankWithin("loaf", [
      "url:https://site.example/sourdough",
      "url:https://site.example/members",
    ]);
    expect(ranked.map((one) => one.doc)).toEqual(["url:https://site.example/sourdough"]);
    const hybrid = await crawler.rankWithin(
      "bread",
      ["url:https://site.example/sourdough", "url:https://site.example/ferry"],
      { rank: "hybrid" },
    );
    expect(hybrid[0]!.doc).toBe("url:https://site.example/sourdough");
    await crawler.close();
    expect(embedder.closed.count).toBe(1);
  });

  it("fails with a clear error when the crawler has no embedder", async () => {
    const { dir, crawler } = await crawl();
    expect(crawler.hybrid).toBeUndefined();
    await expect(crawler.find("bread", { rank: "hybrid" })).rejects.toThrow(NO_EMBEDDER);
    await expect(crawler.embed()).rejects.toThrow(NO_EMBEDDER);
    await expect(crawler.rankWithin("bread", ["x"], { rank: "hybrid" })).rejects.toThrow(
      NO_EMBEDDER,
    );
    expect(existsSync(join(dir, "vectors.sqlite"))).toBe(false);
    // the index has no vectors, so it never falls back to BM25 in silence
    expect(() =>
      crawler.runtime.index.find("bread", { limit: 5, rank: "hybrid" as never }),
    ).toThrow(/rank "hybrid" needs the vectors of an embedder/);
    expect(
      (await crawler.rankWithin("bread", ["url:https://site.example/bakery"], { rank: "fast" }))
        .length,
    ).toBe(1);
  });
});
