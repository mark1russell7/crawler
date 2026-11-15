/**
 * The replay and the score of the decision eval (part C). It replays the WACZ file of the archive
 * step into a new store, with no network, and visits each venue again (`visitVenue`). Then it
 * labels each venue (`labelVenue`), scores the two choices of the rule, and writes the labels and
 * the result:
 *
 *   pnpm exec tsx packages/polite-crawler/eval/decisions/replay.mts --from decisions.wacz \
 *     --venues venues.json --crawl decisions-crawl.json --labels labels.jsonl --out result.json
 *
 * Options: --from (the WACZ file, default decisions.wacz), --venues (default venues.json), --crawl
 * (the log of the live crawl: with it, the replay reads only the venues that the crawl visited),
 * --labels (default labels.jsonl), --out (default result.json), --markdown (a file that gets the
 * tables) and --summary (a file that gets the tables at its end, for example $GITHUB_STEP_SUMMARY).
 *
 * The replay itself is in `replay-venues.mts`. The same WACZ file and the same commit give the same
 * labels.
 *
 * The labels and the result hold data of OpenStreetMap (© OpenStreetMap contributors, ODbL) and
 * URLs of other sites. They are artifacts of CI only. They do not go into the repository.
 */
import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { VENUE_LIMITS, VERSION } from "../../src/index.ts";
import { readWacz } from "../archive.mts";
import { CANDIDATES } from "./label.mts";
import { replayVenues } from "./replay-venues.mts";
import { SPLIT_SEED, markdownOf, scoreBest, scoreLinks, scoresOf, splitVenues } from "./score.mts";
import { ATTRIBUTION, readVenues } from "./venues.mts";
import { readCrawlLog } from "./visit.mts";

let args;
try {
  args = parseArgs({
    options: {
      from: { type: "string", default: "decisions.wacz" },
      venues: { type: "string", default: "venues.json" },
      crawl: { type: "string" },
      labels: { type: "string", default: "labels.jsonl" },
      out: { type: "string", default: "result.json" },
      markdown: { type: "string" },
      summary: { type: "string" },
    },
  }).values;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

const wacz = resolve(args.from);
const file = readVenues(await readFile(args.venues, "utf8"));
const log = args.crawl === undefined ? undefined : readCrawlLog(await readFile(args.crawl, "utf8"));
const statusOf = (osm: string): string => log?.venues[osm]?.status ?? "not-started";
// the split is over each venue of the file, so the half of a venue does not depend on the crawl
const halves = splitVenues(file.venues);
const visited = file.venues.filter(
  (venue) => log === undefined || statusOf(venue.osm) === "visited",
);

const bytes = await readFile(wacz);
const archive = await readWacz(wacz);
const { labels, fetches, held_back: heldBack } = await replayVenues(archive, visited, halves);

writeFileSync(args.labels, labels.map((label) => `${JSON.stringify(label)}\n`).join(""));

const links = scoresOf(labels, scoreLinks);
const best = scoresOf(labels, scoreBest);
const commit = process.env["GITHUB_SHA"] ?? null;
const count = (status: string): number =>
  file.venues.filter((venue) => statusOf(venue.osm) === status).length;
const result = {
  eval: "the decisions of the venue recipe against OpenStreetMap, part C",
  attribution: ATTRIBUTION,
  package: `polite-crawler ${VERSION}`,
  commit,
  archive: {
    file: basename(wacz),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    responses: archive.responses.size,
    redirects: archive.redirects.size,
    start: new Date(archive.start).toISOString(),
    software: archive.software,
  },
  venues: {
    in_file: file.venues.length,
    replayed: visited.length,
    ...(log === undefined ? {} : { stopped: count("stopped"), not_started: count("not-started") }),
  },
  split: {
    seed: SPLIT_SEED,
    train: labels.filter((label) => label.half === "train").length,
    test: labels.filter((label) => label.half === "test").length,
  },
  rule_pages: VENUE_LIMITS.pages,
  candidates: CANDIDATES,
  pages: { fetches, held_back: heldBack },
  links,
  best,
};
writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);

const markdown = markdownOf(links, best, {
  attribution: ATTRIBUTION,
  commit,
  wacz: basename(wacz),
});
if (args.markdown !== undefined) writeFileSync(args.markdown, markdown);
if (args.summary !== undefined) appendFileSync(args.summary, `${markdown}\n`);
process.stdout.write(markdown);
