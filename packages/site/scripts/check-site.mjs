// This script checks the built site in dist/ (build it first with SITE_BASE=/crawler):
// - each internal link and each asset of each page goes to a file of the build;
// - no page scrolls sideways at 320, 375, 768 and 1024 pixels;
// - each row of each table of the prose is in the box of its table at each of these widths, and at 1440;
// - no page logs an error in the console;
// - no page loads the search UI before a reader uses the search, and the search finds pages;
// - with each island hydrated, no page loads more than JS_BUDGET bytes of JavaScript (gzip);
// - one sitemap lists each page, with the date of its last change;
// - the feed of the study is RSS 2.0 that a parser reads, with one item for each run and full addresses;
// - the figures of the guides and the recipe reader answer a click with the result of the package;
// - the explorer of the options of the command line filters its table, and keeps the filter in the address.
// With --shots <dir>, it also saves a screenshot of each page: desktop and phone, light and dark. It
// also saves each figure after its click: desktop in the light theme, and phone in the dark theme.
//   pnpm --filter @crawler/site check [--shots <dir>]
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright-core";

const BASE = "/crawler";
// The JavaScript of a page with each island hydrated, gzip. Preact gives 21 KB at most; React gave 82 KB.
const JS_BUDGET = 40_000;
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
let most = { path: "", bytes: 0 };
// the JavaScript of each page, for the log
const sizes = [];

// one sitemap, with each page and the date of its last change (a shallow clone has no dates, so it is not checked)
const sitemaps = readdirSync(dist)
  .filter((name) => /^sitemap.*\.xml$/.test(name))
  .sort();
if (sitemaps.join(" ") !== "sitemap-0.xml sitemap-index.xml")
  problems.push(`the build has these sitemaps: ${sitemaps.join(", ")}`);
else {
  const xml = readFileSync(join(dist, "sitemap-0.xml"), "utf8");
  const listed = [...xml.matchAll(/<url><loc>([^<]*)<\/loc>(<lastmod>[^<]+<\/lastmod>)?/g)];
  const inSitemap = new Set(listed.map(([, loc]) => new URL(loc).pathname));
  for (const path of pages.filter((path) => path !== `${BASE}/404/`)) {
    if (!inSitemap.has(path)) problems.push(`${path}: not in the sitemap`);
  }
  const git = join(dist, "..", "..", "..", ".git");
  if (existsSync(git) && !existsSync(join(git, "shallow"))) {
    for (const [, loc, lastmod] of listed)
      if (lastmod === undefined) problems.push(`${loc}: no lastmod in the sitemap`);
  }
}

// the dataset of the study names its copy in the repository and the package that made it
const study = readFileSync(join(dist, "notes", "robots-txt-ai-agents", "index.html"), "utf8");
const graphs = [
  ...study.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g),
].flatMap(([, json]) => JSON.parse(json)["@graph"] ?? []);
const dataset = graphs.find((node) => node["@type"] === "Dataset");
for (const same of [
  "https://github.com/mark1russell7/crawler/",
  "https://www.npmjs.com/package/polite-crawler",
]) {
  if (!(dataset?.sameAs ?? []).some((url) => url.startsWith(same)))
    problems.push(`the Dataset of the study has no sameAs ${same}`);
}
// the creator of the dataset names the press contact (src/lib/cite.ts)
const press = dataset?.creator?.contactPoint;
if (
  press?.["@type"] !== "ContactPoint" ||
  press.contactType !== "press" ||
  !press.email?.includes("@")
)
  problems.push("the Dataset of the study has no press contactPoint on its creator");
// a DOI is an address at doi.org, and the page shows no DOI before study-doi.json names one
if (
  dataset?.identifier !== undefined &&
  !String(dataset.identifier).startsWith("https://doi.org/10.")
)
  problems.push(`the Dataset of the study has the identifier ${String(dataset.identifier)}`);

/**
 * The tables of the prose and the card tables with a row that a reader cannot see: a row with no
 * box, or a row out of the box of its table. The class `pc-stack` of a chart once made each card
 * table 28px high: the rows were in a scroll box on a wide screen, and they covered the next
 * sections on a phone. A row that a filter hides (`hidden`) does not count.
 */
const lostRows = (page) =>
  page.evaluate(() => {
    const lost = [];
    const tables = document.querySelectorAll(
      ".sl-markdown-content table:not(:where(.not-content *)), table.pc-cards",
    );
    for (const [index, table] of [...tables].entries()) {
      if (table.closest("[hidden]") !== null) continue;
      const box = table.getBoundingClientRect();
      for (const row of table.querySelectorAll(":scope > tbody > tr")) {
        if (row.closest("[hidden]") !== null) continue;
        const rect = row.getBoundingClientRect();
        if (
          row.getClientRects().length === 0 ||
          rect.top < box.top - 1 ||
          rect.bottom > box.bottom + 1
        ) {
          lost.push(index + 1);
          break;
        }
      }
    }
    return lost;
  });

