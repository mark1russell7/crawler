import { describe, expect, it } from "vitest";
import type { PageLink, VenueSource } from "../../src/index.ts";
import { fromCompact } from "../../src/index.ts";
import type { VenuePages } from "./label.mts";
import { CANDIDATES, agreementOf, candidateLinks, labelVenue, pageLabelOf } from "./label.mts";
import type { Venue } from "./venues.mts";

/*
 * Made-up venues and pages on the domain `.example`. No test sends a request.
 */

const SITE = "https://venue.example/";
const OSM = "Mo-Fr 07:00-15:00; Sa 08:00-13:00; Su off";
const AGREES = "Hours\nMonday - Friday 7am - 3pm\nSaturday 8am - 1pm\nSunday closed";
const DISAGREES = "Hours\nMonday - Friday 9am - 5pm\nSaturday 10am - 4pm\nSunday closed";

const venue: Venue = {
  osm: "node/1",
  name: "Cafe Example",
  website: SITE,
  opening_hours: OSM,
  lat: 10,
  lon: 20,
  area: "one",
};

const link = (path: string, text: string, host = "venue.example"): PageLink => ({
  href: `https://${host}${path}`,
  text,
});

const LINKS: PageLink[] = [
  link("/gallery", "Gallery"),
  link("/hours", "Opening hours"),
  link("/menu.pdf", "Menu as a PDF"),
  link("/menu", "Menu"),
  link("/#top", "Home"),
  link("/hours", "Opening hours"),
  link("/x", "Hours", "other.example"),
  link("/contact", "Contact"),
  link("/blog", "Blog", "www.venue.example"),
  link("/about", "About us"),
];

const page = (url: string, text: string, links: readonly PageLink[] = []): VenueSource => ({
  url,
  text,
  meta: { links },
});

const pagesOf = (
  home: VenueSource | null,
  pages: Record<string, VenueSource | null> = {},
): VenuePages => ({ venue, half: "train", home, pages: new Map(Object.entries(pages)) });

const week = (value: string) => fromCompact(value, "osm")!.week;

describe("the candidate links of a home page", () => {
  it("gives the links of the rule first, then the other links of the site in the order of the page", () => {
    expect(
      candidateLinks(LINKS, SITE).map(({ url, rule_rank, position }) => [url, rule_rank, position]),
    ).toEqual([
      ["https://venue.example/hours", 1, 2],
      ["https://venue.example/menu", 2, 4],
      ["https://venue.example/contact", 3, 8],
      ["https://venue.example/about", 4, 10],
      ["https://venue.example/gallery", null, 1],
      ["https://www.venue.example/blog", null, 9],
    ]);
  });

  it("gives the text and the path of each link", () => {
    expect(candidateLinks(LINKS, SITE)[0]).toMatchObject({ text: "Opening hours", path: "/hours" });
  });

  it("leaves out files, other sites and the home page", () => {
    const urls = candidateLinks(LINKS, SITE).map((candidate) => candidate.url);
    expect(urls).not.toContain("https://venue.example/menu.pdf");
    expect(urls).not.toContain("https://other.example/x");
    expect(urls.some((url) => url.includes("#top"))).toBe(false);
  });

  it("keeps at most the counts of CANDIDATES", () => {
    const many = Array.from({ length: 30 }, (_, at) => [
      link(`/hours-${String(at)}`, "Hours"),
      link(`/page-${String(at)}`, "Page"),
    ]).flat();
    const candidates = candidateLinks(many, SITE);
    expect(candidates.filter((one) => one.rule_rank !== null)).toHaveLength(CANDIDATES.ranked);
    expect(candidates.filter((one) => one.rule_rank === null)).toHaveLength(CANDIDATES.others);
  });
});

describe("the agreement with OpenStreetMap", () => {
  const osm = week(OSM);

  it("agrees when compareHours finds no day that changed", () => {
    expect(agreementOf(osm, week("Mo-Fr 07:00-15:00; Sa 08:00-13:00; Su off"))).toBe("agrees");
  });

  it("agrees when the reading states only some of the days, and they are the same", () => {
    expect(agreementOf(osm, week("Sa 08:00-13:00"))).toBe("agrees");
  });

  it("disagrees when a day changed", () => {
    expect(agreementOf(osm, week("Mo-Fr 07:00-15:00; Sa 08:00-14:00"))).toBe("disagrees");
  });

  it("tells nothing when the two weeks share no day", () => {
    expect(agreementOf(week("Mo 07:00-15:00"), week("Tu 07:00-15:00"))).toBe("no-overlap");
  });
});

