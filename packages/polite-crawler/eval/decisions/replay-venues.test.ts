import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportWacz } from "../../src/index.ts";
import { tempDir, removeDir } from "../../src/test-helpers.ts";
import { FILLER, HTML, htmlPage, openWith, world } from "../../src/test-recipes.ts";
import { readWacz } from "../archive.mts";
import type { Half } from "./label.mts";
import { labelVenue } from "./label.mts";
import { replayVenues } from "./replay-venues.mts";
import type { Venue } from "./venues.mts";
import { visitVenue } from "./visit.mts";

/*
 * Two made-up venues on mock hosts of the domain `.example`. The test records a crawl as a WACZ
 * file, then replays the file. No request goes to the network.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const HOURS =
  "<h2>Hours</h2><p>Monday - Friday 7am - 3pm</p><p>Saturday 8am - 1pm</p><p>Sunday closed</p>";

const venue = (osm: string, site: string): Venue => ({
  osm,
  name: null,
  website: `${site}/`,
  opening_hours: "Mo-Fr 07:00-15:00; Sa 08:00-13:00; Su off",
  lat: 10,
  lon: 20,
  area: "one",
});

const ONE = "https://cafe-one.example";
const TWO = "https://cafe-two.example";

const sites = {
  [ONE]: (path: string) => {
    if (path === "/") {
      return {
        body: htmlPage("Cafe One", `${FILLER}<a href="/hours">Opening hours</a>`),
        headers: HTML,
      };
    }
    if (path === "/hours") return { body: htmlPage("Hours", `${FILLER}${HOURS}`), headers: HTML };
    return undefined;
  },
  [TWO]: (path: string) => {
    if (path === "/") {
      return {
        body: htmlPage("Cafe Two", `${FILLER}<a href="/about">About us</a>`),
        headers: HTML,
      };
    }
    if (path === "/about") return { body: htmlPage("About", FILLER), headers: HTML };
    return undefined;
  },
};

const venues = [venue("node/2", TWO), venue("node/1", ONE)];
const halves = new Map<string, Half>([
  ["node/1", "train"],
  ["node/2", "test"],
]);

describe("the replay of the archive", () => {
  it("gives the labels of the live visits, with no network", async () => {
    const hosts = world(sites);
    const { crawler } = await openWith(hosts, cleanups);
    const live = [];
    for (const one of venues) {
      const visit = await visitVenue(crawler, one);
      live.push(
        labelVenue({
          venue: one,
          half: halves.get(one.osm) ?? "test",
          home: visit.home,
          pages: visit.pages,
        }),
      );
    }
    const folder = await tempDir("decisions-wacz");
    cleanups.push(() => removeDir(folder));
    const out = join(folder, "decisions.wacz");
    await exportWacz(crawler.runtime, { out, includeRefusals: true });

    const replayed = await replayVenues(await readWacz(out), venues, halves);
    // the replay goes in the order of the ids
    expect(replayed.labels.map((label) => label.osm)).toEqual(["node/1", "node/2"]);
    expect(replayed.labels).toEqual([...live].sort((a, b) => a.osm.localeCompare(b.osm)));
    expect(replayed.labels[0]?.links_outcome).toBe("rule-hit");
    expect(replayed.labels[1]?.links_outcome).toBe("no-page-agrees");
    expect(replayed.held_back).toBe(0);

    // a second replay of the same file gives the same labels
    expect((await replayVenues(await readWacz(out), venues, halves)).labels).toEqual(
      replayed.labels,
    );
  });
});
