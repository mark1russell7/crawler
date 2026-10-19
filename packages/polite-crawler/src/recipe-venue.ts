/*
 * The venue recipe reads the opening hours of a venue (a restaurant, a shop, a museum) from its own
 * site. It reads the cheap sources first:
 *
 * 1. The home page: its JSON-LD (`openingHoursSpecification` and `openingHours`) and its text.
 * 2. The few pages of the site that most likely hold hours or a menu, by the words of their links.
 * 3. An OpenStreetMap `opening_hours` value, when the caller gives one. The recipe sends no
 *    request to OpenStreetMap.
 *
 * Each reading names the page, the document and the capture that it came from. The recipe gives
 * readings only. To compare them with the hours that an application keeps is the work of the
 * application, and `compareHours` is the pure helper for it.
 */
import type { Doc } from "./docs.ts";
import type { Duration } from "./duration.ts";
import { durationMs } from "./duration.ts";
import type { Archived } from "./fallback.ts";
import { archivedOf } from "./fallback.ts";
import type { Day, Hours, Week } from "./hours.ts";
import {
  DAYS,
  describeWeek,
  disagreements,
  fromCompact,
  fromSchemaOrg,
  fromText,
} from "./hours.ts";
import type { PageLink } from "./html.ts";
import { typesOf } from "./html.ts";
import type { RecipeTarget } from "./recipe.ts";
import { deadlineOf, runtimeOf } from "./recipe.ts";
import type { PageOptions, PageResult } from "./runtime.ts";
import { HELD_BACK, fetchPage, isHeldBack, recordOverride } from "./runtime.ts";

/**
 * These are the limits of the venue recipe.
 *
 * @beta
 */
export const VENUE_LIMITS: {
  /** The pages of the site that a read fetches after the home page, by default. */
  readonly pages: number;
  /** The most pages after the home page. */
  readonly maxPages: number;
  /** The most menu links of a result. */
  readonly menus: number;
  /** The most readings of one page. A page with more is a list of something else. */
  readonly readingsPerPage: number;
  /** The most links of one page that the recipe ranks. */
  readonly links: number;
  /** The distance in metres within which a JSON-LD location is the venue. */
  readonly nearMetres: number;
} = { pages: 3, maxPages: 8, menus: 8, readingsPerPage: 20, links: 200, nearMetres: 150 };

// ── words ───────────────────────────────────────────────────────────────────

const STOP_WORDS: ReadonlySet<string> = new Set(["the", "a", "an", "and", "of", "at"]);

/** This function gives the words of a text in one form: lower case, no accents, and `&` as `and`. */
const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0 && !STOP_WORDS.has(word));

/**
 * This function tells if a page names a venue: the page has the first word of the name and 60
 * percent of its words. A domain that a venue let go can show a different business. It gives
 * undefined for a name with no word.
 *
 * @beta
 */
export const namesVenue = (
  name: string,
  page: { readonly title: string; readonly text: string },
): boolean | undefined => {
  const words = wordsOf(name);
  if (words.length === 0) return undefined;
  const onPage = new Set(wordsOf(`${page.title} ${page.text}`));
  const named = new Set(words);
  const found = [...named].filter((word) => onPage.has(word)).length;
  return onPage.has(words[0]!) && found / named.size >= 0.6;
};

// ── the links of the site ───────────────────────────────────────────────────

/** The words of a link that tell what its page holds, with their weights. */
const LINK_WORDS: ReadonlyArray<readonly [RegExp, number]> = [
  [/hours|horario|horaires|opening/, 6],
  [/menu|food|drink|wine|cocktail/, 4],
  [/contact|location|visit|find.?us|directions/, 3],
  [/about|info/, 2],
  [/lunch|dinner|brunch|breakfast/, 2],
];

/** The hosts of review and social sites: a menu there is a different page about the venue. */
const SOCIAL =
  /(?:^|\.)(?:yelp|tripadvisor|facebook|instagram|twitter|x|tiktok|google|apple|spotify)\.[a-z.]+$/i;