describe("the label of a page", () => {
  const osm = week(OSM);

  it("is no-page with no page", () => {
    expect(pageLabelOf(osm, undefined)).toBe("no-page");
  });

  it("is no-hours with no reading", () => {
    expect(pageLabelOf(osm, [])).toBe("no-hours");
  });

  it("is agrees when one reading agrees, and disagrees when no reading agrees", () => {
    const read = (text: string) => labelVenue(pagesOf(page(SITE, text))).home_label;
    expect(read(AGREES)).toBe("agrees");
    expect(read(DISAGREES)).toBe("disagrees");
    expect(read("Welcome to the cafe")).toBe("no-hours");
  });
});

describe("the outcomes of the two choices", () => {
  it("gives no-home with no home page", () => {
    const label = labelVenue(pagesOf(null));
    expect([label.links_outcome, label.best_outcome]).toEqual(["no-home", "no-home"]);
    expect(label.links).toEqual([]);
  });

  it("gives home-agrees when the home page agrees, and a hit when the best reading agrees", () => {
    const label = labelVenue(pagesOf(page(SITE, AGREES, LINKS)));
    expect([label.links_outcome, label.best_outcome]).toEqual(["home-agrees", "hit"]);
  });

  it("gives rule-hit when a page of the first links of the rule agrees", () => {
    const label = labelVenue(
      pagesOf(page(SITE, "Welcome", LINKS), {
        "https://venue.example/contact": page("https://venue.example/contact", AGREES),
      }),
    );
    expect([label.links_outcome, label.best_outcome]).toEqual(["rule-hit", "hit"]);
    expect(label.links.find((one) => one.path === "/contact")?.label).toBe("agrees");
    expect(label.rule_pages).toBe(3);
  });

  it("gives rule-miss when only a page past the first links of the rule agrees", () => {
    const label = labelVenue(
      pagesOf(page(SITE, "Welcome", LINKS), {
        "https://venue.example/hours": page("https://venue.example/hours", "No hours here"),
        "https://venue.example/about": page("https://venue.example/about", AGREES),
      }),
    );
    expect(label.links_outcome).toBe("rule-miss");
    // the rule did not read the page that agrees, so the readings of the rule tell nothing
    expect(label.best_outcome).toBe("no-reading");
  });

  it("gives rule-miss when only another link of the site agrees", () => {
    const label = labelVenue(
      pagesOf(page(SITE, DISAGREES, LINKS), {
        "https://venue.example/gallery": page("https://venue.example/gallery", AGREES),
      }),
    );
    expect([label.links_outcome, label.best_outcome]).toEqual(["rule-miss", "none-agrees"]);
  });

  it("gives no-page-agrees when no page agrees", () => {
    const label = labelVenue(
      pagesOf(page(SITE, "Welcome", LINKS), {
        "https://venue.example/hours": page("https://venue.example/hours", DISAGREES),
        "https://venue.example/menu": null,
      }),
    );
    expect([label.links_outcome, label.best_outcome]).toEqual(["no-page-agrees", "none-agrees"]);
    expect(label.links.find((one) => one.path === "/menu")?.label).toBe("no-page");
    expect(label.links.find((one) => one.path === "/gallery")?.label).toBe("no-page");
  });

  it("gives a miss when a reading agrees and the best reading does not agree", () => {
    const jsonld = {
      "@context": "https://schema.org",
      "@type": "CafeOrCoffeeShop",
      name: "Cafe Example",
      openingHours: "Mo-Su 09:00-17:00",
    };
    const home: VenueSource = {
      url: SITE,
      text: "Welcome",
      meta: { links: LINKS, jsonld: [jsonld] },
    };
    const label = labelVenue(
      pagesOf(home, {
        "https://venue.example/hours": page("https://venue.example/hours", AGREES),
      }),
    );
    expect(label.links_outcome).toBe("rule-hit");
    expect(label.best_outcome).toBe("miss");
    expect(label.best).not.toBeNull();
    expect(label.readings[label.best!]).toMatchObject({ from: "jsonld", agreement: "disagrees" });
    expect(label.readings.some((one) => one.agreement === "agrees")).toBe(true);
  });

  it("writes the week of OpenStreetMap, the half and the features of each link", () => {
    const label = labelVenue(pagesOf(page(SITE, "Welcome", LINKS)));
    expect(label).toMatchObject({ osm: "node/1", area: "one", half: "train", home: SITE });
    expect(label.osm_hours).not.toBe("");
    expect(label.links[0]).toEqual({
      url: "https://venue.example/hours",
      text: "Opening hours",
      path: "/hours",
      position: 2,
      rule_rank: 1,
      label: "no-page",
      readings: 0,
    });
  });
});
