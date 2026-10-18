import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Line, Parsed } from "./cli-line.ts";
import {
  NOTHING_READ,
  UsageError,
  VENUE_MAX_PAGES,
  WALL,
  compareDays,
  dayText,
  describeProduct,
  keptWeekOf,
  moneyText,
  productCode,
  readLine,
  refusedPage,
} from "./cli-line.ts";
import type { RecipeTarget } from "./recipe.ts";
import { prepareRecipe, productCommand, venueCommand } from "./cli-recipes.ts";
import { compareHours } from "./hours.ts";
import type { Week } from "./hours.ts";
import { VENUE_LIMITS } from "./recipe-venue.ts";
import { FILLER, HTML, htmlPage, jsonLd, openWith, pagesOf, world } from "./test-recipes.ts";
import type { LocalSite } from "./test-surfaces.ts";
import { localSite, removeDir, runCli, tempDir } from "./test-surfaces.ts";

/*
 * The commands `venue` and `product`, with made-up sites on the domain `.example` (mock hosts in
 * this process) and on 127.0.0.1 (a local server for the command line in a child process). The
 * bakery Forno Esempio, the restaurant group Trattoria Campione and the shop Bottega Campione are
 * made up, and so are their addresses, positions, phone numbers, codes and prices.
 */

const SLOW = 60_000;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** This function reads a command line that must be valid, and gives its command. */
const command = (args: readonly string[]): Line => {
  const parsed: Parsed = readLine(args, {});
  if (parsed.kind !== "command") throw new Error(`no command: ${parsed.kind}`);
  return parsed;
};

/** This function gives the message of the usage error of a function. */
const usageOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    return (error as Error).message;
  }
  throw new Error("no usage error");
};

const usage = (args: readonly string[]): string => usageOf(() => readLine(args, {}));

/** This function does a command of a recipe in this process, and gives its exit code and its output. */
const run = async (
  target: RecipeTarget,
  args: readonly string[],
): Promise<{ readonly code: number; readonly text: string }> => {
  const line = command(args);
  const recipe = line.recipeLine!;
  const printed: string[] = [];
  const io = { json: line.values.json === true, out: (text: string) => void printed.push(text) };
  const code =
    recipe.recipe === "venue"
      ? await venueCommand(target, recipe, prepareRecipe(recipe), io)
      : await productCommand(target, recipe, io);
  return { code, text: printed.join("\n") };
};

const linesOf = (text: string): string[] => text.split(String.fromCharCode(10));

// ── the made-up sites ──────────────────────────────────────────────────────

const FORNO = "https://forno-esempio.example";
const TRATTORIA = "https://trattoria-campione.example";
const CAFFE = "https://caffe-modello.example";
const SHOP = "https://bottega-campione.example";
const PAGE = `${SHOP}/products/olio-esempio`;

type Json = Record<string, unknown>;

const bakery: Json = {
  "@context": "https://schema.org",
  "@type": "Bakery",
  name: "Forno Esempio",
  telephone: "+1 555 0100",
  openingHoursSpecification: [
    {
      "@type": "OpeningHoursSpecification",
      dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
      opens: "07:00",
      closes: "15:00",
    },
    {
      "@type": "OpeningHoursSpecification",
      dayOfWeek: "Saturday",
      opens: "08:00",
      closes: "14:00",
    },
    { "@type": "OpeningHoursSpecification", dayOfWeek: "Sunday", opens: "00:00", closes: "00:00" },
  ],
};

/** The bakery gives its hours in its JSON-LD, and in the text of its page "Visit" with a different Saturday. */
const forno = (path: string) => {
  const pages: Record<string, string> = {
    "/": htmlPage(
      "Forno Esempio",
      `<p>Forno Esempio bakes bread in a wood oven.</p>${FILLER}
       <a href="/visit">Hours &amp; location</a> <a href="/menu">Menu</a> <a href="/blog">Blog</a>`,
      jsonLd(bakery),
    ),
    "/visit": htmlPage(
      "Visit",
      `<h2>Hours</h2><p>Monday - Friday 7am - 3pm</p><p>Saturday 8am - 1pm</p><p>Sunday closed</p>${FILLER}`,
    ),
    "/menu": htmlPage(
      "Menu",
      `<p>Focaccia, pane di semola.</p><a href="/files/menu.pdf">The whole menu</a>${FILLER}`,
      jsonLd(bakery),
    ),
  };
  const body = pages[path];
  return body === undefined ? undefined : { body, headers: HTML };
};

const branch = (street: string, lat: number, days: string): Json => ({
  "@type": "Restaurant",
  name: "Trattoria Campione",
  address: { "@type": "PostalAddress", streetAddress: street },
  geo: { "@type": "GeoCoordinates", latitude: lat, longitude: 20.5678 },
  openingHours: days,
});