/** The files that hold no hours as text. */
const FILE = /\.(?:pdf|jpe?g|png|gif|webp|svg|mp4)(?:[?#]|$)/i;

const hostOf = (url: string): string | undefined => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
};

const withoutHash = (url: string): string => url.replace(/#.*$/s, "").replace(/\/$/, "");

/**
 * This function ranks the links of a page by the words of their text and path. The links to
 * the hours or a menu come first. It keeps only the links on the site of `home`,
 * and it leaves out the files (a PDF, an image) and the home page itself.
 *
 * @beta
 */
export const rankHoursLinks = (links: readonly PageLink[], home: string): PageLink[] => {
  const site = hostOf(home);
  const self = withoutHash(home);
  const seen = new Set<string>();
  const scored: Array<{ readonly link: PageLink; readonly score: number }> = [];
  for (const link of links.slice(0, VENUE_LIMITS.links)) {
    if (typeof link?.href !== "string" || hostOf(link.href) !== site || FILE.test(link.href))
      continue;
    const key = withoutHash(link.href);
    if (key === self || seen.has(key)) continue;
    let path = "";
    try {
      path = new URL(link.href).pathname;
    } catch {
      continue;
    }
    const words = `${typeof link.text === "string" ? link.text : ""} ${path}`.toLowerCase();
    const score = LINK_WORDS.reduce(
      (sum, [pattern, weight]) => sum + (pattern.test(words) ? weight : 0),
      0,
    );
    if (score <= 0) continue;
    seen.add(key);
    scored.push({ link, score });
  }
  // a stable sort: links of equal score keep the order of the page
  return scored.sort((a, b) => b.score - a.score).map((entry) => entry.link);
};

/** A link to a menu. */
export interface VenueLink {
  readonly url: string;
  readonly text: string;
}

// ── the location of a venue ─────────────────────────────────────────────────

/** The place of a venue, to choose its hours on a page that lists more than one location. */
export interface VenueLocation {
  /** This text is the street address, for example `12 Via Esempio`. The number and the street count. */
  readonly address?: string | undefined;
  readonly lat?: number | undefined;
  readonly lon?: number | undefined;
}

interface Point {
  readonly lat: number;
  readonly lon: number;
}

const EARTH_METRES = 6_371_000;

/** This function gives the distance in metres between two points on the earth (the haversine formula). */
const metresBetween = (a: Point, b: Point): number => {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_METRES * Math.asin(Math.min(1, Math.sqrt(h)));
};

const pointOf = (lat: unknown, lon: unknown): Point | undefined => {
  const la = typeof lat === "string" ? Number.parseFloat(lat) : lat;
  const lo = typeof lon === "string" ? Number.parseFloat(lon) : lon;
  return typeof la === "number" &&
    typeof lo === "number" &&
    Number.isFinite(la) &&
    Number.isFinite(lo) &&
    Math.abs(la) <= 90 &&
    Math.abs(lo) <= 180
    ? { lat: la, lon: lo }
    : undefined;
};

/** The words of a street that tell nothing about which street: directions and kinds of road. */
const STREET_NOISE: ReadonlySet<string> = new Set([
  "n",
  "s",
  "e",
  "w",
  "north",
  "south",
  "east",
  "west",
  "st",
  "street",
  "ave",
  "avenue",
  "rd",
  "road",
  "blvd",
  "boulevard",
  "dr",
  "drive",
  "ln",
  "lane",
  "ct",
  "court",
  "pl",
  "place",
  "sq",
  "square",
  "hwy",
  "highway",
  "pkwy",
  "parkway",
  "way",
  "ter",
  "terrace",
  "suite",
  "ste",
  "unit",
]);

/** This function gives the number of a street address and the words that name its street. */
const streetOf = (
  address: string,
): { readonly number: string; readonly words: ReadonlySet<string> } | undefined => {
  const words = wordsOf((address.split(",")[0] ?? address).slice(0, 200));
  const number = words.find((word) => /^\d+[a-z]?$/.test(word));
  if (number === undefined) return undefined;
  return {
    number,
    words: new Set(words.filter((word) => !/^\d/.test(word) && !STREET_NOISE.has(word))),
  };
};

const addressText = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return addressText(value[0]);
  if (typeof value === "object" && value !== null) {
    const street = (value as Record<string, unknown>)["streetAddress"];
    return typeof street === "string" ? street : undefined;
  }
  return undefined;
};

/**
 * This function tells if a JSON-LD location record is the venue. The record must have the same
 * number on a street that shares a word, or a position near the venue (`VENUE_LIMITS.nearMetres`).
 *
 * @beta
 */
export const locationMatches = (
  record: Readonly<Record<string, unknown>>,
  location: VenueLocation,
): boolean => {
  const geo = record["geo"];
  const at =
    typeof geo === "object" && geo !== null
      ? pointOf(
          (geo as Record<string, unknown>)["latitude"],
          (geo as Record<string, unknown>)["longitude"],
        )
      : undefined;
  const ours = pointOf(location.lat, location.lon);
  if (at !== undefined && ours !== undefined && metresBetween(at, ours) <= VENUE_LIMITS.nearMetres)
    return true;
  const theirs = addressText(record["address"]);
  if (theirs === undefined || location.address === undefined) return false;
  const a = streetOf(theirs);
  const b = streetOf(location.address);
  return (
    a !== undefined &&
    b !== undefined &&
    a.number === b.number &&
    [...a.words].some((word) => b.words.has(word))
  );
};

const located = (record: Readonly<Record<string, unknown>>): boolean =>
  record["address"] !== undefined || record["geo"] !== undefined;

// ── the readings ────────────────────────────────────────────────────────────

/** One reading of the hours, with the source that it came from. */
export interface VenueReading {
  /** The value `jsonld` is the structured data of a page, `text` the text of a page, and `osm` the value of the caller. */
  readonly from: "jsonld" | "osm" | "text";
  /**
   * This value orders the readings, 0 first. JSON-LD is 0, a text under an hours heading is 1 and
   * OpenStreetMap is 2. A text with no label of a different schedule is 3. A different schedule is
   * 4, for example a brunch, a kitchen, a happy hour or an office.
   */
  readonly rank: number;
  /** The value `opening` is the opening hours of the venue (a rank of 3 or less). Else it is `other`. */
  readonly schedule: "opening" | "other";
  /** This text is the line above a reading of the text, for example `Hours` or `Happy hour`. */
  readonly label: string | null;
  /** This text is the week as words, from `describeWeek`. */
  readonly hours: string;
  readonly week: Week;
  /** This value is true when the reader guessed an am or a pm. */
  readonly inferred: boolean;
  /** This value is true when the reader left out a rule or a line (a holiday, a date). */
  readonly partial: boolean;
  /** This text names the season or the dates of the hours. */
  readonly season: string | null;
  /** This text is the words that the hours came from. A reading of the text can be a quote for `verify`. */
  readonly raw: string;
  /** This path names the JSON-LD record of the reading in the metadata of the document, for example `jsonld[2]`. */
  readonly path: string | null;
  /** This URL is the page of the reading. */
  readonly url: string | null;
  readonly doc: string | null;
  /** This id is the capture of the text that the reading came from. A citation names it. */
  readonly capture: string | null;
  readonly fetched_at: string | null;
  /** This value tells that the page is an archived copy, with the archive and the date of the copy. */
  readonly archived?: Archived | undefined;
}

/** A stored document, or a version of one: what `venueReadingsOf` reads. */
export interface VenueSource {
  readonly doc?: string | null | undefined;
  readonly url: string | null;
  readonly text: string;
  readonly meta: Readonly<Record<string, unknown>>;
  readonly capture?: string | null | undefined;
  readonly fetched_at?: string | null | undefined;
}

/** The result of `venueReadingsOf`: what one document says. */
export interface VenueRead {
  readonly readings: readonly VenueReading[];
  /** This value is the first `telephone` of the JSON-LD records of the venue. */
  readonly phone: string | null;
  readonly menus: readonly VenueLink[];
  readonly notes: readonly string[];
  /**
   * This value counts the work of the reader. The tests use it, because it does not change with the computer.
   *
   * @beta
   */
  readonly steps: number;
}

/** The types of JSON-LD records that have the hours of a venue. */
const HOURS_TYPES =
  /Restaurant|LocalBusiness|FoodEstablishment|BarOrPub|CafeOrCoffeeShop|Bakery|Store|Place|Winery|Brewery|NightClub|Museum|TouristAttraction|Library|EntertainmentBusiness/;

/**
 * A label that names a schedule that is not the opening hours. The line above a schedule is often a
 * different thing, for example a phone number, and such a line tells nothing.
 */
const OTHER_SCHEDULE =
  /brunch|lunch|dinner|breakfast|happy|kitchen|bar|deliver|take.?out|pick.?up|patio|holiday|season|summer|winter|special|late|menu/i;

/**
 * A label of a service beside the opening hours, or of an office. Its hours are a different
 * schedule, also when the label says "hours" ("Happy hour", "Kitchen hours", "Office hours").
 */
const SERVICE =
  /happy|kitchen|deliver|take.?out|pick.?up|brunch|holiday|special|patio|bar|late.?night|office/i;

const rankOf = (from: VenueReading["from"], label: string | null): number => {
  if (from === "jsonld") return 0;
  if (from === "osm") return 2;
  const text = label ?? "";
  if (SERVICE.test(text)) return 4;
  if (/hour|open/i.test(text)) return 1;
  return OTHER_SCHEDULE.test(text) ? 4 : 3;
};

const reading = (
  from: VenueReading["from"],
  hours: Hours,
  label: string | null,
  source: {
    readonly url: string | null;
    readonly doc: string | null;
    readonly capture: string | null;
    readonly fetched_at: string | null;
    readonly path: string | null;
    readonly archived?: Archived | undefined;
  },
): VenueReading => {
  const rank = rankOf(from, label);
  return {
    from,
    rank,
    schedule: rank <= 3 ? "opening" : "other",
    label,
    hours: describeWeek(hours.week),
    week: hours.week,
    inferred: hours.inferred,
    partial: hours.partial === true,
    season: hours.season ?? null,
    raw: hours.raw,
    path: source.path,
    url: source.url,
    doc: source.doc,
    capture: source.capture,
    fetched_at: source.fetched_at,
    ...(source.archived === undefined ? {} : { archived: source.archived }),
  };
};

const recordsOf = (meta: Readonly<Record<string, unknown>>): Record<string, unknown>[] => {
  const jsonld = meta["jsonld"];
  return Array.isArray(jsonld)
    ? jsonld.filter(
        (record): record is Record<string, unknown> =>
          record !== null && typeof record === "object" && !Array.isArray(record),
      )
    : [];
};

const linksOf = (meta: Readonly<Record<string, unknown>>): PageLink[] => {
  const links = meta["links"];
  return Array.isArray(links)
    ? links.filter(
        (link): link is PageLink =>
          link !== null && typeof link === "object" && typeof (link as PageLink).href === "string",
      )
    : [];
};

/**
 * This function reads the hours of one stored document, or of one version of it. It is pure, and
 * it sends no request. Thus it also reads a version at a time (`versionAtTime`) or an archived copy.
 *
 * - It reads each JSON-LD record of a venue type with `fromSchemaOrg`, and the text with `fromText`.
 * - On a page that lists more than one location, it reads only the location that matches
 *   `location`. With no `location`, it reads none of them, and a note says so.
 * - It gives the first `telephone` and the menu links that are not on a review or social site.
 */
export const venueReadingsOf = (
  source: VenueSource,
  options: { readonly location?: VenueLocation | undefined } = {},
): VenueRead => {
  let steps = 0;
  const notes: string[] = [];
  const archived = archivedOf(source.meta);
  const where = {
    url: archived?.original ?? source.url,
    doc: source.doc ?? null,
    capture: source.capture ?? null,
    fetched_at: source.fetched_at ?? null,
    ...(archived === undefined ? {} : { archived }),
  };
  const all = recordsOf(source.meta);
  steps += all.length;
  const venues = all
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => typesOf(record).some((type) => HOURS_TYPES.test(type)));
  // a page of a group lists each of its locations: only the hours of this venue are its hours
  let usable = venues;
  const placed = venues.filter(({ record }) => located(record));
  if (placed.length > 1) {
    const location = options.location;
    const ours =
      location === undefined
        ? []
        : placed.filter(({ record }) => locationMatches(record, location));
    if (ours.length === 0) {
      notes.push(
        location === undefined
          ? `${where.url ?? "the page"} lists ${String(placed.length)} locations: give location to read the hours of one`
          : `${where.url ?? "the page"} lists ${String(placed.length)} locations, and none matched the location: their hours were not read`,
      );
    }
    usable = [...ours, ...venues.filter(({ record }) => !located(record))];
  }
  const readings: VenueReading[] = [];
  let phone: string | null = null;
  for (const { record, index } of usable) {
    steps += 1;
    const hours = fromSchemaOrg(record);
    if (hours !== undefined && readings.length < VENUE_LIMITS.readingsPerPage) {
      readings.push(reading("jsonld", hours, null, { ...where, path: `jsonld[${String(index)}]` }));
    }
    const telephone = record["telephone"];
    if (phone === null && typeof telephone === "string" && telephone.trim().length > 0)
      phone = telephone.trim().slice(0, 100);
  }
  steps += source.text.length;
  for (const hours of fromText(source.text)) {
    if (readings.length >= VENUE_LIMITS.readingsPerPage) {
      notes.push(
        `${where.url ?? "the page"} gives more than ${String(VENUE_LIMITS.readingsPerPage)} readings: the rest were not read`,
      );
      break;
    }
    readings.push(reading("text", hours, hours.label, { ...where, path: null }));
  }
  const menus: VenueLink[] = [];
  for (const link of linksOf(source.meta).slice(0, VENUE_LIMITS.links)) {
    steps += 1;
    if (menus.length >= VENUE_LIMITS.menus) break;
    const text = typeof link.text === "string" ? link.text.slice(0, 200) : "";
    const host = hostOf(link.href);
    if (host === undefined || SOCIAL.test(host) || !/menu/i.test(`${text} ${link.href}`)) continue;
    if (menus.some((menu) => menu.url === link.href)) continue;
    menus.push({ url: link.href, text });
  }
  return { readings, phone, menus, notes, steps };
};

