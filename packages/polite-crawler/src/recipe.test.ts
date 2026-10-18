import { afterEach, describe, expect, it } from "vitest";
import type { ExtractedDoc } from "./docs.ts";
import { Extractors } from "./runtime.ts";
import { defineRecipe, registerRecipe, runRecipe } from "./recipe.ts";
import type { Reply } from "./test-recipes.ts";
import { FILLER, HTML, JSON_TYPE, htmlPage, openWith, pagesOf, world } from "./test-recipes.ts";

/*
 * The recipe SDK, with a made-up bakery: Forno Esempio. Its menu API and its site are mock hosts on
 * the domain `.example`. No test uses the network.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const API = "https://api.forno-esempio.example";
const SITE = "https://forno-esempio.example";

interface Item {
  readonly id: string;
  readonly name: string;
  readonly price: string;
}

const menuJson = (items: readonly Item[]): string => JSON.stringify({ items });

const MENU: readonly Item[] = [
  { id: "focaccia", name: "Focaccia al rosmarino", price: "4.50 EUR" },
  { id: "pane", name: "Pane di semola", price: "3.20 EUR" },
];

/** The recipe of the menu API: one document for each item. */
const menuRecipe = defineRecipe({
  name: "forno-menu",
  description: "The menu of the day of Forno Esempio",
  mode: "api",
  minInterval: "2s",
  maxAge: "6h",
  fetch: (day: string) => `${API}/menu?day=${encodeURIComponent(day)}`,
  extract: (body, capture): ExtractedDoc[] => {
    const data = JSON.parse(new TextDecoder().decode(body)) as { items: Item[] };
    return data.items.map((item) => ({
      doc: `menu:forno-esempio/${item.id}`,
      kind: "menu-item",
      title: item.name,
      text: `${item.name}: ${item.price}. Baked this morning.`,
      url: capture.url,
      meta: { price: item.price },
    }));
  },
});

/** A mock API that gives the menu of the moment. */
const menuApi = (
  menu: () => string | Reply,
): Record<string, (path: string) => Reply | undefined> => ({
  [API]: (path) => {
    if (!path.startsWith("/menu")) return undefined;
    const answer = menu();
    return typeof answer === "string" ? { body: answer, headers: JSON_TYPE } : answer;
  },
});

