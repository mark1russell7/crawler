import { afterEach, describe, expect, it } from "vitest";
import { compareHours } from "./hours.ts";
import type { PageLink } from "./html.ts";
import {
  VENUE_LIMITS,
  locationMatches,
  namesVenue,
  rankHoursLinks,
  readVenue,
  venueReadingsOf,
} from "./recipe-venue.ts";
import { versionAtTime } from "./runtime.ts";
import { FILLER, HTML, htmlPage, jsonLd, openWith, pagesOf, world } from "./test-recipes.ts";

/*
 * The venue recipe, with made-up venues on the domain `.example`: the bakery Forno Esempio, the
 * restaurant group Trattoria Campione with two locations, and the cafe Caffè Modello. The
 * addresses, the positions and the phone numbers are made up too.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const FORNO = "https://forno-esempio.example";

const bakery = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
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
  ...extra,
});

const HOURS_TEXT = "Hours\nMonday - Friday 7am - 3pm\nSaturday 8am - 1pm\nSunday closed";

describe("the readings of one document", () => {
  it("reads the JSON-LD and the text, with the source of each reading", () => {
    const read = venueReadingsOf({
      doc: `url:${FORNO}/`,
      url: `${FORNO}/`,
      capture: "fetch.000000000001",
      fetched_at: "2026-10-01T08:00:00.000Z",
      text: `Forno Esempio\n\n${HOURS_TEXT}\n\nHappy hour\nFriday 4pm - 6pm`,
      meta: {
        jsonld: [{ "@type": "WebSite", name: "Forno Esempio" }, bakery()],
        links: [
          { href: `${FORNO}/menu`, text: "Our menu" },
          { href: "https://www.instagram.com/forno.esempio.menu", text: "Menu photos" },
          { href: `${FORNO}/files/menu.pdf`, text: "Menu (PDF)" },
          { href: `${FORNO}/menu`, text: "Menu again" },
        ],
      },
    });
    expect(read.readings.map((one) => [one.from, one.rank, one.label, one.schedule])).toEqual([
      ["jsonld", 0, null, "opening"],
      ["text", 1, "Hours", "opening"],
      ["text", 4, "Happy hour", "other"],
    ]);
    const [jsonld, text] = read.readings;
    expect(jsonld).toMatchObject({
      hours: "Mon–Fri 07:00–15:00; Sat 08:00–14:00; Sun closed",
      path: "jsonld[1]",
      doc: `url:${FORNO}/`,
      capture: "fetch.000000000001",
      fetched_at: "2026-10-01T08:00:00.000Z",
      inferred: false,
    });
    expect(text?.week).toMatchObject({ sat: [["08:00", "13:00"]], sun: [] });
    expect(text?.raw).toBe("Monday - Friday 7am - 3pm\nSaturday 8am - 1pm\nSunday closed");
    expect(read.phone).toBe("+1 555 0100");
    expect(read.menus).toEqual([
      { url: `${FORNO}/menu`, text: "Our menu" },
      { url: `${FORNO}/files/menu.pdf`, text: "Menu (PDF)" },
    ]);
    expect(read.notes).toEqual([]);
  });

  it("reads only the location of the venue on a page that lists more than one", () => {
    const branch = (street: string, lat: number, days: string) => ({
      "@type": "Restaurant",
      name: "Trattoria Campione",
      address: { "@type": "PostalAddress", streetAddress: street },
      geo: { "@type": "GeoCoordinates", latitude: lat, longitude: 20.5678 },
      openingHours: days,
    });
    const source = {
      url: "https://trattoria-campione.example/locations",
      text: "Our two dining rooms.",
      meta: {
        jsonld: [
          branch("12 Via Esempio", 10.1234, "Mo-Sa 12:00-22:00"),
          branch("48 Via Modello", 10.2234, "Tu-Su 17:00-23:00"),
        ],
      },
    };
    const byStreet = venueReadingsOf(source, { location: { address: "12 Via Esempio, Unit 2" } });
    expect(byStreet.readings.map((one) => one.hours)).toEqual(["Mon–Sat 12:00–22:00"]);
    // about 100 m from the second branch
    const byPin = venueReadingsOf(source, { location: { lat: 10.2243, lon: 20.5678 } });
    expect(byPin.readings.map((one) => one.hours)).toEqual(["Tue–Sun 17:00–23:00"]);
    const none = venueReadingsOf(source);
    expect(none.readings).toEqual([]);
    expect(none.notes[0]).toMatch(/lists 2 locations: give location/);
    const far = venueReadingsOf(source, { location: { address: "7 Via Lontana" } });
    expect(far.notes[0]).toMatch(/none matched the location/);
  });

  it("matches a location by the street number and a word of the street, or by the position", () => {
    const record = {
      address: "12 Via Esempio",
      geo: { latitude: "10.1234", longitude: "20.5678" },
    };
    expect(locationMatches(record, { address: "12 Via Esempio" })).toBe(true);
    expect(locationMatches(record, { address: "12 Esempio Street, Suite 4" })).toBe(true);
    expect(locationMatches(record, { address: "14 Via Esempio" })).toBe(false);
    // the kind of road is not a word of the street
    expect(locationMatches({ address: "12 Main Street" }, { address: "12 Other Street" })).toBe(
      false,
    );
    expect(locationMatches(record, { lat: 10.1235, lon: 20.5679 })).toBe(true);
    expect(locationMatches(record, { lat: 10.2, lon: 20.5678 })).toBe(false);
    expect(
      locationMatches({ address: { streetAddress: "3 Via Corta" } }, { address: "3 Via Corta" }),
    ).toBe(true);
    expect(locationMatches({}, { address: "3 Via Corta" })).toBe(false);
    expect(locationMatches({ geo: { latitude: 200, longitude: 0 } }, { lat: 200, lon: 0 })).toBe(
      false,
    );
  });

  it("tells if a page names the venue, with the first word and most of the others", () => {
    const page = (text: string) => ({ title: "Welcome", text });
    expect(namesVenue("Caffè Modello", page("Caffe Modello opens at seven."))).toBe(true);
    expect(namesVenue("The Caffè Modello", page("CAFFÈ MODELLO & friends"))).toBe(true);
    expect(namesVenue("Caffè Modello", page("This domain is for sale."))).toBe(false);
    // the first word of the name must be on the page
    expect(namesVenue("Caffè Modello", page("Modello Dentistry"))).toBe(false);
    expect(namesVenue("The & Of", page("anything"))).toBeUndefined();
  });

  it("ranks the links of a site by the words that tell of hours or a menu", () => {
    const links: PageLink[] = [
      { href: `${FORNO}/blog`, text: "Blog" },
      { href: `${FORNO}/about`, text: "About us" },
      { href: `${FORNO}/menu`, text: "Menu" },
      { href: `${FORNO}/visit`, text: "Hours & location" },
      { href: `${FORNO}/contact`, text: "Contact" },
      { href: `${FORNO}/files/hours.pdf`, text: "Hours (PDF)" },
      { href: "https://other.example/hours", text: "Hours" },
      { href: `${FORNO}/`, text: "Home hours" },
      { href: `${FORNO}/menu#today`, text: "Menu of today" },
      { href: "https://www.forno-esempio.example/lunch-menu", text: "Lunch" },
    ];
    expect(rankHoursLinks(links, `${FORNO}/`).map((link) => link.href)).toEqual([
      `${FORNO}/visit`,
      "https://www.forno-esempio.example/lunch-menu",
      `${FORNO}/menu`,
      `${FORNO}/contact`,
      `${FORNO}/about`,
    ]);
    expect(rankHoursLinks([{ href: "not a url", text: "Hours" }], `${FORNO}/`)).toEqual([]);
  });
});

/** The pages of the site of Forno Esempio. */
const fornoSite =
  (overrides: Record<string, string> = {}) =>
  (path: string) => {
    const pages: Record<string, string> = {
      "/": htmlPage(
        "Forno Esempio",
        `<p>Forno Esempio bakes bread in a wood oven.</p>${FILLER}
       <a href="/visit">Hours &amp; location</a> <a href="/menu">Menu</a> <a href="/contact">Contact</a>
       <a href="/about">About us</a> <a href="/blog">Blog</a> <a href="https://www.instagram.com/forno.esempio">Instagram</a>`,
        jsonLd(bakery()),
      ),
      "/visit": htmlPage(
        "Visit",
        `<h2>Hours</h2><p>Monday - Friday 7am - 3pm</p><p>Saturday 8am - 1pm</p><p>Sunday closed</p>${FILLER}`,
      ),
      "/menu": htmlPage(
        "Menu",
        `<p>Focaccia, pane di semola.</p><a href="/files/menu.pdf">The whole menu</a>${FILLER}`,
        jsonLd(bakery()),
      ),
      "/contact": htmlPage("Contact", `<p>Write to bakery@example.com.</p>${FILLER}`),
      ...overrides,
    };
    const body = pages[path];
    return body === undefined ? undefined : { body, headers: HTML };
  };

