/**
 * The collect step of the decision eval (part C). It asks the Overpass API of OpenStreetMap for the
 * venues of each area that have a site and opening hours. Then it draws a sample of each area with a
 * seed. It sends each query through `send` of `polite-crawler/api`, one query at a time, at the pace
 * of the host. Start it in CI only (`.github/workflows/decisions.yml`), not on a shared computer:
 *
 *   pnpm exec tsx packages/polite-crawler/eval/decisions/collect.mts --out venues.json
 *
 * Options: --areas (default eval/decisions/areas.json), --out (default venues.json), --per-area
 * (the most venues of each area, default 400), --seed (the seed of the draw) and --endpoint (the
 * URL of the Overpass API).
 *
 * - A query that times out (a 504, or a 200 with a remark of a runtime error) splits its tile into
 *   four tiles, to a depth of 3.
 * - A 429 waits for the pace of the host (`send` parks the host), and the query goes again, a
 *   maximum of 5 times.
 *
 * The file of venues holds data of OpenStreetMap (© OpenStreetMap contributors, ODbL). It is an
 * artifact of CI only. It does not go into the repository.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { VERSION } from "../../src/index.ts";
import type { Pace } from "../../src/api.ts";
import { fetchTransport, send } from "../../src/api.ts";
import { HostScheduler, realClock } from "../../src/politeness.ts";
import type { Box, OverpassElement, Venue, VenuesFile } from "./venues.mts";
import {
  ATTRIBUTION,
  drawVenues,
  overpassQuery,
  quarters,
  readAreas,
  venuesOf,
} from "./venues.mts";

const here = dirname(fileURLToPath(import.meta.url));

/** The seed of the draw. A different seed gives a different sample. */
const DRAW_SEED = "polite-crawler decisions draw 1";
/** The most splits of a tile: a depth of 3 gives at most 64 tiles for each area. */
const MAX_DEPTH = 3;
/** The most queries for one tile after a 429. */
const MAX_TRIES = 5;

let args;
try {
  args = parseArgs({
    options: {
      areas: { type: "string", default: join(here, "areas.json") },
      out: { type: "string", default: "venues.json" },
      "per-area": { type: "string", default: "400" },
      seed: { type: "string", default: DRAW_SEED },
      endpoint: { type: "string", default: "https://overpass-api.de/api/interpreter" },
    },
  }).values;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

const perArea = Number(args["per-area"]);
if (!Number.isInteger(perArea) || perArea < 1 || perArea > 5000) {
  process.stderr.write("--per-area is a whole number from 1 to 5000\n");
  process.exit(2);
}

const areas = readAreas(await readFile(args.areas, "utf8"));
const endpoint = new URL(args.endpoint);
// the User-Agent names the crawler and its repository, and nothing more
const transport = fetchTransport({
  userAgent: `PoliteCrawler-eval/${VERSION} (+https://github.com/mark1russell7/crawler)`,
  timeoutMs: 240_000,
});
const pace: Pace = { scheduler: new HostScheduler(realClock, 1), now: realClock.now };

/** The result of one query: the elements, or a time-out that splits the tile. */
type Asked = { readonly elements: OverpassElement[] } | { readonly timedOut: string };

const ask = async (box: Box, label: string): Promise<Asked> => {
  for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
    const { reply } = await send(pace, transport, {
      source: "Overpass API",
      host: endpoint.host,
      minIntervalMs: 5000,
      what: `the venues of ${label}`,
      exchange: {
        method: "POST",
        url: endpoint.href,
        headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
        body: `data=${encodeURIComponent(overpassQuery(box))}`,
      },
    });
    if (reply.status === 429) {
      process.stderr.write(`${label}: 429, try ${String(attempt)} of ${String(MAX_TRIES)}\n`);
      continue;
    }
    if (reply.status === 504) return { timedOut: "504" };
    if (reply.status !== 200) {
      throw new Error(`${label}: the Overpass API gave ${String(reply.status)}`);
    }
    const parsed = JSON.parse(reply.body) as { elements?: unknown; remark?: unknown };
    if (typeof parsed.remark === "string" && /runtime error/i.test(parsed.remark)) {
      return { timedOut: parsed.remark.slice(0, 200) };
    }
    if (!Array.isArray(parsed.elements)) throw new Error(`${label}: the answer has no elements`);
    return { elements: parsed.elements as OverpassElement[] };
  }
  throw new Error(`${label}: the Overpass API gave 429 ${String(MAX_TRIES)} times`);
};

/** This function gives the elements of a tile. A tile that times out goes as four tiles. */
const elementsOf = async (
  box: Box,
  label: string,
  depth: number,
): Promise<{ elements: OverpassElement[]; tiles: number }> => {
  const asked = await ask(box, label);
  if ("elements" in asked) return { elements: asked.elements, tiles: 1 };
  if (depth >= MAX_DEPTH) throw new Error(`${label}: the query timed out (${asked.timedOut})`);
  process.stderr.write(
    `${label}: the query timed out (${asked.timedOut}), so it goes as 4 tiles\n`,
  );
  const elements: OverpassElement[] = [];
  let tiles = 0;
  for (const [at, part] of quarters(box).entries()) {
    const result = await elementsOf(part, `${label}.${String(at + 1)}`, depth + 1);
    elements.push(...result.elements);
    tiles += result.tiles;
  }
  return { elements, tiles };
};

const summary: Array<VenuesFile["areas"][number]> = [];
const venues: Venue[] = [];
for (const area of areas) {
  const { elements, tiles } = await elementsOf(area.box, area.name, 0);
  const found = venuesOf(elements, area.name);
  const drawn = drawVenues(found, perArea, args.seed, area.name);
  summary.push({ name: area.name, label: area.label, box: area.box, found: found.length, tiles });
  // a venue in two areas stays in the first area only
  const known = new Set(venues.map((venue) => venue.osm));
  venues.push(...drawn.filter((venue) => !known.has(venue.osm)));
  process.stderr.write(
    `${area.name}: ${String(found.length)} venues with a site and hours, ${String(drawn.length)} drawn, ${String(tiles)} tiles\n`,
  );
}

const file: VenuesFile = {
  attribution: ATTRIBUTION,
  collected_at: new Date(realClock.now()).toISOString(),
  seed: args.seed,
  per_area: perArea,
  areas: summary,
  venues,
};
await writeFile(args.out, `${JSON.stringify(file, null, 2)}\n`);
process.stderr.write(`${String(venues.length)} venues in ${args.out}\n`);