/** The restaurant group lists its two locations on one page. */
const trattoria = (path: string) =>
  path === "/"
    ? {
        body: htmlPage(
          "Trattoria Campione",
          `<p>Trattoria Campione has two dining rooms.</p>${FILLER}`,
          jsonLd([
            branch("12 Via Esempio", 10.1234, "Mo-Sa 12:00-22:00"),
            branch("48 Via Modello", 10.2234, "Tu-Su 17:00-23:00"),
          ]),
        ),
        headers: HTML,
      }
    : undefined;

const offer = (price: string, availability = "InStock", extra: Json = {}): Json => ({
  "@type": "Offer",
  price,
  priceCurrency: "EUR",
  availability: `https://schema.org/${availability}`,
  seller: { "@type": "Organization", name: "Bottega Campione" },
  ...extra,
});

/** The product group of the page: three bottles, from 9.90 EUR to 18.00 EUR. */
const oil: Json = {
  "@context": "https://schema.org",
  "@type": "ProductGroup",
  "@id": `${PAGE}#product`,
  url: PAGE,
  name: "Olio Esempio",
  brand: { "@type": "Brand", name: "Campione" },
  sku: "OE-GROUP",
  gtin13: "0000000000017",
  image: [{ "@type": "ImageObject", url: `${SHOP}/img/olio.jpg` }],
  hasVariant: [
    { "@type": "Product", name: "Olio Esempio 250 ml", sku: "OE-250", offers: offer("9.90") },
    {
      "@type": "Product",
      name: "Olio Esempio 500 ml",
      sku: "OE-500",
      offers: offer("12.50", "InStock", { url: `${PAGE}?variant=222` }),
    },
    {
      "@type": "Product",
      name: "Olio Esempio 1 l",
      sku: "OE-1000",
      offers: offer("18.00", "OutOfStock"),
    },
  ],
};

/** A product of the box "people also bought": it is first on the page, and it is not the product of the page. */
const related: Json = {
  "@type": "Product",
  url: `${SHOP}/products/olio-rustico`,
  name: "Olio Rustico",
  description: "A related product with a long description. ".repeat(20),
  offers: offer("5.00"),
};

const shop = (path: string) =>
  path.startsWith("/products/olio-esempio")
    ? {
        body: htmlPage(
          "Olio Esempio",
          `<p>An olive oil of Campione.</p>${FILLER}`,
          jsonLd([related, oil]),
        ),
        headers: HTML,
      }
    : path === "/collections/olio"
      ? { body: htmlPage("Our oils", `<p>All the oils of the shop.</p>${FILLER}`), headers: HTML }
      : path === "/products/riservato"
        ? {
            body: htmlPage("Riservato", `<p>For members.</p>${FILLER}`, jsonLd(oil)),
            headers: { ...HTML, "content-signal": "ai-input=no" },
          }
        : path === "/products/aceto-campione"
          ? { status: 403, body: "Forbidden" }
          : undefined;

// ── the command line ───────────────────────────────────────────────────────

