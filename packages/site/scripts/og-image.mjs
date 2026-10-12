// This script renders scripts/og-card.html to public/og.png (1200 by 630), the share card of the site.
// Start it after a change of the card: pnpm --filter @crawler/site og
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";

const card = new URL("./og-card.html", import.meta.url);
const out = fileURLToPath(new URL("../public/og.png", import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(card.href);
await page.screenshot({ path: out, type: "png" });
await browser.close();
console.info(`wrote ${out}`);