const browser = await chromium.launch();
const context = await browser.newContext();
for (const path of pages) {
  const page = await context.newPage();
  const errors = [];
  const scripts = new Set();
  page.on("request", (request) => {
    if (request.resourceType() === "script") scripts.add(new URL(request.url()).pathname);
  });
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
    if (fileOf(url.pathname) === undefined)
      problems.push(`${path}: the link ${ref} goes to no file`);
  }
  // the islands hydrate when they come into view: scroll through the page once, then count the JavaScript
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 600) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForLoadState("networkidle");
  const bytes = [...scripts].reduce((sum, script) => {
    const file = fileOf(script);
    return file === undefined ? sum : sum + gzipSync(readFileSync(file)).length;
  }, 0);
  if (bytes > JS_BUDGET)
    problems.push(
      `${path}: ${String(bytes)} bytes of JavaScript (gzip), more than ${String(JS_BUDGET)}`,
    );
  if (bytes > most.bytes) most = { path, bytes };
  sizes.push({ path, bytes });
  for (const table of await lostRows(page))
    problems.push(`${path}: a row of table ${String(table)} is out of its table at 1440 px`);
  for (const width of [320, 375, 768, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(150);
    const { scroll, client } = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    if (scroll > client)
      problems.push(`${path}: the page is ${String(scroll)} px wide at ${String(width)} px`);
    for (const table of await lostRows(page))
      problems.push(
        `${path}: a row of table ${String(table)} is out of its table at ${String(width)} px`,
      );
  }
  // the Pagefind UI loads at the first use of the search, not on each page (src/components/Search.astro)
  if (await page.locator("#starlight__search > *").count())
    problems.push(`${path}: the search UI loads before a reader uses it`);
  for (const error of errors) problems.push(`${path}: console error: ${error}`);
  await page.close();
}

// the first click on the search button loads the search UI, and a query finds pages
{
  const page = await context.newPage();
  page.on("pageerror", (error) => problems.push(`search: ${error.message}`));
  await page.goto(`${origin}${BASE}/`, { waitUntil: "networkidle" });
  await page.locator("button[data-open-modal]").click();
  const input = page.locator("#starlight__search input");
  try {
    await input.waitFor({ timeout: 10_000 });
    if (!(await input.evaluate((node) => node === document.activeElement)))
      problems.push("search: the input has no focus after the first click");
    await input.fill("robots.txt");
    await page.locator(".pagefind-ui__result").first().waitFor({ timeout: 10_000 });
  } catch (error) {
    problems.push(
      `search: ${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)}`,
    );
  }
  await page.close();
}

// the feed of the monthly runs: XML that a parser reads, one item for each CSV of a run, and each
// address of an item goes to a file of the build. The study page names the feed in its head.
{
  const SITE = "https://mark1russell7.github.io/crawler/";
  const feed = join(dist, "study", "feed.xml");
  const runs = readdirSync(join(dist, "data")).filter((name) =>
    /^robots-study-\d{4}-\d{2}-\d{2}\.csv$/.test(name),
  );
  if (!existsSync(feed)) problems.push("the build has no study/feed.xml");
  else {
    const page = await context.newPage();
    await page.goto(`${origin}${BASE}/`, { waitUntil: "networkidle" });
    const read = await page.evaluate(
      (xml) => {
        const doc = new DOMParser().parseFromString(xml, "application/xml");
        const error = doc.querySelector("parsererror");
        return {
          error: error === null ? undefined : (error.textContent ?? "a parser error"),
          root: doc.documentElement.nodeName,
          version: doc.documentElement.getAttribute("version"),
          items: [...doc.querySelectorAll("channel > item")].map((item) => ({
            link: item.querySelector("link")?.textContent ?? "",
            enclosure: item.querySelector("enclosure")?.getAttribute("url") ?? "",
            length: Number(item.querySelector("enclosure")?.getAttribute("length")),
            html: item.querySelector("description")?.textContent ?? "",
          })),
        };
      },
      readFileSync(feed, "utf8"),
    );
    await page.close();
    if (read.error !== undefined) problems.push(`study/feed.xml: ${read.error.split("\n")[0]}`);
    if (read.root !== "rss" || read.version !== "2.0")
      problems.push("study/feed.xml is not RSS 2.0");
    if (read.items.length !== runs.length)
      problems.push(
        `study/feed.xml has ${String(read.items.length)} items for ${String(runs.length)} runs`,
      );
    for (const item of read.items) {
      const hrefs = [...item.html.matchAll(/href="([^"]+)"/g)].map((match) => match[1] ?? "");
      for (const link of [item.link, item.enclosure, ...hrefs]) {
        if (!link.startsWith("https://")) problems.push(`study/feed.xml: ${link} is not absolute`);
        else if (link.startsWith(SITE)) {
          const path = `${BASE}/${new URL(link).pathname.slice(new URL(SITE).pathname.length)}`;
          if (fileOf(path) === undefined) problems.push(`study/feed.xml: ${link} goes to no file`);
        }
      }
      const csv = fileOf(`${BASE}/${item.enclosure.slice(SITE.length)}`);
      if (csv !== undefined && statSync(csv).size !== item.length)
        problems.push(`study/feed.xml: the length of ${item.enclosure} is not its size`);
    }
  }
  if (!/<link[^>]+rel="alternate"[^>]+type="application\/rss\+xml"/.test(study))
    problems.push("the study page has no <link rel=alternate> to the feed");
}