// ── the recipe ──────────────────────────────────────────────────────────────

/** An OpenStreetMap `opening_hours` value, with where the caller got it. */
export interface VenueOsm {
  /** This text is the value of the tag, for example `Mo-Fr 08:00-18:00; Sa 09:00-13:00`. */
  readonly value: string;
  readonly url?: string | null | undefined;
  readonly doc?: string | null | undefined;
  readonly capture?: string | null | undefined;
  readonly fetched_at?: string | null | undefined;
}

/** These options control `readVenue`. */
export interface VenueOptions {
  /** This value is the number of pages after the home page, from 0 to `VENUE_LIMITS.maxPages`. The default is 3. */
  readonly pages?: number | undefined;
  /** This text is the name of the venue. The result tells if the home page names it (`names_venue`). */
  readonly name?: string | undefined;
  /** With true, a home page that does not name the venue gives no reading, and the recipe fetches no more pages. */
  readonly requireName?: boolean | undefined;
  /** This value is the place of the venue, for a page that lists more than one location. */
  readonly location?: VenueLocation | undefined;
  /** This value is an OpenStreetMap `opening_hours` value. The recipe reads it, and sends no request for it. */
  readonly osm?: string | VenueOsm | undefined;
  /** The value `auto` renders a page only when it shows almost nothing without JavaScript. */
  readonly render?: "auto" | "never" | "always" | undefined;
  /** A stored copy younger than this age answers with no request. The default is `24h`. */
  readonly maxAge?: Duration | undefined;
  /** These agents get their robots.txt rules applied too, for example `Claude-User`. */
  readonly onBehalfOf?: readonly string[] | undefined;
  readonly signal?: AbortSignal | undefined;
  /** No request starts after this time from the start of the read, for example `"2m"`. */
  readonly budget?: Duration | undefined;
  readonly scope?: string | undefined;
  readonly labels?: Readonly<Record<string, string>> | undefined;
  /** This name connects the captures to the job that asked for them. The default is `venue`. */
  readonly job?: string | undefined;
  /** This value is true when a person gave this URL directly. It is the only way to read a held-back page. The crawler logs it. */
  readonly userProvided?: boolean | undefined;
  /** The value `archive` reads an archived copy of a page that the site refuses, or when the site is down. */
  readonly fallback?: "archive" | "none" | undefined;
  readonly archiveDespiteRobots?: boolean | undefined;
}

