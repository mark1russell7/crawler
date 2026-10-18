/**
 * The command of the eval "tokens per verified claim" (part A). eval/README.md tells the method.
 *
 * Online mode fetches the pages of the claims with the default identity of the crawler (robots.txt,
 * the pace of each site), exports the store as a WACZ file, and measures from that file. Run it in
 * CI (`.github/workflows/eval.yml`), not on a shared computer:
 *
 *   pnpm exec tsx packages/polite-crawler/eval/run.mts --wacz eval.wacz --out eval-result.json
 *
 * Offline mode measures from a saved WACZ file, with no network. The same file and the same commit
 * give the same numbers. With --expect, the command compares its result with a saved result:
 *
 *   pnpm exec tsx packages/polite-crawler/eval/run.mts --from eval.wacz --expect eval-result.json
 *
 * Options: --claims (the question set, default eval/claims.json), --from (offline mode), --wacz
 * (the WACZ file that online mode writes, default eval.wacz), --out (the JSON result, default
 * eval-result.json), --markdown (a file that gets the summary), --summary (a file that gets the
 * summary at its end, for example $GITHUB_STEP_SUMMARY), --window (the read window, default 2000
 * characters) and --expect (a result to compare with).
 *
 * The exit code is 0 when each claim is verified, and 1 when a claim is not verified. With --expect,
 * it is 0 when the two results agree, and 1 when they do not agree. A wrong command line gives 2.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { exportWacz, openCrawler, VERSION } from "../src/index.ts";
import type { Measurement } from "./measure.mts";
import { markdownSummary, measure, readClaims } from "./measure.mts";

const here = dirname(fileURLToPath(import.meta.url));

let args;
try {
  args = parseArgs({
    options: {
      claims: { type: "string", default: join(here, "claims.json") },
      from: { type: "string" },
      wacz: { type: "string", default: "eval.wacz" },
      out: { type: "string", default: "eval-result.json" },
      markdown: { type: "string" },
      summary: { type: "string" },
      window: { type: "string", default: "2000" },
      expect: { type: "string" },
    },
  }).values;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

const window = Number(args.window);
if (!Number.isInteger(window) || window < 100 || window > 20_000) {
  process.stderr.write("--window is a whole number of characters from 100 to 20000\n");
  process.exit(2);
}

const claims = readClaims(await readFile(args.claims, "utf8"));
const offline = args.from !== undefined;
const wacz = resolve(args.from ?? args.wacz);
const live: Array<{ url: string; outcome: string; status: number; note: string | null }> = [];

if (!offline) {
  // online mode: the default identity of the crawler, a new store, and the pace of each site
  const urls = [...new Set(claims.map((claim) => claim.url))];
  const dir = await mkdtemp(join(tmpdir(), "polite-crawler-eval-live-"));
  const crawler = openCrawler({ dir, renderer: false });
  try {
    const pages = await Promise.all(
      urls.map(async (url) => {
        try {
          return await crawler.fetch(url, { onBehalfOf: ["Claude-User"], render: "never" });
        } catch (error) {
          return {
            url,
            outcome: "error",
            status: 0,
            note: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    for (const page of pages) {
      live.push({ url: page.url, outcome: page.outcome, status: page.status, note: page.note });
      process.stdout.write(`${page.outcome} ${String(page.status)} ${page.url}\n`);
    }
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
}

const measured = await measure({ wacz, claims, window });
const commit = process.env["GITHUB_SHA"] ?? null;
const result = {
  eval: "tokens per verified claim, part A",
  package: `polite-crawler ${VERSION}`,
  commit,
  mode: offline ? "offline" : "online",
  wacz: basename(wacz),
  ...(offline ? {} : { live }),
  ...measured,
};
writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);

const markdown = markdownSummary(measured, {
  mode: result.mode,
  commit,
  wacz: basename(wacz),
});
if (args.markdown !== undefined) writeFileSync(args.markdown, markdown);
if (args.summary !== undefined) appendFileSync(args.summary, `${markdown}\n`);

const { summary } = measured;
process.stdout.write(
  `${String(summary.verified)} of ${String(summary.claims)} claims verified. Median tokens: polite-crawler ${String(summary.polite.median.tokens)}, Markdown ${String(summary.markdown.median.tokens)}. Ratio of the totals: ${String(summary.ratio.markdown_total)}.\n`,
);
for (const claim of measured.claims) {
  if (!claim.verified) process.stdout.write(`NOT VERIFIED ${claim.id}: ${claim.failure ?? ""}\n`);
}

// with --expect, the exit code tells only if the two results agree
let failed = args.expect === undefined && summary.failed > 0;
if (args.expect !== undefined) {
  // the parts that come from the archive: the replay, the claims and the summary
  const expected = JSON.parse(await readFile(args.expect, "utf8")) as Partial<Measurement>;
  const parts = ["window", "archive", "tool_definitions", "replay", "claims", "summary"] as const;
  for (const part of parts) {
    const same = JSON.stringify(expected[part]) === JSON.stringify(measured[part]);
    process.stdout.write(`${same ? "same" : "DIFFERENT"} ${part}\n`);
    if (!same) failed = true;
  }
}
process.exitCode = failed ? 1 : 0;
