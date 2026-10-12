// This script renders the share cards (1200 by 630): scripts/og-card.html to public/og.png, and
// scripts/og-study.html to public/og-robots-study.png with the verdicts of the robots.txt study.
// Start it after a change of a card or of the study: pnpm --filter @crawler/site og
// The numbers come from src/lib/study.ts, the module that gives the numbers of the page (Node.js 23.6
// or later reads the TypeScript of that module).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { formatDay, headline } from "../src/lib/study.ts";

const study = JSON.parse(readFileSync(new URL("../src/data/robots-study.json", import.meta.url), "utf8"));
const gpt = study.agents.findIndex((agent) => agent.token === "GPTBot");
const { gpt: row, summary } = headline(study);
const facts = {
  date: formatDay(study.fetched.from),
  share: `${String(Math.round(row.share))}%`,
  answered: String(summary.answered),
  codes: study.sites.map((site) => site.p[gpt]),
};

const cards = [
  ["./og-card.html", "../public/og.png"],
  ["./og-study.html", "../public/og-robots-study.png"],
];
const browser = await chromium.launch();
for (const [card, png] of cards) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.addInitScript((value) => {
    window.study = value;
  }, facts);
  await page.goto(new URL(card, import.meta.url).href);
  const out = fileURLToPath(new URL(png, import.meta.url));
  await page.screenshot({ path: out, type: "png" });
  await page.close();
  console.info(`wrote ${out}`);
}
await browser.close();
