/**
 * The venues of the decision eval: the areas, the Overpass query, the venues of an answer and the
 * seeded draw. Each function here is pure. The live collection is `collect.mts`.
 *
 * The data of OpenStreetMap is © OpenStreetMap contributors, under the ODbL. The file of venues is
 * an artifact of CI only. It does not go into the repository.
 */
import { deriveSeed, random, seedOf } from "@mark1russell7/rigor-generators";
import { DAYS, fromCompact } from "../../src/index.ts";

/** The attribution that each summary of OpenStreetMap data carries. */
export const ATTRIBUTION = "© OpenStreetMap contributors (ODbL)";

/** A box of degrees (WGS84): the south and north latitudes, the west and east longitudes. */
export interface Box {
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
}

/** One area of the eval: a short name, a label for people, and its box. */
export interface Area {
  readonly name: string;
  readonly label: string;
  readonly box: Box;
}

/** One venue of OpenStreetMap with a site and opening hours. */
export interface Venue {
  /** This text is the type and the id of the OpenStreetMap element, for example `node/123`. */
  readonly osm: string;
  readonly name: string | null;
  /** This URL is the `website` tag, with `https://` when the tag has no scheme. */
  readonly website: string;
  /** This text is the `opening_hours` tag, as OpenStreetMap gives it. */
  readonly opening_hours: string;
  readonly lat: number;
  readonly lon: number;
  /** This text is the name of the area of the venue. */
  readonly area: string;
}

const isBox = (value: unknown): value is Box => {
  const box = value as Partial<Record<keyof Box, unknown>> | null;
  if (typeof box !== "object" || box === null) return false;
  const { south, west, north, east } = box;
  return (
    typeof south === "number" &&
    typeof west === "number" &&
    typeof north === "number" &&
    typeof east === "number" &&
    south < north &&
    west < east &&
    south >= -90 &&
    north <= 90 &&
    west >= -180 &&
    east <= 180
  );
};

/** This function reads and checks the areas file: each area has a unique name, a label and a valid box. */
export const readAreas = (json: string): Area[] => {
  const parsed = JSON.parse(json) as { areas?: unknown };
  if (!Array.isArray(parsed.areas) || parsed.areas.length === 0)
    throw new Error("the areas file has no list areas");
  const seen = new Set<string>();
  return parsed.areas.map((item: unknown, at) => {
    const area = item as Partial<Record<keyof Area, unknown>>;
    const where = `area ${String(at + 1)}`;
    if (typeof area.name !== "string" || !/^[a-z0-9-]+$/.test(area.name))
      throw new Error(`${where} has no lowercase name`);
    if (seen.has(area.name)) throw new Error(`${where}: the name ${area.name} is not unique`);
    seen.add(area.name);
    if (typeof area.label !== "string" || area.label.trim() === "")
      throw new Error(`${where} has no label`);
    if (!isBox(area.box)) throw new Error(`${where} has no valid box`);
    return { name: area.name, label: area.label, box: area.box };
  });
};

/** The kinds of venue of the eval: the values of the tag `amenity`, and each value of `shop`. */
const AMENITY = "^(restaurant|cafe|bar|pub|fast_food)$";

/**
 * This function gives the Overpass query of one box: the nodes and the ways with a kind of the
 * eval, a `website` and an `opening_hours`. A way gives its center.
 */
export const overpassQuery = (box: Box, timeoutSeconds = 180): string => {
  const bbox = [box.south, box.west, box.north, box.east].map(String).join(",");
  const kinds = [`["amenity"~"${AMENITY}"]`, `["shop"]`];
  const parts = kinds.flatMap((kind) =>
    ["node", "way"].map((type) => `  ${type}${kind}["website"]["opening_hours"](${bbox});`),
  );
  return `[out:json][timeout:${String(timeoutSeconds)}];\n(\n${parts.join("\n")}\n);\nout center tags;\n`;
};

/** This function splits a box into four boxes of the same size. */
export const quarters = (box: Box): Box[] => {
  const midLat = (box.south + box.north) / 2;
  const midLon = (box.west + box.east) / 2;
  return [
    { south: box.south, west: box.west, north: midLat, east: midLon },
    { south: box.south, west: midLon, north: midLat, east: box.east },
    { south: midLat, west: box.west, north: box.north, east: midLon },
    { south: midLat, west: midLon, north: box.north, east: box.east },
  ];
};

/** The part of an element of an Overpass answer that the eval reads. */
export interface OverpassElement {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly lat?: unknown;
  readonly lon?: unknown;
  readonly center?: { readonly lat?: unknown; readonly lon?: unknown } | undefined;
  readonly tags?: Readonly<Record<string, unknown>> | undefined;
}