describe("readLine: venue and product", () => {
  it("reads the options of venue, and the defaults of product", () => {
    const venue = command([
      "venue",
      `${FORNO}/`,
      "--name",
      "Forno Esempio",
      "--require-name",
      "--address",
      "12 Via Esempio",
      "--lat",
      "10.1234",
      // a value that starts with a dash goes after =
      "--lon=-20.5",
      "--osm",
      "Mo-Fr 07:00-15:00",
      "--pages",
      "0",
      "--compare",
      "kept.json",
      "--on-behalf-of",
      "Claude-User",
      "--on-behalf-of",
      "Other_Agent",
      "--user-provided",
      "--archive-fallback",
      "--archive-despite-robots",
      "--budget",
      "2m",
      "--max-age",
      "0",
      "--render",
      "never",
    ]);
    expect(venue.recipeLine).toEqual({
      recipe: "venue",
      url: `${FORNO}/`,
      render: "never",
      maxAge: 0,
      budget: 120_000,
      onBehalfOf: ["Claude-User", "Other_Agent"],
      userProvided: true,
      fallback: "archive",
      archiveDespiteRobots: true,
      name: "Forno Esempio",
      requireName: true,
      location: { address: "12 Via Esempio", lat: 10.1234, lon: -20.5 },
      osm: "Mo-Fr 07:00-15:00",
      pages: 0,
      compare: "kept.json",
    });
    expect(command(["product", PAGE]).recipeLine).toEqual({
      recipe: "product",
      url: PAGE,
      render: "auto",
      maxAge: 86_400_000,
      budget: undefined,
      onBehalfOf: undefined,
      userProvided: false,
      fallback: undefined,
      archiveDespiteRobots: false,
      name: undefined,
      requireName: false,
      location: undefined,
      osm: undefined,
      pages: undefined,
      compare: undefined,
    });
    expect(
      command(["venue", `${FORNO}/`, "--lat", "10", "--lon", "20"]).recipeLine?.location,
    ).toEqual({ lat: 10, lon: 20 });
    expect(usage(["venue", `${FORNO}/`, "--lat", "10", "--lon", "-20.5"])).toMatch(
      /^Option '--lon' argument is ambiguous/,
    );
    expect(command(["find", "bread"]).recipeLine).toBeUndefined();
    // the venue recipe and the command line agree on the most pages
    expect(VENUE_MAX_PAGES).toBe(VENUE_LIMITS.maxPages);
    // the shared options keep their spellings, and the recipes sign their requests too
    const env = {
      POLITE_CRAWLER_SIGN_KEY: "k.pem",
      POLITE_CRAWLER_SIGNATURE_AGENT: "https://bot.example",
    };
    expect(readLine(["product", PAGE], env)).toMatchObject({
      signKey: "k.pem",
      signatureAgent: "https://bot.example",
    });
  });

  it("refuses a wrong command line of venue and product", () => {
    const url = `${FORNO}/`;
    const cases: ReadonlyArray<readonly [readonly string[], string]> = [
      [["venue"], "venue wants the URL of the site of one venue"],
      [["product", "a", "b"], "product wants the URL of one product page"],
      [
        ["venue", "ftp://forno-esempio.example/"],
        'venue wants an http or https URL, not "ftp://forno-esempio.example/"',
      ],
      [["product", "notaurl"], 'product wants an http or https URL, not "notaurl"'],
      [["product", PAGE, "--name", "Olio"], "--name is an option of venue"],
      [["product", PAGE, "--compare", "kept.json"], "--compare is an option of venue"],
      [
        ["fetch", url, "--on-behalf-of", "Claude-User"],
        "--on-behalf-of is an option of venue or product",
      ],
      [["read", "url:x", "--pages", "1"], "--pages is an option of venue"],
      [["venue", url, "--limit", "3"], "--limit is an option of find"],
      [["venue", url, "--pages", "9"], "--pages wants a whole number from 0 to 8"],
      [["venue", url, "--pages", "two"], '--pages wants a whole number, not "two"'],
      [["venue", url, "--lat", "10"], "--lat and --lon go together"],
      [
        ["venue", url, "--lat", "91", "--lon", "0"],
        '--lat wants a number from -90 to 90, not "91"',
      ],
      [
        ["venue", url, "--lat", "1", "--lon", "east"],
        '--lon wants a number from -180 to 180, not "east"',
      ],
      [["venue", url, "--require-name"], "--require-name goes with --name"],
      [["venue", url, "--name", " "], "--name wants the name of the venue"],
      [["venue", url, "--address", ""], "--address wants a street address"],
      [
        ["venue", url, "--osm", " "],
        '--osm wants an opening_hours value, such as "Mo-Fr 08:00-18:00"',
      ],
      [["venue", url, "--compare", " "], "--compare wants a file"],
      [
        ["venue", url, "--on-behalf-of", "Claude User"],
        '--on-behalf-of wants the robots.txt token of an agent, such as Claude-User, not "Claude User"',
      ],
      [
        ["product", PAGE, "--archive-despite-robots"],
        "--archive-despite-robots works only with --archive-fallback",
      ],
      [
        ["product", PAGE, "--budget", "soon"],
        '--budget: not a duration: "soon" (write a number and ms, s, m, h, d or w; m is minutes)',
      ],
      [
        ["venue", url, "--render", "sometimes"],
        '--render is auto, never or always, not "sometimes"',
      ],
    ];
    for (const [args, message] of cases) expect(usage(args), args.join(" ")).toBe(message);
    // an OpenStreetMap value that the reader cannot read is a wrong command line too
    const osm = command(["venue", url, "--osm", "sunrise-sunset"]).recipeLine!;
    expect(usageOf(() => prepareRecipe(osm))).toMatch(
      /^--osm: the hours reader cannot read "sunrise-sunset"/,
    );
  });
});

