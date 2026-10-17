import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { DocInput, RankMode } from "./docs.ts";
import { DocIndex, FAST_RANK_SHARE, INDEX_SCHEMA, MAX_CAPTURES } from "./docs.ts";
import { removeDir, tempDir } from "./test-helpers.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const memory = (): DocIndex => {
  const index = new DocIndex(":memory:");
  cleanups.push(() => index.close());
  return index;
};

const version = (
  capture: string,
  at: string,
  text: string,
  extra: Partial<DocInput> = {},
): DocInput => ({
  doc: "url:https://forno.example/",
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

describe("the versions of a document", () => {
  it("show the latest capture, also when its text is shorter, and keep the earlier versions", () => {
    const index = memory();
    index.upsert(
      version(
        "fetch.v1",
        "2026-10-01T00:00:00.000Z",
        "Hours: Tuesday to Sunday. We also cater weddings.",
        {
          meta: { jsonld: [{ openingHours: "Tu-Su" }], description: "old" },
        },
      ),
      "2026-10-01T00:00:01.000Z",
    );
    const now = index.upsert(
      version("fetch.v2", "2026-10-02T00:00:00.000Z", "CLOSED PERMANENTLY", {
        meta: { description: "new" },
      }),
      "2026-10-02T00:00:01.000Z",
    );
    expect(now).toMatchObject({
      text: "CLOSED PERMANENTLY",
      capture: "fetch.v2",
      captures: ["fetch.v2"],
      capture_count: 2,
      fetched_at: "2026-10-02T00:00:00.000Z",
      meta: { description: "new" },
    });
    // the old JSON-LD does not stay in the metadata of the new version
    expect(now.meta["jsonld"]).toBeUndefined();
    expect(index.find("permanently", { limit: 5 })).toHaveLength(1);
    expect(index.find("weddings", { limit: 5 })).toHaveLength(0);
    expect(index.versions(now.doc).map((row) => row.capture)).toEqual(["fetch.v2", "fetch.v1"]);
    expect(index.versionText(now.doc, "fetch.v1")?.text).toContain("We also cater weddings");
    expect(index.earlierTexts(now.doc).map((row) => row.capture)).toEqual(["fetch.v1"]);
  });

  it("keep the latest by fetch time when the captures come out of sequence", () => {
    const index = memory();
    index.upsert(
      version("fetch.new", "2026-10-02T00:00:00.000Z", "new text"),
      "2026-10-03T00:00:00.000Z",
    );
    const doc = index.upsert(
      version("fetch.old", "2026-10-01T00:00:00.000Z", "old text"),
      "2026-10-03T00:00:00.000Z",
    );
    expect(doc.text).toBe("new text");
  });

  it("give the captures behind the current text, at most ten, and a count of all", () => {
    const index = memory();
    let doc;
    for (let day = 0; day < 30; day += 1) {
      const at = new Date(Date.UTC(2026, 8, 1 + day)).toISOString();
      doc = index.upsert(version(`fetch.${String(day).padStart(2, "0")}`, at, "the same text"), at);
    }
    expect(doc!.captures).toHaveLength(MAX_CAPTURES);
    expect(doc!.captures[0]).toBe("fetch.29");
    expect(doc!.capture_count).toBe(30);
  });

  it("lift a no for AI input when a later capture of the page does not say it", () => {
    const index = memory();
    index.upsert(
      version("fetch.a", "2026-10-01T00:00:00.000Z", "text", { ai_input: "no" }),
      "2026-10-01T00:00:00.000Z",
    );
    expect(index.get("url:https://forno.example/")?.ai_input).toBe("no");
    const lifted = index.upsert(
      version("fetch.b", "2026-10-02T00:00:00.000Z", "text", { ai_input: "yes" }),
      "2026-10-02T00:00:00.000Z",
    );
    expect(lifted.ai_input).toBe("yes");
  });

  it("keep a rendered version while the plain body stays, and show the plain version after it changes", () => {
    const index = memory();
    const shell = (capture: string, at: string, blob: string): DocInput =>
      version(capture, at, "Bistro", { blob, meta: { needs_render: true } });
    index.upsert(shell("fetch.p1", "2026-10-01T00:00:00.000Z", "aa"), "2026-10-01T00:00:00.000Z");
    index.upsert(
      version("fetch.r1", "2026-10-01T00:00:05.000Z", "Bistro. Dinner Monday to Friday.", {
        rendered: true,
        blob: "rr",
      }),
      "2026-10-01T00:00:05.000Z",
    );
    // a revalidation of the same body: the render stays
    const same = index.upsert(
      shell("fetch.p2", "2026-10-02T00:00:00.000Z", "aa"),
      "2026-10-02T00:00:00.000Z",
    );
    expect(same).toMatchObject({ capture: "fetch.r1", rendered: true });
    expect(same.captures).toContain("fetch.p2");
    // a new body: the plain text is the page now, until a new render
    const changed = index.upsert(
      shell("fetch.p3", "2026-10-03T00:00:00.000Z", "bb"),
      "2026-10-03T00:00:00.000Z",
    );
    expect(changed).toMatchObject({ capture: "fetch.p3", rendered: false });
  });

  it("hold back a render that stays current, when its capture refused AI input and a newer plain capture does not", () => {
    const index = memory();
    index.upsert(
      version("fetch.p1", "2026-10-01T00:00:00.000Z", "Bistro", { blob: "aa", ai_input: "no" }),
      "x",
    );
    index.upsert(
      version("fetch.r1", "2026-10-01T00:00:05.000Z", "Bistro. The vault opens at noon.", {
        rendered: true,
        blob: "rr",
        ai_input: "no",
      }),
      "x",
    );
    const same = index.upsert(
      version("fetch.p2", "2026-10-02T00:00:00.000Z", "Bistro", { blob: "aa", ai_input: "yes" }),
      "x",
    );
    expect(same).toMatchObject({ capture: "fetch.r1", ai_input: "no" });
    expect(index.find("vault", { limit: 10 })).toEqual([]);
    expect(index.rankWithin("vault", [same.doc])).toEqual([]);
  });

  it("choose the richer text of two recipes, or the newer text when both ask for it", () => {
    const index = memory();
    const paper = (
      capture: string,
      recipe: string,
      at: string,
      text: string,
      extra: Partial<DocInput> = {},
    ): DocInput => ({
      ...version(capture, at, text, extra),
      doc: "doi:10.1/x",
      kind: "paper",
      recipe,
    });
    index.upsert(
      paper(
        "api.a",
        "europepmc",
        "2026-10-01T00:00:00.000Z",
        "Title. A long abstract about bread.",
        { meta: { pmid: "1" } },
      ),
      "x",
    );
    const doc = index.upsert(
      paper("api.b", "crossref", "2026-10-02T00:00:00.000Z", "Title.", { meta: { year: 2020 } }),
      "x",
    );
    expect(doc).toMatchObject({
      text: "Title. A long abstract about bread.",
      meta: { pmid: "1", year: 2020 },
    });
    expect(doc.captures).toEqual(["api.a", "api.b"]);
    const latest = memory();
    latest.upsert(
      paper("api.a", "one", "2026-10-01T00:00:00.000Z", "long old text", { merge: "latest" }),
      "x",
    );
    expect(
      latest.upsert(
        paper("api.b", "two", "2026-10-02T00:00:00.000Z", "new", { merge: "latest" }),
        "x",
      ).text,
    ).toBe("new");
  });

  it("keep the whole text of a cut text for a quote, and labels for lineage", () => {
    const index = memory();
    const doc = index.upsert(
      version("fetch.cut", "2026-10-01T00:00:00.000Z", "the start", {
        full_text: "the start and the end",
        scope: "intimate",
        labels: { carrier: "gift-17" },
      }),
      "x",
    );
    expect(doc).toMatchObject({ cut: true, scope: "intimate", labels: { carrier: "gift-17" } });
    expect(index.versionText(doc.doc)?.full_text).toBe("the start and the end");
  });
});

describe("the search", () => {
  const page = (doc: string, text: string, extra: Partial<DocInput> = {}): DocInput => ({
    ...version(`fetch.${doc}`, "2026-10-01T00:00:00.000Z", text),
    doc,
    title: doc,
    ...extra,
  });

  it("finds Chinese, Japanese, accented, Turkish and Arabic text, phrases and prefixes", () => {
    const index = memory();
    index.upsert(page("ja", "東京は日本の首都です。"), "x");
    index.upsert(page("zh", "北京是中国的首都。"), "x");
    index.upsert(page("de", "Die Bäckerei an der Straße."), "x");
    index.upsert(page("tr", "İstanbul büyük bir şehirdir."), "x");
    index.upsert(page("ar", "هذه مَدِينَة كبيرة"), "x");
    index.upsert(page("en", "The bakery bakes wood fired bread."), "x");
    const docs = (q: string): string[] => index.find(q, { limit: 10 }).map((hit) => hit.doc);
    expect(docs("東京")).toEqual(["ja"]);
    expect(docs("首都")).toEqual(expect.arrayContaining(["ja"]));
    expect(docs("北京")).toEqual(["zh"]);
    expect(docs("backerei")).toEqual(["de"]);
    expect(docs("strasse")).toEqual(["de"]);
    expect(docs("İstanbul")).toEqual(["tr"]);
    expect(docs("istanbul")).toEqual(["tr"]);
    expect(docs("مدينة")).toEqual(["ar"]);
    expect(docs('"wood fired"')).toEqual(["en"]);
    expect(docs('"fired wood"')).toEqual([]);
    expect(docs("bak*")).toEqual(["en"]);
    expect(index.find("bakes", { limit: 1 })[0]?.snippet).toContain("[bakes]");
  });

  it("asks for each word first, then for one word", () => {
    const index = memory();
    index.upsert(page("both", "sourdough bread and rye"), "x");
    index.upsert(page("one", "sourdough only, nothing else, a long text about sourdough"), "x");
    expect(index.find("sourdough rye", { limit: 10 }).map((hit) => hit.doc)).toEqual([
      "both",
      "one",
    ]);
    expect(index.find("sourdough rye", { limit: 1 }).map((hit) => hit.doc)).toEqual(["both"]);
  });

  it("does not match a long question by its common words", () => {
    const index = memory();
    index.upsert(page("bread", "Fresh sourdough bread every morning, and a family table."), "x");
    index.upsert(
      page("filler", "the and of to in is for on with the and of to in is for on with a the"),
      "x",
    );
    const question =
      "what is the best bread on the menu for a family with kids in the morning and evening";
    expect(index.find(question, { limit: 10 }).map((hit) => hit.doc)).toEqual(["bread"]);
    expect(index.rankWithin(question, ["bread", "filler"]).map((hit) => hit.doc)).toEqual([
      "bread",
    ]);
  });

  it("leaves the common words out of the documents that hold one word, with rank fast", () => {
    const index = memory();
    const texts = [
      "menu of the day with soup",
      "menu and wine list",
      "the menu changes each week",
      "a short menu for lunch",
      "bread on the menu every morning",
      "menu with bread and butter",
      "fresh bread from the oven",
      "bread and cheese",
      "sourdough starter notes",
      "rye flour in stock",
    ];
    texts.forEach((text, at) => index.upsert(page(`d${String(at)}`, text), "x"));
    const docs = (q: string, rank?: RankMode): string[] =>
      index.find(q, { limit: 10, ...(rank !== undefined ? { rank } : {}) }).map((hit) => hit.doc);
    // "menu" is in 6 of 10 documents, more than FAST_RANK_SHARE: a common word
    expect(FAST_RANK_SHARE).toBe(0.2);
    expect(docs("sourdough rye menu")).toHaveLength(8);
    expect(docs("sourdough rye menu", "exact")).toEqual(docs("sourdough rye menu"));
    expect(docs("sourdough rye menu", "fast").sort()).toEqual(["d8", "d9"]);
    // the documents that hold each word come first, with the same rank in the two modes
    const fast = docs("menu bread", "fast");
    expect(fast.slice(0, 2)).toEqual(docs("menu bread").slice(0, 2));
    expect(fast.slice(0, 2).sort()).toEqual(["d4", "d5"]);
    // each word is common, so the rarest word ("bread", in 4 documents) stays
    expect(fast.slice(2).sort()).toEqual(["d6", "d7"]);
    expect(docs("menu bread")).toHaveLength(8);
    // a question of one word is the same in the two modes
    expect(docs("menu", "fast")).toEqual(docs("menu"));
    const all = texts.map((_, at) => `d${String(at)}`);
    expect(index.rankWithin("sourdough rye menu", all)).toHaveLength(8);
    expect(
      index
        .rankWithin("sourdough rye menu", all, { rank: "fast" })
        .map((hit) => hit.doc)
        .sort(),
    ).toEqual(["d8", "d9"]);
    const bad = { rank: "quick" } as unknown as { rank: RankMode };
    expect(() => index.find("menu", { limit: 10, ...bad })).toThrow(RangeError);
    expect(() => index.rankWithin("menu", all, bad)).toThrow(RangeError);
  });

  it("leaves out a document that asked not to be AI input, and ranks many ids", () => {
    const index = memory();
    index.upsert(page("secret", "the vault opens at noon", { ai_input: "no" }), "x");
    index.upsert(page("open", "the vault is public"), "x");
    expect(index.find("vault", { limit: 10 }).map((hit) => hit.doc)).toEqual(["open"]);
    const many = Array.from({ length: 40_000 }, (_, at) => `doc${String(at)}`);
    expect(index.rankWithin("vault", [...many, "secret", "open"]).map((hit) => hit.doc)).toEqual([
      "open",
    ]);
  });
});

describe("the cache entries", () => {
  it("keep the location, the truncation, the freshness and the Vary key, under a canonical key", () => {
    const index = memory();
    index.setLatest({
      url: "https://Forno.example:443/menu?utm_source=mail#top",
      capture: "fetch.r",
      blob: null,
      etag: null,
      last_modified: null,
      content_type: null,
      fetched_at: "2026-10-01T00:00:00.000Z",
      status: 301,
      ai_input: "unset",
      location: "https://forno.example/new",
      fresh_until: "2026-10-02T00:00:00.000Z",
      vary_key: "accept=text/html",
      truncated: true,
    });
    expect(index.latest("https://forno.example/menu")).toMatchObject({
      url: "https://forno.example/menu",
      variant: "plain",
      location: "https://forno.example/new",
      truncated: true,
      fresh_until: "2026-10-02T00:00:00.000Z",
      vary_key: "accept=text/html",
    });
    // an older answer does not replace a newer one
    index.setLatest({
      ...index.latest("https://forno.example/menu")!,
      capture: "fetch.old",
      fetched_at: "2025-01-01T00:00:00.000Z",
    });
    expect(index.latest("https://forno.example/menu")?.capture).toBe("fetch.r");
  });

  it("read a rendered key in the form of version 0.1", () => {
    const index = memory();
    const entry = {
      capture: "fetch.x",
      blob: "ab",
      etag: null,
      last_modified: null,
      content_type: "text/html",
      fetched_at: "2026-10-01T00:00:00.000Z",
      status: 200,
      ai_input: "unset" as const,
    };
    index.setLatest({ ...entry, url: "https://a.example/#rendered" });
    expect(index.latest("https://a.example/", "rendered")?.capture).toBe("fetch.x");
    expect(index.latest("https://a.example/#rendered")?.capture).toBe("fetch.x");
    expect(index.latest("https://a.example/")).toBeUndefined();
  });
});

describe("the index file", () => {
  it("waits for the lock of a different process, and writes ahead", async () => {
    const dir = await tempDir("index");
    cleanups.push(() => removeDir(dir));
    const index = new DocIndex(join(dir, "index.sqlite"));
    cleanups.push(() => index.close());
    const raw = new DatabaseSync(join(dir, "index.sqlite"));
    cleanups.push(() => raw.close());
    expect(raw.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: INDEX_SCHEMA });
  });

  it("opens a file of version 0.1 empty and stale, and a second open is current", async () => {
    const dir = await tempDir("index");
    cleanups.push(() => removeDir(dir));
    const path = join(dir, "index.sqlite");
    const old = new DatabaseSync(path);
    old.exec(
      "CREATE TABLE docs (doc TEXT PRIMARY KEY, text TEXT); INSERT INTO docs VALUES ('a', 'b');",
    );
    old.exec("CREATE VIRTUAL TABLE docs_fts USING fts5(title, text, content='docs');");
    old.close();
    const first = new DocIndex(path);
    expect(first.stale).toBe(true);
    expect(first.counts()).toEqual({ docs: 0, urls: 0 });
    first.close();
    const second = new DocIndex(path);
    cleanups.push(() => second.close());
    expect(second.stale).toBe(false);
  });

  it("joins a transaction that the caller opened on its connection", () => {
    const index = memory();
    const db = (index as unknown as { db: DatabaseSync }).db;
    db.exec("BEGIN");
    for (let at = 0; at < 50; at += 1)
      index.upsert(
        version(
          `fetch.${String(at)}`,
          `2026-10-01T00:00:${String(at).padStart(2, "0")}.000Z`,
          `text ${String(at)}`,
        ),
        "x",
      );
    db.exec("COMMIT");
    expect(index.get("url:https://forno.example/")?.capture_count).toBe(50);
  });

  it("closes once, and refuses work after the close", () => {
    const index = new DocIndex(":memory:");
    index.close();
    index.close();
    expect(() => index.get("x")).toThrow(/closed/);
  });
});

describe("a rebuild", () => {
  it("keeps the old generation until its commit, and an abort leaves it", () => {
    const index = memory();
    index.upsert(version("fetch.a", "2026-10-01T00:00:00.000Z", "old text"), "x");
    const build = index.beginRebuild();
    build.upsert(version("fetch.b", "2026-10-02T00:00:00.000Z", "new text"), "y");
    build.flush();
    // the old generation answers during the rebuild
    expect(index.get("url:https://forno.example/")?.text).toBe("old text");
    build.abort();
    expect(index.get("url:https://forno.example/")?.text).toBe("old text");
    const again = index.beginRebuild();
    again.upsert(version("fetch.b", "2026-10-02T00:00:00.000Z", "new text"), "y");
    // a write to the old generation during the rebuild goes into the new one
    index.upsert(version("fetch.c", "2026-10-03T00:00:00.000Z", "live text"), "z");
    expect(again.commit("2026-10-03T00:00:00.000Z")).toEqual({ docs: 1, urls: 0 });
    expect(index.get("url:https://forno.example/")?.text).toBe("live text");
    expect(index.versions("url:https://forno.example/").map((row) => row.capture)).toEqual([
      "fetch.c",
      "fetch.b",
    ]);
  });

  it("carries the documents of a recipe with no extractor", () => {
    const index = memory();
    index.upsert(
      { ...version("api.x", "2026-10-01T00:00:00.000Z", "rye"), doc: "menu:1", recipe: "menu" },
      "x",
    );
    index.upsert(version("fetch.p", "2026-10-01T00:00:00.000Z", "page text"), "x");
    const build = index.beginRebuild();
    expect(build.carry(new Set(["page"]))).toBe(1);
    build.commit("2026-10-02T00:00:00.000Z");
    expect(index.get("menu:1")?.text).toBe("rye");
    expect(index.get("url:https://forno.example/")).toBeUndefined();
  });
});
