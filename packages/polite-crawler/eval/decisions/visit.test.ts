import { afterEach, describe, expect, it } from "vitest";
import { readVenue } from "../../src/index.ts";
import {
  FILLER,
  HTML,
  htmlPage,
  jsonLd,
  openWith,
  pagesOf,
  world,
} from "../../src/test-recipes.ts";
import { labelVenue } from "./label.mts";
import type { Venue } from "./venues.mts";
import { readCrawlLog, visitVenue } from "./visit.mts";

/*
 * A made-up cafe on a mock host of the domain `.example`. No test uses the network.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const SITE = "https://cafe-visit.example";

const venue: Venue = {
  osm: "node/7",
  name: "Cafe Example",
  website: `${SITE}/`,
  opening_hours: "Mo-Fr 07:00-15:00; Sa 08:00-13:00; Su off",
  lat: 10,
  lon: 20,
  area: "one",
};

const HOURS =
  "<h2>Hours</h2><p>Monday - Friday 7am - 3pm</p><p>Saturday 8am - 1pm</p><p>Sunday closed</p>";

const home = htmlPage(
  "Cafe Example",
  `${FILLER}<a href="/gallery">Gallery</a> <a href="/hours">Opening hours</a> <a href="/menu">Menu</a> <a href="/private">Contact</a> <a href="https://other.example/hours">Hours</a>`,
  jsonLd({
    "@context": "https://schema.org",
    "@type": "CafeOrCoffeeShop",
    name: "Cafe Example",
    openingHours: "Mo-Su 09:00-17:00",
  }),
);

const site = (path: string) => {
  if (path === "/") return { body: home, headers: HTML };
  if (path === "/hours") return { body: htmlPage("Hours", `${FILLER}${HOURS}`), headers: HTML };
  if (path === "/menu") {
    return {
      body: htmlPage("Menu", `${FILLER}${HOURS}`),
      headers: { ...HTML, "content-signal": "ai-input=no" },
    };
  }
  if (path === "/gallery") return { body: htmlPage("Gallery", FILLER), headers: HTML };
  return undefined;
};

describe("the visit of a venue", () => {
  it("fetches the home page and its candidate links, with the rules of the crawler", async () => {
    const hosts = world({ [SITE]: site }, { [SITE]: "User-agent: *\nDisallow: /private\n" });
    const { crawler } = await openWith(hosts, cleanups);
    const visit = await visitVenue(crawler, venue);

    expect(visit.home?.url).toBe(`${SITE}/`);
    expect([...visit.pages.keys()]).toEqual([
      `${SITE}/hours`,
      `${SITE}/menu`,
      `${SITE}/private`,
      `${SITE}/gallery`,
    ]);
    // robots.txt refuses /private, so no request goes to it
    expect(pagesOf(hosts)).not.toContain(`${SITE}/private`);
    expect(visit.pages.get(`${SITE}/private`)).toBeNull();
    // the menu asks not to be AI input, so the eval reads nothing from it
    expect(visit.pages.get(`${SITE}/menu`)).toBeNull();
    expect(visit.held_back).toBe(1);
    expect(visit.pages.get(`${SITE}/hours`)).not.toBeNull();
  });

  it("chooses the same best reading as readVenue on the same pages", async () => {
    const hosts = world({ [SITE]: site }, { [SITE]: "User-agent: *\nDisallow: /private\n" });
    const { crawler } = await openWith(hosts, cleanups);
    const visit = await visitVenue(crawler, venue);
    const label = labelVenue({ venue, half: "test", home: visit.home, pages: visit.pages });
    const result = await readVenue(crawler, venue.website, {
      location: { lat: venue.lat, lon: venue.lon },
    });

    expect(label.links_outcome).toBe("rule-hit");
    expect(label.best_outcome).toBe("miss");
    expect(label.readings.map((one) => [one.from, one.hours])).toEqual(
      result.readings.map((one) => [one.from, one.hours]),
    );
    expect(label.best).not.toBeNull();
    expect(label.readings[label.best!]?.hours).toBe(result.best?.hours);
  });
});

describe("the log of the crawl", () => {
  it("reads a log and refuses a status that it does not know", () => {
    const entry = { status: "visited", fetches: 3, held_back: 0 };
    expect(readCrawlLog(JSON.stringify({ venues: { "node/1": entry } })).venues["node/1"]).toEqual(
      entry,
    );
    expect(() =>
      readCrawlLog(JSON.stringify({ venues: { "node/1": { ...entry, status: "done" } } })),
    ).toThrow(/status/);
  });
});