/** This function gives the site of a `website` tag: the first value, with `https://` when it has no scheme. */
export const websiteOf = (tag: string): string | undefined => {
  const first = (tag.split(";")[0] ?? "").trim();
  if (first === "") return undefined;
  const value = /^[a-z][a-z0-9+.-]*:/i.test(first) ? first : `https://${first}`;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
};

/** This function tells if an `opening_hours` value gives a week of at least one day to the reader of the crawler. */
export const readsHours = (value: string): boolean => {
  const hours = fromCompact(value, "osm");
  return hours !== undefined && DAYS.some((day) => hours.week[day] !== undefined);
};

/** This function compares two venues by the type and then the number of their id. */
export const byOsm = (a: { readonly osm: string }, b: { readonly osm: string }): number => {
  const [typeA = "", idA = "0"] = a.osm.split("/");
  const [typeB = "", idB = "0"] = b.osm.split("/");
  return typeA < typeB ? -1 : typeA > typeB ? 1 : Number(idA) - Number(idB);
};

/**
 * This function gives the venues of the elements of Overpass answers, in the order of their ids.
 * It keeps a node or a way with a site that it can read and hours that the crawler reads. It keeps
 * each element one time.
 */
export const venuesOf = (elements: readonly OverpassElement[], area: string): Venue[] => {
  const venues = new Map<string, Venue>();
  for (const element of elements) {
    const { type, id, tags } = element;
    if ((type !== "node" && type !== "way") || typeof id !== "number" || tags === undefined)
      continue;
    const osm = `${type}/${String(id)}`;
    if (venues.has(osm)) continue;
    const lat = typeof element.lat === "number" ? element.lat : element.center?.lat;
    const lon = typeof element.lon === "number" ? element.lon : element.center?.lon;
    if (typeof lat !== "number" || typeof lon !== "number") continue;
    const site = typeof tags["website"] === "string" ? websiteOf(tags["website"]) : undefined;
    const hours = tags["opening_hours"];
    if (site === undefined || typeof hours !== "string" || !readsHours(hours)) continue;
    const name = typeof tags["name"] === "string" ? tags["name"] : null;
    venues.set(osm, { osm, name, website: site, opening_hours: hours, lat, lon, area });
  }
  return [...venues.values()].sort(byOsm);
};

/**
 * This function draws at most `count` venues of one area with a seed. The draw does not depend on
 * the order of the input, and the result is in the order of the ids.
 */
export const drawVenues = (
  venues: readonly Venue[],
  count: number,
  seed: string,
  area: string,
): Venue[] => {
  const sorted = [...venues].sort(byOsm);
  if (sorted.length <= count) return sorted;
  return random(deriveSeed(seedOf(seed), area))
    .sample(sorted, count)
    .sort(byOsm);
};

/** The file of venues that `collect.mts` writes. */
export interface VenuesFile {
  readonly attribution: string;
  readonly collected_at: string;
  readonly seed: string;
  readonly per_area: number;
  readonly areas: ReadonlyArray<{
    readonly name: string;
    readonly label: string;
    readonly box: Box;
    /** This value is the count of venues of the area that have a site and hours that the crawler reads. */
    readonly found: number;
    /** This value is the count of tiles of the queries of the area. */
    readonly tiles: number;
  }>;
  readonly venues: readonly Venue[];
}

/** This function reads and checks a file of venues. */
export const readVenues = (json: string): VenuesFile => {
  const parsed = JSON.parse(json) as Partial<VenuesFile>;
  if (!Array.isArray(parsed.venues)) throw new Error("the venues file has no list venues");
  const seen = new Set<string>();
  for (const [at, venue] of parsed.venues.entries()) {
    const where = `venue ${String(at + 1)}`;
    if (typeof venue.osm !== "string" || !/^(node|way)\/\d+$/.test(venue.osm))
      throw new Error(`${where} has no OpenStreetMap id`);
    if (seen.has(venue.osm)) throw new Error(`${where}: ${venue.osm} is not unique`);
    seen.add(venue.osm);
    if (typeof venue.website !== "string" || websiteOf(venue.website) === undefined)
      throw new Error(`${where} has no http site`);
    if (typeof venue.opening_hours !== "string") throw new Error(`${where} has no opening_hours`);
    if (typeof venue.area !== "string") throw new Error(`${where} has no area`);
    if (typeof venue.lat !== "number" || typeof venue.lon !== "number")
      throw new Error(`${where} has no position`);
  }
  return parsed as VenuesFile;
};