describe("defineRecipe", () => {
  it("builds the request of an input, with the settings of the recipe", () => {
    const request = menuRecipe.request("mon", { job: "test", labels: { lineage: "l-1" } });
    expect(request).toMatchObject({
      url: `${API}/menu?day=mon`,
      mode: "api",
      recipe: "forno-menu",
      accept: "application/json",
      minIntervalMs: 2000,
      maxAgeMs: 6 * 3_600_000,
      job: "test",
      labels: { lineage: "l-1" },
    });
    expect(menuRecipe.request("mon", { maxAge: "0" }).maxAgeMs).toBe(0);
    expect(menuRecipe).toMatchObject({
      name: "forno-menu",
      description: "The menu of the day of Forno Esempio",
      mode: "api",
    });
    // with no fetch, the input is the URL, and a page gets the HTML Accept
    const plain = defineRecipe({ name: "plain", extract: () => [] });
    expect(plain.request(`${SITE}/a`)).toMatchObject({
      url: `${SITE}/a`,
      mode: "page",
      recipe: "plain",
      maxAgeMs: 24 * 3_600_000,
    });
    expect(plain.request(`${SITE}/a`).accept).toMatch(/text\/html/);
    // a request can carry headers and secret parameters
    const keyed = defineRecipe({
      name: "keyed",
      mode: "api",
      fetch: (q: { readonly term: string }) => ({
        url: `${API}/search?q=${q.term}&key=SECRET`,
        headers: { "x-client": "forno-test" },
        secretParams: ["key"],
        accept: "application/vnd.forno+json",
      }),
      extract: () => [],
    });
    expect(keyed.request({ term: "pane" }).url).toBe(`${API}/search?q=pane&key=SECRET`);
    expect(keyed.request({ term: "pane" })).toMatchObject({
      headers: { "x-client": "forno-test" },
      secretParams: ["key"],
      accept: "application/vnd.forno+json",
    });
  });

  it("refuses a name that is not valid, a reserved name and settings that it cannot read", () => {
    const extract = (): ExtractedDoc[] => [];
    for (const name of ["page", "archive-copy", "archive-index", "robots.txt", "sitemap", "feed"]) {
      expect(() => defineRecipe({ name, extract })).toThrow(/belongs to the crawler/);
    }
    for (const name of ["", "-menu", "a menu", "menu/x", "x".repeat(65)]) {
      expect(() => defineRecipe({ name, extract })).toThrow(RangeError);
    }
    expect(() =>
      defineRecipe({ name: "x", extract: undefined as unknown as () => ExtractedDoc[] }),
    ).toThrow(/needs extract/);
    expect(() => defineRecipe({ name: "x", extract, maxAge: "5 months" })).toThrow(/duration/);
    expect(() => defineRecipe({ name: "x", extract, minInterval: -1 })).toThrow(/duration/);
    expect(() => defineRecipe({ name: "x", extract, maxBytes: 0 })).toThrow(/maxBytes/);
    expect(() => defineRecipe({ name: "x", extract, mode: "feed" as unknown as "page" })).toThrow(
      /mode/,
    );
    const recipe = defineRecipe({ name: "x", extract });
    expect(() => recipe.request("ftp://forno-esempio.example/menu")).toThrow(TypeError);
    expect(() => recipe.request("not a url")).toThrow(/http or https URL/);
    const bad = defineRecipe({ name: "y", fetch: (n: number) => ({ url: String(n) }), extract });
    expect(() => bad.request(4)).toThrow(TypeError);
  });

  it("registers a recipe one time, and refuses a different extractor with its name", () => {
    const extractors = new Extractors();
    registerRecipe(extractors, menuRecipe);
    registerRecipe(extractors, menuRecipe);
    expect(extractors.get("forno-menu")).toBe(menuRecipe.extractor);
    const other = defineRecipe({ name: "forno-menu", extract: () => [] });
    expect(() => registerRecipe(extractors, other)).toThrow(/different extractor/);
    // a recipe of your own cannot take the place of a built-in reader
    const page = { ...other, name: "page" };
    expect(() => registerRecipe(extractors, page)).toThrow(/different extractor/);
  });

  it("checks each document of the extractor, and names the first fault", async () => {
    const run = (docs: unknown) =>
      defineRecipe({ name: "check", extract: () => docs as ExtractedDoc[] }).extractor(
        new Uint8Array(),
        { url: `${SITE}/`, contentType: null },
      );
    const good = { doc: "menu:a", kind: "menu-item", title: "A", text: "a", url: null, meta: {} };
    await expect(run([good])).resolves.toHaveLength(1);
    await expect(run("docs")).rejects.toThrow(/not an array/);
    await expect(run([null])).rejects.toThrow(/must be an object/);
    await expect(run([{ ...good, doc: "" }])).rejects.toThrow(/doc must be a text/);
    await expect(run([{ ...good, doc: "archive:x" }])).rejects.toThrow(/archived copies/);
    await expect(run([good, good])).rejects.toThrow(/two documents have the id menu:a/);
    await expect(run([{ ...good, kind: "" }])).rejects.toThrow(/kind/);
    await expect(run([{ ...good, kind: "archived" }])).rejects.toThrow(/archived copies/);
    await expect(run([{ ...good, title: 1 }])).rejects.toThrow(/title/);
    await expect(run([{ ...good, text: undefined }])).rejects.toThrow(/text/);
    await expect(run([{ ...good, url: 3 }])).rejects.toThrow(/url/);
    await expect(run([{ ...good, meta: [] }])).rejects.toThrow(/meta must be an object/);
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    await expect(run([{ ...good, meta: cycle }])).rejects.toThrow(/meta must be JSON/);
    await expect(run([{ ...good, meta: { n: 1n } }])).rejects.toThrow(/meta must be JSON/);
    await expect(run([{ ...good, merge: "first" }])).rejects.toThrow(/merge/);
    await expect(run([{ ...good, full_text: 2 }])).rejects.toThrow(/full_text/);
    await expect(run([{ ...good, ai_input: "maybe" }])).rejects.toThrow(/ai_input/);
  });
});