describe("readVenue", () => {
  it("reads the home page and the pages most likely to hold hours, and names the days the readings disagree on", async () => {
    const hosts = world({ [FORNO]: fornoSite() });
    const { crawler } = await openWith(hosts, cleanups);
    const result = await readVenue(crawler, `${FORNO}/`, {
      pages: 2,
      name: "Forno Esempio",
      osm: {
        value: "Mo-Fr 07:00-15:00; Sa 08:00-12:00; Su off",
        url: "https://osm.example/node/1",
      },
    });
    expect(pagesOf(hosts)).toEqual([`${FORNO}/`, `${FORNO}/visit`, `${FORNO}/menu`]);
    expect(result).toMatchObject({
      url: `${FORNO}/`,
      home: `${FORNO}/`,
      moved: null,
      names_venue: true,
      held_back: false,
      phone: "+1 555 0100",
    });
    expect(result.pages.map((page) => [page.url, page.outcome])).toEqual([
      [`${FORNO}/`, "ok"],
      [`${FORNO}/visit`, "ok"],
      [`${FORNO}/menu`, "ok"],
    ]);
    // the JSON-LD of the menu page repeats the JSON-LD of the home page: one reading
    expect(result.readings.map((one) => [one.from, one.rank, one.url])).toEqual([
      ["jsonld", 0, `${FORNO}/`],
      ["text", 1, `${FORNO}/visit`],
      ["osm", 2, "https://osm.example/node/1"],
    ]);
    expect(result.best?.from).toBe("jsonld");
    expect(result.from_site?.from).toBe("jsonld");
    expect(result.disagree).toEqual(["sat"]);
    expect(result.menus.map((menu) => menu.url)).toEqual([
      `${FORNO}/menu`,
      `${FORNO}/files/menu.pdf`,
    ]);
    expect(result.captures).toHaveLength(3);
    for (const one of result.readings.filter((reading) => reading.from !== "osm")) {
      expect(result.captures).toContain(one.capture);
    }
    // a reading of the text is a quote that verify finds in its capture
    const text = result.readings[1]!;
    const quote = await crawler.verify(text.doc!, text.raw, { capture: text.capture! });
    expect(quote.found).toBe(true);
    // the second read answers from the store
    const again = await readVenue(crawler.runtime, `${FORNO}/`, { pages: 2 });
    expect(again.pages.every((page) => page.from_cache)).toBe(true);
    expect(pagesOf(hosts)).toHaveLength(3);
  });

  it("obeys robots.txt for each page, and says why a page gave nothing", async () => {
    const hosts = world({ [FORNO]: fornoSite() }, { [FORNO]: "User-agent: *\nDisallow: /visit\n" });
    const { crawler } = await openWith(hosts, cleanups);
    const result = await readVenue(crawler, `${FORNO}/`, { pages: 3 });
    expect(pagesOf(hosts)).toEqual([`${FORNO}/`, `${FORNO}/menu`, `${FORNO}/contact`]);
    expect(result.pages.find((page) => page.url === `${FORNO}/visit`)?.outcome).toBe("skipped");
    expect(result.note).toMatch(/\/visit: skipped \(robots\.txt disallows it/);
    expect(result.readings.map((one) => one.from)).toEqual(["jsonld"]);
  });

  it("reads no hours from a site that does not name the venue, with requireName", async () => {
    const SALE = "https://caffe-modello.example";
    const hosts = world({
      [SALE]: (path) =>
        path === "/"
          ? {
              body: htmlPage(
                "Domain for sale",
                `<p>This domain is for sale. Open Mon-Fri 9am-5pm.</p>${FILLER}<a href="/hours">Hours</a>`,
              ),
              headers: HTML,
            }
          : undefined,
    });
    const { crawler } = await openWith(hosts, cleanups);
    const doubt = await readVenue(crawler, `${SALE}/`, { name: "Caffè Modello", pages: 0 });
    expect(doubt.names_venue).toBe(false);
    expect(doubt.note).toMatch(/does not name Caffè Modello/);
    expect(doubt.readings).toHaveLength(1);
    const strict = await readVenue(crawler, `${SALE}/`, {
      name: "Caffè Modello",
      requireName: true,
    });
    expect(strict.readings).toEqual([]);
    expect(strict.note).toMatch(/requireName/);
    expect(pagesOf(hosts)).toEqual([`${SALE}/`]);
  });

  it("says when the site moved to a different host, and ranks the links of the new host", async () => {
    const OLD = "https://caffe-modello.example";
    const NEW = "https://new-caffe-modello.example";
    const hosts = world({
      [OLD]: (path) =>
        path === "/" ? { status: 301, headers: { location: `${NEW}/` } } : undefined,
      [NEW]: (path) =>
        path === "/"
          ? {
              body: htmlPage(
                "Caffè Modello",
                `<p>Caffè Modello serves coffee.</p>${FILLER}<a href="/hours">Opening hours</a>`,
              ),
              headers: HTML,
            }
          : path === "/hours"
            ? {
                body: htmlPage("Opening hours", `<p>Hours</p><p>Daily 8am - 6pm</p>${FILLER}`),
                headers: HTML,
              }
            : undefined,
    });
    const { crawler } = await openWith(hosts, cleanups);
    const result = await readVenue(crawler, `${OLD}/`, { name: "Caffè Modello" });
    expect(result.home).toBe(`${NEW}/`);
    expect(result.moved).toBe(`${NEW}/`);
    expect(result.note).toContain(`now goes to ${NEW}/`);
    expect(result.best?.hours).toBe("Mon–Sun 08:00–18:00");
    expect(result.best?.url).toBe(`${NEW}/hours`);
  });

  it("reads nothing from a page that refuses AI input, unless a person gave the URL", async () => {
    const hosts = world({
      [FORNO]: (path) => {
        const reply = fornoSite()(path);
        return path === "/visit" && reply !== undefined
          ? { ...reply, headers: { ...HTML, "content-signal": "ai-input=no" } }
          : reply;
      },
    });
    const { crawler } = await openWith(hosts, cleanups);
    const held = await readVenue(crawler, `${FORNO}/`, { pages: 1 });
    expect(held.held_back).toBe(true);
    expect(held.pages[1]).toMatchObject({ url: `${FORNO}/visit`, held_back: true });
    expect(held.readings.map((one) => one.url)).toEqual([`${FORNO}/`]);
    expect(held.note).toContain("asked not to be used as AI input");
    const given = await readVenue(crawler, `${FORNO}/`, {
      pages: 1,
      userProvided: true,
      job: "j-1",
    });
    expect(given.held_back).toBe(false);
    expect(given.readings.map((one) => one.url)).toContain(`${FORNO}/visit`);
    const overrides: unknown[] = [];
    for await (const record of crawler.runtime.captures.scan({ source: "fetch" })) {
      if (record.kind === "override") overrides.push(record.payload);
    }
    expect(overrides).toMatchObject([{ action: "j-1" }]);
  });

  it("reads a version at a time, and compareHours finds the day that changed", async () => {
    let saturday = "8am - 1pm";
    const hosts = world({
      [FORNO]: (path) =>
        path === "/"
          ? {
              body: htmlPage(
                "Forno Esempio",
                `<h2>Hours</h2><p>Monday - Friday 7am - 3pm</p><p>Saturday ${saturday}</p><p>Sunday closed</p>${FILLER}`,
              ),
              headers: HTML,
            }
          : undefined,
    });
    const { crawler, clock } = await openWith(hosts, cleanups);
    const before = await readVenue(crawler, `${FORNO}/`, { pages: 0 });
    const then = new Date(clock.now()).toISOString();
    clock.advance(7 * 86_400_000);
    saturday = "9am - 2pm";
    const after = await readVenue(crawler, `${FORNO}/`, { pages: 0, maxAge: "0" });
    expect(after.from_site?.capture).not.toBe(before.from_site?.capture);
    const compared = compareHours(before.from_site!.week, after.from_site!.week);
    expect(compared).toEqual({ status: "changed", days: ["sat"], added: [], skipped: [] });
    // the pure reader reads the version that was current at a time
    const version = versionAtTime(crawler.runtime, `url:${FORNO}/`, then).version!;
    const past = venueReadingsOf(version);
    expect(past.readings[0]?.week.sat).toEqual([["08:00", "13:00"]]);
    expect(past.readings[0]?.capture).toBe(before.from_site?.capture);
  });

  it("refuses options that are not valid", async () => {
    const hosts = world({});
    const { crawler } = await openWith(hosts, cleanups);
    await expect(readVenue(crawler, "not a url")).rejects.toThrow(TypeError);
    await expect(readVenue(crawler, "ftp://forno-esempio.example/")).rejects.toThrow(TypeError);
    await expect(
      readVenue(crawler, `${FORNO}/`, { pages: VENUE_LIMITS.maxPages + 1 }),
    ).rejects.toThrow(RangeError);
    await expect(readVenue(crawler, `${FORNO}/`, { pages: 1.5 })).rejects.toThrow(RangeError);
    const unreadable = await readVenue(crawler, `${FORNO}/`, { osm: "sunrise-sunset", pages: 0 });
    expect(unreadable.note).toMatch(/OpenStreetMap hours cannot be read/);
  });
});

describe("the time of the venue readers", () => {
  /** The work of a reader for an input of n units and of 2n units: it grows in proportion. */
  const linear = (steps: (n: number) => number): void => {
    const small = steps(2_000);
    const large = steps(4_000);
    expect(large / small).toBeGreaterThan(1.6);
    expect(large / small).toBeLessThan(2.4);
  };

  it("is linear in the text, the records and the links of a document", () => {
    const records = (n: number) =>
      Array.from({ length: n }, (_, index) => ({
        "@type": "Restaurant",
        name: `Branch ${String(index)}`,
        openingHours: "Mo-Fr 09:00-17:00",
      }));
    const links = (n: number) =>
      Array.from({ length: n }, (_, index) => ({
        href: `${FORNO}/menu/${String(index)}`,
        text: "menu",
      }));
    linear(
      (n) =>
        venueReadingsOf({
          url: `${FORNO}/`,
          text: "Mon 9am-5pm\n".repeat(n),
          meta: { jsonld: records(n / 100), links: links(n / 100) },
        }).steps,
    );
    linear((n) => venueReadingsOf({ url: null, text: "1-".repeat(n), meta: {} }).steps);
    linear((n) => venueReadingsOf({ url: null, text: `Hours\n${"x ".repeat(n)}`, meta: {} }).steps);
  });

  it("stays bounded on a page with very many links and readings", () => {
    const many = Array.from({ length: 50_000 }, (_, index) => ({
      href: `${FORNO}/hours/${String(index)}`,
      text: "Hours",
    }));
    expect(rankHoursLinks(many, `${FORNO}/`)).toHaveLength(VENUE_LIMITS.links);
    const read = venueReadingsOf({
      url: `${FORNO}/`,
      text: Array.from(
        { length: 500 },
        (_, index) => `Room ${String(index)}\nMon 9am-5pm\n\nx`,
      ).join("\n"),
      meta: { links: many },
    });
    expect(read.readings).toHaveLength(VENUE_LIMITS.readingsPerPage);
    expect(read.menus).toHaveLength(0);
    expect(read.notes[0]).toMatch(/more than 20 readings/);
  });
});
