// This script checks the built site in dist/ (build it first with SITE_BASE=/crawler):
// - each internal link and each asset of each page goes to a file of the build;
// - no page scrolls sideways at 320, 375, 768 and 1024 pixels;
// - no page logs an error in the console;
// - one sitemap lists each page, with the date of its last change.
// With --shots <dir>, it also saves a screenshot of each page: desktop and phone, light and dark.
//   pnpm --filter @crawler/site check [--shots <dir>]
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const BASE = "/crawler";
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const shotsAt = process.argv.indexOf("--shots");
const shots = shotsAt === -1 ? undefined : process.argv[shotsAt + 1];
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml",
};

/** The file of the build for a path of the site, or undefined. */
const fileOf = (path) => {
  if (!path.startsWith(`${BASE}/`) && path !== BASE) return undefined;
  const rest = decodeURIComponent(path.slice(BASE.length)).replace(/^\//, "");
  for (const candidate of [rest, join(rest, "index.html"), `${rest}.html`]) {
    const file = join(dist, candidate);
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  return undefined;
};

const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  const file = fileOf(path);
  if (file === undefined) {
    response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    response.end(readFileSync(join(dist, "404.html")));
    return;
  }
  response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  response.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${String(server.address().port)}`;

// the pages: each index.html of the build, and the 404 page
const pages = [];
const walk = (dir, prefix) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "_astro" && name !== "pagefind") walk(full, `${prefix}${name}/`);
    } else if (name === "index.html") pages.push(`${BASE}/${prefix}`);
  }
};
walk(dist, "");
pages.sort((a, b) => a.localeCompare(b));

const problems = [];

// one sitemap, with each page and the date of its last change (a shallow clone has no dates, so it is not checked)
const sitemaps = readdirSync(dist).filter((name) => /^sitemap.*\.xml$/.test(name)).sort();
if (sitemaps.join(" ") !== "sitemap-0.xml sitemap-index.xml") problems.push(`the build has these sitemaps: ${sitemaps.join(", ")}`);
else {
  const xml = readFileSync(join(dist, "sitemap-0.xml"), "utf8");
  const listed = [...xml.matchAll(/<url><loc>([^<]*)<\/loc>(<lastmod>[^<]+<\/lastmod>)?/g)];
  const inSitemap = new Set(listed.map(([, loc]) => new URL(loc).pathname));
  for (const path of pages.filter((path) => path !== `${BASE}/404/`)) {
    if (!inSitemap.has(path)) problems.push(`${path}: not in the sitemap`);
  }
  const git = join(dist, "..", "..", "..", ".git");
  if (existsSync(git) && !existsSync(join(git, "shallow"))) {
    for (const [, loc, lastmod] of listed) if (lastmod === undefined) problems.push(`${loc}: no lastmod in the sitemap`);
  }
}

// the dataset of the study names its copy in the repository and the package that made it
const study = readFileSync(join(dist, "notes", "robots-txt-ai-agents", "index.html"), "utf8");
const graphs = [...study.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap(([, json]) => JSON.parse(json)["@graph"] ?? []);
const dataset = graphs.find((node) => node["@type"] === "Dataset");
for (const same of ["https://github.com/mark1russell7/crawler/", "https://www.npmjs.com/package/polite-crawler"]) {
  if (!(dataset?.sameAs ?? []).some((url) => url.startsWith(same))) problems.push(`the Dataset of the study has no sameAs ${same}`);
}

const browser = await chromium.launch();
const context = await browser.newContext();
for (const path of pages) {
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  // the links and the assets of the page
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
  const refs = await page.$$eval("a[href], link[href], script[src], img[src]", (nodes) =>
    nodes.map((node) => node.getAttribute("href") ?? node.getAttribute("src") ?? ""),
  );
  for (const ref of refs) {
    const url = new URL(ref, `${origin}${path}`);
    if (url.origin !== origin || ref.startsWith("#")) continue;
    if (fileOf(url.pathname) === undefined) problems.push(`${path}: the link ${ref} goes to no file`);
  }
  for (const width of [320, 375, 768, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(150);
    const { scroll, client } = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    if (scroll > client) problems.push(`${path}: the page is ${String(scroll)} px wide at ${String(width)} px`);
  }
  for (const error of errors) problems.push(`${path}: console error: ${error}`);
  await page.close();
}

if (shots !== undefined) {
  mkdirSync(shots, { recursive: true });
  for (const scheme of ["light", "dark"]) {
    for (const { device, viewport } of [
      { device: "desktop", viewport: { width: 1440, height: 900 } },
      { device: "phone", viewport: { width: 375, height: 812 } },
    ]) {
      const shot = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: "reduce", deviceScaleFactor: 1 });
      for (const path of pages) {
        const page = await shot.newPage();
        await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
        // the islands hydrate when they come into view: scroll through the page once
        await page.evaluate(async () => {
          for (let y = 0; y < document.body.scrollHeight; y += 600) {
            window.scrollTo(0, y);
            await new Promise((resolve) => setTimeout(resolve, 60));
          }
          window.scrollTo(0, 0);
        });
        await page.waitForTimeout(400);
        const name = path.slice(BASE.length + 1).replace(/\/$/, "").replace(/\//g, "-") || "home";
        await page.screenshot({ path: join(shots, `${name}-${device}-${scheme}.png`), fullPage: true });
        await page.close();
      }
      await shot.close();
    }
  }
}

await browser.close();
server.close();
if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(`${String(problems.length)} problems in ${String(pages.length)} pages`);
  process.exit(1);
}
console.info(`${String(pages.length)} pages: the links go to files, no page scrolls sideways, and no page logs an error`);