describe("runRecipe", () => {
  it("fetches through the crawler, gives the documents of the capture, and answers again from the store", async () => {
    const hosts = world(menuApi(() => menuJson(MENU)));
    const { crawler } = await openWith(hosts, cleanups, { recipes: [menuRecipe] });
    const first = await runRecipe(crawler, menuRecipe, "mon");
    expect(first).toMatchObject({
      recipe: "forno-menu",
      url: `${API}/menu?day=mon`,
      outcome: "ok",
      status: 200,
      from_cache: false,
      held_back: false,
      error: null,
    });
    expect(first.docs.map((doc) => doc.doc)).toEqual([
      "menu:forno-esempio/focaccia",
      "menu:forno-esempio/pane",
    ]);
    expect(first.docs[0]).toMatchObject({
      kind: "menu-item",
      title: "Focaccia al rosmarino",
      meta: { price: "4.50 EUR" },
      capture: first.capture,
      held_back: false,
    });
    expect(first.capture).toMatch(/^fetch\.[0-9a-f]{12}$/);
    // an API is not a page: no robots.txt
    expect(hosts.hits).toEqual([`${API}/menu?day=mon`]);

    // find, read, verify and extract use the documents
    const found = await crawler.find("rosmarino");
    expect(found.map((hit) => hit.doc)).toEqual(["menu:forno-esempio/focaccia"]);
    const read = await crawler.read("menu:forno-esempio/focaccia");
    expect(read.text).toBe("Focaccia al rosmarino: 4.50 EUR. Baked this morning.");
    const quote = await crawler.verify("menu:forno-esempio/pane", "Pane di semola");
    expect(quote).toMatchObject({ found: true, capture: first.capture });
    const checked = await crawler.extract("menu:forno-esempio/focaccia", {
      price: { value: "EUR 4.50", kind: "money" },
    });
    expect(checked.fields["price"]?.status).toBe("normalized");

    // the stored copy answers the second run, with no request
    const second = await runRecipe(crawler.runtime, menuRecipe, "mon");
    expect(second).toMatchObject({ from_cache: true, capture: first.capture });
    expect(second.docs).toHaveLength(2);
    expect(hosts.hits).toHaveLength(1);
  });

  it("keeps a secret of the request out of the result and out of the capture log", async () => {
    const keyed = defineRecipe({
      name: "forno-search",
      mode: "api",
      fetch: (term: string) => ({ url: `${API}/menu?q=${term}&key=SECRET`, secretParams: ["key"] }),
      extract: (body) => menuRecipe.extractor(body, { url: `${API}/menu`, contentType: null }),
    });
    const hosts = world(menuApi(() => menuJson(MENU)));
    const { crawler } = await openWith(hosts, cleanups);
    const result = await runRecipe(crawler, keyed, "pane");
    expect(result.url).toBe(`${API}/menu?q=pane&key=REDACTED`);
    expect(result.docs).toHaveLength(2);
    expect(hosts.hits).toEqual([`${API}/menu?q=pane&key=SECRET`]);
    for await (const record of crawler.runtime.captures.scan({ source: "fetch" })) {
      expect(JSON.stringify(record)).not.toContain("SECRET");
    }
  });

  it("rebuilds its documents at reindex, and keeps them for a runtime that does not know it", async () => {
    const hosts = world(menuApi(() => menuJson(MENU)));
    const opened = await openWith(hosts, cleanups, { recipes: [menuRecipe] });
    const run = await runRecipe(opened.crawler, menuRecipe, "tue");
    const rebuilt = await opened.crawler.reindex();
    expect(rebuilt).toMatchObject({ captures: 1, docs: 2, failed: 0, carried: 0 });
    expect(rebuilt.unknown_recipes).toEqual([]);
    await opened.crawler.close();

    // an application with no recipe keeps the documents, and names the recipe
    const without = await openWith(hosts, cleanups, {}, opened.dir);
    const kept = await without.crawler.reindex();
    expect(kept).toMatchObject({ carried: 2, unknown_recipes: ["forno-menu"] });
    expect((await without.crawler.read("menu:forno-esempio/pane")).capture).toBe(run.capture);
    await without.crawler.close();

    // the recipe at open reads the captures again, and the capture ids stay the same
    const again = await openWith(hosts, cleanups, { recipes: [menuRecipe] }, opened.dir);
    expect(await again.crawler.reindex()).toMatchObject({ docs: 2, carried: 0 });
    const doc = await again.crawler.read("menu:forno-esempio/focaccia");
    expect(doc.capture).toBe(run.capture);
    expect(hosts.hits).toHaveLength(1);
  });

  it("keeps each version, so read at a time and diff work on its documents", async () => {
    let price = "4.50 EUR";
    const hosts = world(
      menuApi(() => menuJson([{ id: "focaccia", name: "Focaccia al rosmarino", price }])),
    );
    const { crawler, clock } = await openWith(hosts, cleanups, { recipes: [menuRecipe] });
    const old = await runRecipe(crawler, menuRecipe, "wed");
    const then = new Date(clock.now()).toISOString();
    clock.advance(86_400_000);
    price = "4.80 EUR";
    const now = await runRecipe(crawler, menuRecipe, "wed", { maxAge: "0" });
    expect(now.capture).not.toBe(old.capture);
    expect(now.docs[0]?.meta).toEqual({ price: "4.80 EUR" });

    const doc = "menu:forno-esempio/focaccia";
    expect((await crawler.read(doc)).text).toContain("4.80 EUR");
    const past = await crawler.read(doc, { at: then });
    expect(past).toMatchObject({ capture: old.capture, before_first: false });
    expect(past.text).toContain("4.50 EUR");
    expect(await crawler.verify(doc, "4.50 EUR", { at: then })).toMatchObject({ found: true });
    expect(await crawler.versions(doc)).toHaveLength(2);
    const diff = await crawler.diff(doc);
    expect(diff.from.capture).toBe(old.capture);
    expect(diff.same).toBe(false);
    expect(diff.summary.lines_changed).toBe(1);
  });

  it("reports an extractor that throws, and asks the source again for a stored copy that it cannot read", async () => {
    let body = "<!doctype html><p>closed for maintenance</p>";
    const hosts = world(menuApi(() => ({ body, headers: JSON_TYPE })));
    const { crawler } = await openWith(hosts, cleanups, { recipes: [menuRecipe] });
    const broken = await runRecipe(crawler, menuRecipe, "thu");
    expect(broken.outcome).toBe("ok");
    expect(broken.docs).toEqual([]);
    expect(broken.error).toMatch(/^extract failed \(forno-menu\): /);
    expect(broken.note).toContain("extract failed");
    // the stored copy is younger than maxAge, but the extractor cannot read it: one more request
    body = menuJson(MENU);
    const fixed = await runRecipe(crawler, menuRecipe, "thu");
    expect(fixed).toMatchObject({ error: null, from_cache: false });
    expect(fixed.docs).toHaveLength(2);
    expect(hosts.hits).toHaveLength(2);
    // reindex counts the capture that the extractor cannot read
    const counts = await crawler.reindex();
    expect(counts.failed).toBe(1);
    expect(counts.errors[0]?.error).toMatch(/JSON/);
  });

  it("obeys robots.txt for a page recipe, and holds back a page that refuses AI input", async () => {
    const eventsRecipe = defineRecipe({
      name: "forno-events",
      extract: (body, capture) => [
        {
          doc: `events:${capture.url}`,
          kind: "events",
          title: "Events at Forno Esempio",
          text: new TextDecoder().decode(body).replace(/<[^>]+>/g, " "),
          url: capture.url,
          meta: { source: "events page" },
        },
      ],
    });
    const hosts = world(
      {
        [SITE]: (path) =>
          path === "/events"
            ? {
                body: htmlPage("Events", `<p>A bread class on Saturday morning.</p>${FILLER}`),
                headers: { ...HTML, "content-signal": "ai-input=no" },
              }
            : undefined,
      },
      { [SITE]: "User-agent: *\nDisallow: /private/\n" },
    );
    const { crawler } = await openWith(hosts, cleanups);
    const refused = await runRecipe(crawler, eventsRecipe, `${SITE}/private/list`);
    expect(refused).toMatchObject({ outcome: "skipped", docs: [] });
    expect(refused.note).toMatch(/robots\.txt disallows/);
    expect(pagesOf(hosts)).toEqual([]);

    const held = await runRecipe(crawler, eventsRecipe, `${SITE}/events`);
    expect(held.held_back).toBe(true);
    expect(held.docs[0]).toMatchObject({ title: "", meta: {}, held_back: true });
    expect(held.note).toContain("asked not to be used as AI input");
    const given = await runRecipe(crawler, eventsRecipe, `${SITE}/events`, { userProvided: true });
    expect(given.docs[0]).toMatchObject({
      title: "Events at Forno Esempio",
      meta: { source: "events page" },
      held_back: false,
    });
    const overrides = [];
    for await (const record of crawler.runtime.captures.scan({ source: "fetch" })) {
      if (record.kind === "override") overrides.push(record.payload);
    }
    expect(overrides).toMatchObject([{ action: "recipe forno-events" }]);
  });

  it("gives a page recipe an archived copy after a refusal, read by the page reader, and refuses the fallback for an API", async () => {
    const pageRecipe = defineRecipe({
      name: "forno-news",
      extract: (_body, capture) => [
        {
          doc: `news:${capture.url}`,
          kind: "news",
          title: "News",
          text: "live news",
          url: capture.url,
          meta: {},
        },
      ],
    });
    const page = `${SITE}/news`;
    const hosts = world({
      [SITE]: (path) => (path === "/news" ? { status: 403, body: "no" } : undefined),
      "https://archive.org": (path) => {
        const asked = new URL(path, "https://archive.org");
        if (asked.pathname !== "/wayback/available") return undefined;
        return {
          body: JSON.stringify({
            archived_snapshots: {
              closest: {
                status: "200",
                available: true,
                url: `http://web.archive.org/web/20250102030405/${page}`,
                timestamp: "20250102030405",
              },
            },
          }),
          headers: JSON_TYPE,
        };
      },
      "https://web.archive.org": (path) =>
        path === `/web/20250102030405id_/${page}`
          ? {
              body: htmlPage("News of Forno Esempio", `<p>The oven is new this year.</p>${FILLER}`),
              headers: HTML,
            }
          : undefined,
    });
    const { crawler } = await openWith(hosts, cleanups);
    const result = await runRecipe(crawler, pageRecipe, page, { fallback: "archive" });
    expect(result).toMatchObject({
      outcome: "blocked",
      status: 403,
      archived: { source: "wayback", timestamp: "2025-01-02T03:04:05Z", original: page },
    });
    expect(result.docs).toHaveLength(1);
    expect(result.docs[0]).toMatchObject({ doc: `archive:${page}`, kind: "archived" });
    expect(result.note).toContain("the page reader read the archived copy");
    expect((await crawler.verify(`archive:${page}`, "The oven is new this year")).found).toBe(true);
    // the recipe never made a document of the old copy
    expect(crawler.runtime.index.get(`news:${page}`)).toBeUndefined();

    await expect(runRecipe(crawler, menuRecipe, "fri", { fallback: "archive" })).rejects.toThrow(
      /archived copy is for a page/,
    );
  });

  it("refuses at open a recipe with the name of an extractor of the application", async () => {
    const hosts = world({});
    await expect(
      openWith(hosts, cleanups, {
        extractors: { "forno-menu": () => [] },
        recipes: [menuRecipe],
      }),
    ).rejects.toThrow(/different extractor/);
  });
});
