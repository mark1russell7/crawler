/**
 * The labels of the decision eval. Each function here is pure: it reads stored pages, and it sends
 * no request.
 *
 * - `candidateLinks` gives the links of a home page that the archive step fetches. They are the
 *   first links of `rankHoursLinks`, then the first other links of the site, in the order of the page.
 * - `agreementOf` compares a week with the week of OpenStreetMap, with `compareHours`.
 * - `labelVenue` labels each candidate page and each reading. It gives the outcome of the two
 *   choices of the rule: the links that `readVenue` fetches, and its best reading.
 */
import type { PageLink, VenueReading, VenueSource, Week } from "../../src/index.ts";
import {
  DAYS,
  VENUE_LIMITS,
  canonicalUrl,
  chooseVenueReadings,
  compareHours,
  describeWeek,
  fromCompact,
  rankHoursLinks,
  siteOf,
  venueReadingsOf,
} from "../../src/index.ts";
import type { Venue } from "./venues.mts";

/** The counts of candidate links: the first links of the rule, and the first other links of the site. */
export const CANDIDATES: { readonly ranked: number; readonly others: number } = {
  ranked: 8,
  others: 8,
};

/** One candidate link of a home page, with the features that a model sees. */
export interface Candidate {
  /** This URL is the `href` of the link, as the crawler fetches it. */
  readonly url: string;
  readonly text: string;
  /** This text is the path of the URL. */
  readonly path: string;
  /** This value is the place of the link among the links of the home page (1 is the first). */
  readonly position: number;
  /** This value is the place of the link in the result of `rankHoursLinks` (1 is the first), or null. */
  readonly rule_rank: number | null;
}