/** One page that the venue recipe fetched. */
export interface VenuePage {
  readonly url: string;
  readonly doc: string | null;
  readonly outcome: string;
  readonly status: number;
  readonly rendered: boolean;
  readonly capture: string | null;
  readonly fetched_at: string | null;
  readonly from_cache: boolean;
  readonly held_back: boolean;
  readonly archived?: Archived | undefined;
  readonly note: string | null;
}

/** The result of `readVenue`. */
export interface VenueResult {
  /** This URL is the site that the caller gave. */
  readonly url: string;
  /** This URL is where the home page landed, after the redirects. */
  readonly home: string | null;
  /** This URL is the new site, when the home page landed on a different host. */
  readonly moved: string | null;
  /** This value tells if the home page names the venue. It is null with no `name`. */
  readonly names_venue: boolean | null;
  readonly pages: readonly VenuePage[];
  /** These are the readings, one for each source, label and week: the best first. */
  readonly readings: readonly VenueReading[];
  /** This reading is the best reading of the opening hours, from any source. */
  readonly best: VenueReading | null;
  /** This reading is the best reading of the site itself (not OpenStreetMap) with no guess. A check for a change compares it. */
  readonly from_site: VenueReading | null;
  /** These days are the days where two readings of the whole schedule (a rank of 2 or less) disagree. */
  readonly disagree: readonly Day[];
  readonly menus: readonly VenueLink[];
  readonly phone: string | null;
  /** These ids are the captures of the pages that the recipe read. */
  readonly captures: readonly string[];
  /** This value is true when a page asked not to be AI input, so the recipe read nothing from it. */
  readonly held_back: boolean;
  readonly note: string | null;
}

