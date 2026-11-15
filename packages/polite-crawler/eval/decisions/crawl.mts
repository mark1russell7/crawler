/**
 * The archive step of the decision eval (part C). It visits each venue of the venues file with
 * polite-crawler (`visitVenue`): the home page and its candidate links, at most 17 pages for each
 * site. Then it exports the store as one WACZ file, with the refusals and the redirects, so the
 * replay gets the same answers with no network. Start it in CI only
 * (`.github/workflows/decisions.yml`), not on a shared computer:
 *
 *   pnpm exec tsx packages/polite-crawler/eval/decisions/crawl.mts --venues venues.json --wacz decisions.wacz
 *
 * Options: --venues (default venues.json), --wacz (default decisions.wacz), --log (the status of
 * each venue, default decisions-crawl.json), --workers (the venues in progress at one time, default
 * 32) and --budget (the minutes after which no visit starts, default 95).
 *
 * robots.txt, the pace of each site, the stops and the rule for a held-back page apply to each
 * fetch. The visits start in the order of a seeded hash of the ids. Thus, when the budget stops the
 * crawl, the crawl leaves out venues of each area, not one area. Ten minutes after the budget, the crawl
 * stops each visit in progress. The log tells which venues the crawl visited, and the replay
 * reads only those venues.
 *
 * The WACZ file holds pages of other sites. It is an artifact of CI only. It does not go into the
 * repository.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { deriveSeed, seedOf } from "@mark1russell7/rigor-generators";
import { exportWacz, openCrawler, VERSION } from "../../src/index.ts";
import { readVenues } from "./venues.mts";
import type { CrawlLog, VenueStatus } from "./visit.mts";
import { visitVenue } from "./visit.mts";

let args;
try {
  args = parseArgs({
    options: {
      venues: { type: "string", default: "venues.json" },
      wacz: { type: "string", default: "decisions.wacz" },
      log: { type: "string", default: "decisions-crawl.json" },
      workers: { type: "string", default: "32" },
      budget: { type: "string", default: "95" },
    },
  }).values;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

const workers = Number(args.workers);
const budgetMinutes = Number(args.budget);
if (!Number.isInteger(workers) || workers < 1 || workers > 64) {
  process.stderr.write("--workers is a whole number from 1 to 64\n");
  process.exit(2);
}
if (!Number.isFinite(budgetMinutes) || budgetMinutes <= 0 || budgetMinutes > 600) {
  process.stderr.write("--budget is a number of minutes from 1 to 600\n");
  process.exit(2);
}

const { venues } = readVenues(await readFile(args.venues, "utf8"));
const order = seedOf("polite-crawler decisions crawl order 1");
const queue = [...venues].sort(
  (a, b) =>
    deriveSeed(order, a.osm) - deriveSeed(order, b.osm) ||
    (a.osm < b.osm ? -1 : a.osm > b.osm ? 1 : 0),
);

const started = Date.now();
const deadline = started + budgetMinutes * 60_000;
const controller = new AbortController();
const stopper = setTimeout(() => controller.abort(), deadline - started + 10 * 60_000);
stopper.unref();

const statuses = new Map<string, VenueStatus>(
  venues.map((venue) => [venue.osm, { status: "not-started", fetches: 0, held_back: 0 }]),
);
const wacz = resolve(args.wacz);
const dir = await mkdtemp(join(tmpdir(), "polite-crawler-decisions-live-"));
// the default identity of the crawler, a new store, and the pace of each site
const crawler = openCrawler({ dir, renderer: false, maxActive: workers });
try {
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (next < queue.length && Date.now() < deadline && !controller.signal.aborted) {
      const venue = queue[next];
      next += 1;
      if (venue === undefined) break;
      const visit = await visitVenue(crawler, venue, controller.signal);
      statuses.set(venue.osm, {
        status: controller.signal.aborted ? "stopped" : "visited",
        fetches: visit.fetches,
        held_back: visit.held_back,
      });
      done += 1;
      if (done % 50 === 0) {
        const minutes = ((Date.now() - started) / 60_000).toFixed(1);
        process.stdout.write(
          `${String(done)} of ${String(queue.length)} venues in ${minutes} min\n`,
        );
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
  clearTimeout(stopper);

  // the refusals and the redirects go into the archive too, so the replay gets the same answers
  const exported = await exportWacz(crawler.runtime, {
    out: wacz,
    includeRefusals: true,
    overwrite: true,
  });
  process.stdout.write(
    `exported ${String(exported.responses)} responses and ${String(exported.metadata)} metadata records to ${wacz}\n`,
  );
} finally {
  await crawler.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

const log: CrawlLog = {
  package: `polite-crawler ${VERSION}`,
  started_at: new Date(started).toISOString(),
  finished_at: new Date().toISOString(),
  budget_minutes: budgetMinutes,
  workers,
  venues: Object.fromEntries(statuses),
};
await writeFile(args.log, `${JSON.stringify(log, null, 2)}\n`);
const counts = new Map<string, number>();
for (const { status } of statuses.values()) counts.set(status, (counts.get(status) ?? 0) + 1);
process.stdout.write(
  `${[...counts].map(([status, count]) => `${String(count)} ${status}`).join(", ")}\n`,
);
