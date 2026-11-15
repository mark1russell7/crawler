/**
 * The replay of the decision eval: it replays a WACZ file into a new store, with no network, and
 * labels each venue. `replay.mts` is the command around it.
 *
 * The same WACZ file and the same commit give the same labels:
 *
 * - The replay visits one venue at a time (`visitVenue`), in the order of the ids.
 * - The clock starts at the first capture of the archive, and it moves only when the crawler waits.
 * - A URL that is not in the archive gets a 404, and no request goes to the network.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCrawler } from "../../src/index.ts";
import type { Archive } from "../archive.mts";
import { replayAgent, replayClock } from "../measure.mts";
import type { Half, VenueLabel } from "./label.mts";
import { labelVenue } from "./label.mts";
import type { Venue } from "./venues.mts";
import { byOsm } from "./venues.mts";
import { visitVenue } from "./visit.mts";

/** The labels of a replay, and its counts of pages. */
export interface Replayed {
  readonly labels: readonly VenueLabel[];
  /** This value is the count of fetches of the replay. */
  readonly fetches: number;
  /** This value is the count of pages that asked not to be AI input. The eval reads nothing from them. */
  readonly held_back: number;
}

/** This function replays the archive, visits each venue in the order of the ids, and labels it. */
export const replayVenues = async (
  archive: Archive,
  venues: readonly Venue[],
  halves: ReadonlyMap<string, Half>,
): Promise<Replayed> => {
  const visited = [...venues].sort(byOsm);
  const agent = replayAgent(
    archive,
    visited.map((venue) => venue.website),
  );
  const dir = await mkdtemp(join(tmpdir(), "polite-crawler-decisions-replay-"));
  const crawler = openCrawler({
    dir,
    renderer: false,
    dispatcher: agent,
    clock: replayClock(archive.start),
    random: () => 0.5,
  });
  const labels: VenueLabel[] = [];
  let fetches = 0;
  let heldBack = 0;
  try {
    for (const venue of visited) {
      const visit = await visitVenue(crawler, venue);
      fetches += visit.fetches;
      heldBack += visit.held_back;
      labels.push(
        labelVenue({
          venue,
          half: halves.get(venue.osm) ?? "test",
          home: visit.home,
          pages: visit.pages,
        }),
      );
    }
  } finally {
    await crawler.close();
    await agent.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  return { labels, fetches, held_back: heldBack };
};