describe("the kept week of --compare", () => {
  it("reads a week, a week of one interval for each day, and a reading of venue --json", async () => {
    const dir = await tempDir("cli-recipes-kept");
    cleanups.push(() => removeDir(dir));
    const write = async (name: string, text: string): Promise<string> => {
      const file = join(dir, name);
      await writeFile(file, text);
      return file;
    };
    const week = await write(
      "week.json",
      JSON.stringify({
        mon: [["07:00", "15:00"]],
        sat: [
          ["8:00", "12:00"],
          ["14:00", "18:00"],
        ],
        sun: [],
      }),
    );
    expect(keptWeekOf(week)).toEqual({
      file: week,
      week: {
        mon: [["07:00", "15:00"]],
        sat: [
          ["8:00", "12:00"],
          ["14:00", "18:00"],
        ],
        sun: [],
      },
    });
    const kept = await write(
      "hours-week.json",
      JSON.stringify({ hours_week: { mon: ["07:00", "15:00"], sun: null }, split: [] }),
    );
    expect(keptWeekOf(kept).week).toEqual({ mon: [["07:00", "15:00"]], sun: [] });
    const reading = await write(
      "reading.json",
      JSON.stringify({ from: "jsonld", week: { tue: [["00:00", "00:00"]] } }),
    );
    expect(keptWeekOf(reading).week).toEqual({ tue: [["00:00", "00:00"]] });
    // a byte order mark at the start of the file does not count
    const marked = await write("marked.json", `${String.fromCharCode(0xfeff)}{"fri": null}`);
    expect(keptWeekOf(marked).week).toEqual({ fri: [] });

    expect(usageOf(() => keptWeekOf(join(dir, "missing.json")))).toMatch(
      /^--compare: the file .*missing\.json does not open \(ENOENT\)$/,
    );
    const broken = await write("broken.json", "{ mon: ");
    expect(usageOf(() => keptWeekOf(broken))).toBe(`--compare: the file ${broken} is not JSON`);
    const list = await write("list.json", "[]");
    expect(usageOf(() => keptWeekOf(list))).toMatch(/is not a week\. Write a list of intervals/);
    const named = await write("named.json", '{"monday": []}');
    expect(usageOf(() => keptWeekOf(named))).toBe(
      `--compare: the file ${named} names "monday", not a day: use mon, tue, wed, thu, fri, sat or sun`,
    );
    for (const value of ['[["7am", "3pm"]]', '"closed"', '["07:00"]', '[["25:00", "26:00"]]']) {
      const wrong = await write("wrong.json", `{"mon": ${value}}`);
      expect(
        usageOf(() => keptWeekOf(wrong)),
        value,
      ).toMatch(/\(the value of mon is not\)$/);
    }
  });

  it("gives each day of a comparison: same, changed, new and not read", () => {
    const kept: Week = { mon: [["07:00", "15:00"]], sat: [["08:00", "13:00"]], sun: [] };
    const read: Week = {
      mon: [["7:00", "15:00"]],
      tue: [["07:00", "15:00"]],
      sat: [["08:00", "14:00"]],
    };
    const comparison = compareHours(kept, read);
    expect(compareDays(kept, read, comparison)).toEqual([
      { day: "mon", status: "same", kept: kept.mon, read: read.mon },
      { day: "tue", status: "new", kept: undefined, read: read.tue },
      { day: "sat", status: "changed", kept: kept.sat, read: read.sat },
      { day: "sun", status: "not read", kept: [], read: undefined },
    ]);
    const split = compareHours(
      {
        fri: [
          ["11:00", "14:00"],
          ["17:00", "22:00"],
        ],
      },
      { fri: [["11:00", "22:00"]] },
      {
        skipSplit: true,
      },
    );
    expect(compareDays({ fri: [] }, { fri: [] }, split)[0]?.status).toBe("skipped");
    // with no kept day, each day that the reading states is new
    const first = compareHours({}, read);
    expect(compareDays({}, read, first).map((one) => [one.day, one.status])).toEqual([
      ["mon", "new"],
      ["tue", "new"],
      ["sat", "new"],
    ]);
    expect([dayText(undefined), dayText([]), dayText([["00:00", "00:00"]])]).toEqual([
      "not stated",
      "closed",
      "open 24 hours",
    ]);
    expect(
      dayText([
        ["11:30", "14:30"],
        ["17:00", "22:00"],
      ]),
    ).toBe("11:30–14:30, 17:00–22:00");
  });
});

// ── venue ──────────────────────────────────────────────────────────────────