// the figures answer a reader: a click, then the result that the code of the package gives
const INTERACTIONS = [
  {
    path: `${BASE}/guide/search/`,
    name: "figure-search-k0",
    figure: ".pc-hy",
    act: async (page) => {
      await page.getByRole("button", { name: "wheelchair access" }).click();
      await page.locator(".pc-hy input[type=range]").first().fill("0");
      await page.getByText("Fused: rank 2 of").waitFor({ timeout: 10_000 });
    },
  },
  {
    path: `${BASE}/tools/recipe-reader/`,
    name: "figure-recipe-product",
    figure: ".pc-tool",
    act: async (page) => {
      await page.getByRole("button", { name: "Shop: variants, sale, related" }).click();
      await page
        .getByText("Without that url, the reader takes Aceto Esempio")
        .waitFor({ timeout: 10_000 });
    },
  },
  {
    path: `${BASE}/guide/recipes/`,
    name: "figure-recipe-error",
    figure: ".pc-rb",
    act: async (page) => {
      await page.getByRole("button", { name: "An item with no name" }).click();
      await page.getByText("title must be a text").waitFor({ timeout: 10_000 });
    },
  },
  {
    // the explorer filters the static table of the page: the shot shows the explorer and the table
    path: `${BASE}/reference/cli/`,
    name: "figure-cli-options",
    figure: ".pc-optx",
    shot: ".pc-optx-wrap",
    act: async (page) => {
      await page.getByRole("radio", { name: "crawl", exact: true }).click();
      // the arrow keys move in the chips: to the next command, and back
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowLeft");
      await page.getByRole("searchbox", { name: "Option name" }).fill("max");
      await page.waitForFunction(
        () => {
          const rows = [...document.querySelectorAll(".pc-optx-wrap tbody tr")];
          const shown = rows.filter((row) => !row.hidden);
          const count = document.querySelector(".pc-optx-status strong")?.textContent;
          return (
            shown.length > 0 &&
            shown.length < rows.length &&
            count === String(shown.length) &&
            shown.every(
              (row) =>
                [...row.cells[0].querySelectorAll("code")].some(
                  (code) => code.textContent === "crawl" && code.classList.contains("pc-hit"),
                ) && row.cells[1].textContent.includes("--max"),
            ) &&
            window.location.hash === "#command=crawl&option=max"
          );
        },
        undefined,
        { timeout: 10_000 },
      );
    },
  },
  {
    path: `${BASE}/guide/daemon/`,
    name: "figure-daemon-end",
    figure: ".pc-dm",
    act: async (page) => {
      // with reduced motion, the figure shows the whole schedule at once
      await page.getByText('"confirmed":true').waitFor({ timeout: 20_000 });
    },
  },
  {
    path: `${BASE}/block-ai-training-crawlers/`,
    name: "figure-robots-builder",
    figure: ".pc-rbuild",
    act: async (page) => {
      // keep the assistants out: the MCP server obeys Claude-User, so it is refused too
      await page
        .getByRole("group", { name: "AI assistants" })
        .getByRole("button", { name: "Keep out", exact: true })
        .click();
      await page.getByText("6 of 16").waitFor({ timeout: 10_000 });
      await page.getByRole("button", { name: "Refused PoliteCrawler on /", exact: true }).click();
      await page.getByText("in the group for Claude-User").first().waitFor({ timeout: 10_000 });
    },
  },
  {
    path: `${BASE}/bot/`,
    name: "figure-site-visit",
    figure: ".pc-visit",
    act: async (page) => {
      await page.getByRole("button", { name: "A small crawl" }).click();
      await page.locator(".pc-visit select").first().selectOption("403");
      // with reduced motion, the figure shows the whole hour at once
      await page
        .locator(".pc-visit .pc-crawl-verdict")
        .getByText(/After a 403, it sends no request/)
        .waitFor({ timeout: 10_000 });
    },
  },
  {
    path: `${BASE}/guide/compare/`,
    name: "figure-pace",
    figure: ".pc-pace",
    act: async (page) => {
      await page.getByRole("button", { name: "A slow site: 2 s" }).click();
      await page
        .locator(".pc-pace .pc-crawl-verdict")
        .getByText(/polite-crawler sends 5 a minute/)
        .waitFor({ timeout: 10_000 });
    },
  },
  {
    path: `${BASE}/notes/tokens-per-claim/`,
    name: "figure-eval-claims",
    figure: ".pc-eval-claims",
    act: async (page) => {
      await page.locator(".pc-eval-claims .pc-eval-plot").focus();
      await page.keyboard.press("Home");
      await page
        .locator(".pc-eval-claims .pc-eval-detail")
        .getByText(/RFC 1149/)
        .waitFor({ timeout: 10_000 });
    },
  },
  {
    path: `${BASE}/notes/tokens-per-claim/`,
    name: "figure-eval-session",
    figure: ".pc-eval-session",
    act: async (page) => {
      await page.getByRole("button", { name: "Short pages first" }).click();
      await page
        .locator(".pc-eval-session .pc-crawl-verdict")
        .getByText(/from claim 13 on/)
        .waitFor({ timeout: 10_000 });
    },
  },
];
for (const { scheme, viewport, device } of shots === undefined
  ? [{ scheme: "light", viewport: { width: 1280, height: 900 }, device: "desktop" }]
  : [
      { scheme: "light", viewport: { width: 1280, height: 900 }, device: "desktop" },
      { scheme: "dark", viewport: { width: 375, height: 812 }, device: "phone" },
    ]) {
  const context = await browser.newContext({
    viewport,
    colorScheme: scheme,
    reducedMotion: "reduce",
    deviceScaleFactor: 1,
  });
  for (const { path, name, figure, shot, act } of INTERACTIONS) {
    const page = await context.newPage();
    page.on("pageerror", (error) => problems.push(`${path}: ${error.message}`));
    try {
      await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
      await page.locator(figure).first().scrollIntoViewIfNeeded();
      // an island hydrates when it comes into view: astro-island drops its ssr attribute then
      await page.waitForFunction(
        (selector) => {
          const island = document.querySelector(selector)?.closest("astro-island");
          return island !== null && island !== undefined && !island.hasAttribute("ssr");
        },
        figure,
        { timeout: 10_000 },
      );
      await act(page);
      if (shots !== undefined) {
        mkdirSync(shots, { recursive: true });
        // the header, the bar "On this page" and the menu button of a phone stay on top, and they
        // hide a part of a tall figure
        await page.addStyleTag({
          content: "header.header, mobile-starlight-toc, .sl-menu-button { visibility: hidden; }",
        });
        await page.waitForTimeout(300);
        await page
          .locator(shot ?? figure)
          .first()
          .screenshot({ path: join(shots, `${name}-${device}-${scheme}.png`) });
      }
    } catch (error) {
      problems.push(
        `${path}: the figure did not answer: ${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)}`,
      );
    }
    await page.close();
  }
  await context.close();
}

if (shots !== undefined) {
  mkdirSync(shots, { recursive: true });
  for (const scheme of ["light", "dark"]) {
    for (const { device, viewport } of [
      { device: "desktop", viewport: { width: 1440, height: 900 } },
      { device: "phone", viewport: { width: 375, height: 812 } },
    ]) {
      const shot = await browser.newContext({
        viewport,
        colorScheme: scheme,
        reducedMotion: "reduce",
        deviceScaleFactor: 1,
      });
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
        const name =
          path
            .slice(BASE.length + 1)
            .replace(/\/$/, "")
            .replace(/\//g, "-") || "home";
        await page.screenshot({
          path: join(shots, `${name}-${device}-${scheme}.png`),
          fullPage: true,
        });
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
console.info(
  `${String(pages.length)} pages: the links go to files, no page scrolls sideways, and no page logs an error`,
);
console.info(
  `the most JavaScript: ${String(most.bytes)} bytes (gzip) on ${most.path}, of ${String(JS_BUDGET)}`,
);
for (const { path, bytes } of sizes)
  console.info(`  ${path}: ${String(bytes)} bytes of JavaScript (gzip)`);