/** The files that hold no hours as text. `rankHoursLinks` leaves out the same files. */
const FILE = /\.(?:pdf|jpe?g|png|gif|webp|svg|mp4)(?:[?#]|$)/i;

/** This function gives the key of a URL: its canonical form with no `/` at the end. */
const keyOf = (url: string): string => canonicalUrl(url).replace(/\/$/, "");

/** This function gives the key of a link on the site of the home page, or undefined for another link. */
const siteKey = (href: string, home: string): string | undefined => {
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (siteOf(url.hostname) !== siteOf(new URL(home).hostname) || FILE.test(href))
      return undefined;
    const key = keyOf(href);
    return key === keyOf(home) ? undefined : key;
  } catch {
    return undefined;
  }
};

/** This function gives the links of a stored page, as `readVenue` reads them. */
export const linksOf = (meta: Readonly<Record<string, unknown>>): PageLink[] => {
  const links = meta["links"];
  return Array.isArray(links)
    ? links.filter(
        (link): link is PageLink =>
          link !== null && typeof link === "object" && typeof (link as PageLink).href === "string",
      )
    : [];
};

/**
 * This function gives the candidate links of a home page. First it gives the first
 * `CANDIDATES.ranked` links of `rankHoursLinks`. Then it gives the first `CANDIDATES.others` other
 * links of the site, in the order of the page. It leaves out the files and the home page, as `rankHoursLinks` does. Each URL occurs once.
 */
export const candidateLinks = (links: readonly PageLink[], home: string): Candidate[] => {
  const page = links.slice(0, VENUE_LIMITS.links);
  const ranked = rankHoursLinks(page, home);
  const rankOf = new Map<string, number>();
  for (const [at, link] of ranked.entries()) {
    const key = siteKey(link.href, home) ?? link.href;
    if (!rankOf.has(key)) rankOf.set(key, at + 1);
  }
  const positionOf = new Map<string, number>();
  for (const [at, link] of page.entries()) {
    const key = siteKey(link.href, home);
    if (key !== undefined && !positionOf.has(key)) positionOf.set(key, at + 1);
  }
  const chosen = new Map<string, PageLink>();
  for (const link of ranked.slice(0, CANDIDATES.ranked)) {
    const key = siteKey(link.href, home) ?? link.href;
    if (!chosen.has(key)) chosen.set(key, link);
  }
  let others = 0;
  for (const link of page) {
    if (others >= CANDIDATES.others) break;
    const key = siteKey(link.href, home);
    if (key === undefined || chosen.has(key)) continue;
    chosen.set(key, link);
    others += 1;
  }
  return [...chosen.entries()].map(([key, link]) => ({
    url: link.href,
    text: typeof link.text === "string" ? link.text : "",
    path: new URL(link.href).pathname,
    position: positionOf.get(key) ?? 0,
    rule_rank: rankOf.get(key) ?? null,
  }));
};

/**
 * The agreement of a week with the week of OpenStreetMap:
 *
 * - `agrees`: the two weeks share a day, and `compareHours` finds no day that changed.
 * - `disagrees`: `compareHours` finds a day that changed.
 * - `no-overlap`: the two weeks share no day, so the reading tells nothing.
 */
export type Agreement = "agrees" | "disagrees" | "no-overlap";

/** This function compares a week with the week of OpenStreetMap, with `compareHours`. */
export const agreementOf = (osm: Week, week: Week): Agreement => {
  if (!DAYS.some((day) => osm[day] !== undefined && week[day] !== undefined)) return "no-overlap";
  return compareHours(osm, week).days.length === 0 ? "agrees" : "disagrees";
};

/**
 * The label of a page:
 *
 * - `agrees`: a reading of the page agrees with OpenStreetMap.
 * - `disagrees`: no reading agrees, and a reading disagrees.
 * - `no-hours`: the page has no reading that shares a day with OpenStreetMap.
 * - `no-page`: the archive has no page that the crawler can read (a refusal, an error or a held-back page).
 */
export type PageLabel = "agrees" | "disagrees" | "no-hours" | "no-page";

/** This function gives the label of a page from its readings. With no page, the label is `no-page`. */
export const pageLabelOf = (
  osm: Week,
  readings: readonly VenueReading[] | undefined,
): PageLabel => {
  if (readings === undefined) return "no-page";
  const agreements = readings.map((one) => agreementOf(osm, one.week));
  if (agreements.includes("agrees")) return "agrees";
  return agreements.includes("disagrees") ? "disagrees" : "no-hours";
};

/** One candidate link with its label. */
export interface LinkLabel extends Candidate {
  readonly label: PageLabel;
  /** This value is the count of readings of the page. */
  readonly readings: number;
}

/** One reading that the rule chooses from, with its label. */
export interface ReadingLabel {
  /** This URL is the page of the reading. */
  readonly page: string | null;
  readonly from: VenueReading["from"];
  readonly rank: number;
  readonly schedule: VenueReading["schedule"];
  readonly label: string | null;
  readonly inferred: boolean;
  readonly partial: boolean;
  readonly season: string | null;
  readonly hours: string;
  readonly agreement: Agreement;
}

/**
 * The outcome of the choice of links:
 *
 * - `no-home`: the archive has no home page that the crawler can read.
 * - `home-agrees`: the home page alone agrees with OpenStreetMap.
 * - `rule-hit`: the home page does not agree, and a page of the first links of the rule agrees.
 * - `rule-miss`: the home page does not agree, a candidate page agrees, and no page of the first links of the rule agrees.
 * - `no-page-agrees`: no page agrees.
 */
export type LinksOutcome = "no-home" | "home-agrees" | "rule-hit" | "rule-miss" | "no-page-agrees";

/**
 * The outcome of the choice of the best reading:
 *
 * - `no-home`: the archive has no home page that the crawler can read.
 * - `no-reading`: the pages of the rule give no reading.
 * - `none-agrees`: no reading agrees with OpenStreetMap.
 * - `hit`: a reading agrees, and the best reading agrees.
 * - `miss`: a reading agrees, and the best reading does not agree, or the rule gives no best reading.
 */
export type BestOutcome = "no-home" | "no-reading" | "none-agrees" | "hit" | "miss";

/** The labels of one venue: one line of `labels.jsonl`. */
export interface VenueLabel {
  readonly osm: string;
  readonly area: string;
  readonly half: Half;
  readonly website: string;
  /** This URL is where the home page landed, or null with no home page. */
  readonly home: string | null;
  /** This text is the week of OpenStreetMap as words. */
  readonly osm_hours: string;
  readonly home_label: PageLabel;
  /** These are the candidate links of the home page, with their labels. */
  readonly links: readonly LinkLabel[];
  /** This value is the count of links that the rule fetches after the home page (`VENUE_LIMITS.pages`). */
  readonly rule_pages: number;
  /** These are the readings of the home page and of the pages of the rule, in the order of `chooseVenueReadings`. */
  readonly readings: readonly ReadingLabel[];
  /** This value is the place of the best reading of the rule in `readings` (0 is the first), or null. */
  readonly best: number | null;
  readonly links_outcome: LinksOutcome;
  readonly best_outcome: BestOutcome;
}

/** The half of a venue: the train half for a model, or the test half. */
export type Half = "train" | "test";

/** The pages of one venue, as the crawler stored them. */
export interface VenuePages {
  readonly venue: Venue;
  readonly half: Half;
  /** This value is the stored home page, or null when the crawler gave no page that it can read. */
  readonly home: VenueSource | null;
  /** These values are the stored candidate pages, by the URL of the candidate. Null is no page. */
  readonly pages: ReadonlyMap<string, VenueSource | null>;
}

/** This function gives the week of the `opening_hours` of a venue. */
export const osmWeek = (venue: Venue): Week => fromCompact(venue.opening_hours, "osm")?.week ?? {};

/**
 * This function labels one venue. It reads each page with `venueReadingsOf` and the position of
 * the venue, as `readVenue` reads it. The rule fetches the first `VENUE_LIMITS.pages` links of
 * `rankHoursLinks`, and `chooseVenueReadings` chooses the best reading of those pages.
 */
export const labelVenue = (input: VenuePages): VenueLabel => {
  const { venue, half, home } = input;
  const osm = osmWeek(venue);
  const location = { lat: venue.lat, lon: venue.lon };
  const readingsOf = (source: VenueSource | null | undefined): VenueReading[] | undefined =>
    source === null || source === undefined
      ? undefined
      : [...venueReadingsOf(source, { location }).readings];
  const base = {
    osm: venue.osm,
    area: venue.area,
    half,
    website: venue.website,
    osm_hours: describeWeek(osm),
    rule_pages: VENUE_LIMITS.pages,
  };
  if (home === null) {
    return {
      ...base,
      home: null,
      home_label: "no-page",
      links: [],
      readings: [],
      best: null,
      links_outcome: "no-home",
      best_outcome: "no-home",
    };
  }
  const homeUrl = home.url ?? venue.website;
  const homeReadings = readingsOf(home) ?? [];
  const homeLabel = pageLabelOf(osm, homeReadings);
  const candidates = candidateLinks(linksOf(home.meta), homeUrl);
  const links: LinkLabel[] = candidates.map((candidate) => {
    const readings = readingsOf(input.pages.get(candidate.url));
    return { ...candidate, label: pageLabelOf(osm, readings), readings: readings?.length ?? 0 };
  });

  const ruled = links.filter(
    (link) => link.rule_rank !== null && link.rule_rank <= VENUE_LIMITS.pages,
  );
  let linksOutcome: LinksOutcome;
  if (homeLabel === "agrees") linksOutcome = "home-agrees";
  else if (!links.some((link) => link.label === "agrees")) linksOutcome = "no-page-agrees";
  else linksOutcome = ruled.some((link) => link.label === "agrees") ? "rule-hit" : "rule-miss";

  // the readings of readVenue: the home page, then the pages of the rule in the order of the rule
  const inOrder = [...ruled].sort((a, b) => (a.rule_rank ?? 0) - (b.rule_rank ?? 0));
  const all = [
    ...homeReadings,
    ...inOrder.flatMap((link) => readingsOf(input.pages.get(link.url)) ?? []),
  ];
  const choice = chooseVenueReadings(all);
  const readings: ReadingLabel[] = choice.readings.map((one) => ({
    page: one.url,
    from: one.from,
    rank: one.rank,
    schedule: one.schedule,
    label: one.label,
    inferred: one.inferred,
    partial: one.partial,
    season: one.season,
    hours: one.hours,
    agreement: agreementOf(osm, one.week),
  }));
  const best = choice.best === null ? null : choice.readings.indexOf(choice.best);
  let bestOutcome: BestOutcome;
  if (readings.length === 0) bestOutcome = "no-reading";
  else if (!readings.some((one) => one.agreement === "agrees")) bestOutcome = "none-agrees";
  else bestOutcome = best !== null && readings[best]?.agreement === "agrees" ? "hit" : "miss";

  return {
    ...base,
    home: homeUrl,
    home_label: homeLabel,
    links,
    readings,
    best,
    links_outcome: linksOutcome,
    best_outcome: bestOutcome,
  };
};