describe("venue", () => {
  it("prints the week of the site, each reading with its source, the disagreement, the menus and the phone", async () => {
    const hosts = world({ [FORNO]: forno });
    const { crawler } = await openWith(hosts, cleanups);
    const args = [
      "venue",
      `${FORNO}/`,
      "--pages",
      "2",
      "--name",
      "Forno Esempio",
      "--osm",
      "Mo-Fr 07:00-15:00; Sa 08:00-12:00; Su off",
    ];
    const { code, text } = await run(crawler, args);
    expect(code).toBe(0);
    expect(pagesOf(hosts)).toEqual([`${FORNO}/`, `${FORNO}/visit`, `${FORNO}/menu`]);
    const lines = linesOf(text);
    expect(lines.slice(0, 4)).toEqual([
      `✓ ${FORNO}/`,
      "  the site: Mon–Fri 07:00–15:00; Sat 08:00–14:00; Sun closed",
      expect.stringMatching(
        /^  from jsonld, rank 0, https:\/\/forno-esempio\.example\/, capture fetch\.[0-9a-f]{12}$/,
      ),
      "readings, the best first:",
    ]);
    expect(lines).toContain("  rank 0  jsonld  Mon–Fri 07:00–15:00; Sat 08:00–14:00; Sun closed");
    expect(lines).toContain(
      '  rank 1  text "Hours"  Mon–Fri 07:00–15:00; Sat 08:00–13:00; Sun closed',
    );
    expect(lines).toContain("  rank 2  osm  Mon–Fri 07:00–15:00; Sat 08:00–12:00; Sun closed");
    expect(text).toMatch(
      /^    https:\/\/forno-esempio\.example\/ · jsonld\[0\] · capture fetch\./m,
    );
    expect(text).toMatch(/^    https:\/\/forno-esempio\.example\/visit · capture fetch\./m);
    expect(text).toMatch(/^    quote: "Monday - Friday 7am - 3pm.*Sunday closed"$/m);
    expect(text).toMatch(/^    value: \[\{"@type":"OpeningHoursSpecification"/m);
    expect(lines).toContain("    value: Mo-Fr 07:00-15:00; Sa 08:00-12:00; Su off");
    expect(lines).toContain(
      "the readings disagree on Sat: 08:00–14:00 (rank 0 jsonld) · 08:00–13:00 (rank 1 text) · 08:00–12:00 (rank 2 osm)",
    );
    expect(lines).toEqual(
      expect.arrayContaining([
        "menus:",
        `  ${FORNO}/menu  Menu`,
        `  ${FORNO}/files/menu.pdf  The whole menu`,
        "phone: +1 555 0100",
        "names the venue: yes",
        "pages (3):",
        `  ✓ ${FORNO}/  ok 200`,
        `  ✓ ${FORNO}/visit  ok 200`,
        `  ✓ ${FORNO}/menu  ok 200`,
      ]),
    );
    expect(text).not.toContain("note:");

    // --json prints the VenueResult; the stored copies answer, with no request
    const json = await run(crawler, [...args, "--json"]);
    expect(json.code).toBe(0);
    const result = JSON.parse(json.text) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual([
      "best",
      "captures",
      "disagree",
      "from_site",
      "held_back",
      "home",
      "menus",
      "moved",
      "names_venue",
      "note",
      "pages",
      "phone",
      "readings",
      "url",
    ]);
    expect(result).toMatchObject({
      url: `${FORNO}/`,
      home: `${FORNO}/`,
      disagree: ["sat"],
      phone: "+1 555 0100",
      best: { from: "jsonld", rank: 0 },
      from_site: { from: "jsonld", hours: "Mon–Fri 07:00–15:00; Sat 08:00–14:00; Sun closed" },
    });
    expect(pagesOf(hosts)).toHaveLength(3);
  });

  it("reads no hours on a page of more locations without a location, and reads one location with --address or --lat and --lon", async () => {
    const hosts = world({ [TRATTORIA]: trattoria });
    const { crawler } = await openWith(hosts, cleanups);
    const none = await run(crawler, ["venue", `${TRATTORIA}/`, "--pages", "0"]);
    expect(none.code).toBe(NOTHING_READ);
    expect(linesOf(none.text).slice(0, 2)).toEqual([`✗ ${TRATTORIA}/`, "  no opening hours found"]);
    expect(none.text).toContain(
      `note: ${TRATTORIA}/ lists 2 locations: give location to read the hours of one`,
    );
    const street = await run(crawler, [
      "venue",
      `${TRATTORIA}/`,
      "--pages",
      "0",
      "--address",
      "12 Via Esempio, Unit 2",
    ]);
    expect(street.code).toBe(0);
    expect(street.text).toContain("  the site: Mon–Sat 12:00–22:00");
    // about 100 m from the second location
    const pin = await run(crawler, [
      "venue",
      `${TRATTORIA}/`,
      "--pages",
      "0",
      "--lat",
      "10.2243",
      "--lon",
      "20.5678",
    ]);
    expect(pin.code).toBe(0);
    expect(pin.text).toContain("  the site: Tue–Sun 17:00–23:00");
    expect(pagesOf(hosts)).toEqual([`${TRATTORIA}/`]);
  });

  it("compares the week of the site with a kept week, day by day", async () => {
    const dir = await tempDir("cli-recipes-compare");
    cleanups.push(() => removeDir(dir));
    const file = join(dir, "kept.json");
    const day = ["07:00", "15:00"];
    await writeFile(
      file,
      JSON.stringify({
        hours_week: { mon: day, tue: day, wed: day, thu: day, fri: day, sat: ["08:00", "13:00"] },
      }),
    );
    const hosts = world({ [FORNO]: forno, [TRATTORIA]: trattoria });
    const { crawler } = await openWith(hosts, cleanups);
    const args = ["venue", `${FORNO}/`, "--pages", "0", "--compare", file];
    const { code, text } = await run(crawler, args);
    expect(code).toBe(0);
    const lines = linesOf(text);
    const at = lines.indexOf(`compare with ${file}: changed (Sat)`);
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at + 1, at + 8)).toEqual([
      "  Mon  same      07:00–15:00",
      "  Tue  same      07:00–15:00",
      "  Wed  same      07:00–15:00",
      "  Thu  same      07:00–15:00",
      "  Fri  same      07:00–15:00",
      "  Sat  changed   08:00–13:00 → 08:00–14:00",
      "  Sun  new       closed",
    ]);
    const json = JSON.parse((await run(crawler, [...args, "--json"])).text) as Record<
      string,
      unknown
    >;
    expect(json["compare"]).toEqual({
      file,
      kept: expect.objectContaining({ sat: [["08:00", "13:00"]] }),
      comparison: { status: "changed", days: ["sat"], added: ["sun"], skipped: [] },
    });
    expect(json["from_site"]).toMatchObject({ from: "jsonld" });
    // with no reading of the site, there is nothing to compare
    const none = await run(crawler, ["venue", `${TRATTORIA}/`, "--pages", "0", "--compare", file]);
    expect(none.code).toBe(NOTHING_READ);
    expect(none.text).toContain(
      `compare with ${file}: no reading of the site with no guess, so nothing to compare`,
    );
    const noneJson = await run(crawler, [
      "venue",
      `${TRATTORIA}/`,
      "--pages",
      "0",
      "--compare",
      file,
      "--json",
    ]);
    expect((JSON.parse(noneJson.text) as { compare: unknown }).compare).toMatchObject({
      comparison: null,
    });
  });

  it("gives the wall code when the site refuses the crawler, and says what moved", async () => {
    const MOVED = "https://new-forno-esempio.example";
    const hosts = world({
      [CAFFE]: (path) => (path === "/" ? { status: 403, body: "Forbidden" } : undefined),
      "https://old-forno-esempio.example": (path) =>
        path === "/" ? { status: 301, headers: { location: `${MOVED}/` } } : undefined,
      [MOVED]: forno,
    });
    const { crawler } = await openWith(hosts, cleanups);
    const refused = await run(crawler, ["venue", `${CAFFE}/`]);
    expect(refused.code).toBe(WALL);
    expect(linesOf(refused.text).slice(0, 2)).toEqual([
      `✗ ${CAFFE}/`,
      "  wall: the site refused the crawler (blocked 403). The crawler does not try a different identity.",
    ]);
    expect(refused.text).toContain(`  ✗ ${CAFFE}/  blocked 403`);
    const moved = await run(crawler, [
      "venue",
      "https://old-forno-esempio.example/",
      "--pages",
      "0",
      "--name",
      "Caffè Modello",
    ]);
    expect(moved.code).toBe(0);
    expect(moved.text).toContain(`moved: the site now goes to ${MOVED}/`);
    expect(moved.text).toContain(
      "names the venue: no. The domain can belong to a different business now.",
    );
    // --require-name reads no hours from a site that does not name the venue
    const strict = await run(crawler, [
      "venue",
      "https://old-forno-esempio.example/",
      "--pages",
      "0",
      "--name",
      "Caffè Modello",
      "--require-name",
    ]);
    expect(strict.code).toBe(NOTHING_READ);
    expect(strict.text).toContain("requireName");
  });

  it("holds back a page that refuses AI input, unless --user-provided", async () => {
    const hosts = world({
      [FORNO]: (path) => {
        const reply = forno(path);
        return reply === undefined
          ? undefined
          : { ...reply, headers: { ...HTML, "content-signal": "ai-input=no" } };
      },
    });
    const { crawler } = await openWith(hosts, cleanups);
    const held = await run(crawler, ["venue", `${FORNO}/`, "--pages", "0"]);
    expect(held.code).toBe(NOTHING_READ);
    expect(held.text).toContain(
      "held back: a page asked not to be AI input, so the recipe read nothing from it. Add --user-provided if you gave this URL yourself. The crawler logs that read.",
    );
    expect(held.text).toContain(`  ✓ ${FORNO}/  ok 200 · held back`);
    const given = await run(crawler, ["venue", `${FORNO}/`, "--pages", "0", "--user-provided"]);
    expect(given.code).toBe(0);
    expect(given.text).not.toContain("held back:");
  });
});