const answered = (page: PageResult): boolean =>
  page.outcome === "ok" || page.outcome === "not-modified" || page.archived !== undefined;

/**
 * This function reads the hours of a venue from its site. It fetches the home page and the pages
 * that most likely hold hours or a menu. Each one is a fetch of the crawler. Thus robots.txt, the
 * pace, the stops, the capture log and the rule for a held-back page apply. It renders a page only
 * when the page needs JavaScript, as `fetch` does.
 *
 * It gives each reading with its source, the best reading, and the days where the readings
 * disagree. It writes nothing but the capture log. To choose the true hours is the decision of
 * the application.
 */
export const readVenue = async (
  target: RecipeTarget,
  url: string,
  options: VenueOptions = {},
): Promise<VenueResult> => {
  const runtime = runtimeOf(target);
  const extra = options.pages ?? VENUE_LIMITS.pages;
  if (!Number.isInteger(extra) || extra < 0 || extra > VENUE_LIMITS.maxPages) {
    throw new RangeError(
      `pages must be a whole number from 0 to ${String(VENUE_LIMITS.maxPages)}, not ${String(extra)}`,
    );
  }
  let site: URL;
  try {
    site = new URL(url);
  } catch {
    throw new TypeError(`readVenue needs the URL of a site, not ${JSON.stringify(url)}`);
  }
  if (site.protocol !== "http:" && site.protocol !== "https:")
    throw new TypeError(`readVenue needs an http or https URL, not ${url}`);
  const maxAge = options.maxAge ?? "24h";
  const job = options.job ?? "venue";
  const userProvided = options.userProvided ?? false;
  const pageOptions: PageOptions = {
    render: options.render ?? "auto",
    maxAgeMs: maxAge === "auto" ? "auto" : durationMs(maxAge),
    onBehalfOf: options.onBehalfOf,
    job,
    signal: options.signal,
    scope: options.scope,
    labels: options.labels,
    deadline: deadlineOf(runtime, options.budget),
    fallback: options.fallback,
    archiveDespiteRobots: options.archiveDespiteRobots,
  };
  const notes: string[] = [];
  const readings: VenueReading[] = [];
  const pages: VenuePage[] = [];
  const menus: VenueLink[] = [];
  const captures = new Set<string>();
  let phone: string | null = null;
  let heldBack = false;

  if (options.osm !== undefined) {
    const osm: VenueOsm = typeof options.osm === "string" ? { value: options.osm } : options.osm;
    const hours = typeof osm.value === "string" ? fromCompact(osm.value, "osm") : undefined;
    if (hours === undefined) {
      notes.push(
        `the OpenStreetMap hours cannot be read: ${JSON.stringify(String(osm.value).slice(0, 200))}`,
      );
    } else {
      readings.push(
        reading("osm", hours, null, {
          url: osm.url ?? null,
          doc: osm.doc ?? null,
          capture: osm.capture ?? null,
          fetched_at: osm.fetched_at ?? null,
          path: null,
        }),
      );
      if (typeof osm.capture === "string") captures.add(osm.capture);
    }
  }

  /** This function fetches one page, and gives its document when the recipe can read it. */
  const readPage = async (pageUrl: string): Promise<Doc | undefined> => {
    const page = await fetchPage(runtime, pageUrl, pageOptions);
    const doc = page.doc === null ? undefined : runtime.index.get(page.doc);
    const held = doc !== undefined && isHeldBack(doc, userProvided);
    pages.push({
      url: pageUrl,
      doc: page.doc,
      outcome: page.outcome,
      status: page.status,
      rendered: page.rendered,
      capture: page.capture,
      fetched_at: page.fetched_at,
      from_cache: page.from_cache,
      held_back: held,
      ...(page.archived === undefined ? {} : { archived: page.archived }),
      note: page.note,
    });
    if (!answered(page)) {
      notes.push(`${pageUrl}: ${page.outcome}${page.note === null ? "" : ` (${page.note})`}`);
    }
    if (doc === undefined) return undefined;
    if (held) {
      heldBack = true;
      return undefined;
    }
    if (doc.ai_input === "no") await recordOverride(runtime, doc, job);
    captures.add(doc.capture);
    return doc;
  };

  const readDoc = (doc: Doc): void => {
    const read = venueReadingsOf(doc, { location: options.location });
    readings.push(...read.readings);
    notes.push(...read.notes);
    phone ??= read.phone;
    for (const menu of read.menus) {
      if (menus.length < VENUE_LIMITS.menus && !menus.some((known) => known.url === menu.url))
        menus.push(menu);
    }
  };

  let homeUrl: string | null = null;
  let namesVenueResult: boolean | null = null;
  const home = await readPage(site.href);
  if (home !== undefined) {
    homeUrl = archivedOf(home.meta)?.original ?? home.url ?? site.href;
    if (options.name !== undefined) {
      namesVenueResult = namesVenue(options.name, home) ?? null;
      if (namesVenueResult === false) {
        notes.push(
          `${homeUrl} does not name ${options.name}: the domain can belong to a different business now`,
        );
      }
    }
    if (namesVenueResult === false && options.requireName === true) {
      notes.push("requireName: the recipe read no hours from a site that does not name the venue");
    } else {
      readDoc(home);
      for (const link of rankHoursLinks(linksOf(home.meta), homeUrl).slice(0, extra)) {
        if (options.signal?.aborted === true) break;
        const doc = await readPage(link.href);
        if (doc !== undefined) readDoc(doc);
      }
    }
  }
  const moved = homeUrl !== null && hostOf(homeUrl) !== hostOf(site.href) ? homeUrl : null;
  if (moved !== null) notes.push(`${site.href} now goes to ${moved}`);
  if (heldBack) notes.push(HELD_BACK);

  // one reading for each source, label and week: a site that repeats its JSON-LD on each page said it once
  const firstOf = new Map<string, VenueReading>();
  for (const one of readings) {
    const key = `${one.from}|${one.label ?? ""}|${one.hours}|${one.season ?? ""}`;
    if (!firstOf.has(key)) firstOf.set(key, one);
  }
  // the best first; of two equal readings, the reading as written before a guess
  const unique = [...firstOf.values()].sort(
    (a, b) => a.rank - b.rank || Number(a.inferred) - Number(b.inferred),
  );
  const disagree = new Set<Day>();
  const whole = unique.filter((one) => one.rank <= 2);
  for (let i = 0; i < whole.length; i += 1) {
    for (let j = i + 1; j < whole.length; j += 1) {
      for (const day of disagreements(whole[i]!.week, whole[j]!.week)) disagree.add(day);
    }
  }
  const best = unique.find((one) => one.schedule === "opening") ?? null;
  const fromSite =
    unique.find((one) => one.from !== "osm" && one.schedule === "opening" && !one.inferred) ?? null;
  return {
    url: site.href,
    home: homeUrl,
    moved,
    names_venue: namesVenueResult,
    pages,
    readings: unique,
    best,
    from_site: fromSite,
    disagree: DAYS.filter((day) => disagree.has(day)),
    menus,
    phone,
    captures: [...captures],
    held_back: heldBack,
    note: notes.length > 0 ? notes.join("; ") : null,
  };
};
