import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OverpassElement, Venue } from "./venues.mts";
import {
  drawVenues,
  overpassQuery,
  quarters,
  readAreas,
  readVenues,
  venuesOf,
  websiteOf,
} from "./venues.mts";

/*
 * Made-up elements of an Overpass answer, on the domain `.example`. No test sends a request.
 */

const here = dirname(fileURLToPath(import.meta.url));

const element = (
  id: number,
  tags: Record<string, string>,
  extra: Partial<OverpassElement> = {},
): OverpassElement => ({ type: "node", id, lat: 1, lon: 2, tags, ...extra });

describe("the areas", () => {
  it("reads the areas file of the eval: three areas with a box each", () => {
    const areas = readAreas(readFileSync(join(here, "areas.json"), "utf8"));
    expect(areas.map((area) => area.name)).toEqual(["edinburgh", "portland", "melbourne"]);
    for (const { box } of areas) {
      expect(box.south).toBeLessThan(box.north);
      expect(box.west).toBeLessThan(box.east);
    }
  });

  it("refuses an area with no valid box or a name that is not unique", () => {
    const box = { south: 0, west: 0, north: 1, east: 1 };
    expect(() =>
      readAreas(JSON.stringify({ areas: [{ name: "a", label: "A", box: { ...box, north: -1 } }] })),
    ).toThrow(/valid box/);
    expect(() =>
      readAreas(
        JSON.stringify({
          areas: [
            { name: "a", label: "A", box },
            { name: "a", label: "B", box },
          ],
        }),
      ),
    ).toThrow(/not unique/);
  });
});

describe("the Overpass query", () => {
  it("asks for nodes and ways with a kind, a website and opening hours in the box", () => {
    const query = overpassQuery({ south: 1, west: 2, north: 3, east: 4 });
    expect(query).toContain('node["amenity"~"^(restaurant|cafe|bar|pub|fast_food)$"]');
    expect(query).toContain('way["shop"]["website"]["opening_hours"](1,2,3,4);');
    expect(query).toContain("out center tags;");
  });

  it("splits a box into four boxes that cover it", () => {
    const parts = quarters({ south: 0, west: 0, north: 2, east: 4 });
    expect(parts).toHaveLength(4);
    expect(parts[0]).toEqual({ south: 0, west: 0, north: 1, east: 2 });
    expect(parts[3]).toEqual({ south: 1, west: 2, north: 2, east: 4 });
  });
});

describe("the venues of an answer", () => {
  it("reads the site of a website tag", () => {
    expect(websiteOf("venue.example")).toBe("https://venue.example/");
    expect(websiteOf("http://venue.example/a;https://b.example")).toBe("http://venue.example/a");
    expect(websiteOf("ftp://venue.example/hours")).toBeUndefined();
    expect(websiteOf(" ")).toBeUndefined();
  });

  it("keeps a node or a way with a site and hours that the crawler reads, one time each", () => {
    const hours = { website: "https://a.example", opening_hours: "Mo-Fr 09:00-17:00" };
    const venues = venuesOf(
      [
        element(3, { ...hours, name: "Three" }),
        element(3, { ...hours, name: "Three again" }),
        element(1, hours),
        element(2, { ...hours, opening_hours: "by appointment" }),
        element(4, { opening_hours: "Mo 09:00-17:00" }),
        element(5, hours, {
          type: "way",
          lat: undefined,
          lon: undefined,
          center: { lat: 5, lon: 6 },
        }),
        element(6, hours, { type: "relation" }),
      ],
      "one",
    );
    expect(venues.map((venue) => venue.osm)).toEqual(["node/1", "node/3", "way/5"]);
    expect(venues[1]).toMatchObject({ name: "Three", area: "one", website: "https://a.example/" });
    expect(venues[2]).toMatchObject({ lat: 5, lon: 6 });
  });
});

describe("the draw", () => {
  const venues: Venue[] = Array.from({ length: 50 }, (_, at) => ({
    osm: `node/${String(at + 1)}`,
    name: null,
    website: "https://a.example/",
    opening_hours: "Mo 09:00-17:00",
    lat: 0,
    lon: 0,
    area: "one",
  }));

  it("draws the same venues at each run and for each order of the input", () => {
    const drawn = drawVenues(venues, 10, "seed", "one").map((venue) => venue.osm);
    expect(drawn).toHaveLength(10);
    expect(drawVenues([...venues].reverse(), 10, "seed", "one").map((venue) => venue.osm)).toEqual(
      drawn,
    );
    expect(drawVenues(venues, 10, "another seed", "one").map((venue) => venue.osm)).not.toEqual(
      drawn,
    );
  });

  it("keeps each venue when the area has no more than the count", () => {
    expect(drawVenues(venues.slice(0, 5), 10, "seed", "one")).toHaveLength(5);
  });

  it("reads a venues file and refuses an id that is not unique", () => {
    const file = { venues: [venues[0], venues[1]] };
    expect(readVenues(JSON.stringify(file)).venues).toHaveLength(2);
    expect(() => readVenues(JSON.stringify({ venues: [venues[0], venues[0]] }))).toThrow(
      /not unique/,
    );
  });
});