// ── product ────────────────────────────────────────────────────────────────

describe("product", () => {
  it("prints the product of the page with its variant, not a related product", async () => {
    const hosts = world({ [SHOP]: shop });
    const { crawler } = await openWith(hosts, cleanups);
    const url = `${PAGE}?variant=222`;
    const { code, text } = await run(crawler, ["product", url]);
    expect(code).toBe(0);
    expect(linesOf(text)).toEqual([
      "✓ Olio Esempio",
      `  ${url}`,
      "  brand Campione · sku OE-GROUP · gtin 0000000000017",
      "  price 9.90 EUR to 18.00 EUR, the range of the offers",
      "  availability InStock (the offers: InStock, OutOfStock)",
      "  variant Olio Esempio 500 ml · sku OE-500 · 12.50 EUR · InStock",
      "  seller Bottega Campione",
      `  image ${SHOP}/img/olio.jpg`,
      expect.stringMatching(
        /^  ok 200 · doc url:https:\/\/bottega-campione\.example\/products\/olio-esempio\?variant=222 · capture fetch\.[0-9a-f]{12}$/,
      ),
    ]);
    expect(text).not.toContain("Olio Rustico");

    // --json prints the ProductResult; the stored copy answers
    const json = await run(crawler, ["product", url, "--json"]);
    expect(json.code).toBe(0);
    const result = JSON.parse(json.text) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual([
      "availabilities",
      "availability",
      "brand",
      "capture",
      "captures",
      "doc",
      "fetched_at",
      "found",
      "from_cache",
      "gtin",
      "held_back",
      "image",
      "name",
      "note",
      "outcome",
      "price",
      "price_to",
      "rendered",
      "seller",
      "sku",
      "status",
      "url",
      "variant",
      "verified",
      "wall",
    ]);
    expect(result).toMatchObject({
      name: "Olio Esempio",
      price: { amount: 9.9, currency: "EUR", raw: "9.90" },
      price_to: { amount: 18, currency: "EUR" },
      variant: { sku: "OE-500", price: { amount: 12.5 } },
      wall: false,
      from_cache: true,
    });
    expect(pagesOf(hosts)).toHaveLength(1);
  });

  it("gives the wall code at a refusal, and the code of nothing read for a list, a held-back page and a missing page", async () => {
    const hosts = world({ [SHOP]: shop }, { [SHOP]: "User-agent: *\nDisallow: /private/\n" });
    const { crawler } = await openWith(hosts, cleanups);
    const list = await run(crawler, ["product", `${SHOP}/collections/olio`, "--render", "never"]);
    expect(list.code).toBe(NOTHING_READ);
    expect(linesOf(list.text)[0]).toBe(`✗ ${SHOP}/collections/olio`);
    expect(list.text).toContain("  note: no schema.org Product data on the page");
    const held = await run(crawler, ["product", `${SHOP}/products/riservato`]);
    expect(held.code).toBe(NOTHING_READ);
    expect(held.text).toContain(
      "  held back: the page asked not to be AI input. Add --user-provided if you gave this URL yourself. The crawler logs that read.",
    );
    const given = await run(crawler, ["product", `${SHOP}/products/riservato`, "--user-provided"]);
    expect(given.code).toBe(0);
    const missing = await run(crawler, ["product", `${SHOP}/products/nessuno`]);
    expect(missing.code).toBe(NOTHING_READ);
    expect(missing.text).toContain("  not-found 404");
    const robots = await run(crawler, ["product", `${SHOP}/private/olio`]);
    expect(robots.code).toBe(WALL);
    const wall = await run(crawler, ["product", `${SHOP}/products/aceto-campione`]);
    expect(wall.code).toBe(WALL);
    expect(linesOf(wall.text).slice(0, 2)).toEqual([
      `✗ ${SHOP}/products/aceto-campione`,
      "  wall: the shop refused the crawler (blocked 403). The crawler does not try a different identity.",
    ]);
    expect(wall.text).toContain("the shop refused the crawler (blocked)");
  });

  it("writes money with its currency code, and tells a wall from a page that is not there", () => {
    expect(moneyText({ amount: 1299, currency: "EUR", raw: "1.299,00" })).toBe("1,299.00 EUR");
    expect(moneyText({ amount: 980, currency: "JPY", raw: "980" })).toBe("980 JPY");
    expect(moneyText({ amount: 1.299, currency: "KWD", raw: "1.299" })).toBe("1.299 KWD");
    expect(moneyText({ amount: 9.999, currency: "EUR", raw: "9.999" })).toBe("9.999 EUR");
    const page = (outcome: string, note: string | null = null, doc: string | null = null) => ({
      outcome,
      note,
      doc,
    });
    expect(
      [
        page("blocked"),
        page("challenge"),
        page("payment-required"),
        page("skipped", "robots.txt disallows it for polite-crawler"),
        page("skipped", "host stopped until 2026-10-07T13:00:00.000Z: blocked"),
        page("ok", "the page is a bot check (cloudflare), not the content"),
        page("not-found"),
        page("skipped", "egress policy: 127.0.0.1 is a loopback address"),
        page("ok", "a bot check", "url:x"),
      ].map(refusedPage),
    ).toEqual([true, true, true, true, true, true, false, false, false]);
  });

  it("names the reason when rendering is off", async () => {
    const hosts = world({ [SHOP]: shop });
    const { crawler } = await openWith(hosts, cleanups);
    const list = await run(crawler, ["product", `${SHOP}/collections/olio`, "--json"]);
    const result = JSON.parse(list.text) as Parameters<typeof describeProduct>[0];
    expect(productCode(result)).toBe(NOTHING_READ);
    const off = describeProduct(
      { ...result, note: "the render gave nothing more: no browser configured for rendering" },
      "playwright-core is not installed",
    );
    expect(off.at(-1)).toBe("  rendering is off: playwright-core is not installed");
    expect(describeProduct(result, undefined).join(" ")).not.toContain("rendering is off");
  });
});

