/**
 * The visit of one venue, and the log of the live crawl.
 *
 * A visit fetches the home page, then each candidate link of the home page. The live archive step
 * (`crawl.mts`) and the replay (`replay-venues.mts`) use this one function. Thus the replay asks
 * for the same URLs in the same order as the live crawl.
 *
 * Each page is a fetch of the crawler: robots.txt, the pace of each site, the stops and the rule
 * for a held-back page apply. The eval does not change them.
 */
import type { Doc, PoliteCrawler } from "../../src/index.ts";
import { isHeldBack } from "../../src/index.ts";
import { candidateLinks, linksOf } from "./label.mts";
import type { Venue } from "./venues.mts";

/**
 * The options of each fetch. `Claude-User` gets its robots.txt rules applied too, because a model
 * reads the labels of the eval. The crawler of CI has no browser, so it renders no page.
 */
export const FETCH_OPTIONS = { onBehalfOf: ["Claude-User"], render: "never" } as const;

/** The pages of one visit. */
export interface Visit {
  /** This value is the home page, or null when the crawler gave no page that it can read. */
  readonly home: Doc | null;
  /** These values are the candidate pages, by the URL of the candidate. Null is no page that the crawler can read. */
  readonly pages: ReadonlyMap<string, Doc | null>;
  /** This value is the count of fetches of the visit. */
  readonly fetches: number;
  /** This value is the count of pages that asked not to be AI input. The eval reads nothing from them. */
  readonly held_back: number;
}

/** The status of one venue in the live crawl. */
export interface VenueStatus {
  /** `visited`: the visit ended. `stopped`: the time limit stopped the visit. `not-started`: the budget ended first. */
  readonly status: "visited" | "stopped" | "not-started";
  readonly fetches: number;
  readonly held_back: number;
}

/** The log of the live crawl that `crawl.mts` writes next to the WACZ file. */
export interface CrawlLog {
  readonly package: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly budget_minutes: number;
  readonly workers: number;
  /** These are the statuses, by the OpenStreetMap id of the venue. */
  readonly venues: Readonly<Record<string, VenueStatus>>;
}

/** This function reads and checks the log of the live crawl. */
export const readCrawlLog = (json: string): CrawlLog => {
  const parsed = JSON.parse(json) as Partial<CrawlLog>;
  if (typeof parsed.venues !== "object" || parsed.venues === null)
    throw new Error("the crawl log has no venues");
  for (const [osm, entry] of Object.entries(parsed.venues)) {
    const status: unknown = (entry as Partial<VenueStatus> | null)?.status;
    if (status !== "visited" && status !== "stopped" && status !== "not-started")
      throw new Error(`the crawl log has no valid status for ${osm}`);
  }
  return parsed as CrawlLog;
};

/**
 * This function visits one venue. The crawler can read a page when it stored a document for the
 * page and the document is not held back. `readVenue` uses the same rule.
 */
export const visitVenue = async (
  crawler: PoliteCrawler,
  venue: Venue,
  signal?: AbortSignal,
): Promise<Visit> => {
  let fetches = 0;
  let heldBack = 0;
  const readable = async (url: string): Promise<Doc | null> => {
    fetches += 1;
    try {
      const page = await crawler.fetch(url, { ...FETCH_OPTIONS, signal });
      const doc = page.doc === null ? undefined : crawler.runtime.index.get(page.doc);
      if (doc === undefined) return null;
      if (isHeldBack(doc)) {
        heldBack += 1;
        return null;
      }
      return doc;
    } catch {
      return null;
    }
  };
  const home = await readable(venue.website);
  const pages = new Map<string, Doc | null>();
  if (home !== null) {
    for (const candidate of candidateLinks(linksOf(home.meta), home.url ?? venue.website)) {
      if (signal?.aborted === true) break;
      pages.set(candidate.url, await readable(candidate.url));
    }
  }
  return { home, pages, fetches, held_back: heldBack };
};