// ── the command line in a child process ────────────────────────────────────

describe("the command line: venue and product", () => {
  let site: LocalSite;
  let work: string;

  beforeAll(async () => {
    work = await tempDir("cli-recipes");
    const product = jsonLd({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Olio Esempio 500 ml",
      sku: "OE-500",
      offers: offer("12.50"),
    });
    site = await localSite((request, response) => {
      const path = request.url ?? "/";
      const html = (body: string): void =>
        void response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
      if (path === "/robots.txt")
        response.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n");
      else if (path === "/")
        html(
          htmlPage(
            "Forno Esempio",
            `<h2>Hours</h2><p>Monday - Friday 7am - 3pm</p><p>Saturday 8am - 1pm</p><p>Sunday closed</p>${FILLER}`,
          ),
        );
      else if (path === "/oil") html(htmlPage("Olio Esempio", FILLER, product));
      else if (path === "/plain") html(htmlPage("About us", FILLER));
      else if (path === "/locked")
        response.writeHead(403, { "content-type": "text/plain" }).end("no");
      else response.writeHead(404, { "content-type": "text/plain" }).end("no such page");
    });
  }, SLOW);

  afterAll(async () => {
    await site.close();
    await removeDir(work);
  });

  it(
    "exits with 0 when it read something, 3 when it read nothing and 4 at a wall, and prints JSON",
    async () => {
      const store = join(work, "store");
      const local = ["--allow-private", "--no-browser", "--dir", store];
      const venue = await runCli(["venue", `${site.origin}/`, "--pages", "0", ...local]);
      expect(venue.code, venue.stderr).toBe(0);
      expect(venue.stdout).toContain(
        "  the site: Mon–Fri 07:00–15:00; Sat 08:00–13:00; Sun closed",
      );
      const json = await runCli(["venue", `${site.origin}/`, "--pages", "0", "--json", ...local]);
      expect(json.code).toBe(0);
      expect(JSON.parse(json.stdout)).toMatchObject({
        url: `${site.origin}/`,
        from_site: { from: "text", label: "Hours" },
        pages: [{ from_cache: true }],
      });
      const product = await runCli(["product", `${site.origin}/oil`, "--json", ...local]);
      expect(product.code, product.stderr).toBe(0);
      expect(JSON.parse(product.stdout)).toMatchObject({
        name: "Olio Esempio 500 ml",
        price: { amount: 12.5, currency: "EUR" },
        wall: false,
      });
      const plain = await runCli(["venue", `${site.origin}/plain`, "--pages", "0", ...local]);
      expect(plain.code).toBe(3);
      expect(plain.stdout).toContain("no opening hours found");
      // a refusal stops the host in its store: this one has a store of its own
      const wall = await runCli([
        "product",
        `${site.origin}/locked`,
        "--allow-private",
        "--no-browser",
        "--dir",
        join(work, "walled"),
      ]);
      expect(wall.code).toBe(4);
      expect(wall.stdout).toContain("wall: the shop refused the crawler (blocked 403)");
    },
    SLOW,
  );

  it(
    "exits with 2 for a wrong command line, and opens no store",
    async () => {
      const dir = join(work, "never");
      const cases: ReadonlyArray<readonly [readonly string[], string]> = [
        [["venue"], "venue wants the URL of the site of one venue"],
        [["product", "ftp://bottega-campione.example/"], "product wants an http or https URL"],
        [["product", PAGE, "--pages", "1"], "--pages is an option of venue"],
        [["venue", `${FORNO}/`, "--compare", join(work, "missing.json")], "--compare: the file"],
        [["venue", `${FORNO}/`, "--osm", "sunrise-sunset"], "--osm: the hours reader cannot read"],
      ];
      // one child process at a time
      for (const [args, message] of cases) {
        const result = await runCli([...args, "--dir", dir]);
        expect(result.code, args.join(" ")).toBe(2);
        expect(result.stdout, args.join(" ")).toBe("");
        expect(result.stderr, args.join(" ")).toContain(`polite-crawler: ${message}`);
      }
      expect(existsSync(dir)).toBe(false);
    },
    SLOW,
  );
});
